import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import {
  clearPendingDelivery, createLicense, deliverPendingLicenses, formatKey, generateKey, handleLicenseHttp, handlePaddleEvent,
  keyHash, licenseActive, licensesDir, listLicenses, listPendingDeliveries, localLicenseStatus,
  newMachineId, normalizeKey, readLicense, readLocalLicense, refreshLocalLicense, removeLocalLicense, revokeLicense,
  saveLocalLicense, validKeyFormat, verifyLicense, verifyPaddleSignature, verifyRemote,
} from '../src/license.mjs';
import { createSignup, Relay } from '../src/relay.mjs';
import { joinHub } from '../src/node-link.mjs';
import { createMcpServer } from '../src/server.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-license-'));
process.env.COMPUTER_MCP_HOME = home;
const licDir = licensesDir(home);
const TOKEN = 'license-test-token-abcdefgh';
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();

let verifyServer;
let verifyBase;
let hub;
let hubServer;
let hubBase;
let hubAdmin;
let relay;
let relayServer;
let relayBase;

before(async () => {
  verifyServer = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    handleLicenseHttp(req, res, pathname, licDir);
  });
  await new Promise((resolve) => { verifyServer.listen(0, '127.0.0.1', resolve); });
  verifyBase = `http://127.0.0.1:${verifyServer.address().port}`;

  hub = new Hub({ file: path.join(home, 'hub.json'), selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  hubAdmin = hub.state.adminKey;
  hubServer = createMcpServer({ name: 'main', getToken: () => TOKEN, auditFile: null, hub });
  await new Promise((resolve) => { hubServer.listen(0, '127.0.0.1', resolve); });
  hubBase = `http://127.0.0.1:${hubServer.address().port}`;

  fs.mkdirSync(path.join(home, 'relay'), { recursive: true });
  relay = new Relay({ dir: path.join(home, 'relay'), config: { host: '127.0.0.1', tls: 'none', origin: 'https://relay.example.com', shared: true } });
  relayServer = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve) => { relayServer.listen(0, '127.0.0.1', resolve); });
  relayBase = `http://127.0.0.1:${relayServer.address().port}`;
});

