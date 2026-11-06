import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopSupported } from './desktop.mjs';
import { browserInstalled } from './browser.mjs';
import { localHandoff } from './handoff-local.mjs';
import { availableShells } from './shell.mjs';
import { ROUTES, nodePsk } from './lan.mjs';
import { MemoryError } from './memory.mjs';
import { entryText } from './memory-context.mjs';

const POLL_HOLD_MS = 25000;
// A node polls again at once, so this much silence means it is gone.
const OFFLINE_MS = 45000;
const INVITE_MS = 10 * 60 * 1000;
const MAX_INVITE_DAYS = 30;
const JOIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_JOIN_FAILURES = 10;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
// Unambiguous when read aloud or retyped: no 0/O or 1/I/L.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// The AI waits this long for the person to finish a takeover it asked for.
const TAKEOVER_MS = 15 * 60 * 1000;
// After the person last touched the browser, the AI stays off its desktop this long.
const HUMAN_HOLD_MS = 2 * 60 * 1000;
const BROWSER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key']);
// Desktop methods a node runs for the browser takeover; the AI cannot name them.
export const BROWSER_METHODS = ['handoff_start', 'handoff_list', 'handoff_select', 'handoff_frame', 'handoff_input'];
// How long one call waits for the person to pick an account in the app.
const SECRET_WAIT_MS = 120 * 1000;
const SECRET_REQUEST_MS = 10 * 60 * 1000;
const EVENT_HOLD_MS = 25000;

export const SECRET_TOOL = {
  name: 'type_secret',
  description: 'Type a saved username or password into the computer without ever seeing it. The owner keeps accounts in the 万机 phone app; each use usually asks them on the phone to pick the account and allow it, which can take a minute, but accounts the owner marked as trusted in the phone app are filled without asking (secret_list shows which ones those are). Click into the field first, or name it with target or element_id, then call this once for the username and once for the password. The reply never contains the value. Use this for logins instead of asking for passwords in chat, and only type into the login form the owner expects.',
  inputSchema: {
    type: 'object',
    properties: {
      secret: { type: 'string', description: 'Which account, as the owner would name it, such as "GitHub" or "公司邮箱".' },
      part: { type: 'string', enum: ['username', 'password'], description: 'Which half of the saved account to type.' },
      target: { type: 'string', description: 'Visible text or name of the field to type into. Default: the focused field.' },
      element_id: { type: 'integer', description: 'Number of the field from the latest ui_look.' },
      window: { type: 'string', description: 'Window title text or a w: handle.' },
      press_enter: { type: 'boolean', description: 'Press Enter afterwards, to submit.' },
      reason: { type: 'string', description: 'One short sentence shown to the owner: what you are logging into and why.' },
    },
    required: ['secret', 'part'],
    additionalProperties: false,
  },
  annotations: { title: 'Type a saved secret', destructiveHint: true, openWorldHint: true },
};

export const SECRET_LIST_TOOL = {
  name: 'secret_list',
  description: 'List the saved accounts the owner keeps in the 万机 phone app, by label and username only, so the AI can tell accounts apart before typing anything. Each entry also says autoAllow: true when the owner lets the AI use that account without asking each time. Passwords are never stored on the hub and never appear here. Name any connected computer; the list is the same for the whole hub. Call this before type_secret when the label alone does not say which account it is, and confirm the username with the owner before typing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'List saved accounts', readOnlyHint: true, openWorldHint: false },
};

const hash = (value) => createHash('sha256').update(String(value)).digest();
const hashText = (value) => hash(value).toString('hex');
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(hash(a), hash(b));
const cleanName = (value) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);

export function machineInfo() {
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    user: os.userInfo().username,
    home: os.homedir(),
    shells: availableShells(),
    desktop: desktopSupported,
    browser: browserInstalled(),
  };
}

// The phone app says which language it shows in the X-App-Lang header; anything but "en" stays Chinese.
export function langOf(req) {
  return String(req?.headers?.['x-app-lang'] || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

// What the phone shows when the browser view cannot work.
function friendlyBrowserError(text, lang = 'zh') {
  const known = [
    [/Open Chrome, Edge or Firefox/i, '这台电脑上没有打开浏览器。请先打开 Chrome、Edge 或 Firefox', 'No browser is open on this computer. Open Chrome, Edge or Firefox first'],
    [/lost focus|minimized/i, '浏览器被别的窗口挡住了，画面暂停；你一操作就会自动切回来', 'The browser is covered by another window, so the picture is paused; it comes back as soon as you interact'],
    [/covering the browser/i, '有别的窗口挡住了浏览器', 'Another window is covering the browser'],
    [/elevated/i, '浏览器以管理员身份运行，Windows 不允许这样操作', 'The browser is running as administrator, and Windows does not allow this'],
    [/offline/i, '这台电脑不在线', 'This computer is offline'],
    [/locked|secure desktop|lock screen/i, '电脑锁屏了，或者正在弹出系统权限确认，需要在电脑上处理', 'The computer is locked or showing a system permission prompt; deal with it on the computer'],
    [/AI browser is not installed/i, '这台电脑还没装 AI 浏览器（在电脑上运行 wanji browser）', 'The AI browser is not installed on this computer (run wanji browser on it)'],
    [/tab is no longer available/i, '这个浏览器标签页已经关了，请重新选择', 'This browser tab has been closed; please choose again'],
    [/no desktop control|not available on this computer/i, '这台电脑没有安装桌面控制', 'Desktop control is not installed on this computer'],
    [/choose a browser|choose another/i, '请先选择要看的浏览器窗口', 'Choose a browser window to view first'],
  ];
  for (const [pattern, zh, en] of known) if (pattern.test(text)) return lang === 'en' ? en : zh;
  return text;
}

export function formatPair(host, code) {
  return `cmcp://${host}/${code}`;
}

// Accepts the pasted pair text, with stray spaces, or "host code" typed by hand.
export function parsePair(text) {
  const value = String(text ?? '').trim();
  const match = /^(?:cmcp:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,63}|\d{1,3}(?:\.\d{1,3}){3})(:\d{2,5})?[\s/]+([0-9a-z-]{8,9})$/i.exec(value);
  if (!match) throw new Error('that is not a pairing code; copy it again from the phone app');
  return { origin: `https://${match[1].toLowerCase()}${match[2] || ''}`, code: match[3].replace(/-/g, '').toUpperCase() };
}

function newCode() {
  let code = '';
  for (const byte of randomBytes(8)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function hubPath(home) {
  return path.join(home, 'hub.json');
}

// Reads or creates the state file; the admin key in it is what the phone app holds.
export function loadHubState(file) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = { adminKey: randomBytes(32).toString('base64url'), selfNote: '', computers: {}, invites: [], clientTokens: [] };
    saveHubState(file, state);
  }
  return state;
}

function saveHubState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function validLan(lan) {
  if (!lan || !Array.isArray(lan.addrs) || !Number.isInteger(lan.port) || lan.port < 1 || lan.port > 65535) return null;
  const addrs = lan.addrs.filter((a) => typeof a === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a)).slice(0, 8);
  return addrs.length ? { addrs, port: lan.port } : null;
}

