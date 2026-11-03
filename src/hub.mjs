import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callDesktop, desktopSupported } from './desktop.mjs';
import { findBash } from './shell.mjs';
import { PublicPool } from './public-pool.mjs';

const POLL_HOLD_MS = 25000;
// A node polls again at once, so this much silence means it is gone.
const OFFLINE_MS = 45000;
const INVITE_MS = 10 * 60 * 1000;
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
// One approval covers the username and the password of a login for this long.
const SECRET_GRANT_MS = 10 * 60 * 1000;
const EVENT_HOLD_MS = 25000;

export const SECRET_TOOL = {
  name: 'type_secret',
  description: 'Type a saved username or password into the computer without ever seeing it. The owner keeps accounts in the Computer MCP phone app; the first use asks them on the phone to pick the account and allow it, which can take a minute. Click into the field first, or name it with target or element_id, then call this once for the username and once for the password. The reply never contains the value. Use this for logins instead of asking for passwords in chat, and only type into the login form the owner expects.',
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
    shells: findBash() ? ['bash', 'powershell'] : [process.platform === 'win32' ? 'powershell' : 'sh'],
    desktop: desktopSupported,
  };
}

// What the phone shows when the browser view cannot work.
function friendlyBrowserError(text) {
  const known = [
    [/Open Chrome, Edge or Firefox/i, '这台电脑上没有打开浏览器。请先打开 Chrome、Edge 或 Firefox'],
    [/lost focus|minimized/i, '浏览器被别的窗口挡住了，画面暂停；你一操作就会自动切回来'],
    [/covering the browser/i, '有别的窗口挡住了浏览器'],
    [/elevated/i, '浏览器以管理员身份运行，Windows 不允许这样操作'],
    [/offline/i, '这台电脑不在线'],
    [/locked|secure desktop|lock screen/i, '电脑锁屏了，或者正在弹出系统权限确认，需要在电脑上处理'],
    [/no desktop control|not available on this computer/i, '这台电脑没有安装桌面控制'],
    [/choose a browser|choose another/i, '请先选择要看的浏览器窗口'],
  ];
  for (const [pattern, message] of known) if (pattern.test(text)) return message;
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
    state = { adminKey: randomBytes(32).toString('base64url'), selfNote: '', computers: {}, invites: [] };
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
    this.joinFailures = [];
    this.browsers = new Map();
    this.secretRequests = new Map();
    this.grants = new Map();
    this.version = 0;
    this.eventWaiters = new Set();
    this.pool = new PublicPool(file.replace(/\.json$/i, '.pool.sqlite'), () => this.bump());
    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.sweeper.unref();
  }

  close() {
    this.pool.close();
    clearInterval(this.sweeper);
    for (const live of this.live.values()) this.answerWaiter(live, { calls: [] });
  }

  save() {
    saveHubState(this.file, this.state);
  }

  liveFor(id) {
    let live = this.live.get(id);
    if (!live) {
      live = { lastSeen: 0, boot: null, waiter: null, queue: [], delivered: new Map() };
      this.live.set(id, live);
    }
    return live;
  }

  isOnline(id) {
    const live = this.live.get(id);
    return Boolean(live) && Date.now() - live.lastSeen < OFFLINE_MS;
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
      return Promise.resolve({ text: `computer "${computer.name}" is offline, so nothing was run. Use list_computers to see which computers are online.`, isError: true });
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
    reply(waiter.res, 200, body);
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
    for (const [key, grant] of this.grants) if (grant.expires < now) this.grants.delete(key);
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

  poll(computer, body, res) {
    const live = this.liveFor(computer.id);
    live.lastSeen = Date.now();
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
    const timer = setTimeout(() => this.answerWaiter(live, { calls: [] }), POLL_HOLD_MS);
    live.waiter = { res, timer };
    res.once('close', () => {
      if (live.waiter?.res === res) {
        clearTimeout(timer);
        live.waiter = null;
      }
    });
    this.flush(live);
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

  // ---- Pairing and management ----

  createInvite() {
    const now = Date.now();
    const code = newCode();
    this.state.invites = this.state.invites.filter((invite) => invite.expires > now);
    this.state.invites.push({ hash: hashText(code), expires: now + INVITE_MS });
    this.save();
    const { host } = new URL(this.origin());
    return { code, host, pair: formatPair(host, code), expiresIn: INVITE_MS / 1000 };
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
    const id = randomBytes(8).toString('hex');
    const key = randomBytes(32).toString('base64url');
    const name = this.uniqueName(body.name);
    this.state.computers[id] = {
      id, name, note: '', keyHash: hashText(key), addedAt: now, info: body.info && typeof body.info === 'object' ? body.info : {},
    };
    this.save();
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

  // ---- Browser takeover from the phone app, on any computer ----

  computerById(id) {
    if (id === 'self') return this.selfName ? { id: 'self', name: this.selfName } : null;
    return this.state.computers[id] || null;
  }

  async desktopOn(id, method, args) {
    if (id === 'self') {
      if (!desktopSupported) return { text: 'this computer has no desktop control', isError: true };
      return callDesktop(method, args).catch((err) => ({ text: err.message, isError: true }));
    }
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

  async browserFrame(id) {
    const session = this.browsers.get(id);
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
    if (session.request?.state === 'waiting') session.request.state = 'complete';
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
    return Boolean(this.pendingRequest(session)) || Date.now() - (session?.humanAt || 0) < HUMAN_HOLD_MS;
  }

  // The AI's takeover tools: the request shows up in the phone app instead of as a link.
  async takeover(name, target) {
    const id = target.self ? 'self' : target.computer.id;
    const computerName = target.self ? this.selfName : target.computer.name;
    if (name === 'request_human_takeover') {
      const started = await this.browserStart(id);
      if (started.isError) return started;
      const request = { id: randomBytes(6).toString('hex'), state: 'waiting', created: Date.now() };
      this.browsers.get(id).request = request;
      this.bump();
      return {
        text: `Asked the owner to take over the browser "${started.title}" on ${computerName} in the Computer MCP phone app.
id: ${request.id}
Tell the user to open the app, finish the verification and tap Return to AI. ui_act on ${computerName} is blocked until then (15 minutes at most). Then call check_human_takeover with this id, and ui_look before continuing.`,
      };
    }
    if (name === 'check_human_takeover') {
      return { text: `takeover on ${computerName}: ${this.pendingRequest(this.browsers.get(id)) ? 'waiting' : this.browsers.get(id)?.request?.state || 'none'}` };
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
    const key = `${id}\n${hint.toLowerCase()}`;
    let grant = this.grants.get(key);
    if (grant && grant.expires < Date.now()) {
      this.grants.delete(key);
      grant = null;
    }
    if (!grant) {
      let request = [...this.secretRequests.values()].find((r) => r.key === key);
      if (!request) {
        const where = [args.window && `window "${args.window}"`, args.target && `field "${args.target}"`, args.element_id !== undefined && `element ${args.element_id}`]
          .filter(Boolean).join(', ');
        request = {
          id: randomBytes(6).toString('hex'), key, computerId: id, computer: computerName, hint, part,
          reason: String(args.reason ?? '').slice(0, 200), where, created: Date.now(), waiters: [],
        };
        this.secretRequests.set(request.id, request);
        this.bump();
      }
      const answer = await new Promise((resolve) => {
        request.waiters.push(resolve);
        setTimeout(() => resolve(null), SECRET_WAIT_MS).unref();
      });
      if (answer === 'denied') return { text: `The owner declined to use "${hint}" on ${computerName}. Do not ask again unless they tell you to.`, isError: true };
      grant = this.grants.get(key);
      if (!grant) return { text: `The owner has not picked an account for "${hint}" yet. Ask them to open the Computer MCP app, then call type_secret again.`, isError: true };
    }
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
      this.grants.set(request.key, {
        label: String(body.label || request.hint).slice(0, 60),
        username: typeof body.username === 'string' ? body.username : '',
        password: typeof body.password === 'string' ? body.password : '',
        expires: Date.now() + SECRET_GRANT_MS,
      });
      for (const wake of request.waiters) wake('approved');
    } else {
      for (const wake of request.waiters) wake('denied');
    }
    this.bump();
    return true;
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
      computers: [
        ...(this.selfName ? [{
          id: 'self', name: this.selfName, note: this.state.selfNote || '', online: true, main: true, os: machineInfo().os, desktop: desktopSupported, takeover: this.takeoverOf('self'),
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
          takeover: this.takeoverOf(c.id),
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
    if (note !== undefined) computer.note = note;
    if (body.name !== undefined) {
      const name = cleanName(body.name).replace(/\s+/g, '-');
      const other = this.resolve(name);
      if (!name || (other && other.computer?.id !== id)) return { status: 409, body: { error: 'that name is empty or already used' } };
      computer.name = name;
    }
    this.save();
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
    if (result.isError) reply(res, 409, { error: friendlyBrowserError(result.text), pick: result.pick === true });
    else reply(res, 200, { ok: true, title: this.browsers.get(id)?.title || '' });
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
        if (pathname === '/hub/node/poll' && req.method === 'POST') {
          this.poll(computer, await readJson(req), res);
          return true;
        }
        if (pathname === '/hub/node/result' && req.method === 'POST') {
          this.result(computer, await readJson(req));
          reply(res, 200, { ok: true });
          return true;
        }
        reply(res, 404, { error: 'not found' });
        return true;
      }
      if (pathname.startsWith('/hub/api/')) {
        if (!this.isAdmin(req)) {
          reply(res, 401, { error: 'unauthorized' });
          return true;
        }
        const action = pathname.slice('/hub/api/'.length);
        if (action === 'pool' && req.method === 'GET') {
          const params = new URL(req.url, 'http://localhost').searchParams;
          const cursor = params.get('after_seq');
          const afterSeq = cursor === null ? undefined : Number(cursor);
          const limit = params.has('limit') ? Number(params.get('limit')) : 50;
          if ((afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) || !Number.isSafeInteger(limit) || limit < 1) {
            reply(res, 400, { error: 'invalid pool cursor or limit' });
          } else reply(res, 200, this.pool.feed({ afterSeq, limit }));
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
        if (action === 'invites' && req.method === 'POST') {
          reply(res, 200, this.createInvite());
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
