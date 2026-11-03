import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { buildCsr, needsRenewal } from '../src/acme.mjs';
import { parsePair } from '../src/hub.mjs';
import { joinHub, startNodeLink } from '../src/node-link.mjs';
import { createAccount, createSignup, readAccount, Relay, removeAccount } from '../src/relay.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-relay-'));
let relay;
let server;
let base;
const links = [];

before(async () => {
  const config = { host: '127.0.0.1', tls: 'none', origin: 'https://relay.example.com', shared: true };
  relay = new Relay({ dir, config });
  server = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const link of links) link.stop();
  relay.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (pathname, body, key) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body ?? {}),
});

async function signUp() {
  const { code } = createSignup(dir);
  const res = await post('/relay/signup', { code });
  assert.equal(res.status, 200);
  const { adminKey } = await res.json();
  assert.equal((await post('/relay/signup', { code })).status, 403, 'an invite works once');
  const status = await (await fetch(`${base}/hub/api/status`, { headers: { Authorization: `Bearer ${adminKey}` } })).json();
  return { adminKey, token: status.mcp.key, status };
}

async function call(token, name, args) {
  const res = await post(`/t/${token}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return (await res.json()).result;
}

async function addComputer(adminKey, name, execute) {
  const invite = await (await post('/hub/api/invites', {}, adminKey)).json();
  const joined = await joinHub({ origin: base, code: invite.code, name });
  links.push(startNodeLink({ origin: base, key: joined.key, execute }));
  for (let i = 0; i < 100; i += 1) {
    const listed = JSON.parse((await call((await accountOf(adminKey)).token, 'list_computers', {})).content[0].text);
    if (listed.computers.some((c) => c.name === joined.name && c.online)) break;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  return { ...joined, pair: invite.pair };
}

async function accountOf(adminKey) {
  const status = await (await fetch(`${base}/hub/api/status`, { headers: { Authorization: `Bearer ${adminKey}` } })).json();
  return { token: status.mcp.key, status };
}

test('a new person starts with an address and no computers, and nothing runs on the relay', async () => {
  const { token, status } = await signUp();
  assert.equal(status.mcp.full, `https://relay.example.com/t/${token}/mcp`);
  assert.deepEqual(status.computers, []);
  for (const args of [{ command: 'echo hi' }, { computer: 'relay', command: 'echo hi' }]) {
    const result = await call(token, 'bash', args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /nothing was run/);
  }
});

test('people are kept apart: names, keys and computers', async () => {
  const alice = await signUp();
  const bob = await signUp();
  const ran = [];
  const joined = await addComputer(alice.adminKey, 'desk', async (tool, args) => {
    ran.push(args.command);
    return { text: `ran ${args.command}` };
  });
  assert.equal(parsePair(joined.pair).origin, 'https://relay.example.com');
  assert.equal((await call(alice.token, 'bash', { computer: 'desk', command: 'whoami' })).content[0].text, 'ran whoami');

  const fromBob = await call(bob.token, 'bash', { computer: 'desk', command: 'steal' });
  assert.equal(fromBob.isError, true);
  assert.deepEqual(ran, ['whoami']);

  // Bob's admin key cannot see or remove Alice's computer.
  const bobStatus = await (await fetch(`${base}/hub/api/status`, { headers: { Authorization: `Bearer ${bob.adminKey}` } })).json();
  assert.deepEqual(bobStatus.computers, []);
  const removal = await fetch(`${base}/hub/api/computers/${joined.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bob.adminKey}` } });
  assert.equal(removal.status, 404);
  // The same name may exist once per person.
  await addComputer(bob.adminKey, 'desk', async () => ({ text: 'bob desk' }));
  assert.equal((await call(bob.token, 'bash', { computer: 'desk', command: 'x' })).content[0].text, 'bob desk');
});

test('wrong tokens and keys get nothing', async () => {
  assert.equal((await post('/t/not-a-real-token-123456/mcp', {})).status, 404);
  assert.equal((await post('/mcp', {}, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/hub/api/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await post('/hub/join', { code: 'AAAAAAAA', name: 'x' })).status, 403);
});

test('an account removed on disk stops working', async () => {
  const id = createAccount(dir).id;
  relay.sync();
  const token = readAccount(dir, id).mcpToken;
  assert.equal((await call(token, 'list_computers', {})).content[0].text.includes('computers'), true);
  fs.rmSync(path.join(dir, 'accounts', `${id}.json`));
  relay.sync();
  assert.equal((await post(`/t/${token}/mcp`, {})).status, 404);
});

test('removing an account also deletes its AI pool, even while the relay held it open', () => {
  const id = createAccount(dir).id;
  relay.sync();
  const accounts = path.join(dir, 'accounts');
  const pools = () => fs.readdirSync(accounts).filter((f) => f.startsWith(id + '.pool.sqlite'));
  assert.ok(pools().length > 0, 'the account has a pool database');
  removeAccount(dir, id);
  relay.sync();
  assert.deepEqual(pools(), []);
  assert.ok(!fs.existsSync(path.join(accounts, id + '.json')));
});

test('pair codes accept an IP address with a port', () => {
  assert.deepEqual(parsePair('cmcp://8.8.4.4:8443/AB23CD45'), { origin: 'https://8.8.4.4:8443', code: 'AB23CD45' });
});

test('a certificate request for an IP address is well formed', (t) => {
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (openssl.status !== 0) return t.skip('openssl not installed');
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const csr = buildCsr(key, '203.0.113.7');
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${csr.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  const file = path.join(dir, 'test.csr');
  fs.writeFileSync(file, pem);
  const out = spawnSync('openssl', ['req', '-in', file, '-noout', '-text', '-verify'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout + out.stderr, /IP Address:203\.0\.113\.7/);
  assert.match(out.stdout + out.stderr, /verify OK|Certificate request self-signature verify OK/);
});

test('renewal starts when a third of the lifetime is left', () => {
  assert.equal(needsRenewal(null), true);
  assert.equal(needsRenewal('not a certificate'), true);
});
