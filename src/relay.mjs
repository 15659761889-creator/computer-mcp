import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { LETS_ENCRYPT, LETS_ENCRYPT_STAGING, needsRenewal, obtainCertificate, readCert, certPaths, writeCert } from './acme.mjs';
import { homeDir } from './config.mjs';
import { Hub, loadHubState } from './hub.mjs';
import { removePoolFiles } from './public-pool.mjs';
import { sendJson, serveMcp } from './server.mjs';

// A relay is a hub on a rented server: it has no machine of its own, every computer connects
// out to it, and it holds one account per person. Self-hosted, it holds exactly one.

const SYNC_MS = 5000;
const RENEW_CHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_CERT_MS = 10 * 60 * 1000;
const SIGNUP_DAYS = 7;
const JOIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_JOIN_FAILURES = 20;

const hash = (value) => createHash('sha256').update(String(value)).digest();
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(hash(a), hash(b));
const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];

export const relayDir = () => path.join(homeDir(), 'relay');
const configFile = (dir) => path.join(dir, 'relay.json');
const accountsDir = (dir) => path.join(dir, 'accounts');
const signupsDir = (dir) => path.join(dir, 'signups');

export function loadRelayConfig(dir = relayDir()) {
  try {
    return JSON.parse(fs.readFileSync(configFile(dir), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function saveRelayConfig(config, dir = relayDir()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile(dir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return { id, adminKey: state.adminKey };
}

export function readAccount(dir, id) {
  return JSON.parse(fs.readFileSync(accountFile(dir, id), 'utf8'));
}

export function removeAccount(dir, id) {
  fs.rmSync(accountFile(dir, id), { force: true });
  // A running relay may still hold the pool open; its next sync removes what is left.
  removePoolFiles(accountFile(dir, id));
}

// Pool databases whose account file is gone, left by a removal while the relay held them open.
function orphanPools(dir, ids) {
  let files;
  try {
    files = fs.readdirSync(accountsDir(dir));
  } catch {
    return [];
  }
  const orphans = new Set();
  for (const f of files) {
    const id = /^([a-f0-9]{8,})\.pool\.sqlite(?:-wal|-shm|-journal)?$/.exec(f)?.[1];
    if (id && !ids.has(id)) orphans.add(id);
  }
  return [...orphans];
}

// One file per code, so the CLI adding codes and the service using them never write the same file.
export function createSignup(dir = relayDir()) {
  const code = randomBytes(12).toString('base64url');
  fs.mkdirSync(signupsDir(dir), { recursive: true });
  const file = path.join(signupsDir(dir), `${hash(code).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ expires: Date.now() + SIGNUP_DAYS * 86400000 }), { mode: 0o600 });
  return { code, days: SIGNUP_DAYS };
}

export function appLink(config, adminKey) {
  return `computermcp://${new URL(relayOrigin(config)).host}/${adminKey}`;
}

export function signupLink(config, code) {
  return `computermcp://${new URL(relayOrigin(config)).host}/signup/${code}`;
}

export class Relay {
  constructor({ dir = relayDir(), config, log = () => {} }) {
    this.dir = dir;
    this.config = config;
    this.log = log;
    this.hubs = new Map();
    this.challenges = new Map();
    this.joinFailures = [];
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
    for (const id of orphanPools(this.dir, ids)) removePoolFiles(accountFile(this.dir, id));
    for (const id of ids) {
      if (this.hubs.has(id)) continue;
      try {
        const hub = new Hub({ file: accountFile(this.dir, id), origin: () => this.origin(), getToken: () => hub.state.mcpToken });
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

  signup(code) {
    if (typeof code !== 'string' || !code) return null;
    const file = path.join(signupsDir(this.dir), `${hash(code).toString('hex')}.json`);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    fs.rmSync(file, { force: true });
    if (entry.expires < Date.now()) return null;
    const account = createAccount(this.dir);
    this.sync();
    return account;
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
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true, service: 'computer-mcp-relay' });
        return;
      }
      if (pathname === '/relay/signup' && req.method === 'POST') {
        const body = await readSmallJson(req);
        const account = this.config.shared ? this.signup(body.code) : null;
        if (account) sendJson(res, 200, { adminKey: account.adminKey });
        else sendJson(res, 403, { error: '这个邀请已失效或已被使用，请向服务提供者重新要一个' });
        return;
      }
      if (pathname === '/hub/join' && req.method === 'POST') {
        await this.join(req, res);
        return;
      }
      if (pathname.startsWith('/hub/node/')) {
        const key = bearer(req);
        const hub = key && this.hubBy((h) => h.nodeFor(req));
        if (hub) await hub.handle(req, res, pathname);
        else sendJson(res, 401, { error: 'this computer has been removed' });
        return;
      }
      if (pathname.startsWith('/hub/api/')) {
        const hub = this.hubBy((h) => h.isAdmin(req));
        if (hub) await hub.handle(req, res, pathname);
        else sendJson(res, 401, { error: 'unauthorized' });
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
    const now = Date.now();
    this.joinFailures = this.joinFailures.filter((at) => now - at < JOIN_WINDOW_MS);
    if (this.joinFailures.length >= MAX_JOIN_FAILURES) {
      sendJson(res, 429, { error: 'too many wrong codes; try again in 10 minutes' });
      return;
    }
    const body = await readSmallJson(req);
    const hub = this.hubBy((h) => h.hasInvite(body.code));
    if (!hub) {
      this.joinFailures.push(now);
      sendJson(res, 403, { error: 'this pairing code is wrong, expired or already used' });
      return;
    }
    const result = hub.join(body);
    sendJson(res, result.status, result.body);
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
      sendJson(res, 200, { ok: true, service: 'computer-mcp-relay' });
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
  if (!config) throw new Error('the relay is not set up; run: computer-mcp relay setup --host <this server\'s IP or domain>');
  const relay = new Relay({ dir, config, log });
  const handler = (req, res) => { relay.handle(req, res); };

  if (config.tls === 'none') {
    const server = http.createServer(handler);
    await listen(server, config.port || 8770, config.bind || '127.0.0.1');
    log(`relay listening on ${config.bind || '127.0.0.1'}:${config.port || 8770} (plain HTTP), public at ${relay.origin()}`);
    return relay;
  }

  if (config.tls === 'files') {
    const load = () => ({ cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) });
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
