import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.mjs';

// License keys use the same unambiguous alphabet as pairing codes (no 0/O, 1/I/L).
// 16 characters = 80 bits; brute force is infeasible, so v1 has no rate limiting.
export const LICENSE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const LICENSE_CACHE_MS = 24 * 60 * 60 * 1000;
export const MAX_MACHINES_PER_KEY = 5;
export const PADDLE_TOLERANCE_MS = 300 * 1000;
// v1 license server: the owner's hub, already public. Override with --server or
// WANJI_LICENSE_SERVER; a buyer never needs to know it, it is in the Paddle email.
export const DEFAULT_LICENSE_SERVER = 'https://pc-test-mcp.3618.app';

export const licensesDir = (home = homeDir()) => path.join(home, 'licenses');
export const localLicensePath = (home = homeDir()) => path.join(home, 'license.json');
const pendingDir = (home = homeDir()) => path.join(home, 'licenses', 'pending');

const hashBuf = (value) => createHash('sha256').update(String(value)).digest();
export const keyHash = (key) => hashBuf(normalizeKey(key)).toString('hex');

export function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  const stripped = key.replace(/[\s-]/g, '').toUpperCase();
  // The WANJI prefix is only a label: 'I' is not in the key alphabet, so a real
  // 16-character key can never start with it, and stripping it is unambiguous.
  return stripped.startsWith('WANJI') ? stripped.slice(5) : stripped;
}

export function validKeyFormat(key) {
  const norm = normalizeKey(key);
  return norm.length === 16 && [...norm].every((c) => LICENSE_ALPHABET.includes(c));
}

export function formatKey(normalized) {
  return `WANJI-${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}`;
}

export function generateKey() {
  let raw = '';
  for (const byte of randomBytes(16)) raw += LICENSE_ALPHABET[byte % LICENSE_ALPHABET.length];
  return formatKey(raw);
}

export function newMachineId() {
  return randomBytes(8).toString('hex');
}

const licenseFile = (dir, hashHex) => path.join(dir, `${hashHex}.json`);

function writeRecord(dir, hashHex, record) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${licenseFile(dir, hashHex)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, licenseFile(dir, hashHex));
}

// The operator issues a key (by hand for now, by Paddle webhook later). The raw key is
// returned once and never stored; the file is named by its hash.
export function createLicense(dir, { email, days = 30, plan = 'pro', subscriptionId = null } = {}) {
  if (typeof email !== 'string' || !email.trim() || email.length > 120) throw new Error('a buyer email is required');
  const nDays = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 30;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const key = generateKey();
    const file = licenseFile(dir, keyHash(key));
    if (fs.existsSync(file)) continue;
    const now = new Date();
    const record = {
      email: email.trim(),
      plan,
      status: 'active',
      subscriptionId: subscriptionId || null,
      expiresAt: new Date(now.getTime() + nDays * 86400000).toISOString(),
      createdAt: now.toISOString(),
      machines: [],
    };
    writeRecord(dir, keyHash(key), record);
    return { key, record };
  }
  throw new Error('could not make a license key; try again');
}

