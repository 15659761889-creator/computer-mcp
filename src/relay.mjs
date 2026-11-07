import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { LETS_ENCRYPT, LETS_ENCRYPT_STAGING, needsRenewal, obtainCertificate, readCert, certPaths, writeCert } from './acme.mjs';
import { homeDir } from './config.mjs';
import { Hub, loadHubState } from './hub.mjs';
import { Transfers, transfersFile } from './transfer.mjs';
import { sendJson, serveMcp } from './server.mjs';
import { handleLicenseHttp, keyHash, licenseActive, licenseStatusRemote, licensesDir, validKeyFormat, verifyLicense, verifyRemote } from './license.mjs';
import { consumeRateLimit } from './rate-limit.mjs';
import { securePrivateFile, writePrivateFile } from './private-file.mjs';

// A relay is a hub on a rented server: it has no machine of its own, every computer connects
// out to it, and it holds one account per person. Self-hosted, it holds exactly one.

const SYNC_MS = 5000;
const RENEW_CHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_CERT_MS = 10 * 60 * 1000;
const SIGNUP_DAYS = 7;
const REMOTE_LICENSE_CACHE_MS = 60 * 1000;

const hash = (value) => createHash('sha256').update(String(value)).digest();
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(hash(a), hash(b));
const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];

// Shared relays require a paid license. A separate relay refreshes status from the
// License Server periodically and uses the last known expiry during a short outage.
const relayAccountOk = async (hub, shared, cache) => {
  const link = hub.state.license;
  if (!link?.keyHash) return !shared;
  if (link.server) {
    const now = Date.now();
    const cached = cache.get(link.keyHash);
    if (cached && now - cached.checkedAt < REMOTE_LICENSE_CACHE_MS) return cached.active;
    try {
      const verdict = await licenseStatusRemote(link.server, link.keyHash);
      const active = verdict.active === true;
      if (active && verdict.expiresAt && verdict.expiresAt !== link.expiresAt) {
        link.expiresAt = verdict.expiresAt;
        hub.save();
      }
      cache.set(link.keyHash, { active, checkedAt: now });
      return active;
    } catch {
      return Number.isFinite(Date.parse(link.expiresAt)) && Date.parse(link.expiresAt) > now;
    }
  }
  return licenseActive(licensesDir(), link.keyHash).active;
};

export const relayDir = () => path.join(homeDir(), 'relay');
const configFile = (dir) => path.join(dir, 'relay.json');
const accountsDir = (dir) => path.join(dir, 'accounts');
const signupsDir = (dir) => path.join(dir, 'signups');