export class Hub {
  // selfName is null on a relay, which has no machine of its own to run tools on.
  constructor({ file, selfName = null, origin, getToken, state }) {
    this.file = file;
    this.selfName = selfName;
    this.origin = origin;
    this.getToken = getToken;
    this.state = state || loadHubState(file);
    this.live = new Map();
    this.nextCall = 1;
    this.nextActivity = 1;
    this.activeCalls = new Map();
    this.recentCalls = [];
    this.joinFailures = [];
    this.browsers = new Map();
    this.secretRequests = new Map();
    // Vault metadata synced from the phone app: id, label and username only.
    // Passwords are never stored here; see setVaultMeta.
    this.vaultAccounts = new Map();
    this.takeoverStarting = new Set();
    this.takeoverHistory = new Map();
    this.version = 0;
    this.eventWaiters = new Set();
    // Set by the service when this machine listens on the LAN: { port, addrs() }.
    this.lan = null;
    // Set by the service: moves files between computers (transfer.mjs).
    this.transfers = null;
    // Set by the service when shared memory is on (memory.mjs).
    this.memory = null;
    this.toolCatalog = null;
    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.sweeper.unref();
  }

  close() {
    clearInterval(this.sweeper);
    for (const live of this.live.values()) this.answerWaiter(live, { calls: [] });
  }

  save() {
    saveHubState(this.file, this.state);
  }

  liveFor(id) {
    let live = this.live.get(id);
    if (!live) {
      live = { id, lastSeen: 0, boot: null, waiter: null, queue: [], delivered: new Map(), via: null, lan: null, lanProblem: null };
      this.live.set(id, live);
    }
    return live;
  }

  isOnline(id) {
    const live = this.live.get(id);
    return Boolean(live) && Date.now() - live.lastSeen < OFFLINE_MS;
  }

  routeOf(computer) {
    return ROUTES.includes(computer?.route) ? computer.route : 'auto';
  }

  // What a computer needs to pick its path to this one: its route, and where this machine listens on the LAN.
  nodeSettings(id) {
    return {
      route: this.routeOf(this.state.computers[id]),
      lan: this.lan ? { addrs: this.lan.addrs(), port: this.lan.port } : null,
    };
  }

  // Where a computer's own LAN port is, for direct transfers: null when it has none or is offline.
  lanOf(id) {
    if (id === 'self') return this.lan ? { addrs: this.lan.addrs(), port: this.lan.port } : null;
    const live = this.live.get(id);
    return this.isOnline(id) && live?.lan ? live.lan : null;
  }

  lanPsk(identity) {
    const id = /^n:([a-f0-9]+)$/.exec(identity)?.[1];
    const computer = id && this.state.computers[id];
    return computer ? nodePsk(computer.keyHash) : null;
  }

  // The phone feed stays in memory and never stores tool arguments or results.
  startActivity(action, computer) {
    const entry = { id: this.nextActivity++, action, computer, startedAt: Date.now() };
    const start = performance.now();
    this.activeCalls.set(entry.id, entry);
    return (status) => {
      this.activeCalls.delete(entry.id);
      this.recentCalls.unshift({ ...entry, status, durationMs: Math.round(performance.now() - start) });
      if (this.recentCalls.length > 80) this.recentCalls.pop();
    };
  }

  // ---- What the AI sees ----

  hasOthers() {
    return Object.keys(this.state.computers).length > 0;
  }

  listComputers() {
    return {
      computers: [
        ...(this.selfName ? [{
          name: this.selfName, note: this.state.selfNote || undefined, online: true, ...machineInfo(),
        }] : []),
        ...Object.values(this.state.computers).map((c) => {
          const online = this.isOnline(c.id);
          return {
            name: c.name,
            note: c.note || undefined,
            online,
            connection: online ? this.live.get(c.id)?.via || undefined : undefined,
            last_seen: online ? undefined : this.lastSeenOf(c),
            ...c.info,
          };
        }),
      ],
    };
  }

  lastSeenOf(c) {
    return c.lastSeen ? new Date(c.lastSeen).toISOString() : null;
  }

  // Names are matched exactly: a guess could run a command on the wrong machine.
  resolve(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (this.selfName && wanted === this.selfName.toLowerCase()) return { self: true };
    const computer = Object.values(this.state.computers).find((c) => c.name.toLowerCase() === wanted);
    return computer ? { computer } : null;
  }

  names() {
    return [this.selfName, ...Object.values(this.state.computers).map((c) => c.name)].filter(Boolean).join(', ');
  }

  forward(computer, tool, args) {
    if (!this.isOnline(computer.id)) {
      const problem = this.live.get(computer.id)?.lanProblem;
      const lanOnly = this.routeOf(computer) === 'lan'
        ? ` It is set to connect over the LAN only${problem ? ` and reports: ${problem}` : ''}; the owner can switch it to auto in the phone app.`
        : '';
      return Promise.resolve({ text: `computer "${computer.name}" is offline, so nothing was run.${lanOnly} Use list_computers to see which computers are online.`, isError: true });
    }
    const live = this.liveFor(computer.id);
    return new Promise((resolve) => {
      const call = { id: String(this.nextCall++), tool, args, resolve };
      live.queue.push(call);
      this.flush(live);
    });
  }