after(() => {
  hub.close();
  hubServer.closeAllConnections();
  hubServer.close();
  relay.close();
  relayServer.closeAllConnections();
  relayServer.close();
  verifyServer.closeAllConnections();
  verifyServer.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function admin(pathname, method = 'GET', body = null) {
  return fetch(`${hubBase}/hub/api/${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${hubAdmin}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function relayPost(pathname, body, key) {
  return fetch(`${relayBase}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

test('keys are random, readable and hard to mistype', () => {
  const key = generateKey();
  assert.match(key, /^WANJI-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.notEqual(generateKey(), key);
  assert.equal(validKeyFormat(key), true);
  assert.equal(validKeyFormat('WANJI-0000-1111-2222-3333'), false, '0, 1 and I are not in the alphabet');
  assert.equal(validKeyFormat('not-a-key'), false);
  assert.equal(formatKey(normalizeKey(`  ${key.toLowerCase()} `)), key, 'spaces, case and dashes are forgiven on entry');
  assert.match(keyHash(key), /^[a-f0-9]{64}$/);
  assert.equal(keyHash(key), keyHash(key.toLowerCase().replaceAll('-', '')));
  assert.match(newMachineId(), /^[a-f0-9]{16}$/);
});

test('the store creates, reads, lists and revokes keys', () => {
  const { key, record } = createLicense(licDir, { email: 'buyer@example.com', days: 30 });
  assert.equal(record.email, 'buyer@example.com');
  assert.equal(record.plan, 'pro');
  assert.equal(record.status, 'active');
  assert.equal(record.machines.length, 0);
  assert.equal(readLicense(licDir, key).email, 'buyer@example.com');
  assert.ok(listLicenses(licDir).some((entry) => entry.record.email === 'buyer@example.com'));
  const revoked = revokeLicense(licDir, key);
  assert.equal(revoked.record.status, 'revoked');
  assert.equal(readLicense(licDir, key).status, 'revoked');
  const second = createLicense(licDir, { email: 'second@example.com', days: 7 });
  const byPrefix = revokeLicense(licDir, keyHash(second.key).slice(0, 8));
  assert.equal(byPrefix.record.email, 'second@example.com');
  assert.equal(revokeLicense(licDir, 'deadbeef'), null, 'an unknown prefix revokes nothing');
});

test('verify binds machines and refuses the rest', () => {
  const { key } = createLicense(licDir, { email: 'verify@example.com', days: 30 });
  assert.deepEqual(verifyLicense(licDir, key, 'm1'), { valid: true, plan: 'pro', expiresAt: readLicense(licDir, key).expiresAt });
  assert.equal(verifyLicense(licDir, key, 'm1').valid, true);
  assert.equal(readLicense(licDir, key).machines.length, 1, 'the same machine is not counted twice');
  for (const m of ['m2', 'm3', 'm4', 'm5']) assert.equal(verifyLicense(licDir, key, m).valid, true);
  assert.deepEqual(verifyLicense(licDir, key, 'm6'), { valid: false, reason: 'too-many-machines', expiresAt: readLicense(licDir, key).expiresAt });
  assert.equal(verifyLicense(licDir, generateKey(), 'm1').reason, 'invalid', 'an unknown key is invalid');
  assert.equal(verifyLicense(licDir, 'garbage', 'm1').reason, 'invalid');
  assert.equal(licenseActive(licDir, keyHash(key)).active, true);
  revokeLicense(licDir, key);
  assert.equal(verifyLicense(licDir, key, 'm1').reason, 'revoked');
  assert.equal(licenseActive(licDir, keyHash(key)).reason, 'revoked');
  const { key: expiring } = createLicense(licDir, { email: 'expired@example.com', days: 30 });
  const file = path.join(licDir, `${keyHash(expiring)}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(verifyLicense(licDir, expiring, 'm1').reason, 'expired');
  assert.equal(licenseActive(licDir, keyHash(expiring)).reason, 'expired');
});

test('missing, malformed and normalized expiry dates never activate a license', () => {
  for (const value of [undefined, null, '', 'not-a-date', '2026-02-30T00:00:00.000Z', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00.000+00:00']) {
    const { key } = createLicense(licDir, { email: 'bad-expiry@example.com', days: 30 });
    const file = path.join(licDir, `${keyHash(key)}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === undefined) delete record.expiresAt;
    else record.expiresAt = value;
    fs.writeFileSync(file, JSON.stringify(record));
    assert.equal(verifyLicense(licDir, key, 'm1').reason, 'expired', `verify rejects expiry ${String(value)}`);
    assert.equal(licenseActive(licDir, keyHash(key)).active, false, `relay access rejects expiry ${String(value)}`);

    const gated = new Hub({
      file: path.join(home, `bad-gate-${String(value).replace(/[^a-z0-9]/gi, '-')}.json`),
      selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => TOKEN,
      state: {
        adminKey: 'bad-expiry-test', computers: { joined: { id: 'joined', name: 'joined' } }, invites: [],
        license: { plan: 'pro', expiresAt: value },
      },
    });
    try {
      assert.equal(gated.isPro(), false, `Hub rejects expiry ${String(value)}`);
      assert.equal(gated.canAddComputer(), false, `Hub gate rejects expiry ${String(value)}`);
    } finally { gated.close(); }
  }
});

test('the license verify endpoint answers without a login', async () => {
  const { key } = createLicense(licDir, { email: 'http@example.com', days: 30 });
  const ok = await fetch(`${verifyBase}/license/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, machineId: 'http-m1' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).valid, true);
  const bad = await fetch(`${verifyBase}/license/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: generateKey(), machineId: 'http-m1' }),
  });
  assert.equal((await bad.json()).reason, 'invalid');
  assert.equal((await fetch(`${verifyBase}/license/verify`)).status, 404, 'GET is not a verify');
  assert.equal((await fetch(`${verifyBase}/license/webhook`, { method: 'POST', body: '{}' })).status, 503, 'the webhook stays off until a secret is configured');
  const verdict = await verifyRemote(verifyBase, key, 'http-m1');
  assert.equal(verdict.valid, true);
  assert.equal(verdict.plan, 'pro');
});

test('the local license caches for a day and re-checks against the server', async () => {
  const { key } = createLicense(licDir, { email: 'cache@example.com', days: 30 });
  const machineId = newMachineId();
  saveLocalLicense(home, { key, machineId, server: verifyBase, plan: 'pro', expiresAt: FUTURE, verifiedAt: new Date().toISOString() });
  const fresh = localLicenseStatus(home);
  assert.equal(fresh.plan, 'pro');
  assert.equal(fresh.fresh, true);
  assert.equal(readLocalLicense(home).key, key);
  const stale = localLicenseStatus(home, Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(stale.fresh, false, 'older than 24h is not fresh');
  assert.equal(stale.plan, 'pro', 'an unexpired cached Pro verdict stays active while it is rechecked');
  assert.equal(stale.stale, true, 'a stale Pro verdict is clearly marked for rechecking');
  saveLocalLicense(home, { key, machineId, server: verifyBase, plan: 'pro', expiresAt: FUTURE, verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
  const refreshed = await refreshLocalLicense(home);
  assert.equal(refreshed.plan, 'pro');
  assert.equal(refreshed.fresh, true);
  assert.ok(Date.parse(readLocalLicense(home).verifiedAt) > Date.now() - 60 * 1000);
  saveLocalLicense(home, { key, machineId, server: verifyBase, plan: 'pro', expiresAt: FUTURE, verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
  const offline = await refreshLocalLicense(home, { server: 'http://127.0.0.1:1' });
  assert.equal(offline.plan, 'pro', 'a dead server keeps the unexpired verdict');
  assert.equal(offline.stale, true);
});

test('a free hub refuses a second computer, a Pro hub lets it join, and the invite is not burned', async () => {
  hub.state.license = null;
  hub.save();
  const first = hub.createInvite();
  assert.equal(hub.join({ code: first.code, name: 'c1' }).status, 200, 'free allows the first computer');
  const second = hub.createInvite();
  const refused = hub.join({ code: second.code, name: 'c2' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Pro/);
  assert.equal(hub.join({ code: second.code, name: 'c2' }).status, 403, 'the same invite still refuses while free');
  hub.state.license = { keyHash: '0'.repeat(64), plan: 'pro', expiresAt: FUTURE, verifiedAt: new Date().toISOString() };
  hub.save();
  assert.equal(hub.join({ code: second.code, name: 'c2' }).status, 200, 'Pro allows the second computer');
  const status = await (await admin('status')).json();
  assert.equal(status.license.plan, 'pro');
});

test('the hub pre-register and license refresh routes follow the same rule', async () => {
  removeLocalLicense(home);
  hub.state.license = null;
  hub.save();
  const blocked = await admin('computers', 'POST', { name: 'pre-reg' });
  assert.equal(blocked.status, 403, 'free cannot pre-register another computer');
  const refreshed = await admin('license/refresh', 'POST');
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).license.plan, 'free', 'no local license means free');
  const { key } = createLicense(licDir, { email: 'hub-refresh@example.com', days: 30 });
  saveLocalLicense(home, { key, machineId: newMachineId(), server: verifyBase, plan: 'pro', expiresAt: FUTURE, verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
  const pro = await admin('license/refresh', 'POST');
  assert.equal((await pro.json()).license.plan, 'pro', 'refresh re-checks and upgrades the hub');
  const allowed = await admin('computers', 'POST', { name: 'pre-reg-pro' });
  assert.ok(allowed.status < 300, `Pro can pre-register, got ${allowed.status}`);
});

test('Paddle signatures verify and events create, extend and revoke', () => {
  const secret = 'whsec-test-secret';
  const event = {
    event_type: 'subscription.created',
    data: {
      customer: { email: 'paddle@example.com' },
      subscription_id: 'sub_test_1',
      current_billing_period: { ends_at: FUTURE },
    },
  };
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const h1 = createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
  const sig = `ts=${ts};h1=${h1}`;
  assert.equal(verifyPaddleSignature(raw, sig, secret), true);
  assert.equal(verifyPaddleSignature(raw, sig, 'wrong-secret'), false);
  assert.equal(verifyPaddleSignature(raw, `ts=${ts};h1=${'0'.repeat(64)}`, secret), false);
  assert.equal(verifyPaddleSignature('tampered', sig, secret), false);
  assert.equal(verifyPaddleSignature(raw, `ts=${Math.floor(Date.now() / 1000) - 3600};h1=${h1}`, secret), false, 'an hour-old signature is stale');
  const created = handlePaddleEvent(licDir, event);
  assert.equal(created.handled, true);
  assert.equal(created.action, 'created');
  assert.equal(created.email, 'paddle@example.com');
  assert.equal(listPendingDeliveries(licDir).length, 1, 'the new key waits to be emailed');
  const again = handlePaddleEvent(licDir, event);
  assert.equal(again.action, 'extended');
  assert.equal(again.keyHash, created.keyHash, 'a repeated event does not make a second key');
  assert.equal(listPendingDeliveries(licDir).length, 1);
  const completed = handlePaddleEvent(licDir, { event_type: 'transaction.completed', data: { subscription_id: 'sub_test_1', current_billing_period: { ends_at: FUTURE } } });
  assert.equal(completed.action, 'extended');
  const canceled = handlePaddleEvent(licDir, { event_type: 'subscription.canceled', data: { subscription_id: 'sub_test_1' } });
  assert.equal(canceled.action, 'revoked');
  assert.equal(handlePaddleEvent(licDir, { event_type: 'something.else', data: {} }).handled, false);
  const pending = listPendingDeliveries(licDir);
  assert.equal(clearPendingDelivery(licDir, pending[0].key), true);
  assert.equal(listPendingDeliveries(licDir).length, 0);
});

test('SMTP license delivery is opt-in and clears the manual queue only after success', async () => {
  const created = handlePaddleEvent(licDir, {
    event_type: 'subscription.created',
    data: { customer: { email: 'smtp-buyer@example.com' }, subscription_id: 'sub_smtp_1', current_billing_period: { ends_at: FUTURE } },
  });
  assert.equal(created.handled, true);
  const [pending] = listPendingDeliveries(licDir);
  assert.ok(pending?.key);

  let sent = [];
  const disabled = await deliverPendingLicenses(licDir, { env: {}, send: async () => { throw new Error('must stay disabled'); } });
  assert.equal(disabled.configured, false);
  assert.equal(disabled.remaining, 1, 'without SMTP settings the manual queue is untouched');

  const env = {
    WANJI_SMTP_HOST: 'smtp.example.com', WANJI_SMTP_PORT: '465',
    WANJI_SMTP_USER: 'mailer@example.com', WANJI_SMTP_PASSWORD: 'test-only-password',
    WANJI_SMTP_FROM: 'billing@example.com',
  };
  const delivered = await deliverPendingLicenses(licDir, { env, send: async (config, message) => { sent.push({ config, message }); } });
  assert.deepEqual({ configured: delivered.configured, sent: delivered.sent, failed: delivered.failed, remaining: delivered.remaining }, { configured: true, sent: 1, failed: 0, remaining: 0 });
  assert.equal(sent[0].config.secure, true);
  assert.equal(sent[0].message.to, 'smtp-buyer@example.com');
  assert.ok(sent[0].message.text.includes(pending.key));

  handlePaddleEvent(licDir, {
    event_type: 'subscription.created',
    data: { customer: { email: 'retry-buyer@example.com' }, subscription_id: 'sub_smtp_retry', current_billing_period: { ends_at: FUTURE } },
  });
  const failed = await deliverPendingLicenses(licDir, { env, send: async () => { throw new Error('smtp unavailable'); } });
  assert.equal(failed.failed, 1);
  assert.equal(failed.remaining, 1, 'a failed delivery remains available for retry or manual sending');
});

test('the Paddle webhook needs its secret and a good signature', async () => {
  const secret = 'whsec-test-secret';
  const event = { event_type: 'subscription.created', data: { customer: { email: 'webhook@example.com' }, subscription_id: 'sub_webhook_1', current_billing_period: { ends_at: FUTURE } } };
  const raw = JSON.stringify(event);
  const res = await fetch(`${verifyBase}/license/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
  assert.equal(res.status, 503, 'no secret configured');
  process.env.WANJI_PADDLE_WEBHOOK_SECRET = secret;
  try {
    const bad = await fetch(`${verifyBase}/license/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': 'ts=1;h1=00' }, body: raw });
    assert.equal(bad.status, 401, 'a bad signature is refused');
    const ts = String(Math.floor(Date.now() / 1000));
    const h1 = createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
    const good = await fetch(`${verifyBase}/license/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': `ts=${ts};h1=${h1}` }, body: raw });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).action, 'created');
  } finally {
    delete process.env.WANJI_PADDLE_WEBHOOK_SECRET;
  }
});

test('a relay account from a license key works until the key is revoked', async () => {
  const { key } = createLicense(licDir, { email: 'relay-buyer@example.com', days: 30 });
  const first = await relayPost('/relay/signup', { licenseKey: key, machineId: 'buyer-pc' });
  assert.equal(first.status, 200);
  const { adminKey } = await first.json();
  const again = await relayPost('/relay/signup', { licenseKey: key, machineId: 'buyer-phone' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).adminKey, adminKey, 'the same key returns the same account');
  const badKey = await relayPost('/relay/signup', { licenseKey: generateKey(), machineId: 'x' });
  assert.equal(badKey.status, 403);
  const status = await (await fetch(`${relayBase}/hub/api/status`, { headers: { Authorization: `Bearer ${adminKey}` } })).json();
  assert.equal(status.license.plan, 'pro');
  const invite = await (await relayPost('/hub/api/invites', {}, adminKey)).json();
  const joined = await joinHub({ origin: relayBase, code: invite.code, name: 'buyer-pc' });
  assert.ok(joined.id, 'a Pro account can add a computer');
  revokeLicense(licDir, key);
  const afterRevoke = await fetch(`${relayBase}/hub/api/status`, { headers: { Authorization: `Bearer ${adminKey}` } });
  assert.equal(afterRevoke.status, 402, 'a revoked license stops the account at once');
  const mcp = await relayPost(`/t/${status.mcp.key}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(mcp.status, 402, 'a revoked license stops MCP too');
  const { code } = createSignup(path.join(home, 'relay'));
  const operator = await relayPost('/relay/signup', { code });
  assert.equal(operator.status, 200);
  const opAdmin = (await operator.json()).adminKey;
  const opStatus = await fetch(`${relayBase}/hub/api/status`, { headers: { Authorization: `Bearer ${opAdmin}` } });
  assert.equal(opStatus.status, 200, 'an operator-made account needs no license');
});
