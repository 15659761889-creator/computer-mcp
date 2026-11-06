import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { startLanServer } from '../src/lan.mjs';
import { joinHub, startNodeLink } from '../src/node-link.mjs';
import { createMcpServer } from '../src/server.mjs';
import { Transfers, handleXferLan, isXferTool, runXfer, xferPsk } from '../src/transfer.mjs';

// One main computer and simulated joined computers in this process, each with a real LAN port on 127.0.0.1.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-lan-'));
const TOKEN = 'lan-test-token-abcdefgh';
const closers = [];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function makeHub(name, { lan = true } = {}) {
  const hub = new Hub({ file: path.join(dir, `${name}.json`), selfName: name, origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  // These tests exercise multi-computer features, which are Pro: give the test hub a license.
  hub.state.license = { keyHash: '0'.repeat(64), plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString(), verifiedAt: new Date().toISOString() };
  hub.save();
  hub.transfers = new Transfers({ hub, file: path.join(dir, `${name}.transfers.json`) });
  if (lan) {
    const server = await startLanServer({
      port: 0,
      host: '127.0.0.1',
      pskFor: (id) => (id.startsWith('n:') ? hub.lanPsk(id) : xferPsk(id)),
      handle: (req, res, id) => (id.startsWith('t:') ? handleXferLan(req, res, id) : hub.handleLan(req, res, id)),
    });
    hub.lan = { port: server.address().port, addrs: () => ['127.0.0.1'] };
    closers.push(() => { server.closeAllConnections(); server.close(); });
  }
  const server = createMcpServer({ name, getToken: () => TOKEN, auditFile: null, hub });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  closers.push(() => { hub.close(); server.closeAllConnections(); server.close(); });
  return { hub, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, name, args) {
  const res = await fetch(`${base}/t/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

async function admin(main, pathname, method = 'GET', body) {
  const res = await fetch(`${main.base}/hub/api/${pathname}`, {
    method, headers: { Authorization: `Bearer ${main.hub.state.adminKey}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return res.json();
}

async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

// A joined computer: its own LAN port for copies, and a link to the main computer.
async function addComputer(main, name, { route = 'auto', lanPort } = {}) {
  const invite = await admin(main, 'invites', 'POST');
  const joined = await joinHub({ origin: main.base, code: invite.code, name });
  if (route !== 'auto') await admin(main, `computers/${joined.id}`, 'PATCH', { route });
  const server = await startLanServer({ port: 0, host: '127.0.0.1', pskFor: xferPsk, handle: handleXferLan });
  closers.push(() => { server.closeAllConnections(); server.close(); });
  const port = lanPort ?? server.address().port;
  const link = startNodeLink({
    origin: main.base, key: joined.key, id: joined.id, route,
    lanSelf: () => ({ addrs: ['127.0.0.1'], port }),
    findHub: async () => [],
    lanRetryMs: 1500,
    execute: async (tool, args) => (isXferTool(tool) ? runXfer(tool, args) : { text: `${name} ran ${tool}` }),
  });
  closers.push(() => link.stop());
  return { ...joined, link };
}

const statusOf = async (main, name) => (await admin(main, 'status')).computers.find((c) => c.name === name);

function tree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    if (content === null) {
      fs.mkdirSync(file, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const big = randomBytes(20 * 1024 * 1024 + 123);

let main;
let desk;
let laptop;

before(async () => {
  main = await makeHub('main');
  desk = await addComputer(main, 'desk');
  laptop = await addComputer(main, 'laptop');
  await until(async () => (await statusOf(main, 'desk')).via === 'lan' && (await statusOf(main, 'laptop')).via === 'lan', 'both computers on the LAN');
});

after(() => {
  for (const close of closers.reverse()) close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('in auto, a computer on the same network talks to the main one over the LAN', async () => {
  const status = await statusOf(main, 'desk');
  assert.equal(status.route, 'auto');
  assert.equal(status.via, 'lan');
  assert.equal((await call(main.base, 'bash', { computer: 'desk', command: 'x' })).content[0].text, 'desk ran bash');
  const listed = JSON.parse((await call(main.base, 'list_computers', {})).content[0].text).computers.find((c) => c.name === 'desk');
  assert.equal(listed.connection, 'lan');
});

test('switching a computer to public moves it to the internet at once, and back', async () => {
  await admin(main, `computers/${desk.id}`, 'PATCH', { route: 'public' });
  await until(async () => (await statusOf(main, 'desk')).via === 'public', 'desk on the internet', 4000);
  assert.equal((await call(main.base, 'bash', { computer: 'desk', command: 'x' })).content[0].text, 'desk ran bash');
  await admin(main, `computers/${desk.id}`, 'PATCH', { route: 'auto' });
  await until(async () => (await statusOf(main, 'desk')).via === 'lan', 'desk back on the LAN', 4000);
});

test('a bad route is refused', async () => {
  assert.match((await admin(main, `computers/${desk.id}`, 'PATCH', { route: 'wifi' })).error, /auto, lan or public/);
});

test('LAN only fails loudly when there is no LAN, and can be switched back from the phone', async () => {
  const cloud = await makeHub('cloud', { lan: false });
  const pc = await addComputer(cloud, 'pc', { route: 'lan' });
  await until(async () => (await statusOf(cloud, 'pc')).lanProblem, 'the LAN problem to be reported');
  const status = await statusOf(cloud, 'pc');
  assert.equal(status.online, false);
  const reply = await call(cloud.base, 'bash', { computer: 'pc', command: 'x' });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /LAN only.*no LAN address/);
  await admin(cloud, `computers/${pc.id}`, 'PATCH', { route: 'auto' });
  // The LAN-only computer asks over the internet whether its route changed (each minute; 1.5 s here).
  await until(async () => (await statusOf(cloud, 'pc')).online, 'pc to come back over the internet');
  assert.equal((await statusOf(cloud, 'pc')).via, 'public');
});

test('a folder goes from the main computer to another over the LAN, checked', async () => {
  const src = path.join(dir, 'src1');
  tree(src, { 'a.txt': 'hello', 'sub/deep/b.bin': big, 'empty.txt': '', 'nothing/': null, '中文 名.txt': '你好' });
  const dest = path.join(dir, 'out1', 'copy');
  const reply = await call(main.base, 'transfer', { from: 'main', from_path: src, to: 'desk', to_path: dest });
  assert.equal(reply.isError, undefined, reply.content[0].text);
  assert.match(reply.content[0].text, /done[\s\S]*over the LAN, every file checked with SHA-256/);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello');
  assert.equal(sha(path.join(dest, 'sub/deep/b.bin')), sha(path.join(src, 'sub/deep/b.bin')));
  assert.equal(fs.readFileSync(path.join(dest, 'empty.txt')).length, 0);
  assert.ok(fs.statSync(path.join(dest, 'nothing')).isDirectory());
  assert.equal(fs.readFileSync(path.join(dest, '中文 名.txt'), 'utf8'), '你好');
  assert.equal(fs.existsSync(`${dest}.cmcp-part`), false);
});

test('two joined computers copy to each other directly', async () => {
  const src = path.join(dir, 'single.bin');
  fs.writeFileSync(src, big);
  const dest = path.join(dir, 'out2', 'single.bin');
  const reply = await call(main.base, 'transfer', { from: 'desk', from_path: src, to: 'laptop', to_path: dest });
  assert.match(reply.content[0].text, /done[\s\S]*over the LAN/);
  assert.equal(sha(dest), sha(src));
});

test('route public goes through the main computer in pieces', async () => {
  const src = path.join(dir, 'src3');
  tree(src, { 'big.bin': big, 'small/1.txt': '1', 'small/2.txt': '2', 'zero.txt': '' });
  const dest = path.join(dir, 'out3');
  const reply = await call(main.base, 'transfer', { from: 'laptop', from_path: src, to: 'main', to_path: dest, route: 'public' });
  assert.match(reply.content[0].text, /done[\s\S]*over the internet/);
  assert.equal(sha(path.join(dest, 'big.bin')), sha(path.join(src, 'big.bin')));
  assert.equal(fs.readFileSync(path.join(dest, 'small/2.txt'), 'utf8'), '2');
  assert.equal(fs.readFileSync(path.join(dest, 'zero.txt')).length, 0);
});

test('an existing destination is an error unless overwrite, which merges a folder', async () => {
  const src = path.join(dir, 'src4');
  tree(src, { 'new.txt': 'new', 'same.txt': 'from source' });
  const dest = path.join(dir, 'out4');
  tree(dest, { 'keep.txt': 'kept', 'same.txt': 'old' });
  const refused = await call(main.base, 'transfer', { from: 'main', from_path: src, to: 'desk', to_path: dest });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /already exists; nothing was copied/);
  const merged = await call(main.base, 'transfer', { from: 'main', from_path: src, to: 'desk', to_path: dest, overwrite: true });
  assert.match(merged.content[0].text, /done/);
  assert.equal(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(path.join(dest, 'same.txt'), 'utf8'), 'from source');
  assert.equal(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'new');
});

test('a chosen LAN route that cannot work is an error; auto falls back and says so', async () => {
  const deaf = await addComputer(main, 'deaf', { lanPort: 1 });
  await until(async () => (await statusOf(main, 'deaf')).online, 'deaf online');
  const src = path.join(dir, 'deaf.txt');
  fs.writeFileSync(src, 'over the internet');
  const forced = await call(main.base, 'transfer', { from: 'deaf', from_path: src, to: 'desk', to_path: path.join(dir, 'out5', 'a.txt'), route: 'lan' });
  assert.equal(forced.isError, true);
  assert.match(forced.content[0].text, /chosen route lan failed, nothing was copied: desk cannot reach deaf over the LAN: 127\.0\.0\.1:1/);
  assert.equal(fs.existsSync(path.join(dir, 'out5', 'a.txt')), false);
  const auto = await call(main.base, 'transfer', { from: 'deaf', from_path: src, to: 'desk', to_path: path.join(dir, 'out5', 'a.txt') });
  assert.match(auto.content[0].text, /done[\s\S]*over the internet[\s\S]*note: not over the LAN/);
  assert.equal(fs.readFileSync(path.join(dir, 'out5', 'a.txt'), 'utf8'), 'over the internet');
});

test('a partial copy is resumed, and a wrong one is caught by the hash and redone', async () => {
  const src = path.join(dir, 'resume.bin');
  fs.writeFileSync(src, big);
  const good = path.join(dir, 'out6', 'good.bin');
  fs.mkdirSync(path.dirname(good), { recursive: true });
  fs.writeFileSync(`${good}.cmcp-part`, big.subarray(0, 5 * 1024 * 1024));
  const resumed = await call(main.base, 'transfer', { from: 'main', from_path: src, to: 'laptop', to_path: good });
  assert.match(resumed.content[0].text, /done/);
  assert.equal(sha(good), sha(src));

  const bad = path.join(dir, 'out6', 'bad.bin');
  fs.writeFileSync(`${bad}.cmcp-part`, randomBytes(5 * 1024 * 1024));
  const redone = await call(main.base, 'transfer', { from: 'main', from_path: src, to: 'laptop', to_path: bad, route: 'public' });
  assert.match(redone.content[0].text, /done/);
  assert.equal(sha(bad), sha(src));
});

test('a long transfer replies with an id and can be checked', async () => {
  const src = path.join(dir, 'later.bin');
  fs.writeFileSync(src, big);
  const started = await call(main.base, 'transfer', { from: 'main', from_path: src, to: 'desk', to_path: path.join(dir, 'out7', 'later.bin'), wait: 0 });
  const id = /transfer ([a-f0-9]+):/.exec(started.content[0].text)[1];
  const checked = await call(main.base, 'transfer', { id, wait: 30 });
  assert.match(checked.content[0].text, new RegExp(`transfer ${id}: done`));
  assert.match((await call(main.base, 'transfer', {})).content[0].text, new RegExp(id));
});

test('a missing source or computer copies nothing', async () => {
  assert.match((await call(main.base, 'transfer', { from: 'main', from_path: path.join(dir, 'nope'), to: 'desk', to_path: path.join(dir, 'x') })).content[0].text, /does not exist/);
  assert.match((await call(main.base, 'transfer', { from: 'main', from_path: dir, to: 'ghost', to_path: dir })).content[0].text, /no computer named "ghost"/);
  assert.match((await call(main.base, 'transfer', { from: 'desk', from_path: dir, to: 'desk', to_path: dir })).content[0].text, /same computer/);
});
