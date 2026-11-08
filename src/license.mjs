import {
  createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.mjs';
import { sendSmtpMail, smtpConfig } from './smtp.mjs';
import { securePrivateFile, writePrivateFile } from './private-file.mjs';
import { consumeRateLimit } from './rate-limit.mjs';

// License keys use the same unambiguous alphabet as pairing codes (no 0/O, 1/I/L).
export const LICENSE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const LICENSE_CACHE_MS = 24 * 60 * 60 * 1000;
export const MAX_MACHINES_PER_KEY = 5;
export const PADDLE_TOLERANCE_MS = 300 * 1000;
export const VERIFY_RATE_WINDOW_MS = 60 * 1000;
export const VERIFY_RATE_IP_MAX = 60;
export const VERIFY_RATE_ACCOUNT_MAX = 10;
// The official relay, which also answers /license/*. Override with --server or
// WANJI_LICENSE_SERVER; a buyer never needs to know it.
export const DEFAULT_LICENSE_SERVER = 'https://wanji-api.3618.app';
// Where Pro accounts live: the same official relay.
export const DEFAULT_RELAY = 'https://wanji-api.3618.app';

// A Pro verdict stays usable this long without reaching the license server.
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// The license server signs every Pro verdict with its Ed25519 key (SPKI DER, base64).
// A computer trusts only verdicts signed by one of these, so editing license.json
// cannot make it Pro.
const LICENSE_PUBLIC_KEYS = [
  // The 2026-11-07 key was deleted with pc-test's old install, so 0.6.9 clients can never be Pro.
  'MCowBQYDK2VwAyEAo3AYu6W2MNCbmX0B9nNtCTZPUcoLZGHgiwAwZcoMZTc=', // official relay (WanjiOfficial on pc-test), made 2026-11-08
];
let trustedKeys = LICENSE_PUBLIC_KEYS;
// Tests sign with a key of their own; nothing in the product calls this.
export function trustLicenseKeysForTesting(keys) {
  trustedKeys = keys;
}

export const licensesDir = (home = homeDir()) => path.join(home, 'licenses');
export const localLicensePath = (home = homeDir()) => path.join(home, 'license.json');
const pendingDir = (home = homeDir()) => path.join(home, 'licenses', 'pending');

const hashBuf = (value) => createHash('sha256').update(String(value)).digest();

export function licenseExpiryTime(value) {
  // License expiries are written with Date.toISOString(). Require that exact UTC
  // representation and round-trip it, because Date.parse normalizes invalid dates.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

function secureServerOrigin(server) {
  let url;
  try { url = new URL(String(server || '')); } catch { throw new Error('license server must be an HTTPS URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('license server must use HTTPS');
  }
  return url.origin;
}
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
  writePrivateFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, licenseFile(dir, hashHex));
}

// The operator issues a key (by hand for now, by Paddle webhook later). The raw key is
// returned once and never stored; the file is named by its hash.
export function createLicense(dir, { email, days = 30, plan = 'pro', subscriptionId = null, sandbox = false } = {}) {
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
      ...(sandbox ? { sandbox: true } : {}),
    };
    writeRecord(dir, keyHash(key), record);
    return { key, record };
  }
  throw new Error('could not make a license key; try again');
}

