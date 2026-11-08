import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createLicense, extendLicense, licenseExpiryTime, licensesDir, listLicenses, revokeLicense } from './license.mjs';
import { writePrivateFile } from './private-file.mjs';

// The relay operator's control panel: service checks, Pro keys and accounts. It runs inside
// the relay process (so it sees which computers are online) but listens on 127.0.0.1 only,
// never through the public port or tunnel. A random token in the path keeps other web
// pages on this computer from driving it; the Host and Origin checks stop DNS rebinding.

export const DEFAULT_PANEL_PORT = 8771;
const CHECK_TIMEOUT_MS = 8000;
const DAYS_PER_MONTH = 31;

const tokenFile = (dir) => path.join(dir, 'panel-token');

export function panelToken(dir) {
  try {
    const token = fs.readFileSync(tokenFile(dir), 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {
    // Made below.
  }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(dir, { recursive: true });
  writePrivateFile(tokenFile(dir), `${token}\n`);
  return token;
}

export const panelPort = (config) => config.panelPort || DEFAULT_PANEL_PORT;
export const panelUrl = (dir, config) => `http://127.0.0.1:${panelPort(config)}/p/${panelToken(dir)}/`;

const digest = (value) => createHash('sha256').update(String(value)).digest();
const sameToken = (a, b) => typeof a === 'string' && timingSafeEqual(digest(a), digest(b));

let appVersion = null;
function version() {
  if (appVersion) return appVersion;
  try {
    appVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    appVersion = '?';
  }
  return appVersion;
}

async function check(name, url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: 'manual' });
    await res.arrayBuffer().catch(() => null);
    return { name, url, ok: res.status < 400, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { name, url, ok: false, error: err.cause?.code || err.name || 'error', ms: Date.now() - started };
  }
}

function licenseRow({ keyHash, record }) {
  const expires = licenseExpiryTime(record.expiresAt);
  return {
    id: keyHash.slice(0, 8),
    buyer: record.email,
    status: record.status === 'active' && expires <= Date.now() ? 'expired' : record.status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    machines: record.machines?.length || 0,
  };
}

