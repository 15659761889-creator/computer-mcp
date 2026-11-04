import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { firstReachable, lanRequest, readBody } from './lan.mjs';
import { resolvePath } from './tools.mjs';

// Moving files between computers. The main computer drives every transfer and keeps its state;
// the computers at both ends run the small internal tools below (named _xfer_*, never shown to the AI).
// Over the LAN the receiver pulls straight from the sender; over the internet the pieces pass
// through the main computer. Either way the receiver writes into a staging copy that grows only
// at its end, so a transfer resumes from what is there, and nothing replaces the destination
// until every file's SHA-256 matches the source.

const STAGING = '.cmcp-part';
const PIECE = 8 * 1024 * 1024;
const LAN_BUDGET = 1024 * 1024 * 1024;
const MAX_FILES = 500000;
const TICKET_MS = 24 * 3600 * 1000;
const WAIT_ONLINE_MS = 24 * 3600 * 1000;
const KEEP = 50;

class XferError extends Error {}

// Beside the hub's state file, so a relay keeps one per account.
export const transfersFile = (stateFile) => `${stateFile.replace(/\.json$/i, '')}.transfers.json`;

const fail = (message) => { throw new XferError(message); };
const toRel = (rel) => String(rel ?? '').split(/[\\/]+/).filter(Boolean).join('/');

// rel must stay inside root: no absolute paths, no "..".
function inside(root, rel) {
  const clean = toRel(rel);
  if (!clean) return root;
  if (clean.split('/').some((part) => part === '..' || part === '.') || path.isAbsolute(clean) || /^[a-z]:/i.test(clean)) fail(`bad path in transfer: ${rel}`);
  return path.join(root, ...clean.split('/'));
}

const stagingOf = (dest) => `${dest}${STAGING}`;

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

async function scan(args) {
  const root = resolvePath(args.path);
  const stat = await fsp.stat(root).catch(() => fail(`${root} does not exist`));
  if (stat.isFile()) return { kind: 'file', files: [{ rel: '', size: stat.size, mtimeMs: stat.mtimeMs }], dirs: [], skipped: 0 };
  if (!stat.isDirectory()) fail(`${root} is neither a file nor a folder`);
  const files = [];
  const dirs = [];
  let skipped = 0;
  const walk = async (dir, rel) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => fail(`cannot read ${dir}: ${err.code || err.message}`));
    if (!entries.length && rel) dirs.push(rel);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      // Links are skipped: following them could copy a whole drive or loop forever.
      if (entry.isSymbolicLink()) {
        skipped += 1;
      } else if (entry.isDirectory()) {
        await walk(full, childRel);
      } else if (entry.isFile()) {
        const info = await fsp.stat(full).catch(() => null);
        if (!info) {
          skipped += 1;
          continue;
        }
        files.push({ rel: childRel, size: info.size, mtimeMs: info.mtimeMs });
        if (files.length > MAX_FILES) fail(`more than ${MAX_FILES} files; pack them into an archive first`);
      } else {
        skipped += 1;
      }
    }
  };
  await walk(root, '');
  return { kind: 'dir', files, dirs, skipped };
}

