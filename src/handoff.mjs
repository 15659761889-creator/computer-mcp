import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callDesktop, desktopSupported } from './desktop.mjs';

const PAGE = fileURLToPath(new URL('../web/handoff.html', import.meta.url));
const TTL = 15 * 60 * 1000;
const IDLE = 5 * 60 * 1000;
export const HANDOFF_TOOLS = [
  {
    name: 'request_human_takeover',
    description: 'Ask the human to take over the currently active Windows browser window. Returns a temporary, browser-openable handoff link; tell the user to open it on their phone, complete the verification, tap Return to AI, and then say continue. During the takeover AI ui_act calls are blocked. The page never receives the full MCP credential. Only use when human interaction is required.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Hand browser control to human', openWorldHint: true }
  },
  {
    name: 'check_human_takeover',
    description: 'Check the temporary browser handoff state. Returns waiting, complete, expired, or cancelled. If complete, continue with a fresh ui_look.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'ID returned by request_human_takeover' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Check human handoff', readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'cancel_human_takeover',
    description: 'Revoke the active temporary human takeover link and return desktop control to AI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Cancel human handoff', openWorldHint: false }
  }
];

const random = () => randomBytes(32).toString('base64url');
const equal = (a,b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(Buffer.from(a.padEnd(100).slice(0,100)), Buffer.from(b.padEnd(100).slice(0,100))) && a.length === b.length;
};
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const pieces = [];
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024) { reject(new Error('request too large')); req.destroy(); } else pieces.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(pieces).toString('utf8'))); } catch { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

export class HandoffManager {
  constructor(publicOrigin = () => null) {
    this.publicOrigin = publicOrigin;
    this.session = null;
    this.previous = new Map();
    this.pendingStart = false;
  }
  status(session = this.session) {
    if (!session) return 'none';
    if (session.state !== 'waiting') return session.state;
    if (Date.now() >= session.deadline || Date.now() >= session.lastAccess + IDLE) {
      session.state = 'expired';
    }
    return session.state;
  }
  locked() { return this.status() === 'waiting' || this.pendingStart; }
  async invoke(name, args) {
    if (name === 'request_human_takeover') {
      if (!desktopSupported) return { text: 'Human takeover requires Windows desktop control', isError: true };
      if (this.locked()) return { text: 'A handoff is already active; use check_human_takeover.', isError: true };
      this.pendingStart = true;
      try {
        const reply = await callDesktop('handoff_start', {});
        if (reply.isError) return { text: reply.text, isError: true };
        const origin = this.publicOrigin();
        if (!origin || !/^https:\/\/[^/]+$/i.test(origin)) return { text: 'Public HTTPS origin not configured; launch quick tunnel or fixed service.', isError: true };
        const id = randomBytes(8).toString('hex');
        const secret = random();
        const now = Date.now();
        this.session = { id, secret, hwnd: reply.hwnd, title: reply.title, created: now, deadline: now + TTL, lastAccess: now, state: 'waiting' };
        this.previous.set(id, this.session);
        // The secret is in the URL fragment, so HTTP requests / reverse-proxy logs never contain it.
        const url = origin + '/handoff#key=' + secret;
        return { text: 'Human browser takeover ready.\nid: ' + id + '\nwindow: ' + reply.title + '\nopen on phone: ' + url +
          '\nValid up to 15 minutes, expires after 5 minutes idle. Do not share this link. Ask the human to tap Return to AI, then continue.' };
      } finally {
        this.pendingStart = false;
      }
    }
    if (name === 'check_human_takeover') {
      const s = this.previous.get(args?.id);
      if (!s) return { text: 'unknown session', isError: true };
      return { text: 'handoff ' + s.id + ': ' + this.status(s) + '; window: ' + s.title };
    }
    if (name === 'cancel_human_takeover') {
      if (this.session && this.status() === 'waiting') this.session.state = 'cancelled';
      return { text: 'Human takeover cancelled; desktop control returned to AI.' };
    }
    return { text: 'unknown handoff tool', isError: true };
  }
  auth(req) {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1];
    const s = this.session;
    if (!s || !equal(bearer, s.secret) || this.status() !== 'waiting') return null;
    s.lastAccess = Date.now();
    return s;
  }
  async handle(req, res, pathname) {
    if (pathname === '/handoff' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      });
      res.end(fs.readFileSync(PAGE));
      return true;
    }
    if (!pathname.startsWith('/handoff/api/')) return false;
    const s = this.auth(req);
    if (!s) { json(res, 401, { error: 'Session expired, finished or unauthorized' }); return true; }
    const action = pathname.slice('/handoff/api/'.length);
    try {
      if (action === 'status' && req.method === 'GET') {
        json(res, 200, { state: this.status(), title: s.title, expiresIn: Math.max(0, Math.floor((s.deadline - Date.now()) / 1000)) });
      } else if (action === 'frame' && req.method === 'GET') {
        const frame = await callDesktop('handoff_frame', { hwnd: s.hwnd });
        if (frame.isError) { json(res, 409, { error: frame.text }); return true; }
        const bytes = Buffer.from(frame.image.data, 'base64');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
      } else if (action === 'input' && req.method === 'POST') {
        const data = await readJson(req);
        if (!['click','double_click','right_click','drag','scroll','type','key'].includes(data.action)) { json(res, 400, { error: 'unsupported action' }); return true; }
        const result = await callDesktop('handoff_input', { ...data, hwnd: s.hwnd });
        json(res, result.isError ? 409 : 200, result.isError ? { error: result.text } : { ok: true, message: result.text });
      } else if (action === 'finish' && req.method === 'POST') {
        s.state = 'complete';
        json(res, 200, { ok: true, state: 'complete' });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.end();
    }
    return true;
  }
}