export function loadRelayConfig(dir = relayDir()) {
  try {
    securePrivateFile(configFile(dir));
    return JSON.parse(fs.readFileSync(configFile(dir), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function saveRelayConfig(config, dir = relayDir()) {
  fs.mkdirSync(dir, { recursive: true });
  writePrivateFile(configFile(dir), `${JSON.stringify(config, null, 2)}\n`);
}

export function relayOrigin(config) {
  if (config.origin) return config.origin.replace(/\/$/, '');
  const port = config.httpsPort && config.httpsPort !== 443 ? `:${config.httpsPort}` : '';
  return `https://${config.host}${port}`;
}

export function listAccounts(dir = relayDir()) {
  try {
    return fs.readdirSync(accountsDir(dir)).filter((f) => /^[a-f0-9]{8,}\.json$/.test(f)).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export function accountFile(dir, id) {
  return path.join(accountsDir(dir), `${id}.json`);
}

export function createAccount(dir = relayDir(), label = '') {
  const id = randomBytes(6).toString('hex');
  const file = accountFile(dir, id);
  fs.mkdirSync(accountsDir(dir), { recursive: true });
  const state = loadHubState(file);
  state.mcpToken = randomBytes(32).toString('base64url');
  state.label = label;
  state.createdAt = new Date().toISOString();
  writePrivateFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return { id, adminKey: state.adminKey };
}

export function readAccount(dir, id) {
  const file = accountFile(dir, id);
  securePrivateFile(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function removeAccount(dir, id) {
  fs.rmSync(accountFile(dir, id), { force: true });
  fs.rmSync(transfersFile(accountFile(dir, id)), { force: true });
  // Chat pool databases from versions before 0.6.1.
  for (const end of ['', '-wal', '-shm', '-journal']) fs.rmSync(accountFile(dir, id).replace(/\.json$/, `.pool.sqlite${end}`), { force: true });
}

// One file per code, so the CLI adding codes and the service using them never write the same file.
export function createSignup(dir = relayDir(), licenseKey) {
  if (!validKeyFormat(licenseKey)) throw new Error('a valid license key is required for a shared-relay invite');
  const code = randomBytes(12).toString('base64url');
  fs.mkdirSync(signupsDir(dir), { recursive: true });
  const file = path.join(signupsDir(dir), `${hash(code).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ expires: Date.now() + SIGNUP_DAYS * 86400000, licenseKey }), { mode: 0o600 });
  return { code, days: SIGNUP_DAYS };
}

export function appLink(config, adminKey) {
  return `wanji://${new URL(relayOrigin(config)).host}/${adminKey}`;
}

export function signupLink(config, code) {
  return `wanji://${new URL(relayOrigin(config)).host}/signup/${code}`;
}

export class Relay {
  constructor({ dir = relayDir(), config, log = () => {} }) {
    this.dir = dir;
    this.config = config;
    this.log = log;
    this.hubs = new Map();
    this.challenges = new Map();
    this.licenseSignups = new Set();
    this.licenseStatusCache = new Map();
    this.sync();
    this.syncer = setInterval(() => this.sync(), SYNC_MS);
    this.syncer.unref();
  }

  close() {
    clearInterval(this.syncer);
    for (const hub of this.hubs.values()) hub.close();
  }

  origin() {
    return relayOrigin(this.config);
  }

  // Accounts are files the CLI may add or delete while the service runs.
  sync() {
    const ids = new Set(listAccounts(this.dir));
    for (const [id, hub] of this.hubs) {
      if (!ids.has(id)) {
        hub.close();
        this.hubs.delete(id);
      }
    }
    for (const id of ids) {
      if (this.hubs.has(id)) continue;
      try {
        const hub = new Hub({ file: accountFile(this.dir, id), origin: () => this.origin(), getToken: () => hub.state.mcpToken });
        hub.transfers = new Transfers({ hub, file: transfersFile(accountFile(this.dir, id)) });
        this.hubs.set(id, hub);
      } catch (err) {
        this.log(`account ${id} could not be loaded: ${err.message}`);
      }
    }
  }

  hubBy(test) {
    for (const hub of this.hubs.values()) if (test(hub)) return hub;
    return null;
  }

  async signup(code, machineId) {
    if (typeof code !== 'string' || !code) return null;
    const file = path.join(signupsDir(this.dir), `${hash(code).toString('hex')}.json`);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (entry.expires < Date.now() || !validKeyFormat(entry.licenseKey)) {
      fs.rmSync(file, { force: true });
      return null;
    }
    const result = await this.signupWithLicense(entry.licenseKey, machineId);
    if (result && !result.error) fs.rmSync(file, { force: true });
    return result;
  }

  // A license can create one relay account, but cannot recover that account's admin key.
  async signupWithLicense(key, machineId) {
    if (!validKeyFormat(key)) return { error: 'invalid' };
    const hashHex = keyHash(key);
    if (this.licenseSignups.has(hashHex)
      || listAccounts(this.dir).some((id) => readAccount(this.dir, id).license?.keyHash === hashHex)) {
      return { error: 'already-registered' };
    }
    this.licenseSignups.add(hashHex);
    try {
      const server = this.config.licenseServer || process.env.WANJI_LICENSE_SERVER || null;
      const boundMachine = machineId || `relay:${this.config.host}`;
      let verdict;
      try {
        verdict = server
          ? await verifyRemote(server, key, boundMachine)
          : verifyLicense(licensesDir(), key, boundMachine);
      } catch {
        return { error: 'license-server-unavailable' };
      }
      if (!verdict.valid) return { error: verdict.reason || 'invalid' };
      const account = createAccount(this.dir);
      const state = readAccount(this.dir, account.id);
      state.license = {
        keyHash: hashHex, plan: verdict.plan || 'pro', expiresAt: verdict.expiresAt,
        ...(server ? { server } : {}),
      };
      writePrivateFile(accountFile(this.dir, account.id), `${JSON.stringify(state, null, 2)}\n`);
      this.sync();
      return account;
    } finally {
      this.licenseSignups.delete(hashHex);
    }
  }

  async handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (pathname === '/license/verify' || pathname === '/license/unbind' || pathname === '/license/status' || pathname === '/license/webhook') {
        await handleLicenseHttp(req, res, pathname, licensesDir());
        return;
      }
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true, service: 'wanji-relay' });
        return;
      }
      if (pathname === '/relay/signup' && req.method === 'POST') {
        const body = await readSmallJson(req);
        const rateAccount = body.licenseKey ? keyHash(body.licenseKey)
          : (typeof body.code === 'string' && body.code ? hash(body.code).toString('hex') : null);
        const retryAfter = consumeRateLimit(req, { scope: 'relay-signup', account: rateAccount, ipMax: 60, accountMax: 10 });
        if (retryAfter) {
          sendJson(res, 429, { error: 'too many signup requests; try again later' }, { 'Retry-After': String(retryAfter) });
          return;
        }
        const en = String(req.headers['x-app-lang'] || '').toLowerCase().startsWith('en');
        if (body.licenseKey || body.code) {
          if (!this.config.shared) {
            sendJson(res, 403, { error: en ? 'This relay serves one person' : '这个中继只服务一个人' });
            return;
          }
          const result = body.licenseKey
            ? await this.signupWithLicense(body.licenseKey, body.machineId)
            : await this.signup(body.code, body.machineId);
          if (!result || result.error) {
            const why = {
              invalid: en ? 'This license key is not valid' : '这个许可证密钥无效',
              expired: en ? 'This license has expired' : '这个许可证已过期',
              revoked: en ? 'This license was revoked' : '这个许可证已被作废',
              'too-many-machines': en ? 'This license is already used on too many computers' : '这个许可证已在太多台电脑上用过',
              'already-registered': en ? 'This license already has a relay account. Use that account’s app key instead.' : '这个许可证已经创建过中继账号，请使用该账号的管理密钥连接',
              'license-server-unavailable': en ? 'Could not reach the license server' : '暂时无法连接许可证服务器',
            }[result?.error] || (en ? 'This invite is invalid or has expired' : '这个邀请无效或已过期');
            sendJson(res, 403, { error: why });
            return;
          }
          sendJson(res, 200, { adminKey: result.adminKey });
          return;
        }
        sendJson(res, 403, { error: en
          ? 'This invite is invalid or has expired. Ask the service provider for a licensed invite'
          : '这个邀请无效或已过期，请向服务提供者索取许可证邀请' });
        return;
      }
      if (pathname === '/hub/join' && req.method === 'POST') {
        await this.join(req, res);
        return;
      }
      if (pathname.startsWith('/hub/node/')) {
        const key = bearer(req);
        const hub = key && this.hubBy((h) => h.nodeFor(req));
        if (!hub) {
          sendJson(res, 401, { error: 'this computer has been removed' });
          return;
        }
        if (!(await relayAccountOk(hub, this.config.shared, this.licenseStatusCache))) {
          sendJson(res, 402, { error: "this account's license has expired or was revoked" });
          return;
        }
        await hub.handle(req, res, pathname);
        return;
      }
      if (pathname.startsWith('/hub/api/')) {
        const hub = this.hubBy((h) => h.isAdmin(req));
        if (!hub) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (!(await relayAccountOk(hub, this.config.shared, this.licenseStatusCache))) {
          sendJson(res, 402, { error: "this account's license has expired or was revoked" });
          return;
        }
        await hub.handle(req, res, pathname);
        return;
      }
      const pathToken = /^\/t\/([^/]+)\/mcp\/?$/.exec(pathname)?.[1];
      const token = pathToken || ((pathname === '/mcp' || pathname === '/mcp/') ? bearer(req) : null);
      if (token) {
        const hub = this.hubBy((h) => sameSecret(token, h.state.mcpToken));
        if (!hub) {
          sendJson(res, pathToken ? 404 : 401, { error: pathToken ? 'not found' : 'unauthorized' });
          return;
        }
        if (!(await relayAccountOk(hub, this.config.shared, this.licenseStatusCache))) {
          sendJson(res, 402, { error: "this account's license has expired or was revoked" });
          return;
        }
        // No audit log here: what people run on their own computers is not the relay's to keep.
        await serveMcp(req, res, { name: 'relay', audit: () => {}, handoff: null, hub, clientIp: req.socket.remoteAddress });
        return;
      }
      if (pathname === '/mcp' || pathname === '/mcp/') {
        sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
      else res.end();
    }
  }

  // Codes are checked across every account before the matching hub takes the join.
  async join(req, res) {
    const body = await readSmallJson(req);
    const hub = this.hubBy((h) => h.hasInvite(body.code));
    if (!hub) {
      const retryAfter = consumeRateLimit(req, { scope: 'hub-join', ipMax: 10, windowMs: 10 * 60 * 1000 });
      if (retryAfter) {
        sendJson(res, 429, { error: 'too many wrong codes; try again in 10 minutes' }, { 'Retry-After': String(retryAfter) });
        return;
      }
      sendJson(res, 403, { error: 'this pairing code is wrong, expired or already used' });
      return;
    }
    if (!(await relayAccountOk(hub, this.config.shared, this.licenseStatusCache))) {
      sendJson(res, 402, { error: "this account's license has expired or was revoked" });
      return;
    }
    const result = hub.join(body, req);
    sendJson(res, result.status, result.body, result.headers || {});
  }

  // Answers the certificate authority's ownership check; everything else moves to HTTPS.
  handlePlain(req, res) {
    const token = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url || '')?.[1];
    if (token && this.challenges.has(token)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(this.challenges.get(token));
      return;
    }
    if (req.url === '/healthz') {
      sendJson(res, 200, { ok: true, service: 'wanji-relay' });
      return;
    }
    res.writeHead(301, { Location: `${this.origin()}${req.url || '/'}` });
    res.end();
  }
}

function readSmallJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16384) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve();
  });
});

