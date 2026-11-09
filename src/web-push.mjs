import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { securePrivateFile, writePrivateFile } from './private-file.mjs';

// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payloads (RFC 8291), so the
// iPhone web app gets notifications through Apple's push service. No dependency.

// Apple refuses a VAPID subject that is not a real https: or mailto: URL.
const SUBJECT = 'https://wanji.3618.app';
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function vapidPath(home) {
  return path.join(home, 'web-push-vapid.json');
}

// One key pair per server; subscriptions are tied to its public key, so it is kept.
export function loadVapid(file) {
  try {
    securePrivateFile(file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.publicKey && saved.privateKey) return saved;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFile(file, `${JSON.stringify(keys, null, 2)}\n`);
  return keys;
}

function vapidSigningKey(vapid) {
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

export function vapidHeader(endpoint, vapid, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT }));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: vapidSigningKey(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${vapid.publicKey}`;
}

// RFC 8291: one aes128gcm record, encrypted to the browser's p256dh key and auth secret.
export function encryptPayload(subscription, payload, { salt = randomBytes(16), serverEcdh } = {}) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const ecdh = serverEcdh || createECDH('prime256v1');
  if (!serverEcdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

export function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || !sub.keys) return false;
  let url;
  try { url = new URL(sub.endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const p256dh = Buffer.from(String(sub.keys.p256dh || ''), 'base64url');
  const auth = Buffer.from(String(sub.keys.auth || ''), 'base64url');
  return p256dh.length === 65 && p256dh[0] === 4 && auth.length === 16;
}

// Resolves to 'ok', 'gone' (drop the subscription) or 'failed'.
export async function sendPush(subscription, message, vapid, { fetchImpl = fetch } = {}) {
  const payload = JSON.stringify(message).slice(0, MAX_PAYLOAD);
  try {
    const res = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(subscription.endpoint, vapid),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '600',
        Urgency: 'high',
        ...(message.tag ? { Topic: String(message.tag).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'wanji' } : {}),
      },
      body: encryptPayload(subscription, payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