  // ---- Delivery to nodes ----

  answerWaiter(live, body) {
    const waiter = live.waiter;
    if (!waiter) return false;
    live.waiter = null;
    clearTimeout(waiter.timer);
    if (waiter.res.destroyed) return false;
    reply(waiter.res, 200, { ...body, settings: this.nodeSettings(live.id) });
    return true;
  }

  flush(live) {
    if (!live.queue.length || !live.waiter || live.waiter.res.destroyed) return;
    const calls = live.queue.splice(0);
    for (const call of calls) live.delivered.set(call.id, call);
    this.answerWaiter(live, { calls: calls.map(({ id, tool, args }) => ({ id, tool, args })) });
  }

  failPending(live, { queued, delivered }) {
    for (const call of live.queue.splice(0)) call.resolve({ text: queued, isError: true });
    for (const call of live.delivered.values()) call.resolve({ text: delivered, isError: true });
    live.delivered.clear();
  }

  // Wakes the phone app's long poll whenever something needs the person.
  bump() {
    this.version += 1;
    for (const wake of this.eventWaiters) wake();
    this.eventWaiters.clear();
  }

  sweep() {
    const now = Date.now();
    for (const [id, request] of this.secretRequests) {
      if (request.created + SECRET_REQUEST_MS < now) {
        this.secretRequests.delete(id);
        for (const wake of request.waiters) wake(null);
        this.bump();
      }
    }
    for (const [id, live] of this.live) {
      const computer = this.state.computers[id];
      if (computer && !computer.lastSeenSaved && !this.isOnline(id)) {
        computer.lastSeen = live.lastSeen;
        computer.lastSeenSaved = true;
        this.save();
      }
      if (this.isOnline(id)) continue;
      const name = computer?.name || id;
      this.failPending(live, {
        queued: `computer "${name}" went offline before this was delivered, so it was not run.`,
        delivered: `computer "${name}" disconnected while running this, so whether it finished is unknown. Do not simply retry: when it is back, check with the job tool or ui_look.`,
      });
    }
  }

  // via is the path the poll came in on: 'lan' or 'public'.
  poll(computer, body, res, via = 'public') {
    const live = this.liveFor(computer.id);
    live.lastSeen = Date.now();
    live.via = via;
    live.lan = validLan(body.lan);
    live.lanProblem = typeof body.lanProblem === 'string' ? body.lanProblem.slice(0, 300) : null;
    if (computer.lastSeenSaved) delete computer.lastSeenSaved;
    if (live.boot && body.boot !== live.boot) {
      this.failPending(live, {
        queued: `computer "${computer.name}" restarted before this was delivered, so it was not run.`,
        delivered: `computer "${computer.name}" restarted while running this, so whether it finished is unknown. Do not simply retry: check with the job tool or ui_look.`,
      });
    }
    live.boot = body.boot;
    if (body.info && JSON.stringify(body.info) !== JSON.stringify(computer.info)) {
      computer.info = body.info;
      this.save();
    }
    // A call the node does not report as received was lost on the way, so sending it again cannot run it twice.
    const running = new Set(Array.isArray(body.running) ? body.running : []);
    const lost = [...live.delivered.values()].filter((call) => !running.has(call.id));
    for (const call of lost) live.delivered.delete(call.id);
    live.queue.unshift(...lost);

    this.answerWaiter(live, { calls: [] });
    const stale = typeof body.knows === 'string' && body.knows !== JSON.stringify(this.nodeSettings(computer.id));
    const timer = setTimeout(() => this.answerWaiter(live, { calls: [] }), stale ? 0 : POLL_HOLD_MS);
    live.waiter = { res, timer };
    res.once('close', () => {
      if (live.waiter?.res === res) {
        clearTimeout(timer);
        live.waiter = null;
      }
    });
    this.flush(live);
  }

  // A computer that may only use the LAN and cannot find this one asks here, over the internet,
  // whether its route changed. It gets no calls this way.
  nodeCheckIn(computer, body) {
    const live = this.liveFor(computer.id);
    live.lanProblem = typeof body.lanProblem === 'string' ? body.lanProblem.slice(0, 300) : null;
    if (ROUTES.includes(body.route) && body.route !== this.routeOf(computer)) {
      computer.route = body.route;
      this.save();
      this.bump();
    }
    return this.nodeSettings(computer.id);
  }

  result(computer, body) {
    const live = this.liveFor(computer.id);
    live.lastSeen = Date.now();
    const call = live.delivered.get(String(body.id));
    if (!call) return;
    live.delivered.delete(call.id);
    const outcome = body.outcome;
    call.resolve(outcome && typeof outcome.text === 'string'
      ? outcome
      : { text: 'the computer returned an unreadable result', isError: true });
  }

  // ---- The shared memory, from the phone app ----