async function renew(relay, config, dir, log) {
  const files = certPaths(dir);
  if (fs.existsSync(files.account)) securePrivateFile(files.account);
  const accountKeyPem = fs.existsSync(files.account) ? fs.readFileSync(files.account, 'utf8') : undefined;
  const issued = await obtainCertificate({
    directoryUrl: config.acmeDirectory || (config.staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT),
    identifier: config.host,
    accountKeyPem,
    setChallenge: (token, value) => relay.challenges.set(token, value),
    log,
  });
  relay.challenges.clear();
  writeCert(dir, issued);
  log('certificate ready');
  return { cert: issued.cert, key: issued.key };
}

// Runs until stopped. tls: "acme" gets and renews its own certificate on port 80;
// "files" reads certFile and keyFile; "none" serves plain HTTP behind another proxy or tunnel.
export async function runRelay({ dir = relayDir(), log = (line) => console.log(line) } = {}) {
  const config = loadRelayConfig(dir);
  if (!config) throw new Error('the relay is not set up; run: wanji relay setup --host <this server\'s IP or domain>');
  const relay = new Relay({ dir, config, log });
  const handler = (req, res) => { relay.handle(req, res); };

  if (config.tls === 'none') {
    const server = http.createServer(handler);
    await listen(server, config.port || 8770, config.bind || '127.0.0.1');
    log(`relay listening on ${config.bind || '127.0.0.1'}:${config.port || 8770} (plain HTTP), public at ${relay.origin()}`);
    return relay;
  }

  if (config.tls === 'files') {
    const load = () => {
      securePrivateFile(config.keyFile);
      return { cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) };
    };
    const server = https.createServer(load(), handler);
    await listen(server, config.httpsPort || 443, config.bind);
    // Another tool renews these files, so pick up whatever it wrote.
    setInterval(() => { try { server.setSecureContext(load()); } catch { /* keep the old one */ } }, RENEW_CHECK_MS).unref();
    log(`relay listening on port ${config.httpsPort || 443}, public at ${relay.origin()}`);
    return relay;
  }

  const certDir = path.join(dir, 'tls');
  const plain = http.createServer((req, res) => relay.handlePlain(req, res));
  await listen(plain, config.httpPort || 80, config.bind);
  let current = readCert(certDir);
  while (needsRenewal(current?.cert)) {
    try {
      current = await renew(relay, config, certDir, log);
    } catch (err) {
      log(`could not get a certificate: ${err.message}`);
      log(`check that ports ${config.httpPort || 80} and ${config.httpsPort || 443} are open in the cloud console's firewall; retrying in 10 minutes`);
      if (current) break;
      await new Promise((resolve) => { setTimeout(resolve, RETRY_CERT_MS); });
    }
  }
  const server = https.createServer(current, handler);
  await listen(server, config.httpsPort || 443, config.bind);
  log(`relay listening on port ${config.httpsPort || 443}, public at ${relay.origin()}`);
  setInterval(async () => {
    if (!needsRenewal(current.cert)) return;
    try {
      current = await renew(relay, config, certDir, log);
      server.setSecureContext(current);
    } catch (err) {
      log(`certificate renewal failed, will retry: ${err.message}`);
    }
  }, Math.min(RENEW_CHECK_MS, 60 * 60 * 1000)).unref();
  return relay;
}

export function validHost(host) {
  return net.isIPv4(host) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}
