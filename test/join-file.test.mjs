import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { joinFilePath, readJoinFileAt } from '../src/config.mjs';
import { joinedConfig } from '../src/cli.mjs';
import { startNodeLink } from '../src/node-link.mjs';
import { createMcpServer } from '../src/server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-joinfile-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-joinfile-home-'));
const TOKEN = 'join-file-test-token';
const previousHome = process.env.COMPUTER_MCP_HOME;
let hub;
let server;
let base;
let adminKey;
const links = [];

before(async () => {
  hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  adminKey = hub.state.adminKey;
  server = createMcpServer({ name: 'main', getToken: () => TOKEN, auditFile: null, hub });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.COMPUTER_MCP_HOME = home;
});

after(() => {
  for (const link of links) link.stop();
  hub.close();
  server.closeAllConnections();
  server.close();
  if (previousHome === undefined) delete process.env.COMPUTER_MCP_HOME;
  else process.env.COMPUTER_MCP_HOME = previousHome;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

async function admin(pathname, method = 'GET', body = null) {
  return fetch(`${base}/hub/api/${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${adminKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('POST /hub/api/computers pre-registers a computer that can connect', async () => {
  const res = await admin('computers', 'POST', { name: 'file-desk' });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.name, 'file-desk');
  assert.equal(created.origin, 'https://hub.example.com');
  assert.match(created.id, /^[0-9a-f]{16}$/);
  assert.equal(typeof created.key, 'string');
  assert.ok(created.key.length > 20);
  links.push(startNodeLink({ origin: base, key: created.key, execute: async () => ({ text: 'ok' }) }));
  for (let i = 0; i < 100 && !hub.isOnline(created.id); i += 1) await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(hub.isOnline(created.id), true);
  assert.equal((await admin(`computers/${created.id}`, 'DELETE')).status, 200);
});

test('POST /hub/api/computers needs the admin key', async () => {
  const res = await fetch(`${base}/hub/api/computers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'nope' }) });
  assert.equal(res.status, 401);
});

test('pre-registering without a name uses computer', async () => {
  const created = await (await admin('computers', 'POST', {})).json();
  assert.equal(created.name, 'computer');
  assert.equal((await admin(`computers/${created.id}`, 'DELETE')).status, 200);
});

test('readJoinFileAt reads a valid join file and returns null when missing', () => {
  const file = path.join(home, 'probe.json');
  assert.equal(readJoinFileAt(file), null);
  const key = 'k'.repeat(43);
  fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com', id: '0123456789abcdef', key, name: 'desk-2' }));
  assert.deepEqual(readJoinFileAt(file), { origin: 'https://hub.example.com', id: '0123456789abcdef', key, name: 'desk-2' });
  fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com', id: '0123456789abcdef', key }));
  assert.equal(readJoinFileAt(file).name, undefined);
  fs.rmSync(file);
});

test('readJoinFileAt rejects invalid join files', () => {
  const file = path.join(home, 'bad.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readJoinFileAt(file), /加入文件无效/);
  fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com', id: 'x' }));
  assert.throws(() => readJoinFileAt(file), /缺少 origin\/id\/key/);
  fs.writeFileSync(file, JSON.stringify({ origin: 'ftp://hub.example.com', id: 'x', key: 'y' }));
  assert.throws(() => readJoinFileAt(file), /http/);
  fs.writeFileSync(file, JSON.stringify({ origin: 'not a url', id: 'x', key: 'y' }));
  assert.throws(() => readJoinFileAt(file), /加入文件无效/);
  fs.rmSync(file);
});

test('joinFilePath is join.json in the config folder', () => {
  assert.equal(joinFilePath(), path.join(home, 'join.json'));
});

test('joinedConfig saves the main computer origin from the join file', () => {
  const key = 'k'.repeat(43);
  const joined = readJoinFileAt((() => {
    const file = path.join(home, 'cfg.json');
    fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com', id: '0123456789abcdef', key, name: 'desk-4' }));
    return file;
  })());
  fs.rmSync(path.join(home, 'cfg.json'));
  const fresh = joinedConfig(null, joined, { port: 8765, proxy: undefined, token: 'new-token' });
  assert.deepEqual(fresh, {
    name: 'desk-4', port: 8765, proxy: undefined, token: 'new-token', joined: { origin: 'https://hub.example.com', id: '0123456789abcdef', key },
  });
  const rejoined = joinedConfig({ token: 'old-token', port: 9000 }, joined, { port: 9000, proxy: 'http://127.0.0.1:7890', token: 'new-token' });
  assert.equal(rejoined.token, 'old-token');
  assert.equal(rejoined.joined.origin, 'https://hub.example.com');
});

test('the service does not read join.json on its own', () => {
  const source = fs.readFileSync(new URL('../src/service.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /readJoinFile|joinFilePath|consumeJoinFile/);
});