export function readLicenseByHash(dir, hashHex) {
  try {
    const file = licenseFile(dir, hashHex);
    securePrivateFile(file);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
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

// A full key, or the hash prefix that `relay license list` shows (must match one record).
function resolveLicenseHash(dir, keyOrPrefix) {
  if (validKeyFormat(keyOrPrefix)) return keyHash(keyOrPrefix);
  if (/^[a-f0-9]{8,64}$/.test(String(keyOrPrefix || '').toLowerCase())) {
    const hits = listLicenses(dir).filter((entry) => entry.keyHash.startsWith(String(keyOrPrefix).toLowerCase()));
    return hits.length === 1 ? hits[0].keyHash : null;
  }
  return null;
}

// A renewal paid by hand: the same key runs `days` longer, counted from its current
// expiry, or from now if it has already run out. A revoked key stays revoked.
export function extendLicense(dir, keyOrPrefix, days) {
  const hashHex = resolveLicenseHash(dir, keyOrPrefix);
  if (!hashHex || !Number.isFinite(days) || days <= 0 || days > 3650) return null;
  const record = readLicenseByHash(dir, hashHex);
  if (!record || record.status !== 'active') return null;
  const from = Math.max(Date.now(), licenseExpiryTime(record.expiresAt) || 0);
  record.expiresAt = new Date(from + days * 86400000).toISOString();
  writeRecord(dir, hashHex, record);
  return { keyHash: hashHex, record };
}

export function revokeLicense(dir, keyOrPrefix) {
  const hashHex = resolveLicenseHash(dir, keyOrPrefix);
  if (!hashHex) return null;
  const record = readLicenseByHash(dir, hashHex);
  if (!record) return null;
  record.status = 'revoked';
  writeRecord(dir, hashHex, record);
  return { keyHash: hashHex, record };
}

function extendLicenseBySubscription(dir, subscriptionId, endsAt) {
  const found = findLicenseBySubscription(dir, subscriptionId);
  if (!found || found.record.status !== 'active') return null;
  // A sandbox renewal never runs past SANDBOX_LICENSE_DAYS from now.
  const cap = found.record.sandbox ? Date.now() + SANDBOX_LICENSE_DAYS * 86400000 : Infinity;
  const until = Math.min(Date.parse(endsAt || ''), cap);
  if (Number.isFinite(until)
    && (!Number.isFinite(Date.parse(found.record.expiresAt || '')) || until > Date.parse(found.record.expiresAt))) {
    found.record.expiresAt = new Date(until).toISOString();
  }
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
  if (typeof machineId !== 'string' || !machineId || machineId.length > 128) return { valid: false, reason: 'invalid' };
  const record = readLicense(dir, key);
  if (!record) return { valid: false, reason: 'invalid' };
  if (record.status !== 'active') return { valid: false, reason: 'revoked', expiresAt: record.expiresAt };
  const expires = licenseExpiryTime(record.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return { valid: false, reason: 'expired', expiresAt: record.expiresAt };
  const machines = Array.isArray(record.machines) ? record.machines : [];
  if (!machines.includes(machineId)) {
    if (machines.length >= MAX_MACHINES_PER_KEY) return { valid: false, reason: 'too-many-machines', expiresAt: record.expiresAt };
    machines.push(machineId);
    record.machines = machines;
    writeRecord(dir, keyHash(key), record);
  }
  return { valid: true, plan: record.plan || 'pro', expiresAt: record.expiresAt };
}

// ---- Signed verdicts ----

const signingKeyFile = (dir) => path.join(dir, 'signing-key.pem');

// The license server's Ed25519 key, made on first use and kept beside the license records.
export function licenseSigningKey(dir) {
  const file = signingKeyFile(dir);
  try {
    securePrivateFile(file);
    return createPrivateKey(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  writePrivateFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return privateKey;
}

// What goes into LICENSE_PUBLIC_KEYS for a server's signing key.
export function licensePublicKey(dir) {
  return createPublicKey(licenseSigningKey(dir)).export({ type: 'spki', format: 'der' }).toString('base64');
}

const verdictPayload = ({ keyHash: hashHex, machineId, plan, expiresAt, verifiedAt }) => Buffer.from(
  ['wanji-license-v1', hashHex, machineId, plan, expiresAt, verifiedAt].join('\n'),
);

// Adds the time of the check and a signature over key, machine, plan and expiry.
export function signVerdict(dir, key, machineId, verdict, verifiedAt = new Date().toISOString()) {
  const payload = verdictPayload({ keyHash: keyHash(key), machineId, plan: verdict.plan, expiresAt: verdict.expiresAt, verifiedAt });
  return { ...verdict, machineId, verifiedAt, signature: sign(null, payload, licenseSigningKey(dir)).toString('base64') };
}

export function verdictSignatureOk(local, keys = trustedKeys) {
  if (typeof local?.signature !== 'string' || typeof local.machineId !== 'string') return false;
  const payload = verdictPayload({ keyHash: keyHash(local.key), machineId: local.machineId, plan: local.plan, expiresAt: local.expiresAt, verifiedAt: local.verifiedAt });
  const signature = Buffer.from(local.signature, 'base64');
  return keys.some((der) => {
    try {
      return verify(null, payload, createPublicKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'spki' }), signature);
    } catch {
      return false;
    }
  });
}

export function unbindLicenseMachine(dir, key, machineId) {
  if (!validKeyFormat(key) || typeof machineId !== 'string' || !machineId || machineId.length > 128) {
    return { unbound: false, reason: 'invalid' };
  }
  const record = readLicense(dir, key);
  if (!record) return { unbound: false, reason: 'invalid' };
  const machines = Array.isArray(record.machines) ? record.machines : [];
  if (!machines.includes(machineId)) return { unbound: false, reason: 'not-bound' };
  record.machines = machines.filter((id) => id !== machineId);
  writeRecord(dir, keyHash(key), record);
  return { unbound: true, machinesRemaining: record.machines.length };
}

// Local relays use the license store directly; separate relays query /license/status.
export function licenseActive(dir, hashHex) {
  const record = readLicenseByHash(dir, hashHex);
  if (!record) return { active: false, reason: 'invalid' };
  if (record.status !== 'active') return { active: false, reason: 'revoked', expiresAt: record.expiresAt };
  const expires = licenseExpiryTime(record.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return { active: false, reason: 'expired', expiresAt: record.expiresAt };
  return { active: true, plan: record.plan || 'pro', expiresAt: record.expiresAt };
}

// ---- The key a buyer types, kept on their own computer ----

export function readLocalLicense(home = homeDir()) {
  try {
    const file = localLicensePath(home);
    securePrivateFile(file);
    const local = JSON.parse(fs.readFileSync(file, 'utf8'));
    return local && typeof local === 'object' ? local : null;
  } catch {
    return null;
  }
}

export function saveLocalLicense(home, data) {
  fs.mkdirSync(home, { recursive: true });
  const target = localLicensePath(home);
  const tmp = `${target}.tmp`;
  writePrivateFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

export function removeLocalLicense(home = homeDir()) {
  fs.rmSync(localLicensePath(home), { force: true });
}

export function localLicenseStatus(home = homeDir(), now = Date.now()) {
  const local = readLocalLicense(home);
  if (!local?.key || !validKeyFormat(local.key)) return { plan: 'free', fresh: false };
  const expires = licenseExpiryTime(local.expiresAt);
  const age = now - licenseExpiryTime(local.verifiedAt);
  // Pro only on a verdict the license server signed, checked within the offline grace.
  if (local.plan === 'pro' && expires > now && age < OFFLINE_GRACE_MS && verdictSignatureOk(local)) {
    const fresh = age < LICENSE_CACHE_MS;
    return { plan: 'pro', expiresAt: local.expiresAt, verifiedAt: local.verifiedAt, fresh, stale: !fresh, keyHash: keyHash(local.key), server: local.server || null };
  }
  return { plan: 'free', expiresAt: local.expiresAt || null, verifiedAt: local.verifiedAt || null, fresh: false, keyHash: keyHash(local.key), server: local.server || null };
}

export async function verifyRemote(server, key, machineId) {
  const origin = secureServerOrigin(server);
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

export async function unbindRemote(server, key, machineId) {
  const origin = secureServerOrigin(server);
  const res = await fetch(`${origin}/license/unbind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, machineId }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`license server answered ${res.status}`);
  return body;
}

export async function licenseStatusRemote(server, hashHex) {
  const origin = secureServerOrigin(server);
  const res = await fetch(`${origin}/license/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyHash: hashHex }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`license server answered ${res.status}`);
  return body;
}

// Stores the license server's answer for this computer.
export function saveVerdict(home, local, verdict, server) {
  saveLocalLicense(home, {
    key: local.key, machineId: local.machineId, server,
    plan: verdict.valid ? (verdict.plan || 'pro') : 'free',
    expiresAt: verdict.expiresAt || null,
    verifiedAt: verdict.verifiedAt || new Date().toISOString(),
    signature: verdict.valid ? verdict.signature || null : null,
  });
  return localLicenseStatus(home);
}

// Re-checks the stored key against the license server. A fresh cache is trusted
// without a network call; a network failure keeps the signed verdict for
// OFFLINE_GRACE_MS, so a short outage never locks a paying user out.
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
    if (cached.plan === 'pro') return { ...cached, stale: true, server: target };
    return { plan: 'free', fresh: false, stale: true, error: err.message, keyHash: keyHash(local.key), server: target };
  }
  const status = saveVerdict(home, { key: local.key, machineId }, verdict, target);
  return {
    ...status, fresh: true, stale: false,
    reason: verdict.reason || (verdict.valid && status.plan !== 'pro' ? 'unsigned' : null), server: target,
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

// A Paddle setting from an environment variable, or else a file in the Wanji folder.
function paddleSetting(envName, fileName, env, home) {
  if (env[envName]) return env[envName].trim();
  try {
    const file = path.join(home, fileName);
    securePrivateFile(file);
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// Paddle's live and sandbox accounts sign webhooks with different secrets. Sandbox is
// for test purchases: its licenses are marked and last at most SANDBOX_LICENSE_DAYS,
// so a test card never buys real Pro.
export const SANDBOX_LICENSE_DAYS = 3;
const PADDLE_MODES = {
  live: { secret: ['WANJI_PADDLE_WEBHOOK_SECRET', 'paddle-webhook-secret.txt'], apiKey: ['WANJI_PADDLE_API_KEY', 'paddle-api-key.txt'] },
  sandbox: { secret: ['WANJI_PADDLE_SANDBOX_WEBHOOK_SECRET', 'paddle-sandbox-webhook-secret.txt'], apiKey: ['WANJI_PADDLE_SANDBOX_API_KEY', 'paddle-sandbox-api-key.txt'] },
};

export function paddleSecret(mode = 'live', env = process.env, home = homeDir()) {
  return paddleSetting(...PADDLE_MODES[mode].secret, env, home);
}

// Subscription events carry only customer_id, so the buyer's email is looked up with the API key.
export function paddleApiKey(env = process.env, home = homeDir(), mode = 'live') {
  return paddleSetting(...PADDLE_MODES[mode].apiKey, env, home);
}

// Sandbox mode, or a key containing _sdbx_, uses the sandbox API; WANJI_PADDLE_API_URL overrides both.
export function paddleApiBase(apiKey, env = process.env, mode = 'live') {
  if (env.WANJI_PADDLE_API_URL) return secureServerOrigin(env.WANJI_PADDLE_API_URL);
  return mode === 'sandbox' || /_sdbx_/.test(apiKey) ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

const paddleEmailOf = (data) => data.customer?.email || data.customer_email || null;
const creatingEvent = (type) => type === 'subscription.created' || type === 'subscription.activated';

// Fills data.customer_email on an event that will create a license. Returns false
// when the email is still unknown, so the webhook answers an error and Paddle retries.
export async function fillPaddleEmail(dir, event, { env = process.env, home = homeDir(), fetchImpl = fetch, mode = 'live' } = {}) {
  const data = event?.data;
  if (!creatingEvent(event?.event_type) || !data || typeof data !== 'object' || paddleEmailOf(data)) return true;
  if (findLicenseBySubscription(dir, data.subscription_id || data.id)) return true;
  const apiKey = paddleApiKey(env, home, mode);
  if (!apiKey || typeof data.customer_id !== 'string' || !/^ctm_[a-z0-9]+$/i.test(data.customer_id)) return false;
  try {
    const res = await fetchImpl(`${paddleApiBase(apiKey, env, mode)}/customers/${data.customer_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const email = (await res.json())?.data?.email;
    if (typeof email !== 'string' || !email.trim()) return false;
    data.customer_email = email.trim();
    return true;
  } catch {
    return false;
  }
}

// Only money that actually went back ends a license: an approved full refund or a
// chargeback. A refund request still pending, a rejected one, or a partial credit does not.
const endsLicense = (data) => data.status === 'approved'
  && (data.action === 'chargeback' || (data.action === 'refund' && data.type === 'full'));

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
  writePrivateFile(path.join(pending, `${keyHash(key)}.json`),
    JSON.stringify({ key, email, createdAt: new Date().toISOString() }));
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
      const file = path.join(pendingDir(path.dirname(dir)), f);
      securePrivateFile(file);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export async function deliverPendingLicenses(dir, { env = process.env, send = sendSmtpMail } = {}) {
  const config = smtpConfig(env);
  if (!config) return { configured: false, sent: 0, remaining: listPendingDeliveries(dir).length };
  let sent = 0;
  let failed = 0;
  for (const pending of listPendingDeliveries(dir)) {
    if (typeof pending.email !== 'string' || !pending.email.trim()) { failed += 1; continue; }
    try {
      await send(config, {
        to: pending.email,
        subject: 'Your Wanji Pro license key',
        text: `Thank you for subscribing to Wanji Pro.\n\nYour license key is:\n\n${pending.key}\n\nEnter it once with: wanji license <key>\n\nKeep this key private.`,
      });
      if (clearPendingDelivery(dir, pending.key)) sent += 1;
      else failed += 1;
    } catch {
      // SMTP failure leaves the key in the manual queue for a later retry.
      failed += 1;
    }
  }
  return { configured: true, sent, failed, remaining: listPendingDeliveries(dir).length };
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

// Paddle sends the billing period on transactions and subscriptions under different names.
export function handlePaddleEvent(dir, event, { mode = 'live' } = {}) {
  const type = event?.event_type;
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const subscription = data.subscription && typeof data.subscription === 'object' ? data.subscription : {};
  const email = paddleEmailOf(data);
  const subscriptionId = data.subscription_id || subscription.id || data.id || null;
  const endsAt = data.billing_period?.ends_at || data.current_billing_period?.ends_at
    || subscription.current_billing_period?.ends_at || subscription.billing_period?.ends_at
    || data.next_billed_at || data.ends_at || subscription.next_billed_at || null;
  const daysFrom = (iso) => (iso && Number.isFinite(Date.parse(iso))
    ? Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 86400000)) : 30);
  if (creatingEvent(type)) {
    const existing = findLicenseBySubscription(dir, subscriptionId);
    if (existing) {
      const kept = extendLicenseBySubscription(dir, subscriptionId, endsAt);
      return { handled: true, action: 'extended', keyHash: existing.keyHash, email: kept?.record.email || existing.record.email };
    }
    if (!email) return { handled: false, reason: 'no buyer email in event' };
    const sandbox = mode === 'sandbox';
    const days = sandbox ? Math.min(daysFrom(endsAt), SANDBOX_LICENSE_DAYS) : daysFrom(endsAt);
    const { key, record } = createLicense(dir, { email, days, subscriptionId, sandbox });
    queuePendingDelivery(dir, key, email);
    return { handled: true, action: 'created', keyHash: keyHash(key), email, expiresAt: record.expiresAt };
  }
  if (type === 'transaction.completed' || (type === 'subscription.updated' && data.status === 'active')) {
    const kept = extendLicenseBySubscription(dir, subscriptionId, endsAt);
    if (!kept) return { handled: false, reason: 'no license for this subscription' };
    return { handled: true, action: 'extended', keyHash: kept.keyHash, email: kept.record.email };
  }
  if ((type === 'adjustment.created' || type === 'adjustment.updated') && !endsLicense(data)) {
    return { handled: false, reason: 'adjustment does not end the license' };
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

// ---- HTTP: License Server verification, status, unbind and Paddle webhook routes ----

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// License-endpoint throttling uses the shared limiter in ./rate-limit.mjs (scope 'license-verify'); see handleLicenseHttp.

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
  if ((pathname === '/license/verify' || pathname === '/license/unbind' || pathname === '/license/status') && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req, 16384)).toString('utf8'));
    } catch {
      reply(res, 400, { error: 'invalid JSON' });
      return;
    }
    if (pathname === '/license/status' && !/^[a-f0-9]{64}$/i.test(String(body?.keyHash || ''))) {
      reply(res, 400, { error: 'invalid license hash' });
      return;
    }
    const account = validKeyFormat(body?.key)
      ? keyHash(body.key)
      : (/^[a-f0-9]{64}$/i.test(String(pathname === '/license/status' ? body.keyHash : '')) ? String(body.keyHash).toLowerCase() : null);
    const retryAfter = consumeRateLimit(req, {
      scope: 'license-verify',
      account,
      windowMs: VERIFY_RATE_WINDOW_MS,
      ipMax: VERIFY_RATE_IP_MAX,
      accountMax: VERIFY_RATE_ACCOUNT_MAX,
    });
    if (retryAfter) {
      reply(res, 429, { error: 'too many license requests; try again later' }, { 'Retry-After': String(retryAfter) });
      return;
    }
    if (pathname === '/license/unbind') {
      reply(res, 200, unbindLicenseMachine(dir, body?.key, body?.machineId));
      return;
    }
    if (pathname === '/license/status') {
      reply(res, 200, licenseActive(dir, String(body.keyHash).toLowerCase()));
      return;
    }
    const verdict = verifyLicense(dir, body?.key, body?.machineId);
    reply(res, 200, verdict.valid ? signVerdict(dir, body.key, body.machineId, verdict) : verdict);
    return;
  }
  if (pathname === '/license/webhook' && req.method === 'POST') {
    const secrets = Object.keys(PADDLE_MODES).map((mode) => ({ mode, secret: paddleSecret(mode) })).filter((s) => s.secret);
    if (!secrets.length) {
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
    // Which account sent it follows from which secret signed it.
    const mode = secrets.find((s) => verifyPaddleSignature(raw, req.headers['paddle-signature'], s.secret))?.mode;
    if (!mode) {
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
    if (!(await fillPaddleEmail(dir, event, { mode }))) {
      // A non-2xx answer makes Paddle send the event again later.
      console.error(`Paddle ${mode} ${event?.event_type}: could not look up the buyer email (check the ${mode} API key)`);
      reply(res, 503, { error: 'could not look up the buyer email; retry later' });
      return;
    }
    const result = handlePaddleEvent(dir, event, { mode });
    if (result.handled && smtpConfig()) await deliverPendingLicenses(dir);
    reply(res, 200, { received: true, handled: result.handled, action: result.action || null });
    return;
  }
  reply(res, 404, { error: 'not found' });
}
