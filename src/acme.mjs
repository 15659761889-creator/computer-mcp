import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { securePrivateFile, writePrivateFile } from './private-file.mjs';

// A small ACME client (RFC 8555) for one certificate: a domain or, with Let's Encrypt's
// short-lived profile, a bare IP address, so a rented server needs no domain at all.

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const b64u = (data) => Buffer.from(data).toString('base64url');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---- Minimal DER, enough for a certificate signing request ----

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const octets = (data) => der(0x04, data);

function oid(text) {
  const [a, b, ...rest] = text.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let n = value >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  const halves = ip.split('::');
  const words = (part) => (part ? part.split(':').map((w) => parseInt(w, 16)) : []);
  const head = words(halves[0]);
  const tail = halves.length > 1 ? words(halves[1]) : [];
  const all = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  const out = Buffer.alloc(16);
  all.forEach((word, i) => out.writeUInt16BE(word, i * 2));
  return out;
}

export function buildCsr(certKey, identifier) {
  const spki = certKey.publicKey.export({ type: 'spki', format: 'der' });
  // SAN entries: [2] dNSName or [7] iPAddress.
  const name = net.isIP(identifier) ? der(0x87, ipBytes(identifier)) : der(0x82, Buffer.from(identifier));
  const extension = seq(oid('2.5.29.17'), octets(seq(name)));
  const attributes = der(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(seq(extension))));
  const info = seq(der(0x02, Buffer.from([0])), seq(), spki, attributes);
  const signature = sign('sha256', info, certKey.privateKey);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), der(0x03, Buffer.from([0]), signature));
}

// ---- Protocol ----

class AcmeClient {
  constructor(directoryUrl, accountKey) {
    this.directoryUrl = directoryUrl;
    this.key = accountKey;
    const { crv, kty, x, y } = accountKey.publicKey.export({ format: 'jwk' });
    this.jwk = { crv, kty, x, y };
    this.thumbprint = b64u(createHash('sha256').update(JSON.stringify(this.jwk)).digest());
    this.nonce = null;
    this.kid = null;
  }

  async init() {
    this.directory = await (await fetch(this.directoryUrl)).json();
  }

  async newNonce() {
    const res = await fetch(this.directory.newNonce, { method: 'HEAD' });
    return res.headers.get('replay-nonce');
  }

  async post(url, payload, { retry = true } = {}) {
    const nonce = this.nonce || await this.newNonce();
    this.nonce = null;
    const header = { alg: 'ES256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
    const protectedPart = b64u(JSON.stringify(header));
    const payloadPart = payload === undefined ? '' : b64u(JSON.stringify(payload));
    const signature = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`), { key: this.key.privateKey, dsaEncoding: 'ieee-p1363' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json' },
      body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: b64u(signature) }),
    });
    this.nonce = res.headers.get('replay-nonce');
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      if (retry && body?.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, { retry: false });
      throw new Error(`certificate authority refused ${new URL(url).pathname}: ${body?.detail || res.status}`);
    }
    return { body, location: res.headers.get('location') };
  }

  async account() {
    const { location } = await this.post(this.directory.newAccount, { termsOfServiceAgreed: true });
    this.kid = location;
  }

  async poll(url, done, what) {
    for (let i = 0; i < 60; i += 1) {
      const { body } = await this.post(url, undefined);
      if (body.status === 'invalid') throw new Error(`${what} failed: ${JSON.stringify(body.error || body.challenges?.find((c) => c.error)?.error || body)}`);
      if (done(body)) return body;
      await sleep(2000);
    }
    throw new Error(`${what} timed out`);
  }
}

// Gets a certificate for identifier. setChallenge(token, keyAuthorization) must make
// http://identifier/.well-known/acme-challenge/<token> answer keyAuthorization.
export async function obtainCertificate({ directoryUrl = LETS_ENCRYPT, identifier, accountKeyPem, setChallenge, log = () => {} }) {
  // Reusing the account key keeps one account instead of creating one per renewal.
  const privateKey = accountKeyPem ? createPrivateKey(accountKeyPem) : null;
  const accountKey = privateKey
    ? { privateKey, publicKey: createPublicKey(privateKey) }
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const client = new AcmeClient(directoryUrl, accountKey);
  await client.init();
  await client.account();

  const isIp = net.isIP(identifier) !== 0;
  const offered = Object.keys(client.directory.meta?.profiles || {});
  // IP certificates exist only as short-lived ones.
  const profile = isIp && offered.includes('shortlived') ? 'shortlived' : undefined;
  log(`requesting a certificate for ${identifier}${profile ? ` (${profile})` : ''}`);
  const order = await client.post(client.directory.newOrder, {
    identifiers: [{ type: isIp ? 'ip' : 'dns', value: identifier }],
    ...(profile ? { profile } : {}),
  });

  for (const authzUrl of order.body.authorizations) {
    const { body: authz } = await client.post(authzUrl, undefined);
    if (authz.status === 'valid') continue;
    const challenge = authz.challenges.find((c) => c.type === 'http-01');
    if (!challenge) throw new Error('the certificate authority offered no http-01 challenge');
    setChallenge(challenge.token, `${challenge.token}.${client.thumbprint}`);
    await client.post(challenge.url, {});
    await client.poll(authzUrl, (body) => body.status === 'valid', 'the ownership check on port 80');
  }

  const certKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await client.post(order.body.finalize, { csr: b64u(buildCsr(certKey, identifier)) });
  const final = await client.poll(order.location, (body) => body.status === 'valid', 'issuing the certificate');
  const { body: cert } = await client.post(final.certificate, undefined);
  return {
    cert,
    key: certKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    accountKey: accountKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// Renews when less than a third of the lifetime is left, which suits both 6-day and 90-day certificates.
export function needsRenewal(certPem, now = Date.now()) {
  if (!certPem) return true;
  try {
    const cert = new X509Certificate(certPem);
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    return to - now < (to - from) / 3;
  } catch {
    return true;
  }
}

export function certPaths(dir) {
  return {
    cert: path.join(dir, 'cert.pem'),
    key: path.join(dir, 'key.pem'),
    account: path.join(dir, 'acme-account.pem'),
  };
}

export function readCert(dir) {
  const files = certPaths(dir);
  try {
    securePrivateFile(files.key);
    if (fs.existsSync(files.account)) securePrivateFile(files.account);
    return { cert: fs.readFileSync(files.cert, 'utf8'), key: fs.readFileSync(files.key, 'utf8') };
  } catch {
    return null;
  }
}

export function writeCert(dir, { cert, key, accountKey }) {
  const files = certPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  writePrivateFile(files.key, key);
  fs.writeFileSync(files.cert, cert);
  if (accountKey) writePrivateFile(files.account, accountKey);
}