export function readLicenseByHash(dir, hashHex) {
  try {
    const record = JSON.parse(fs.readFileSync(licenseFile(dir, hashHex), 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

export function readLicense(dir, key) {
  if (!validKeyFormat(key)) return null;
  return readLicenseByHash(dir, keyHash(key));
}

export function listLicenses(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => ({ keyHash: f.slice(0, -5), record: readLicenseByHash(dir, f.slice(0, -5)) }))
    .filter((entry) => entry.record)
    .sort((a, b) => String(b.record.createdAt || '').localeCompare(String(a.record.createdAt || '')));
}

export function findLicenseBySubscription(dir, subscriptionId) {
  if (!subscriptionId) return null;
  return listLicenses(dir).find((entry) => entry.record.subscriptionId === subscriptionId) || null;
}

export function revokeLicense(dir, keyOrPrefix) {
  let hashHex = null;
  if (validKeyFormat(keyOrPrefix)) {
    hashHex = keyHash(keyOrPrefix);
  } else if (/^[a-f0-9]{8,64}$/.test(String(keyOrPrefix || '').toLowerCase())) {
    const hits = listLicenses(dir).filter((entry) => entry.keyHash.startsWith(String(keyOrPrefix).toLowerCase()));
    if (hits.length !== 1) return null;
    hashHex = hits[0].keyHash;
  } else {
    return null;
  }
  const record = readLicenseByHash(dir, hashHex);
  if (!record) return null;
  record.status = 'revoked';
  writeRecord(dir, hashHex, record);
  return { keyHash: hashHex, record };
}

function extendLicenseBySubscription(dir, subscriptionId, endsAt) {
  const found = findLicenseBySubscription(dir, subscriptionId);
  if (!found || found.record.status !== 'active') return null;
  if (endsAt && Number.isFinite(Date.parse(endsAt))) found.record.expiresAt = new Date(endsAt).toISOString();
  writeRecord(dir, found.keyHash, found.record);
  return found;
}

function revokeLicenseBySubscription(dir, subscriptionId) {
  const found = findLicenseBySubscription(dir, subscriptionId);
  if (!found) return null;
  found.record.status = 'revoked';
  writeRecord(dir, found.keyHash, found.record);
  return found;
}

// The license server's check. A successful check binds the machine (first 5).
export function verifyLicense(dir, key, machineId) {
  if (!validKeyFormat(key)) return { valid: false, reason: 'invalid' };
  if (typeof machineId !== 'string' || !machineId) return { valid: false, reason: 'invalid' };
  const record = readLicense(dir, key);
  if (!record) return { valid: false, reason: 'invalid' };
  if (record.status !== 'active') return { valid: false, reason: 'revoked', expiresAt: record.expiresAt };
  if (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) return { valid: false, reason: 'expired', expiresAt: record.expiresAt };
  const machines = Array.isArray(record.machines) ? record.machines : [];
  if (!machines.includes(machineId)) {
    if (machines.length >= MAX_MACHINES_PER_KEY) return { valid: false, reason: 'too-many-machines', expiresAt: record.expiresAt };
    machines.push(machineId);
    record.machines = machines;
    writeRecord(dir, keyHash(key), record);
  }
  return { valid: true, plan: record.plan || 'pro', expiresAt: record.expiresAt };
}

// What the relay checks on every request for a license-linked account: the store is
// the source of truth, so a revoke takes effect at once.
export function licenseActive(dir, hashHex) {
  const record = readLicenseByHash(dir, hashHex);
  if (!record) return { active: false, reason: 'invalid' };
  if (record.status !== 'active') return { active: false, reason: 'revoked', expiresAt: record.expiresAt };
  if (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) return { active: false, reason: 'expired', expiresAt: record.expiresAt };
  return { active: true, plan: record.plan || 'pro', expiresAt: record.expiresAt };
}

// ---- The key a buyer types, kept on their own computer ----

export function readLocalLicense(home = homeDir()) {
  try {
    const local = JSON.parse(fs.readFileSync(localLicensePath(home), 'utf8'));
    return local && typeof local === 'object' ? local : null;
  } catch {
    return null;
  }
}

export function saveLocalLicense(home, data) {
  fs.mkdirSync(home, { recursive: true });
  const target = localLicensePath(home);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function removeLocalLicense(home = homeDir()) {
  fs.rmSync(localLicensePath(home), { force: true });
}

export function localLicenseStatus(home = homeDir(), now = Date.now()) {
  const local = readLocalLicense(home);
  if (!local?.key || !validKeyFormat(local.key)) return { plan: 'free', fresh: false };
  const expires = Date.parse(local.expiresAt || '');
  const verified = Date.parse(local.verifiedAt || '');
  if (local.plan === 'pro' && Number.isFinite(expires) && expires > now
    && Number.isFinite(verified) && now - verified < LICENSE_CACHE_MS) {
    return { plan: 'pro', expiresAt: local.expiresAt, verifiedAt: local.verifiedAt, fresh: true, keyHash: keyHash(local.key), server: local.server || null };
  }
  return { plan: 'free', expiresAt: local.expiresAt || null, verifiedAt: local.verifiedAt || null, fresh: false, keyHash: keyHash(local.key), server: local.server || null };
}

export async function verifyRemote(server, key, machineId) {
  const origin = String(server || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(origin)) throw new Error('license server must be an http(s) URL');
  const res = await fetch(`${origin}/license/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, machineId }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`license server answered ${res.status}`);
  return body;
}

// Re-checks the stored key against the license server. A fresh cache is trusted
// without a network call; a network failure keeps the cached verdict while it
// has not expired, so a short outage never locks a paying user out.
export async function refreshLocalLicense(home = homeDir(), { server } = {}) {
  const local = readLocalLicense(home);
  if (!local?.key || !validKeyFormat(local.key)) return { plan: 'free', fresh: false };
  const cached = localLicenseStatus(home);
  if (cached.fresh) return cached;
  const target = server || local.server || process.env.WANJI_LICENSE_SERVER || DEFAULT_LICENSE_SERVER;
  const machineId = local.machineId || newMachineId();
  let verdict;
  try {
    verdict = await verifyRemote(target, local.key, machineId);
  } catch (err) {
    if (local.plan === 'pro' && local.expiresAt && Date.parse(local.expiresAt) > Date.now()) {
      return { plan: 'pro', expiresAt: local.expiresAt, verifiedAt: local.verifiedAt, fresh: false, stale: true, keyHash: keyHash(local.key), server: target };
    }
    return { plan: 'free', fresh: false, stale: true, error: err.message, keyHash: keyHash(local.key), server: target };
  }
  const now = new Date().toISOString();
  saveLocalLicense(home, {
    ...local, machineId, server: target,
    plan: verdict.valid ? (verdict.plan || 'pro') : 'free',
    expiresAt: verdict.expiresAt || null, verifiedAt: now,
  });
  return {
    plan: verdict.valid ? (verdict.plan || 'pro') : 'free',
    expiresAt: verdict.expiresAt || null, verifiedAt: now, fresh: true,
    reason: verdict.reason || null, keyHash: keyHash(local.key), server: target,
  };
}

// Writes the refreshed verdict onto a hub's state (what Hub.isPro reads).
export async function refreshHubLicense(hub, home = homeDir()) {
  const verdict = await refreshLocalLicense(home);
  if (verdict.plan === 'pro') {
    hub.state.license = { keyHash: verdict.keyHash, plan: 'pro', expiresAt: verdict.expiresAt, verifiedAt: verdict.verifiedAt };
  } else {
    hub.state.license = null;
  }
  hub.save();
  return verdict;
}

// ---- Paddle webhook (entry point; inert until the secret is configured) ----

export function paddleSecret() {
  return process.env.WANJI_PADDLE_WEBHOOK_SECRET || '';
}

// Paddle-Signature: ts=<unix>;h1=<hex>; HMAC-SHA256 over `ts:rawBody`.
export function verifyPaddleSignature(rawBody, header, secret, now = Date.now()) {
  if (!secret || typeof header !== 'string') return false;
  const fields = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const ts = Number(fields.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > PADDLE_TOLERANCE_MS) return false;
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${fields.ts}:`), raw])).digest();
  return header.split(';').filter((p) => p.trim().startsWith('h1=')).map((p) => p.trim().slice(3))
    .some((h) => /^[a-f0-9]{64}$/.test(h) && timingSafeEqual(Buffer.from(h, 'hex'), expected));
}

// Keys the webhook makes still need to reach the buyer by email (no mail provider
// in v1). They wait in licenses/pending/ for the operator: `wanji relay license
// pending` shows them, `wanji relay license sent <key>` clears one after emailing.
export function queuePendingDelivery(dir, key, email) {
  const pending = pendingDir(path.dirname(dir));
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, `${keyHash(key)}.json`),
    JSON.stringify({ key, email, createdAt: new Date().toISOString() }), { mode: 0o600 });
}

