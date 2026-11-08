import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-panel-'));
process.env.COMPUTER_MCP_HOME = home;
const { Relay } = await import('../src/relay.mjs');
const { panelHandler, panelToken } = await import('../src/relay-panel.mjs');
const { keyHash, licensesDir, listLicenses } = await import('../src/license.mjs');

let relay;
let server;
let port;
let token;
const dir = path.join(home, 'relay');

before(async () => {
  fs.mkdirSync(dir, { recursive: true });
  server = http.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const config = { host: 'relay.example.com', tls: 'none', origin: 'https://relay.example.com', shared: true, port: 1, panelPort: port };
  relay = new Relay({ dir, config });
  server.on('request', panelHandler(relay, { dir, config }));
  token = panelToken(dir);
});

after(() => {
  relay.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const url = (p) => `http://127.0.0.1:${port}/p/${token}${p}`;
const post = (p, body, headers = {}) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the panel answers only with its token and only to this computer', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/p/wrong-token/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  const page = await fetch(url('/'));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /万机服务端面板/);
  const rebound = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `/p/${token}/api/status`, headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(rebound, 403, 'another Host (DNS rebinding) is refused');
  assert.equal((await post('/api/licenses/create', { buyer: 'x', months: 1 }, { Origin: 'https://evil.example.com' })).status, 403, 'another site cannot make keys');
  const form = await fetch(url('/api/licenses/create'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'buyer=x&months=1' });
  assert.equal(form.status, 415, 'a plain form post is refused');
  assert.equal(listLicenses(licensesDir()).length, 0, 'none of that made a key');
});

test('the panel makes, extends and revokes keys and lists them', async () => {
  assert.equal((await post('/api/licenses/create', { buyer: '', months: 1 })).status, 400);
  assert.equal((await post('/api/licenses/create', { buyer: 'wx-buyer', months: 0 })).status, 400);
  const made = await post('/api/licenses/create', { buyer: 'wx-buyer', months: 2 });
  assert.equal(made.status, 200);
  const { key, expiresAt } = await made.json();
  assert.match(key, /^WANJI-/);
  const id = keyHash(key).slice(0, 8);
  let status = await (await fetch(url('/api/status'))).json();
  const row = status.licenses.find((l) => l.id === id);
  assert.equal(row.buyer, 'wx-buyer');
  assert.equal(row.status, 'active');
  assert.equal(JSON.stringify(status).includes(key), false, 'the status never shows a key');
  const extended = await (await post('/api/licenses/extend', { id, months: 1 })).json();
  assert.equal(Date.parse(extended.expiresAt), Date.parse(expiresAt) + 31 * 86400000);
  assert.equal((await post('/api/licenses/revoke', { id })).status, 200);
  status = await (await fetch(url('/api/status'))).json();
  assert.equal(status.licenses.find((l) => l.id === id).status, 'revoked');
  assert.equal((await post('/api/licenses/extend', { id, months: 1 })).status, 404, 'a revoked key cannot be renewed');
  assert.ok(Array.isArray(status.accounts));
});
