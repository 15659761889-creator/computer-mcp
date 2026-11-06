import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { readJoinFileAt } from '../src/config.mjs';
import { buildJoinerExe } from '../src/cli.mjs';
import { createMcpServer } from '../src/server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-joiner-test-'));
const TOKEN = 'joiner-test-token';
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
let hub;
let server;
let base;
let adminKey;

before(async () => {
  hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  adminKey = hub.state.adminKey;
  server = createMcpServer({ name: 'main', getToken: () => TOKEN, auditFile: null, hub });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  hub.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const admin = (pathname, method = 'GET', body = null) => fetch(`${base}/hub/api/${pathname}`, {
  method,
  headers: { Authorization: `Bearer ${adminKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const joinWith = (code, name) => fetch(`${base}/hub/join`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }),
});

test('a phone pairing code still lasts 10 minutes', async () => {
  const invite = await (await admin('invites', 'POST')).json();
  assert.equal(invite.expiresIn, 600);
  assert.equal(invite.origin, 'https://hub.example.com');
});

test('a joiner code lasts the asked days, at most 30, and works once', async () => {
  const invite = await (await admin('invites', 'POST', { days: 7 })).json();
  assert.equal(invite.expiresIn, 7 * 86400);
  assert.equal((await (await admin('invites', 'POST', { days: 365 })).json()).expiresIn, 30 * 86400);
  const first = await joinWith(invite.code, 'new-desk');
  assert.equal(first.status, 200);
  const created = await first.json();
  assert.equal(created.name, 'new-desk');
  assert.ok(created.key && created.id);
  assert.equal((await joinWith(invite.code, 'again')).status, 403);
  assert.equal((await admin(`computers/${created.id}`, 'DELETE')).status, 200);
});

test('invite --cancel voids unused codes', async () => {
  const invite = await (await admin('invites', 'POST', { days: 7 })).json();
  const res = await (await admin('invites', 'DELETE')).json();
  assert.ok(res.cancelled >= 1);
  assert.equal((await joinWith(invite.code, 'late')).status, 403);
});

test('readJoinFileAt accepts a one-use code instead of id/key', () => {
  const file = path.join(dir, 'code.json');
  fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com', code: 'ABCDEFGH' }));
  assert.deepEqual(readJoinFileAt(file), { origin: 'https://hub.example.com', code: 'ABCDEFGH', name: undefined });
  fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com', code: 'ABCDEFGH', name: 'desk' }));
  assert.equal(readJoinFileAt(file).name, 'desk');
  fs.writeFileSync(file, JSON.stringify({ origin: 'https://hub.example.com' }));
  assert.throws(() => readJoinFileAt(file), /加入文件无效/);
});

// Lists a ZIP's entry names from its central directory.
function zipEntries(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString('utf8').replace(/\\/g, '/'));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

test('buildJoinerExe makes stub + ZIP + footer with only the payload inside', { skip: process.platform !== 'win32' || !fs.existsSync(CSC) }, () => {
  const target = path.join(dir, 'Wanji-Join.exe');
  buildJoinerExe({ join: { origin: 'https://hub.example.com', code: 'ABCDEFGH' }, target });
  const exe = fs.readFileSync(target);
  assert.equal(exe.subarray(0, 2).toString('ascii'), 'MZ');
  const footer = exe.subarray(exe.length - 16);
  assert.equal(footer.subarray(0, 8).toString('ascii'), 'WANJISFX');
  const offset = Number(footer.readBigInt64LE(8));
  assert.equal(exe.readUInt32LE(offset), 0x04034b50);
  const names = zipEntries(exe.subarray(offset, exe.length - 16));
  for (const wanted of ['node.exe', 'bootstrap.cmd', 'join.json', 'app/bin/wanji.mjs', 'app/src/cli.mjs', 'app/package.json']) {
    assert.ok(names.includes(wanted), `missing ${wanted}`);
  }
  assert.ok(!names.some((n) => /stub\.exe$|payload\.zip$/.test(n)), 'build leftovers in the payload');
});

test('the bootstrap runs join once from the extracted copy, with no second autostart', () => {
  const bootstrap = fs.readFileSync(new URL('../src/joiner-bootstrap.cmd', import.meta.url), 'utf8');
  const commands = bootstrap.split(/\r?\n/).filter((line) => line.includes('wanji.mjs'));
  assert.equal(commands.length, 1);
  assert.match(commands[0], /%~dp0node\.exe" "%~dp0app\\bin\\wanji\.mjs" join --file .* --install-runtime --joiner/);
  assert.doesNotMatch(bootstrap, /xcopy|autostart"?\s*$/m);
});