export function listPendingDeliveries(dir) {
  let files = [];
  try {
    files = fs.readdirSync(pendingDir(path.dirname(dir))).filter((f) => /^[a-f0-9]{64}\.json$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pendingDir(path.dirname(dir)), f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function clearPendingDelivery(dir, keyOrPrefix) {
  let hashHex = null;
  if (validKeyFormat(keyOrPrefix)) hashHex = keyHash(keyOrPrefix);
  else if (/^[a-f0-9]{8,64}$/.test(String(keyOrPrefix || '').toLowerCase())) {
    const hits = listPendingDeliveries(dir).map((p) => keyHash(p.key)).filter((h) => h.startsWith(String(keyOrPrefix).toLowerCase()));
    if (hits.length !== 1) return false;
    hashHex = hits[0];
  } else return false;
  const file = path.join(pendingDir(path.dirname(dir)), `${hashHex}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// Paddle event shapes are read defensively: the fields we need have moved between
// API versions, so every lookup has a fallback and a missing expiry means 30 days.
export function handlePaddleEvent(dir, event) {
  const type = event?.event_type;
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const email = data.customer?.email || data.customer_email || null;
  const subscriptionId = data.subscription_id || data.id || null;
  const endsAt = data.current_billing_period?.ends_at || data.next_billed_at || data.ends_at || null;
  const daysFrom = (iso) => (iso && Number.isFinite(Date.parse(iso))
    ? Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 86400000)) : 30);
  if (type === 'subscription.created' || type === 'subscription.activated') {
    if (!email) return { handled: false, reason: 'no buyer email in event' };
    const existing = findLicenseBySubscription(dir, subscriptionId);
    if (existing) {
      const kept = extendLicenseBySubscription(dir, subscriptionId, endsAt);
      return { handled: true, action: 'extended', keyHash: existing.keyHash, email: kept?.record.email || existing.record.email };
    }
    const { key, record } = createLicense(dir, { email, days: daysFrom(endsAt), subscriptionId });
    queuePendingDelivery(dir, key, email);
    return { handled: true, action: 'created', keyHash: keyHash(key), email, expiresAt: record.expiresAt };
  }
  if (type === 'transaction.completed') {
    const kept = extendLicenseBySubscription(dir, subscriptionId, endsAt);
    if (!kept) return { handled: false, reason: 'no license for this subscription' };
    return { handled: true, action: 'extended', keyHash: kept.keyHash, email: kept.record.email };
  }
  if (type === 'subscription.canceled'
    || (type === 'subscription.updated' && data.status === 'canceled')
    || type === 'adjustment.created' || type === 'adjustment.updated') {
    const gone = revokeLicenseBySubscription(dir, subscriptionId);
    if (!gone) return { handled: false, reason: 'no license for this subscription' };
    return { handled: true, action: 'revoked', keyHash: gone.keyHash, email: gone.record.email };
  }
  return { handled: false, reason: 'ignored event type' };
}

// ---- HTTP: the license server's two routes ----

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handleLicenseHttp(req, res, pathname, dir = licensesDir()) {
  if (pathname === '/license/verify' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req, 16384)).toString('utf8'));
    } catch {
      reply(res, 400, { error: 'invalid JSON' });
      return;
    }
    reply(res, 200, verifyLicense(dir, body?.key, body?.machineId));
    return;
  }
  if (pathname === '/license/webhook' && req.method === 'POST') {
    const secret = paddleSecret();
    if (!secret) {
      reply(res, 503, { error: 'license webhook is not configured yet; set WANJI_PADDLE_WEBHOOK_SECRET' });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, 262144);
    } catch (err) {
      reply(res, err.status || 400, { error: err.message || 'bad request' });
      return;
    }
    if (!verifyPaddleSignature(raw, req.headers['paddle-signature'], secret)) {
      reply(res, 401, { error: 'bad signature' });
      return;
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      reply(res, 400, { error: 'invalid JSON' });
      return;
    }
    const result = handlePaddleEvent(dir, event);
    reply(res, 200, { received: true, handled: result.handled, action: result.action || null });
    return;
  }
  reply(res, 404, { error: 'not found' });
}
