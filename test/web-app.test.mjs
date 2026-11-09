import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { createMcpServer } from '../src/server.mjs';
import { encryptPayload, loadVapid, sendPush, validSubscription, vapidHeader } from '../src/web-push.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-webapp-'));
const TOKEN = 'webapp-test-token-abcdefgh';
let hub;
let server;
let base;

const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

// The browser's side of RFC 8291, written independently of the sender.
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint: 'https://push.example.com/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
function browserDecrypt({ ecdh, auth }, body) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipherText = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const shared = ecdh.computeSecret(asPublic);
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipherText.subarray(-16));
  const plain = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString('utf8');
}

before(async () => {
  hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  hub.vapid = loadVapid(path.join(dir, 'vapid.json'));
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

const admin = (pathname, method = 'GET', body) => fetch(`${base}/hub/api/${pathname}`, {
  method,
  headers: { Authorization: `Bearer ${hub.state.adminKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('push payload decrypts on the browser side', () => {
  const b = browserKeys();
  const message = JSON.stringify({ title: 'AI 想输入密码', body: 'GitHub · zzcts5pro' });
  assert.equal(browserDecrypt(b, encryptPayload(b.subscription, message)), message);
});

test('push encryption matches RFC 8291 Appendix A byte for byte', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const body = encryptPayload(
    { keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
    'When I grow up, I want to be a watermelon',
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), serverEcdh: ecdh },
  );
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID header is a valid ES256 JWT for the endpoint origin', () => {
  const vapid = loadVapid(path.join(dir, 'vapid2.json'));
  assert.deepEqual(loadVapid(path.join(dir, 'vapid2.json')), vapid, 'keys are kept, not regenerated');
  const header = vapidHeader('https://web.push.apple.com/QGx/abc', vapid);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, vapid.publicKey);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.match(claims.sub, /^https:\/\//);
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('sendPush posts aes128gcm and reports gone subscriptions', async () => {
  const b = browserKeys();
  const vapid = loadVapid(path.join(dir, 'vapid.json'));
  let seen;
  const ok = await sendPush(b.subscription, { title: 't', body: 'b', tag: 'secret-1' }, vapid, {
    fetchImpl: async (url, init) => { seen = { url, init }; return { status: 201, ok: true }; },
  });
  assert.equal(ok, 'ok');
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.Topic, 'secret-1');
  assert.deepEqual(JSON.parse(browserDecrypt(b, seen.init.body)), { title: 't', body: 'b', tag: 'secret-1' });
  assert.equal(await sendPush(b.subscription, { title: 'x' }, vapid, { fetchImpl: async () => ({ status: 410, ok: false }) }), 'gone');
  assert.equal(await sendPush(b.subscription, { title: 'x' }, vapid, { fetchImpl: async () => { throw new Error('down'); } }), 'failed');
});

test('subscriptions: validated, saved, deduplicated, removed', async () => {
  assert.equal(validSubscription({ endpoint: 'http://insecure/x', keys: browserKeys().subscription.keys }), false);
  assert.equal((await admin('push/key')).status, 200);
  assert.equal((await (await admin('push/key')).json()).publicKey, hub.vapid.publicKey);
  assert.equal((await admin('push/subscribe', 'POST', { subscription: { endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  const { subscription } = browserKeys();
  assert.equal((await admin('push/subscribe', 'POST', { subscription, device: 'iPhone' })).status, 200);
  assert.equal((await admin('push/subscribe', 'POST', { subscription, device: 'iPhone' })).status, 200);
  assert.equal(hub.state.webPush.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'hub.json'), 'utf8')).webPush.length, 1, 'persisted');
  assert.equal((await (await admin('push/unsubscribe', 'POST', { endpoint: subscription.endpoint })).json()).removed, 1);
  assert.equal(hub.state.webPush.length, 0);
  const unauth = await fetch(`${base}/hub/api/push/key`);
  assert.equal(unauth.status, 401);
});

test('notify sends to every device and drops gone ones', async () => {
  const live = browserKeys();
  const dead = browserKeys();
  dead.subscription.endpoint = 'https://push.example.com/dead';
  hub.state.webPush = [{ ...live.subscription }, { ...dead.subscription }];
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/dead')) return { status: 410, ok: false };
    bodies.push(init.body);
    return { status: 201, ok: true };
  };
  try {
    assert.equal(await hub.notify({ title: 'hi', body: 'there' }), 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(JSON.parse(browserDecrypt(live, bodies[0])).title, 'hi');
  assert.deepEqual(hub.state.webPush.map((s) => s.endpoint), [live.subscription.endpoint]);
  hub.state.webPush = [];
});

test('two phones keep separate account lists', async () => {
  await admin('vault-meta', 'POST', { entries: [{ id: 'a1', label: 'GitHub', username: 'droid' }] });
  await admin('vault-meta', 'POST', { device: 'web-1234', entries: [{ id: 'a1', label: 'Mail', username: 'ios' }] });
  assert.deepEqual(hub.vaultAccountList().map((a) => a.label), ['GitHub', 'Mail']);
  await admin('vault-meta', 'POST', { device: 'web-1234', entries: [] });
  assert.deepEqual(hub.vaultAccountList().map((a) => a.username), ['droid']);
  await admin('vault-meta', 'POST', { entries: [] });
});

test('the web app is served with a strict CSP and nothing outside /app/', async () => {
  const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  const page = await fetch(`${base}/app/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /<script src="app.js"/);
  for (const name of ['app.js', 'app.css', 'sw.js', 'manifest.webmanifest', 'icon-180.png']) {
    assert.equal((await fetch(`${base}/app/${name}`)).status, 200, name);
  }
  assert.equal((await fetch(`${base}/app/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/app/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/app/`, { method: 'POST' })).status, 405);
});