export function panelStatus(relay, startedAt) {
  const licenses = listLicenses(licensesDir());
  const byHash = new Map(licenses.map((entry) => [entry.keyHash, entry]));
  const accounts = [...relay.hubs.entries()].map(([id, hub]) => {
    const lic = hub.state.license?.keyHash ? byHash.get(hub.state.license.keyHash) : null;
    return {
      id,
      createdAt: hub.state.createdAt || null,
      license: lic ? licenseRow(lic) : null,
      computers: hub.listComputers().computers.map((c) => ({
        name: c.name, online: c.online, connection: c.connection || null, lastSeen: c.last_seen || null, os: c.os || null,
      })),
    };
  });
  return {
    version: version(),
    origin: relay.origin(),
    startedAt,
    accounts,
    licenses: licenses.map(licenseRow),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

export function panelHandler(relay, { dir, config, startedAt = new Date().toISOString() }) {
  const token = panelToken(dir);
  const port = panelPort(config);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const checks = () => [
    { name: '中继（公网）', url: `${relay.origin()}/healthz` },
    { name: '中继（本机）', url: `http://127.0.0.1:${config.port || 8770}/healthz` },
    ...(Array.isArray(config.panelChecks) ? config.panelChecks.filter((c) => c && c.name && c.url) : []),
  ];
  return async (req, res) => {
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'forbidden' });
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    const match = /^\/p\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match || !sameToken(match[1], token)) return send(res, 404, { error: 'not found' });
    const sub = match[2] || '/';
    if (sub === '/' && req.method === 'GET') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (sub === '/api/status' && req.method === 'GET') return send(res, 200, panelStatus(relay, startedAt));
    if (sub === '/api/checks' && req.method === 'GET') return send(res, 200, { checks: await Promise.all(checks().map((c) => check(c.name, c.url))) });
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    // A cross-site form cannot send JSON, and a page elsewhere has another Origin.
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^http:\/\//, '').toLowerCase())) return send(res, 403, { error: 'forbidden' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    const months = Number(body.months);
    const validMonths = Number.isInteger(months) && months >= 1 && months <= 36;
    if (sub === '/api/licenses/create') {
      const buyer = String(body.buyer || '').trim();
      if (!buyer || buyer.length > 120) return send(res, 400, { error: '请填写买家（微信号或备注）' });
      if (!validMonths) return send(res, 400, { error: '月数要在 1 到 36 之间' });
      const { key, record } = createLicense(licensesDir(), { email: buyer, days: months * DAYS_PER_MONTH });
      relay.log(`panel: key made for ${buyer}, ${months} month(s)`);
      return send(res, 200, { key, expiresAt: record.expiresAt });
    }
    if (sub === '/api/licenses/extend') {
      if (!validMonths) return send(res, 400, { error: '月数要在 1 到 36 之间' });
      const done = extendLicense(licensesDir(), String(body.id || ''), months * DAYS_PER_MONTH);
      if (!done) return send(res, 404, { error: '找不到这个有效的密钥（已作废的不能续费）' });
      relay.log(`panel: ${done.keyHash.slice(0, 8)} extended by ${months} month(s)`);
      return send(res, 200, { expiresAt: done.record.expiresAt });
    }
    if (sub === '/api/licenses/revoke') {
      const done = revokeLicense(licensesDir(), String(body.id || ''));
      if (!done) return send(res, 404, { error: '找不到这个密钥' });
      relay.log(`panel: ${done.keyHash.slice(0, 8)} revoked`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  };
}

export async function startPanel(relay, { dir, config, log = () => {} }) {
  const server = http.createServer(panelHandler(relay, { dir, config }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(panelPort(config), '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  log(`control panel on http://127.0.0.1:${panelPort(config)} (this computer only; run: wanji relay panel)`);
  return server;
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>万机服务端面板</title>
<style>
:root{--bg:#f5f7f6;--card:#fff;--ink:#16201b;--muted:#6b7771;--line:#dde3df;--ok:#0e8a5f;--bad:#c2410c;--warn:#b45309;--accent:#0e7569}
@media(prefers-color-scheme:dark){:root{--bg:#0d1110;--card:#151b19;--ink:#edf2ef;--muted:#8fa098;--line:#26302c;--ok:#34d399;--bad:#fb923c;--warn:#fbbf24;--accent:#2ec4b0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:22px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 12px}
header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.stat{border:1px solid var(--line);border-radius:10px;padding:12px}.stat b{font-size:15px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--muted)}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}.tag.active{color:var(--ok);border-color:var(--ok)}.tag.expired{color:var(--warn);border-color:var(--warn)}.tag.revoked{color:var(--bad);border-color:var(--bad)}
input{padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
button{padding:7px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.newkey{margin-top:12px;padding:12px;border:2px dashed var(--accent);border-radius:10px;display:none}
.newkey code{font-size:18px;font-weight:700;letter-spacing:.03em}.pc{white-space:nowrap}.err{color:var(--bad)}
</style></head><body><div class="wrap">
<header><h1>万机服务端面板</h1><span class="muted" id="meta">加载中…</span></header>

<div class="card"><h2>服务状态</h2><div class="grid" id="checks"></div></div>

<div class="card"><h2>生成密钥</h2>
<div class="row"><input id="buyer" placeholder="买家（微信号或备注）" size="28"><input id="months" type="number" min="1" max="36" value="1" style="width:80px"><span class="muted">个月</span><button id="make">生成</button><span class="err" id="makeErr"></span></div>
<div class="newkey" id="newkey"><div class="muted">新密钥（只显示这一次，复制后发给买家）：</div><div class="row"><code id="keyText"></code><button class="ghost" id="copy">复制</button></div><div class="muted" id="keyExp"></div></div>
</div>

<div class="card"><h2>已发出的密钥 <span class="muted" id="licCount"></span></h2>
<table><thead><tr><th>编号</th><th>买家</th><th>状态</th><th>到期</th><th>电脑</th><th>发出时间</th><th></th></tr></thead><tbody id="lics"></tbody></table></div>

<div class="card"><h2>Pro 账号与电脑 <span class="muted" id="accCount"></span></h2>
<table><thead><tr><th>账号</th><th>买家</th><th>电脑（绿点在线）</th><th>开通时间</th></tr></thead><tbody id="accs"></tbody></table></div>
</div>
<script>
const base = location.pathname.replace(/\\/$/, '');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }).replace(/:\\d\\d$/, '') : '—';
const STATUS = { active: '有效', expired: '已过期', revoked: '已作废' };
async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
async function loadChecks() {
  try {
    const { checks } = await (await fetch(base + '/api/checks')).json();
    $('checks').innerHTML = checks.map((c) => '<div class="stat"><span class="dot ' + (c.ok ? 'ok' : 'bad') + '"></span><b>' + esc(c.name) + '</b><div class="muted">' + (c.ok ? '正常 · ' + c.ms + ' ms' : '异常 · ' + esc(c.status || c.error)) + '</div><div class="muted" style="font-size:12px;word-break:break-all">' + esc(c.url) + '</div></div>').join('');
  } catch { $('checks').innerHTML = '<div class="err">面板连不上中继进程</div>'; }
}
async function load() {
  let s;
  try { s = await (await fetch(base + '/api/status')).json(); } catch { $('meta').textContent = '连不上中继进程'; return; }
  $('meta').textContent = '版本 ' + s.version + ' · ' + s.origin + ' · 本次启动 ' + day(s.startedAt);
  $('licCount').textContent = '（' + s.licenses.length + '）';
  $('lics').innerHTML = s.licenses.map((l) => '<tr><td><code>' + l.id + '</code></td><td>' + esc(l.buyer) + '</td><td><span class="tag ' + l.status + '">' + (STATUS[l.status] || l.status) + '</span></td><td>' + day(l.expiresAt) + '</td><td>' + l.machines + ' / 5</td><td>' + day(l.createdAt) + '</td><td class="row">'
    + (l.status !== 'revoked' ? '<button class="ghost" data-extend="' + l.id + '">续 1 个月</button><button class="danger" data-revoke="' + l.id + '">作废</button>' : '') + '</td></tr>').join('') || '<tr><td colspan="7" class="muted">还没有发出密钥</td></tr>';
  $('accCount').textContent = '（' + s.accounts.length + '）';
  $('accs').innerHTML = s.accounts.map((a) => '<tr><td><code>' + a.id + '</code></td><td>' + (a.license ? esc(a.license.buyer) + ' <span class="tag ' + a.license.status + '">' + (STATUS[a.license.status] || '') + '</span>' : '<span class="muted">—</span>') + '</td><td>'
    + (a.computers.map((c) => '<div class="pc"><span class="dot ' + (c.online ? 'ok' : '') + '"></span>' + esc(c.name) + (c.online ? '' : ' <span class="muted">最后在线 ' + day(c.lastSeen) + '</span>') + '</div>').join('') || '<span class="muted">还没有电脑</span>') + '</td><td>' + day(a.createdAt) + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">还没有 Pro 账号</td></tr>';
}
$('make').onclick = async () => {
  $('makeErr').textContent = '';
  try {
    const r = await post('/api/licenses/create', { buyer: $('buyer').value, months: Number($('months').value) });
    $('keyText').textContent = r.key; $('keyExp').textContent = '到期：' + day(r.expiresAt); $('newkey').style.display = 'block'; $('buyer').value = '';
    load();
  } catch (e) { $('makeErr').textContent = e.message; }
};
$('copy').onclick = async () => { await navigator.clipboard.writeText($('keyText').textContent); $('copy').textContent = '已复制'; setTimeout(() => { $('copy').textContent = '复制'; }, 1500); };
$('lics').onclick = async (e) => {
  const ext = e.target.dataset.extend, rev = e.target.dataset.revoke;
  try {
    if (ext) { await post('/api/licenses/extend', { id: ext, months: 1 }); }
    if (rev && confirm('确定作废 ' + rev + '？买家的电脑会立刻断开 Pro。')) { await post('/api/licenses/revoke', { id: rev }); }
  } catch (err) { alert(err.message); }
  if (ext || rev) load();
};
load(); loadChecks(); setInterval(load, 5000); setInterval(loadChecks, 30000);
</script></body></html>`;