  // The phone acts as the owner: its notes are locked unless it says otherwise, and its deletes and
  // undos wipe the text from the file, the same as `wanji memory` on the computer.
  handleMemory(action, method, body, lang = 'zh') {
    const memory = this.memory;
    if (!memory) return { status: 404, body: { error: lang === 'en' ? 'Shared memory is not turned on on this main computer' : '这台主电脑没有开启共享记忆' } };
    const id = typeof body?.id === 'string' ? body.id : undefined;
    try {
      if (!action && method === 'GET') {
        const notes = memory.all().map((e) => ({
          id: e.id,
          kind: e.kind,
          key: e.key ?? null,
          text: e.text,
          display_text: entryText(e, memory.clock()),
          project: e.project ?? null,
          state: e.state ?? null,
          computer: e.computer ?? null,
          tags: e.tags ?? [],
          author: e.author,
          owner: e.by === 'owner',
          locked: Boolean(e.locked),
          rev: e.rev,
          updated: e.updated,
          via: e.via ?? null,
        }));
        return { status: 200, body: { notes, stats: memory.stats(), authors: memory.authors() } };
      }
      if (method !== 'POST') return { status: 404, body: { error: 'not found' } };
      if (action === 'add') {
        const kind = body?.kind === 'handoff' ? 'handoff' : 'fact';
        const found = kind === 'fact' && body?.key ? memory.get({ key: body.key }) : null;
        const { entry } = memory.write({
          kind,
          text: body?.text,
          key: kind === 'fact' ? body?.key : undefined,
          computer: body?.computer || undefined,
          project: body?.project,
          state: body?.state,
          if_rev: found?.rev,
          by: 'owner',
          locked: body?.locked !== false,
        });
        return { status: 200, body: { id: entry.id } };
      }
      if (action === 'forget') {
        memory.forget({ id, by: 'owner' });
        return { status: 200, body: { ok: true } };
      }
      if (action === 'lock') {
        memory.setLock({ id }, body?.locked !== false);
        return { status: 200, body: { ok: true } };
      }
      if (action === 'revoke') {
        const all = body?.all === true;
        if (all && !Number.isFinite(body?.since)) return { status: 400, body: { error: lang === 'en' ? 'Undoing every AI’s writes needs a start time' : '撤销所有 AI 的写入时要给出起始时间' } };
        const { events } = memory.revoke({ author: all ? '*' : body?.author, since: body?.since });
        return { status: 200, body: { events } };
      }
    } catch (err) {
      if (err instanceof MemoryError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    return { status: 404, body: { error: 'not found' } };
  }

  // ---- Pairing and management ----

  // One use either way. `days` is for the one-click joiner EXE, which may sit in a
  // chat for a while before the new computer runs it; the phone's codes stay 10 minutes.
  createInvite({ days } = {}) {
    const now = Date.now();
    const code = newCode();
    const ttl = Number.isFinite(days) && days > 0 ? Math.min(days, MAX_INVITE_DAYS) * 86400000 : INVITE_MS;
    this.state.invites = this.state.invites.filter((invite) => invite.expires > now);
    this.state.invites.push({ hash: hashText(code), expires: now + ttl });
    this.save();
    const { host } = new URL(this.origin());
    return { code, host, origin: this.origin(), pair: formatPair(host, code), expiresIn: Math.round(ttl / 1000) };
  }

  // Voids every unused pairing code, e.g. a joiner EXE sent to the wrong person.
  cancelInvites() {
    const count = this.state.invites.filter((invite) => invite.expires > Date.now()).length;
    this.state.invites = [];
    this.save();
    return count;
  }

  uniqueName(wanted) {
    const base = cleanName(wanted).replace(/\s+/g, '-') || 'computer';
    const taken = new Set([this.selfName, ...Object.values(this.state.computers).map((c) => c.name)].filter(Boolean).map((n) => n.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // 主机预注册电脑，不用配对码：join file 本身就是凭证，要妥善保管，用完即删。
  createComputer(name, info) {
    const now = Date.now();
    const id = randomBytes(8).toString('hex');
    const key = randomBytes(32).toString('base64url');
    const computerName = this.uniqueName(name);
    this.state.computers[id] = {
      id, name: computerName, note: '', keyHash: hashText(key), addedAt: now, info: info && typeof info === 'object' ? info : {},
    };
    this.save();
    return { id, key, name: computerName };
  }

  hasInvite(code) {
    const wanted = hashText(String(code ?? '').replace(/-/g, '').toUpperCase());
    return this.state.invites.some((invite) => invite.expires > Date.now() && invite.hash === wanted);
  }

  join(body) {
    const now = Date.now();
    this.joinFailures = this.joinFailures.filter((at) => now - at < JOIN_WINDOW_MS);
    if (this.joinFailures.length >= MAX_JOIN_FAILURES) {
      return { status: 429, body: { error: 'too many wrong codes; try again in 10 minutes' } };
    }
    const wanted = hashText(String(body.code ?? '').replace(/-/g, '').toUpperCase());
    const index = this.state.invites.findIndex((invite) => invite.expires > now && invite.hash === wanted);
    if (index < 0) {
      this.joinFailures.push(now);
      return { status: 403, body: { error: 'this pairing code is wrong, expired or already used' } };
    }
    this.state.invites.splice(index, 1);
    const { id, key, name } = this.createComputer(body.name, body.info);
    return { status: 200, body: { id, key, name } };
  }

  nodeFor(req) {
    const key = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!key) return null;
    const wanted = hashText(key);
    return Object.values(this.state.computers).find((c) => sameSecret(c.keyHash, wanted)) || null;
  }

  isAdmin(req) {
    const key = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    return sameSecret(key, this.state.adminKey);
  }


  listClientTokens() {
    const entries = Array.isArray(this.state.clientTokens) ? this.state.clientTokens : [];
    return entries.map(({ id, name, tools, createdAt }) => ({
      id, name, tools: Array.isArray(tools) ? tools : [], createdAt,
    }));
  }

  authenticateClientToken(value) {
    if (typeof value !== 'string' || !value) return null;
    const wanted = hashText(value);
    const entry = (Array.isArray(this.state.clientTokens) ? this.state.clientTokens : [])
      .find((item) => sameSecret(item.keyHash, wanted));
    return entry ? { id: entry.id, name: entry.name, tools: Array.isArray(entry.tools) ? [...entry.tools] : [] } : null;
  }

  createClientToken(body) {
    const name = cleanName(body?.name);
    if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
    const catalog = this.toolCatalog?.() || [];
    const known = new Set(catalog.map((tool) => tool.name));
    if (!Array.isArray(body?.tools)) throw Object.assign(new Error('tools must be an array'), { status: 400 });
    const tools = [...new Set(body.tools.filter((item) => typeof item === 'string'))];
    if (!tools.length || tools.some((tool) => !known.has(tool))) {
      throw Object.assign(new Error('select at least one available tool'), { status: 400 });
    }
    this.state.clientTokens = Array.isArray(this.state.clientTokens) ? this.state.clientTokens : [];
    if (this.state.clientTokens.length >= 100) throw Object.assign(new Error('too many client tokens'), { status: 409 });
    const key = 'cmcp_' + randomBytes(32).toString('base64url');
    const entry = {
      id: randomBytes(8).toString('hex'),
      name,
      keyHash: hashText(key),
      tools: catalog.filter((tool) => tools.includes(tool.name)).map((tool) => tool.name),
      createdAt: new Date().toISOString(),
    };
    this.state.clientTokens.push(entry);
    this.save();
    return { token: { id: entry.id, name: entry.name, tools: entry.tools, createdAt: entry.createdAt }, key };
  }

  updateClientToken(id, body) {
    const entry = (Array.isArray(this.state.clientTokens) ? this.state.clientTokens : []).find((item) => item.id === id);
    if (!entry) return { status: 404, body: { error: 'no such token' } };
    const name = body.name === undefined ? entry.name : cleanName(body.name);
    if (!name) return { status: 400, body: { error: 'name is required' } };
    let tools = entry.tools;
    if (body.tools !== undefined) {
      const catalog = this.toolCatalog?.() || [];
      const known = new Set(catalog.map((tool) => tool.name));
      if (!Array.isArray(body.tools)) return { status: 400, body: { error: 'tools must be an array' } };
      const selected = [...new Set(body.tools.filter((item) => typeof item === 'string'))];
      if (!selected.length || selected.some((tool) => !known.has(tool))) {
        return { status: 400, body: { error: 'select at least one available tool' } };
      }
      tools = catalog.filter((tool) => selected.includes(tool.name)).map((tool) => tool.name);
    }
    entry.name = name;
    entry.tools = tools;
    this.save();
    return { status: 200, body: { token: { id: entry.id, name: entry.name, tools: entry.tools, createdAt: entry.createdAt } } };
  }

  deleteClientToken(id) {
    const entries = Array.isArray(this.state.clientTokens) ? this.state.clientTokens : [];
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.state.clientTokens = next;
    this.save();
    return true;
  }

  // ---- Browser takeover from the phone app, on any computer ----

  computerById(id) {
    if (id === 'self') return this.selfName ? { id: 'self', name: this.selfName } : null;
    return this.state.computers[id] || null;
  }

  async desktopOn(id, method, args) {
    if (id === 'self') return localHandoff(method, args);
    const computer = this.state.computers[id];
    if (!computer) return { text: 'no such computer', isError: true };
    return this.forward(computer, `_${method}`, args);
  }

  // Picks the browser window in front (or the first one open) and brings it forward.
  async browserStart(id) {
    const reply = await this.desktopOn(id, 'handoff_start', {});
    if (reply.isError) return reply;
    const session = this.browsers.get(id) || {};
    Object.assign(session, { hwnd: reply.hwnd, title: reply.title });
    this.browsers.set(id, session);
    return reply;
  }

  // A computer with only the AI's own browser has nothing to choose from.
  onlyAiBrowser(id) {
    const info = id === 'self' ? machineInfo() : this.state.computers[id]?.info;
    return Boolean(info && !info.desktop && info.browser);
  }

  async browserFrame(id) {
    let session = this.browsers.get(id);
    if (!session?.hwnd && this.onlyAiBrowser(id)) {
      const started = await this.browserStart(id);
      if (started.isError) return started;
      session = this.browsers.get(id);
    }
    if (!session?.hwnd) return { text: 'choose a browser window first', isError: true, pick: true };
    let reply = await this.desktopOn(id, 'handoff_frame', { hwnd: session.hwnd });
    // The helper restarted and forgot the window: select the same one again, never a different one.
    if (reply.isError && /not selected/.test(reply.text)) {
      const again = await this.browserSelect(id, session.hwnd);
      if (again.isError) return again;
      reply = await this.desktopOn(id, 'handoff_frame', { hwnd: session.hwnd });
    }
    if (reply.isError && /no longer available/.test(reply.text)) {
      session.hwnd = null;
      return { text: 'that browser window was closed; choose another', isError: true, pick: true };
    }
    return reply;
  }

  async browserWindows(id) {
    return this.desktopOn(id, 'handoff_list', {});
  }

  async browserSelect(id, hwnd) {
    const reply = await this.desktopOn(id, 'handoff_select', { hwnd: Number(hwnd) });
    if (reply.isError) return reply;
    const session = this.browsers.get(id) || {};
    Object.assign(session, { hwnd: reply.hwnd, title: reply.title });
    this.browsers.set(id, session);
    return reply;
  }

  async browserInput(id, body) {
    const session = this.browsers.get(id);
    if (!session?.hwnd) return { text: 'open the browser view first', isError: true };
    if (!BROWSER_ACTIONS.has(body.action)) return { text: 'unsupported action', isError: true };
    const args = { hwnd: session.hwnd, action: body.action };
    for (const field of ['x', 'y', 'to_x', 'to_y', 'amount']) if (typeof body[field] === 'number') args[field] = body[field];
    if (typeof body.text === 'string') args.text = body.text.slice(0, 2000);
    if (typeof body.keys === 'string') args.keys = body.keys.slice(0, 50);
    session.humanAt = Date.now();
    let result = await this.desktopOn(id, 'handoff_input', args);
    // The person is acting on this window, so bring it back if something covered it, then try once more.
    if (result.isError && /lost focus|minimized|covering the browser/.test(result.text)) {
      const again = await this.browserSelect(id, session.hwnd);
      if (again.isError) return again;
      result = await this.desktopOn(id, 'handoff_input', args);
    }
    return result;
  }

  browserFinish(id) {
    const session = this.browsers.get(id);
    if (!session) return;
    session.humanAt = 0;
    if (this.pendingRequest(session)) session.request.state = 'complete';
    this.bump();
  }

  pendingRequest(session) {
    const request = session?.request;
    if (request?.state === 'waiting' && Date.now() > request.created + TAKEOVER_MS) request.state = 'expired';
    return request?.state === 'waiting' ? request : null;
  }

  // While the person is on a computer's browser, the AI must not move the same mouse.
  browserLocked(id) {
    const session = this.browsers.get(id);
    return this.takeoverStarting.has(id) || Boolean(this.pendingRequest(session)) || Date.now() - (session?.humanAt || 0) < HUMAN_HOLD_MS;
  }

  // The AI's takeover tools: the request shows up in the phone app instead of as a link.
  async takeover(name, target, args = {}) {
    const id = target.self ? 'self' : target.computer.id;
    const computerName = target.self ? this.selfName : target.computer.name;
    if (name === 'request_human_takeover') {
      if (this.takeoverStarting.has(id) || this.pendingRequest(this.browsers.get(id))) return { text: 'A takeover is already pending for this computer.', isError: true };
      this.takeoverStarting.add(id);
      let started;
      try { started = await this.browserStart(id); } finally { this.takeoverStarting.delete(id); }
      if (started.isError) return started;
      const request = { id: randomBytes(6).toString('hex'), computerId: id, state: 'waiting', created: Date.now() };
      this.browsers.get(id).request = request;
      this.takeoverHistory.set(request.id, request);
      if (this.takeoverHistory.size > 1000) this.takeoverHistory.delete(this.takeoverHistory.keys().next().value);
      this.bump();
      return {
        text: `Asked the owner to take over the browser "${started.title}" on ${computerName} in the 万机 phone app.
id: ${request.id}
Tell the user to open the app, finish the verification and tap Return to AI. ui_act and browser on ${computerName} are blocked until then (15 minutes at most). Then call check_human_takeover with this id, and look again (browser look, or ui_look) before continuing.`,
      };
    }
    if (name === 'check_human_takeover') {
      const request = this.takeoverHistory.get(args.id);
      if (!request || request.computerId !== id) return { text: 'unknown takeover session', isError: true };
      this.pendingRequest({ request });
      return { text: `takeover on ${computerName}: ${request.state}` };
    }
    const session = this.browsers.get(id);
    if (session?.request?.state === 'waiting') session.request.state = 'cancelled';
    if (session) session.humanAt = 0;
    this.bump();
    return { text: `Takeover on ${computerName} cancelled; the desktop is the AI's again.` };
  }

  // ---- Saved accounts, typed without the AI seeing them ----

  // run(uiActArgs) performs ui_act on the right computer.
  async typeSecret(target, args, run) {
    const id = target.self ? 'self' : target.computer.id;
    const computerName = target.self ? this.selfName : target.computer.name;
    const hint = String(args.secret ?? '').trim().slice(0, 60);
    if (!hint) return { text: 'name the account in secret', isError: true };
    const part = args.part === 'username' ? 'username' : 'password';
    const where = [args.window && `window "${args.window}"`, args.target && `field "${args.target}"`, args.element_id !== undefined && `element ${args.element_id}`]
      .filter(Boolean).join(', ');
    const request = {
      id: randomBytes(6).toString('hex'), computerId: id, computer: computerName, hint, part,
      reason: String(args.reason ?? '').slice(0, 200), where, created: Date.now(), waiters: [],
    };
    this.secretRequests.set(request.id, request);
    this.bump();
    const grant = await new Promise((resolve) => {
      request.waiters.push(resolve);
      setTimeout(() => {
        if (this.secretRequests.delete(request.id)) this.bump();
        resolve(null);
      }, SECRET_WAIT_MS).unref();
    });
    if (grant === 'denied') return { text: `The owner declined to use "${hint}" on ${computerName}. Do not ask again unless they tell you to.`, isError: true };
    if (!grant) return { text: `The owner has not picked an account for "${hint}" yet. Ask them to open the 万机 app, then call type_secret again.`, isError: true };
    if (this.browserLocked(id)) return { text: 'The owner is using this computer’s browser; the approved fill was not performed. Request approval again after takeover ends.', isError: true };
    const value = grant[part];
    if (!value) return { text: `The saved account "${grant.label}" has no ${part}.`, isError: true };
    const first = { action: 'type', text: value };
    for (const field of ['target', 'element_id', 'window']) if (args[field] !== undefined) first[field] = args[field];
    // Clearing is select-all and delete, which outside a named field could wipe a whole document.
    if (args.target !== undefined || args.element_id !== undefined) first.clear = true;
    // Keys go only to a named window, so Enter must name the same one as the typing.
    const enter = { action: 'key', keys: 'enter', ...(args.window !== undefined ? { window: args.window } : {}) };
    const steps = [first, ...(args.press_enter ? [enter] : [])];
    const result = await run({ steps, observe: false });
    // Whatever the computer said back, the value itself must not reach the AI.
    const scrub = (text) => String(text ?? '').split(value).join('***');
    if (result.isError) return { text: `Typing the ${part} failed: ${scrub(result.text)}`, isError: true };
    return { text: `Typed the ${part} of the saved account "${grant.label}" on ${computerName}${args.press_enter ? ' and pressed Enter' : ''}. The value is never shown to you; use ui_look to check the result.` };
  }

  answerSecret(requestId, body) {
    const request = this.secretRequests.get(requestId);
    if (!request) return false;
    this.secretRequests.delete(requestId);
    if (body.approve === true && (typeof body.username === 'string' || typeof body.password === 'string')) {
      const grant = {
        label: String(body.label || request.hint).slice(0, 60),
        username: typeof body.username === 'string' ? body.username : '',
        password: typeof body.password === 'string' ? body.password : '',
      };
      for (const wake of request.waiters) wake(grant);
    } else {
      for (const wake of request.waiters) wake('denied');
    }
    this.bump();
    return true;
  }

  // ---- Vault metadata: labels and usernames only, synced from the phone app ----
  // The vault itself stays on the phone, encrypted; only its labels, usernames and
  // the owner's auto-allow flag ever reach the hub, so the AI can tell accounts apart
  // before typing. A password sent here by mistake is dropped, never stored, and never
  // returned. The flag itself is set only in the phone app, never by any MCP tool.

  setVaultMeta(entries) {
    if (!Array.isArray(entries)) throw Object.assign(new Error('entries must be an array'), { status: 400 });
    if (entries.length > 100) throw Object.assign(new Error('too many accounts'), { status: 400 });
    const next = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw Object.assign(new Error('each account needs id, label and username'), { status: 400 });
      const id = String(entry.id ?? '').trim().slice(0, 80);
      const label = String(entry.label ?? '').trim().slice(0, 60);
      const username = String(entry.username ?? '').trim().slice(0, 120);
      if (!id || !label) throw Object.assign(new Error('each account needs id, label and username'), { status: 400 });
      next.set(id, { id, label, username, autoAllow: entry.autoAllow === true });
    }
    this.vaultAccounts = next;
    this.bump();
    return this.vaultAccountList();
  }

  vaultAccountList() {
    return [...this.vaultAccounts.values()]
      .map(({ id, label, username, autoAllow }) => ({ id, label, username, autoAllow: autoAllow === true }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  secretList() {
    const accounts = this.vaultAccountList();
    if (!accounts.length) return { text: 'No saved accounts have been shared from the phone app yet. Ask the owner to open the 万机 app so it can sync them, then call secret_list again.' };
    return { text: JSON.stringify({ accounts }, null, 2) };
  }

  // Answers at once when something changed since the app's last look, otherwise when something does.
  waitForEvent(since, res) {
    if (String(since) !== String(this.version)) {
      reply(res, 200, { version: this.version });
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      if (!res.destroyed) reply(res, 200, { version: this.version });
    };
    const timer = setTimeout(() => {
      this.eventWaiters.delete(wake);
      wake();
    }, EVENT_HOLD_MS);
    this.eventWaiters.add(wake);
    res.once('close', () => {
      clearTimeout(timer);
      this.eventWaiters.delete(wake);
    });
  }

  status() {
    const origin = this.origin();
    const token = this.getToken();
    return {
      version: this.version,
      mcp: { full: `${origin}/t/${token}/mcp`, address: `${origin}/mcp`, key: token },
      secretRequests: [...this.secretRequests.values()].map(({ id, computer, hint, part, reason, where }) => ({ id, computer, hint, part, reason, where })),
      vaultAccounts: this.vaultAccounts.size,
      computers: [
        ...(this.selfName ? [{
          id: 'self', name: this.selfName, note: this.state.selfNote || '', online: true, main: true, os: machineInfo().os, desktop: desktopSupported, browser: browserInstalled(), takeover: this.takeoverOf('self'),
        }] : []),
        ...Object.values(this.state.computers).map((c) => ({
          id: c.id,
          name: c.name,
          note: c.note || '',
          online: this.isOnline(c.id),
          main: false,
          os: c.info?.os || '',
          lastSeen: this.lastSeenOf(c),
          desktop: c.info?.desktop === true,
          browser: c.info?.browser === true,
          takeover: this.takeoverOf(c.id),
          route: this.routeOf(c),
          via: this.isOnline(c.id) ? this.live.get(c.id)?.via || null : null,
          lanProblem: this.live.get(c.id)?.lanProblem || null,
        })),
      ],
    };
  }

  takeoverOf(id) {
    const session = this.browsers.get(id);
    return this.pendingRequest(session) ? { title: session.title || '' } : null;
  }

  remove(id) {
    this.browsers.delete(id);
    const computer = this.state.computers[id];
    if (!computer) return false;
    const live = this.live.get(id);
    if (live) {
      this.failPending(live, {
        queued: `computer "${computer.name}" was removed, so this was not run.`,
        delivered: `computer "${computer.name}" was removed while running this.`,
      });
      this.answerWaiter(live, { calls: [] });
      this.live.delete(id);
    }
    delete this.state.computers[id];
    this.save();
    return true;
  }

  update(id, body) {
    const note = body.note === undefined ? undefined : String(body.note).slice(0, 200);
    if (id === 'self' && this.selfName) {
      if (note !== undefined) this.state.selfNote = note;
      this.save();
      return { status: 200, body: { ok: true } };
    }
    const computer = this.state.computers[id];
    if (!computer) return { status: 404, body: { error: 'no such computer' } };
    if (body.route !== undefined && !ROUTES.includes(body.route)) return { status: 400, body: { error: 'route must be auto, lan or public' } };
    if (note !== undefined) computer.note = note;
    if (body.route !== undefined) computer.route = body.route;
    if (body.name !== undefined) {
      const name = cleanName(body.name).replace(/\s+/g, '-');
      const other = this.resolve(name);
      if (!name || (other && other.computer?.id !== id)) return { status: 409, body: { error: 'that name is empty or already used' } };
      computer.name = name;
    }
    this.save();
    // A waiting poll answers now, so the computer switches routes at once.
    if (body.route !== undefined && this.live.has(id)) this.answerWaiter(this.live.get(id), { calls: [] });
    return { status: 200, body: { ok: true } };
  }

  async handleBrowser(req, res, id, action) {
    if (!this.computerById(id)) {
      reply(res, 404, { error: 'no such computer' });
      return;
    }
    let result;
    if (action === 'frame') {
      result = await this.browserFrame(id);
      if (!result.isError && result.image) {
        const bytes = Buffer.from(result.image.data, 'base64');
        const title = encodeURIComponent(this.browsers.get(id)?.title || '');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Window-Title': title });
        res.end(bytes);
        return;
      }
    } else if (action === 'windows') {
      result = await this.browserWindows(id);
      if (!result.isError) {
        reply(res, 200, { windows: result.windows || [], selected: this.browsers.get(id)?.hwnd || null });
        return;
      }
    } else if (action === 'select') {
      result = await this.browserSelect(id, (await readJson(req)).hwnd);
    } else if (action === 'start') {
      const session = this.browsers.get(id);
      result = session?.hwnd ? await this.browserSelect(id, session.hwnd) : { text: 'choose a browser window first', isError: true, pick: true };
    } else if (action === 'input') {
      result = await this.browserInput(id, await readJson(req));
    } else {
      this.browserFinish(id);
      result = { text: 'returned to AI' };
    }
    if (result.isError) reply(res, 409, { error: friendlyBrowserError(result.text, langOf(req)), pick: result.pick === true });
    else reply(res, 200, { ok: true, title: this.browsers.get(id)?.title || '' });
  }

  async handleNode(computer, pathname, req, res, via) {
    if (pathname === '/hub/node/poll' && req.method === 'POST') {
      this.poll(computer, await readJson(req), res, via);
    } else if (pathname === '/hub/node/result' && req.method === 'POST') {
      this.result(computer, await readJson(req));
      reply(res, 200, { ok: true });
    } else if (pathname === '/hub/node/settings' && req.method === 'POST') {
      reply(res, 200, this.nodeCheckIn(computer, await readJson(req)));
    } else if (pathname === '/hub/node/ping') {
      reply(res, 200, { ok: true });
    } else {
      reply(res, 404, { error: 'not found' });
    }
  }

  // Requests that came in on the LAN port, already authenticated by the TLS key: only a
  // computer's own polling. The MCP link and the phone API are never served there.
  async handleLan(req, res, identity) {
    const computer = this.state.computers[identity.slice(2)];
    const { pathname } = new URL(req.url, 'https://lan');
    if (!identity.startsWith('n:') || !computer || !pathname.startsWith('/hub/node/')) {
      reply(res, 404, { error: 'not found' });
      return;
    }
    try {
      await this.handleNode(computer, pathname, req, res, 'lan');
    } catch (err) {
      if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
      else res.end();
    }
  }

  // Returns false when the path is not the hub's.
  async handle(req, res, pathname) {
    if (!pathname.startsWith('/hub/')) return false;
    try {
      if (pathname === '/hub/join' && req.method === 'POST') {
        const result = this.join(await readJson(req));
        reply(res, result.status, result.body);
        return true;
      }
      if (pathname.startsWith('/hub/node/')) {
        const computer = this.nodeFor(req);
        if (!computer) {
          reply(res, 401, { error: 'this computer has been removed' });
          return true;
        }
        await this.handleNode(computer, pathname, req, res, 'public');
        return true;
      }
      if (pathname.startsWith('/hub/api/')) {
        if (!this.isAdmin(req)) {
          reply(res, 401, { error: 'unauthorized' });
          return true;
        }
        const action = pathname.slice('/hub/api/'.length);
        if (action === 'token-tools' && req.method === 'GET') {
          reply(res, 200, { tools: this.toolCatalog?.() || [] });
          return true;
        }
        if (action === 'tokens' && req.method === 'GET') {
          reply(res, 200, { tokens: this.listClientTokens() });
          return true;
        }
        if (action === 'tokens' && req.method === 'POST') {
          reply(res, 201, this.createClientToken(await readJson(req)));
          return true;
        }
        const tokenId = /^tokens\/([a-f0-9]+)$/.exec(action)?.[1];
        if (tokenId && req.method === 'DELETE') {
          reply(res, this.deleteClientToken(tokenId) ? 200 : 404, { ok: true });
          return true;
        }
        if (tokenId && req.method === 'POST') {
          const result = this.updateClientToken(tokenId, await readJson(req));
          reply(res, result.status, result.body);
          return true;
        }
        if (action === 'activity' && req.method === 'GET') {
          res.setHeader('Cache-Control', 'no-store');
          reply(res, 200, { active: [...this.activeCalls.values()].reverse(), recent: this.recentCalls });
          return true;
        }
        if (action === 'status' && req.method === 'GET') {
          reply(res, 200, this.status());
          return true;
        }
        if (action === 'wait' && req.method === 'GET') {
          this.waitForEvent(new URL(req.url, 'http://localhost').searchParams.get('since'), res);
          return true;
        }
        const secret = /^secrets\/([a-f0-9]+)$/.exec(action)?.[1];
        if (secret && req.method === 'POST') {
          const answered = this.answerSecret(secret, await readJson(req));
          reply(res, answered ? 200 : 404, answered ? { ok: true } : { error: 'this request has expired' });
          return true;
        }
        // Vault metadata from the phone app: labels and usernames only.
        if (action === 'vault-meta' && req.method === 'POST') {
          const saved = this.setVaultMeta((await readJson(req))?.entries);
          reply(res, 200, { accounts: saved });
          return true;
        }
        if (action === 'invites' && req.method === 'POST') {
          reply(res, 200, this.createInvite({ days: (await readJson(req))?.days }));
          return true;
        }
        if (action === 'invites' && req.method === 'DELETE') {
          reply(res, 200, { cancelled: this.cancelInvites() });
          return true;
        }
        if (action === 'computers' && req.method === 'POST') {
          const created = this.createComputer((await readJson(req))?.name);
          reply(res, 201, { ...created, origin: this.origin() });
          return true;
        }
        const memoryAction = /^memory(?:\/(add|forget|lock|revoke))?$/.exec(action);
        if (memoryAction) {
          const done = this.handleMemory(memoryAction[1], req.method, memoryAction[1] ? await readJson(req) : null, langOf(req));
          reply(res, done.status, done.body);
          return true;
        }
        const browser = /^computers\/([a-z0-9]+)\/browser\/(frame|input|start|finish|windows|select)$/.exec(action);
        if (browser) {
          await this.handleBrowser(req, res, browser[1], browser[2]);
          return true;
        }
        const id = /^computers\/([a-z0-9]+)$/.exec(action)?.[1];
        if (id && req.method === 'DELETE') {
          reply(res, this.remove(id) ? 200 : 404, { ok: true });
          return true;
        }
        // POST as well, because Android's HttpURLConnection cannot send PATCH.
        if (id && (req.method === 'PATCH' || req.method === 'POST')) {
          const result = this.update(id, await readJson(req));
          reply(res, result.status, result.body);
          return true;
        }
      }
      reply(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
      else res.end();
    }
    return true;
  }
}