async function prepare(args) {
  const dest = resolvePath(args.dest);
  const existing = await fsp.stat(dest).catch(() => null);
  if (existing && !args.overwrite) fail(`${dest} already exists; nothing was copied. Pass overwrite: true to replace it, or choose another to_path`);
  if (existing && (args.kind === 'dir') !== existing.isDirectory()) fail(`${dest} exists and is a ${existing.isDirectory() ? 'folder' : 'file'}, but the source is a ${args.kind === 'dir' ? 'folder' : 'file'}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (args.kind === 'dir') await fsp.mkdir(stagingOf(dest), { recursive: true });
  return { dest };
}

const stagedFile = (dest, kind, rel) => (kind === 'file' ? stagingOf(dest) : inside(stagingOf(dest), rel));

async function have(args) {
  const dest = resolvePath(args.dest);
  const sizes = {};
  for (const rel of args.files || []) {
    const size = await sizeOf(stagedFile(dest, args.kind, rel));
    if (size) sizes[rel] = size;
  }
  return { sizes };
}

async function readPieces(args) {
  const root = resolvePath(args.path);
  const data = [];
  for (const piece of args.pieces || []) {
    const file = args.kind === 'file' ? root : inside(root, piece.rel);
    const length = Math.max(0, Math.min(Number(piece.length) || 0, PIECE));
    const buffer = Buffer.alloc(length);
    let read = 0;
    if (length) {
      const handle = await fsp.open(file, 'r');
      try {
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, Number(piece.offset) + read);
          if (!bytesRead) break;
          read += bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
    if (read < length) fail(`${file} got shorter while it was being copied`);
    data.push(buffer.toString('base64'));
  }
  return { data };
}

const busy = new Set();

async function lock(file, work) {
  if (busy.has(file)) fail(`another copy into ${file} is still running`);
  busy.add(file);
  try {
    return await work();
  } finally {
    busy.delete(file);
  }
}

async function writePieces(args) {
  const dest = resolvePath(args.dest);
  for (const piece of args.pieces || []) {
    const file = stagedFile(dest, args.kind, piece.rel);
    await lock(file, async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const current = await sizeOf(file);
      // The staging copy only grows at its end; anything else means the two sides disagree.
      if (current !== Number(piece.offset)) {
        const err = new XferError(`resync: ${file} has ${current} bytes, not ${piece.offset}`);
        err.resync = true;
        throw err;
      }
      await fsp.appendFile(file, Buffer.from(piece.data || '', 'base64'));
    });
  }
  return { ok: true };
}

// ---- Direct LAN copies: the sender serves one transfer's files to whoever holds its ticket ----

const tickets = new Map();

export function xferPsk(identity) {
  const id = /^t:([a-f0-9]+)$/.exec(identity)?.[1];
  const ticket = id && tickets.get(id);
  if (!ticket || ticket.expires < Date.now()) return null;
  return ticket.psk;
}

async function serve(args) {
  for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id);
  tickets.set(String(args.ticket), { psk: Buffer.from(String(args.psk), 'base64'), root: resolvePath(args.path), kind: args.kind, expires: Date.now() + TICKET_MS });
  return { ok: true };
}

// GET /lan/xfer/ping and /lan/xfer/file?rel=&offset=&length=, for a ticket's own files only.
export async function handleXferLan(req, res, identity) {
  const ticket = tickets.get(identity.slice(2));
  const url = new URL(req.url, 'https://lan');
  if (!identity.startsWith('t:') || !ticket) {
    res.writeHead(404).end();
    return;
  }
  if (url.pathname === '/lan/xfer/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (url.pathname !== '/lan/xfer/file') {
    res.writeHead(404).end();
    return;
  }
  let file;
  try {
    file = ticket.kind === 'file' ? ticket.root : inside(ticket.root, url.searchParams.get('rel'));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const size = await sizeOf(file);
  const offset = Number(url.searchParams.get('offset')) || 0;
  const length = Math.max(0, Math.min(Number(url.searchParams.get('length')) || 0, size - offset));
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': length });
  if (!length) {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(file, { start: offset, end: offset + length - 1 }), res).catch(() => res.destroy());
}

const peerOf = (args) => ({ identity: `t:${args.ticket}`, psk: Buffer.from(String(args.psk), 'base64') });

async function probe(args) {
  const peer = peerOf(args);
  const host = await firstReachable(args.lan?.addrs, args.lan?.port, async (h, port) => {
    const res = await lanRequest({ ...peer, host: h, port, path: '/lan/xfer/ping', timeoutMs: 2500 });
    await readBody(res);
    if (res.statusCode !== 200) throw new Error(`${h}:${port} answered ${res.statusCode}`);
  }).catch((err) => fail(err.message));
  return { host };
}

// Pulls up to budget bytes of the listed files from the sender into the staging copy.
async function pull(args) {
  const dest = resolvePath(args.dest);
  const peer = peerOf(args);
  let budget = Number(args.budget) || LAN_BUDGET;
  const sizes = {};
  for (const { rel, size } of args.files || []) {
    if (budget <= 0) break;
    const file = stagedFile(dest, args.kind, rel);
    await lock(file, async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      let current = await sizeOf(file);
      if (current > size) {
        await fsp.rm(file, { force: true });
        current = 0;
      }
      const length = Math.min(size - current, budget);
      if (length > 0 || !fs.existsSync(file)) {
        const query = new URLSearchParams({ rel, offset: String(current), length: String(length) });
        const res = await lanRequest({ ...peer, host: args.host, port: args.lan.port, path: `/lan/xfer/file?${query}`, timeoutMs: 60000 });
        if (res.statusCode !== 200) {
          res.resume();
          fail(`the sender answered ${res.statusCode} for ${rel || 'the file'}`);
        }
        await pipeline(res, fs.createWriteStream(file, { flags: 'a' }));
      }
      const now = await sizeOf(file);
      if (now !== current + length) fail(`the LAN copy of ${rel || 'the file'} stopped early (${now - current} of ${length} bytes)`);
      sizes[rel] = now;
      budget -= length;
    });
  }
  return { sizes };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// Hashes the source (staged false) or the staging copy (staged true), in manifest order.
async function hashAll(args) {
  const root = resolvePath(args.root);
  const hashes = [];
  const stats = [];
  for (const rel of args.files || []) {
    const file = args.staged ? stagedFile(root, args.kind, rel) : (args.kind === 'file' ? root : inside(root, rel));
    const info = await fsp.stat(file).catch(() => null);
    if (!info) {
      hashes.push(null);
      stats.push(null);
      continue;
    }
    hashes.push(await hashFile(file));
    stats.push([info.size, info.mtimeMs]);
  }
  return { hashes, stats };
}

async function drop(args) {
  const dest = resolvePath(args.dest);
  for (const rel of args.files || []) await fsp.rm(stagedFile(dest, args.kind, rel), { force: true });
  return { ok: true };
}

async function moveInto(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { recursive: true, force: true });
  await fsp.rename(from, to);
}

// Puts the checked copy in place. Run again after a lost reply, it sees the work already done.
async function commit(args) {
  const dest = resolvePath(args.dest);
  const staging = stagingOf(dest);
  if (!fs.existsSync(staging)) {
    if (fs.existsSync(dest)) return { ok: true };
    fail(`the copy waiting at ${staging} is gone`);
  }
  for (const rel of args.dirs || []) await fsp.mkdir(inside(staging, rel), { recursive: true });
  const existing = await fsp.stat(dest).catch(() => null);
  if (existing && !args.overwrite) fail(`${dest} appeared while copying; the copy is kept at ${staging}`);
  if (args.kind === 'file' || !existing) {
    await moveInto(staging, dest);
    return { ok: true };
  }
  // Overwriting a folder merges: files from the source replace their namesakes, and nothing else is deleted.
  const merge = async (from, to) => {
    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await fsp.mkdir(b, { recursive: true });
        await merge(a, b);
      } else {
        await moveInto(a, b);
      }
    }
  };
  await merge(staging, dest);
  await fsp.rm(staging, { recursive: true, force: true });
  return { ok: true };
}

async function abort(args) {
  await fsp.rm(stagingOf(resolvePath(args.dest)), { recursive: true, force: true });
  return { ok: true };
}

const HANDLERS = {
  _xfer_scan: scan,
  _xfer_prepare: prepare,
  _xfer_have: have,
  _xfer_read: readPieces,
  _xfer_write: writePieces,
  _xfer_serve: serve,
  _xfer_probe: probe,
  _xfer_pull: pull,
  _xfer_hash: hashAll,
  _xfer_drop: drop,
  _xfer_commit: commit,
  _xfer_abort: abort,
};

export const isXferTool = (name) => Object.hasOwn(HANDLERS, name);

// Runs on whichever computer holds the files. Results travel as { text, data }.
export async function runXfer(name, args = {}) {
  try {
    return { text: 'ok', data: await HANDLERS[name](args) };
  } catch (err) {
    return { text: err.message, isError: true, resync: err.resync === true };
  }
}

// ---- The driver, on the main computer ----

export const TRANSFER_TOOL = {
  name: 'transfer',
  description: 'Copy a file or a whole folder from one computer to another. The data goes straight between the computers and never through you, so any size works. It uses the LAN when both are on the same network, otherwise the internet; the owner sets each computer to auto, lan or public, and route overrides that for this call (a chosen route that cannot work is an error, never a silent switch). Interrupted transfers continue when the computers are back, and every file is checked with SHA-256 before it is put in place. to_path is the exact new path; an existing one is an error unless overwrite is true (a folder is then merged: same-named files replaced, nothing deleted). Returns when done or after wait seconds with an id; call again with only id to check, or id and cancel. With no arguments, lists recent transfers.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Computer that has the file or folder.' },
      from_path: { type: 'string', description: 'Path on that computer.' },
      to: { type: 'string', description: 'Computer to copy it to.' },
      to_path: { type: 'string', description: 'Exact path it gets there, including its name.' },
      route: { type: 'string', enum: ['auto', 'lan', 'public'], description: 'Optional. Default: from the owner\'s setting for these computers.' },
      overwrite: { type: 'boolean', description: 'Replace an existing to_path. Default false.' },
      wait: { type: 'number', description: 'Seconds to wait before replying with progress. Default 60.' },
      id: { type: 'string', description: 'A transfer id, to check it or cancel it.' },
      cancel: { type: 'boolean', description: 'With id: stop it and delete the partial copy.' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Copy between computers', destructiveHint: true, openWorldHint: true },
};

const TRANSIENT = /is offline|went offline|restarted|disconnected|was removed while/;
const ACTIVE = new Set(['starting', 'scanning', 'copying', 'verifying', 'waiting']);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

class Cancelled extends Error {}

export class Transfers {
  constructor({ hub, file }) {
    this.hub = hub;
    this.file = file;
    this.list = [];
    this.running = new Map();
    try {
      this.list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.list = [];
    }
    // The main computer restarted: carry on with what was under way.
    for (const t of this.list) if (ACTIVE.has(t.status)) this.launch(t);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // The LAN ticket's key and the cancel flag live only in memory.
      const plain = (key, value) => (key === 'lan' || key === 'cancel' ? undefined : value);
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.list.slice(0, KEEP), plain));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // Progress is still in memory.
    }
  }

  // { id, name, self, computer, route }
  endpoint(name) {
    const target = this.hub.resolve(name);
    if (!target) fail(`there is no computer named "${name}". Available: ${this.hub.names()}`);
    if (target.self) return { id: 'self', name: this.hub.selfName, self: true, route: 'auto' };
    return { id: target.computer.id, name: target.computer.name, computer: target.computer, route: this.hub.routeOf(target.computer) };
  }

  // Waits out an endpoint that is offline or restarting, then runs the internal tool there.
  async call(t, end, tool, args) {
    const started = Date.now();
    for (;;) {
      if (t.cancel) throw new Cancelled();
      if (!end.self && !this.hub.isOnline(end.id)) {
        if (Date.now() - started > WAIT_ONLINE_MS) fail(`${end.name} has been offline for a day`);
        t.waitingFor = end.name;
        await sleep(3000);
        continue;
      }
      t.waitingFor = null;
      const outcome = end.self ? await runXfer(tool, args) : await this.hub.forward(end.computer, tool, args);
      if (!outcome.isError) return outcome.data || {};
      if (outcome.resync) {
        const err = new XferError(outcome.text);
        err.resync = true;
        throw err;
      }
      if (!end.self && TRANSIENT.test(outcome.text) && !/removed/.test(outcome.text)) {
        await sleep(2000);
        continue;
      }
      fail(outcome.text);
    }
  }

  wantedRoute(a, b, asked) {
    if (asked) return asked;
    const routes = [a.route, b.route];
    if (routes.includes('lan') && routes.includes('public')) {
      fail(`${a.route === 'lan' ? a.name : b.name} is set to LAN only and ${a.route === 'public' ? a.name : b.name} to internet only; choose route for this transfer, or change one in the phone app`);
    }
    if (routes.includes('lan')) return 'lan';
    if (routes.includes('public')) return 'public';
    return 'auto';
  }

  start(args) {
    for (const key of ['from', 'from_path', 'to', 'to_path']) {
      if (typeof args[key] !== 'string' || !args[key].trim()) fail(`${key} is required`);
    }
    const a = this.endpoint(args.from);
    const b = this.endpoint(args.to);
    if (a.id === b.id) fail('from and to are the same computer; copy with the bash tool instead');
    const route = this.wantedRoute(a, b, args.route);
    const t = {
      id: randomBytes(4).toString('hex'),
      from: a.name, to: b.name, src: args.from_path, dest: args.to_path,
      route, overwrite: args.overwrite === true,
      status: 'starting', via: null, total: 0, done: 0, files: 0, error: null,
      createdAt: Date.now(), copyStartedAt: null, finishedAt: null,
    };
    this.list.unshift(t);
    this.launch(t);
    return t;
  }

  launch(t) {
    t.cancel = false;
    const job = this.run(t).finally(() => {
      this.running.delete(t.id);
      this.save();
    });
    this.running.set(t.id, job);
  }

  // Asks the receiver to pull from the sender over the LAN; returns null when that works,
  // otherwise the reason.
  async tryLan(t, a, b, manifest) {
    const lan = this.hub.lanOf(a.id);
    if (!lan) return `${a.name} has no LAN address on record (it is offline, older than this feature, or the main computer is a cloud relay)`;
    if (!b.self && !this.hub.lanOf(b.id) && !this.hub.isOnline(b.id)) return `${b.name} is offline`;
    const ticket = randomBytes(8).toString('hex');
    const psk = randomBytes(32).toString('base64');
    await this.call(t, a, '_xfer_serve', { ticket, psk, path: t.src, kind: manifest.kind });
    try {
      const { host } = await this.call(t, b, '_xfer_probe', { ticket, psk, lan });
      t.lan = { ticket, psk, lan, host };
      return null;
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return `${b.name} cannot reach ${a.name} over the LAN: ${err.message}`;
    }
  }

  async copyLan(t, b, manifest, sizes) {
    for (;;) {
      const remaining = manifest.files.filter((f) => (sizes[f.rel] || 0) !== f.size || (f.size === 0 && !(f.rel in sizes)));
      if (!remaining.length) return;
      const { sizes: got } = await this.call(t, b, '_xfer_pull', {
        ticket: t.lan.ticket, psk: t.lan.psk, lan: t.lan.lan, host: t.lan.host,
        dest: t.dest, kind: manifest.kind, files: remaining.map(({ rel, size }) => ({ rel, size })), budget: LAN_BUDGET,
      });
      for (const [rel, size] of Object.entries(got)) sizes[rel] = size;
      this.progress(t, manifest, sizes);
    }
  }

  async copyPublic(t, a, b, manifest, sizes) {
    // Pieces of at most 8 MB, small files batched together, read ahead of the write.
    const batches = [];
    let batch = [];
    let batchBytes = 0;
    const flush = () => {
      if (batch.length) batches.push(batch);
      batch = [];
      batchBytes = 0;
    };
    for (const f of manifest.files) {
      let offset = sizes[f.rel] || 0;
      if (offset === f.size && (f.size > 0 || f.rel in sizes)) continue;
      do {
        const length = Math.min(f.size - offset, PIECE - batchBytes);
        batch.push({ rel: f.rel, offset, length });
        offset += length;
        batchBytes += length;
        if (batchBytes >= PIECE || batch.length >= 512) flush();
      } while (offset < f.size);
    }
    flush();
    let next = batches.length ? this.call(t, a, '_xfer_read', { path: t.src, kind: manifest.kind, pieces: batches[0] }) : null;
    for (let i = 0; i < batches.length; i += 1) {
      const { data } = await next;
      next = i + 1 < batches.length ? this.call(t, a, '_xfer_read', { path: t.src, kind: manifest.kind, pieces: batches[i + 1] }) : null;
      // An unhandled rejection of the read-ahead would crash the process if the write fails first.
      next?.catch(() => {});
      const pieces = batches[i].map((p, k) => ({ rel: p.rel, offset: p.offset, data: data[k] }));
      await this.call(t, b, '_xfer_write', { dest: t.dest, kind: manifest.kind, pieces });
      for (const p of batches[i]) sizes[p.rel] = p.offset + p.length;
      this.progress(t, manifest, sizes);
    }
  }

  progress(t, manifest, sizes) {
    t.done = manifest.files.reduce((sum, f) => sum + Math.min(sizes[f.rel] || 0, f.size), 0);
  }

  async copy(t, a, b, manifest) {
    const rels = manifest.files.map((f) => f.rel);
    const { sizes } = await this.call(t, b, '_xfer_have', { dest: t.dest, kind: manifest.kind, files: rels });
    this.progress(t, manifest, sizes);
    t.status = 'copying';
    t.copyStartedAt = t.copyStartedAt || Date.now();
    t.copyStartBytes = t.done;
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (t.via === 'lan') await this.copyLan(t, b, manifest, sizes);
        else await this.copyPublic(t, a, b, manifest, sizes);
        return;
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        if (err.resync && attempt < 5) {
          Object.assign(sizes, (await this.call(t, b, '_xfer_have', { dest: t.dest, kind: manifest.kind, files: rels })).sizes);
          continue;
        }
        if (t.via === 'lan' && t.route === 'auto') {
          t.note = `the LAN copy broke (${err.message}), so the rest went over the internet`;
          t.via = 'public';
          Object.assign(sizes, (await this.call(t, b, '_xfer_have', { dest: t.dest, kind: manifest.kind, files: rels })).sizes);
          continue;
        }
        if (t.via === 'lan' && attempt < 3) {
          await sleep(3000);
          const reason = await this.tryLan(t, a, b, manifest);
          if (reason) fail(`chosen route lan failed: ${reason}`);
          continue;
        }
        throw err;
      }
    }
  }

  async run(t) {
    try {
      const a = this.endpoint(t.from);
      const b = this.endpoint(t.to);
      t.status = 'scanning';
      const manifest = await this.call(t, a, '_xfer_scan', { path: t.src });
      t.total = manifest.files.reduce((sum, f) => sum + f.size, 0);
      t.files = manifest.files.length;
      t.skipped = manifest.skipped;
      await this.call(t, b, '_xfer_prepare', { dest: t.dest, kind: manifest.kind, overwrite: t.overwrite });

      t.via = 'public';
      if (t.route !== 'public') {
        const reason = await this.tryLan(t, a, b, manifest);
        if (!reason) t.via = 'lan';
        else if (t.route === 'lan') fail(`chosen route lan failed, nothing was copied: ${reason}`);
        else t.note = `not over the LAN: ${reason}`;
      }
      this.save();

      for (let round = 1; ; round += 1) {
        await this.copy(t, a, b, manifest);
        t.status = 'verifying';
        const rels = manifest.files.map((f) => f.rel);
        const [source, copy] = await Promise.all([
          this.call(t, a, '_xfer_hash', { root: t.src, kind: manifest.kind, files: rels, staged: false }),
          this.call(t, b, '_xfer_hash', { root: t.dest, kind: manifest.kind, files: rels, staged: true }),
        ]);
        const changed = manifest.files.filter((f, i) => !source.stats[i] || source.stats[i][0] !== f.size || source.stats[i][1] !== f.mtimeMs);
        if (changed.length) fail(`the source changed while it was being copied (${changed.slice(0, 3).map((f) => f.rel || t.src).join(', ')}); the partial copy is kept and a new transfer resumes it`);
        const bad = rels.filter((rel, i) => source.hashes[i] !== copy.hashes[i]);
        if (!bad.length) break;
        if (round >= 2) fail(`${bad.length} file(s) still differ after copying twice, for example ${bad[0] || t.src}`);
        await this.call(t, b, '_xfer_drop', { dest: t.dest, kind: manifest.kind, files: bad });
      }
      await this.call(t, b, '_xfer_commit', { dest: t.dest, kind: manifest.kind, overwrite: t.overwrite, dirs: manifest.dirs });
      t.status = 'done';
    } catch (err) {
      if (err instanceof Cancelled) {
        t.status = 'cancelled';
        try {
          const b = this.endpoint(t.to);
          if (b.self || this.hub.isOnline(b.id)) await (b.self ? runXfer('_xfer_abort', { dest: t.dest }) : this.hub.forward(b.computer, '_xfer_abort', { dest: t.dest }));
        } catch {
          // The partial copy stays; it is named *.cmcp-part.
        }
      } else {
        t.status = 'failed';
        t.error = err.message;
      }
    }
    t.finishedAt = Date.now();
    t.waitingFor = null;
    delete t.lan;
  }

  describe(t) {
    const where = `${t.from}:${t.src} -> ${t.to}:${t.dest}`;
    const how = t.via === 'lan' ? 'over the LAN' : t.via === 'public' ? 'over the internet' : '';
    const end = t.finishedAt || Date.now();
    const secs = Math.max((end - (t.copyStartedAt || t.createdAt)) / 1000, 0.001);
    const rate = t.copyStartedAt ? ` at ${bytes(Math.round(Math.max(t.done - (t.copyStartBytes || 0), 0) / secs))}/s` : '';
    const lines = [`transfer ${t.id}: ${t.status}${t.waitingFor ? ` (waiting for ${t.waitingFor} to come online)` : ''}`, where];
    if (t.status === 'done') {
      lines.push(`${bytes(t.total)} in ${t.files} file(s), ${secs.toFixed(1)} s${rate} ${how}, every file checked with SHA-256.`);
    } else if (t.status === 'failed') {
      lines.push(`error: ${t.error}`);
      if (t.done) lines.push(`${bytes(t.done)} of ${bytes(t.total)} had arrived and is kept; the same transfer again resumes from there.`);
    } else if (t.status !== 'cancelled') {
      const percent = t.total ? Math.floor((t.done / t.total) * 100) : 0;
      lines.push(`${percent}% (${bytes(t.done)} of ${bytes(t.total)}, ${t.files} file(s))${rate} ${how}`.trim());
      lines.push(`Still running; check with transfer { "id": "${t.id}" }.`);
    }
    if (t.note) lines.push(`note: ${t.note}`);
    if (t.skipped) lines.push(`note: ${t.skipped} link(s) or special file(s) were skipped`);
    return lines.join('\n');
  }

  async waitFor(t, seconds) {
    const job = this.running.get(t.id);
    if (!job || seconds <= 0) return;
    let timer;
    await Promise.race([job, new Promise((resolve) => { timer = setTimeout(resolve, seconds * 1000); })]);
    clearTimeout(timer);
  }

  // The transfer tool.
  async tool(args = {}) {
    try {
      const wait = args.wait === undefined ? 60 : Math.max(0, Math.min(Number(args.wait) || 0, 600));
      if (args.id !== undefined) {
        const t = this.list.find((x) => x.id === String(args.id));
        if (!t) return { text: `no transfer with id ${args.id}`, isError: true };
        if (args.cancel) {
          t.cancel = true;
          await this.waitFor(t, 30);
        } else {
          await this.waitFor(t, wait);
        }
        return { text: this.describe(t), isError: t.status === 'failed' };
      }
      if (args.from === undefined && args.to === undefined) {
        if (!this.list.length) return { text: 'no transfers yet' };
        return { text: this.list.slice(0, 10).map((t) => this.describe(t)).join('\n\n') };
      }
      const t = this.start(args);
      await this.waitFor(t, wait);
      return { text: this.describe(t), isError: t.status === 'failed' };
    } catch (err) {
      if (err instanceof XferError) return { text: err.message, isError: true };
      throw err;
    }
  }
}
