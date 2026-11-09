// 万机 phone web app. Talks only to /hub/api/* on this origin, with the admin key the
// person scanned. Passwords stay on this phone, encrypted with a key that only Face ID
// (a passkey's PRF output) or the owner's master password can produce.

const KEY_STORE = 'wanji.key';
const VAULT_STORE = 'wanji.vault';
const DEVICE_STORE = 'wanji.device';
const root = document.documentElement;
const supportsLinear = CSS.supports('transition-timing-function', 'linear(0, 1)');
const ease = (name, fallback) => (supportsLinear ? getComputedStyle(root).getPropertyValue(name).trim() : fallback);
const SPRING = ease('--spring', 'cubic-bezier(.2,.9,.25,1.05)');
const SPRING_SMOOTH = ease('--spring-smooth', 'cubic-bezier(.2,.8,.2,1)');
const SPRING_BOUNCY = ease('--spring-bouncy', 'cubic-bezier(.3,1.4,.4,1)');
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let key = localStorage.getItem(KEY_STORE);
const S = { status: null, version: null, activity: null, tab: 'computers', offline: false, seenSecrets: new Set(), seenTakeovers: new Set() };

// ---------- tiny DOM helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'icon') el.innerHTML = ICONS[v] || '';
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'vars') for (const [name, value] of Object.entries(v)) el.style.setProperty(name, value);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const $ = (sel, el = document) => el.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const ICONS = {
  computers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8.5 20h7M12 16v4"/></svg>',
  vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M18.5 4.5L21 7"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3.5l2.5-6 4 12 2.5-6H21"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  windows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="13" height="10" rx="2"/><path d="M8 19h11a2 2 0 0 0 2-2V9"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  faceid: '<svg width="38" height="38" viewBox="0 0 38 38" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M2 11V7a5 5 0 0 1 5-5h4M27 2h4a5 5 0 0 1 5 5v4M36 27v4a5 5 0 0 1-5 5h-4M11 36H7a5 5 0 0 1-5-5v-4"/><path d="M12 13v3M26 13v3M19 13v8h-2M13 26c3.5 3 8.5 3 12 0"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
};

// Press feedback for anything marked .tap: glass dips (or swells) under the finger.
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tap');
  if (!el) return;
  el.classList.add('pressed');
  const up = () => { el.classList.remove('pressed'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}, { passive: true });

// ---------- API ----------
class ApiError extends Error {}
async function api(path, { method = 'GET', body, raw = false, timeout = 15000, auth = key } = {}) {
  let res;
  try {
    res = await fetch(`/hub/api/${path}`, {
      method,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${auth}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new ApiError(err?.name === 'TimeoutError' ? '连接超时' : '连不上服务器，请检查网络');
  }
  if (res.status === 401 && auth === key) {
    unpair('连接已失效，请在电脑上重新显示二维码再扫一次');
    throw new ApiError('连接已失效');
  }
  if (res.status === 402) throw new ApiError('Pro 已到期或被停用，请联系卖家续费');
  if (raw) {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new ApiError(data.error || `服务器返回 ${res.status}`), { pick: data.pick === true, status: res.status });
    }
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new ApiError(data.error || `服务器返回 ${res.status}`), { pick: data.pick === true, status: res.status });
  return data;
}

// ---------- toast and banner ----------
function toast(text) {
  const el = h('div', { class: 'toast glass strong', text });
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 500); }, 1900);
}

let bannerEl = null;
function banner({ title, sub, icon = '🤖', tint = 'tint-orange', onTap, ttl = 9000 }) {
  bannerEl?.remove();
  const el = h('div', { class: `banner glass tap ${tint}`, onclick: () => { hide(); onTap?.(); } },
    h('div', { class: 'ai', text: icon }),
    h('div', null, h('div', { class: 't1', text: title }), h('div', { class: 't2', text: sub })));
  let startY = null;
  el.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const dy = e.changedTouches[0].clientY - startY;
    el.style.transition = ''; el.style.transform = '';
    if (dy < -30) hide();
  });
  const hide = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 600); if (bannerEl === el) bannerEl = null; };
  document.body.append(el);
  bannerEl = el;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  if (ttl) setTimeout(hide, ttl);
}

// ---------- sheets ----------
const sheets = [];
function openSheet(content, { onClose, dismissable = true } = {}) {
  const scrim = h('div', { class: 'scrim' });
  const body = h('div', { class: 'sheet-body' }, content);
  const sheet = h('div', { class: 'sheet glass strong' }, h('div', { class: 'grab' }), body);
  const entry = { sheet, scrim, onClose, closed: false };
  const close = (result) => {
    if (entry.closed) return;
    entry.closed = true;
    sheet.classList.remove('show');
    scrim.classList.remove('show');
    sheets.splice(sheets.indexOf(entry), 1);
    if (!sheets.length) $('#app').classList.remove('behind-sheet');
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 650);
    onClose?.(result);
  };
  entry.close = close;
  if (dismissable) scrim.addEventListener('click', () => close());
  // Drag down to dismiss, with rubber banding upward.
  let start = null;
  let last = null;
  sheet.addEventListener('touchstart', (e) => {
    if (!dismissable) return;
    const onGrab = e.target.closest('.grab');
    if (!onGrab && body.scrollTop > 0) return;
    if (e.target.closest('input, textarea, .choice-list')) return;
    start = { y: e.touches[0].clientY, t: performance.now() };
    last = start;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dy = e.touches[0].clientY - start.y;
    last = { y: e.touches[0].clientY, t: performance.now() };
    sheet.classList.add('dragging');
    sheet.style.transform = `translateY(${dy > 0 ? dy : -Math.sqrt(-dy) * 3}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / 400));
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!start) return;
    const dy = last.y - start.y;
    const v = (last.y - start.y) / Math.max(1, last.t - start.t);
    start = null;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    scrim.style.opacity = '';
    if (dy > 140 || (dy > 30 && v > 0.6)) close();
  });
  $('#overlay').append(scrim, sheet);
  sheets.push(entry);
  $('#app').classList.add('behind-sheet');
  requestAnimationFrame(() => requestAnimationFrame(() => { scrim.classList.add('show'); sheet.classList.add('show'); }));
  return entry;
}

function confirmSheet({ title, sub, ok = '确定', danger = false }) {
  return new Promise((resolve) => {
    let entry;
    const content = [
      h('h3', { text: title }),
      sub ? h('div', { class: 'sub', text: sub }) : null,
      h('div', { class: 'btns', style: { marginTop: '22px' } },
        h('button', { class: 'btn secondary tap', text: '取消', onclick: () => entry.close(false) }),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'} tap`, text: ok, onclick: () => entry.close(true) })),
    ];
    entry = openSheet(content, { onClose: (r) => resolve(r === true) });
  });
}

function promptSheet({ title, sub, placeholder = '', value = '', type = 'text', ok = '好' }) {
  return new Promise((resolve) => {
    let entry;
    const input = h('input', { class: 'field', type, placeholder, value, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const submit = () => entry.close(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    entry = openSheet([
      h('h3', { text: title }),
      sub ? h('div', { class: 'sub', text: sub }) : null,
      h('div', { style: { height: '16px' } }),
      input,
      h('div', { class: 'btns', style: { marginTop: '8px' } },
        h('button', { class: 'btn secondary tap', text: '取消', onclick: () => entry.close(null) }),
        h('button', { class: 'btn primary tap', text: ok, onclick: submit })),
    ], { onClose: (r) => resolve(typeof r === 'string' ? r : null) });
    setTimeout(() => input.focus(), 350);
  });
}

// ---------- navigation ----------
const stack = [];
function makePage({ title, large = true, back = false, right = null, pushed = false }) {
  const scroller = h('div', { class: 'scroller' });
  const small = h('div', { class: 'small', text: title || '' });
  const navbar = h('div', { class: 'navbar' }, h('div', { class: 'bg' }), small,
    back ? h('button', { class: 'back glass tap swell', icon: 'back', 'aria-label': '返回', onclick: () => pop() }) : null,
    right);
  const page = h('div', { class: `page${pushed ? ' pushed' : ' tabpage'}` }, scroller, navbar);
  if (!large) navbar.classList.add('collapsed');
  let lastTop = 0;
  scroller.addEventListener('scroll', () => {
    const top = scroller.scrollTop;
    if (large) navbar.classList.toggle('collapsed', top > 44);
    const titleEl = $('.large-title', scroller);
    if (titleEl) titleEl.style.opacity = String(Math.max(0, 1 - top / 44));
    if (!pushed && page === currentTop()) {
      const wrap = $('.tabbar-wrap');
      if (top > 90 && top > lastTop + 4) wrap?.classList.add('mini');
      else if (top < lastTop - 4 || top < 40) wrap?.classList.remove('mini');
    }
    lastTop = top;
  }, { passive: true });
  return { page, scroller, navbar, small };
}
const currentTop = () => (stack.length ? stack[stack.length - 1].page : tabs[S.tab]?.page);

async function push(view) {
  const under = currentTop();
  view.page.classList.add('enter');
  $('#app').append(view.page);
  stack.push(view);
  $('.tabbar-wrap')?.classList.add('away');
  await nextFrame();
  view.page.classList.add('enter-active');
  view.page.classList.remove('enter');
  under.classList.add('under-anim', 'under');
  enableSwipeBack(view, under);
}

function pop() {
  const view = stack.pop();
  if (!view) return;
  const under = currentTop();
  view.page.classList.remove('enter-active');
  view.page.classList.add('leave');
  under.classList.add('under-anim');
  under.classList.remove('under');
  if (!stack.length) $('.tabbar-wrap')?.classList.remove('away');
  view.onLeave?.();
  setTimeout(() => { view.page.remove(); under.classList.remove('under-anim'); }, 450);
}

// Interactive swipe from the left edge, following the finger; releases by distance or speed.
function enableSwipeBack(view, under) {
  const page = view.page;
  let start = null;
  let last = null;
  page.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t.clientX > 28) return;
    start = { x: t.clientX, t: performance.now() };
    last = start;
    page.classList.add('dragging');
    under.classList.add('dragging');
    under.classList.remove('under-anim');
  }, { passive: true });
  page.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dx = Math.max(0, e.touches[0].clientX - start.x);
    last = { x: e.touches[0].clientX, t: performance.now() };
    const w = window.innerWidth;
    page.style.transform = `translateX(${dx}px)`;
    under.style.transform = `translateX(${-28 + (dx / w) * 28}%)`;
    under.style.filter = `brightness(${0.7 + (dx / w) * 0.3})`;
  }, { passive: true });
  page.addEventListener('touchend', () => {
    if (!start) return;
    const dx = last.x - start.x;
    const v = dx / Math.max(1, last.t - start.t);
    start = null;
    page.classList.remove('dragging');
    under.classList.remove('dragging');
    page.style.transform = '';
    under.style.transform = '';
    under.style.filter = '';
    if (dx > window.innerWidth * 0.35 || (dx > 20 && v > 0.45)) pop();
    else under.classList.add('under-anim');
  });
}

// ---------- tabs ----------
const tabs = {};
const TAB_ORDER = [
  { id: 'computers', label: '电脑', title: '万机' },
  { id: 'vault', label: '密码', title: '密码' },
  { id: 'activity', label: '动态', title: '动态' },
  { id: 'settings', label: '设置', title: '设置' },
];

function buildShell() {
  const app = $('#app');
  app.textContent = '';
  for (const t of TAB_ORDER) {
    tabs[t.id] = makePage({ title: t.title });
    tabs[t.id].page.classList.toggle('off', t.id !== S.tab);
    app.append(tabs[t.id].page);
  }
  const pill = h('div', { class: 'tab-pill' });
  const bar = h('div', { class: 'tabbar glass' }, pill,
    TAB_ORDER.map((t) => h('button', { class: `tab${t.id === S.tab ? ' on' : ''}`, dataset: null, 'data-tab': t.id, onclick: () => switchTab(t.id) },
      h('span', { icon: t.id }), h('span', { text: t.label }))));
  const fab = h('button', { class: 'fab glass tap swell', icon: 'plus', 'aria-label': '添加', onclick: () => fabAction() });
  const wrap = h('div', { class: 'tabbar-wrap' }, bar, fab);
  wrap.addEventListener('click', (e) => { if (wrap.classList.contains('mini') && e.target.closest('.tabbar')) wrap.classList.remove('mini'); }, true);
  app.append(wrap);
  requestAnimationFrame(() => movePill(false));
  // The bar widens when the + button hides; keep the pill on its tab.
  let sized = false;
  new ResizeObserver(() => { if (sized) movePill(true); sized = true; }).observe(bar);
  updateFab();
  for (const t of TAB_ORDER) renderTab(t.id, true);
}

function movePill(animate = true) {
  const tab = $(`.tab[data-tab="${S.tab}"]`);
  const pill = $('.tab-pill');
  if (!tab || !pill) return;
  if (!animate) pill.style.transition = 'none';
  pill.style.left = `${tab.offsetLeft}px`;
  pill.style.width = `${tab.offsetWidth}px`;
  if (animate) {
    pill.classList.add('moving');
    setTimeout(() => pill.classList.remove('moving'), 220);
  } else {
    pill.getBoundingClientRect();
    pill.style.transition = '';
  }
}

function switchTab(id) {
  if (stack.length) return;
  if (id === S.tab) {
    tabs[id].scroller.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const from = tabs[S.tab].page;
  const to = tabs[id].page;
  S.tab = id;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === id);
  $('.tabbar-wrap').classList.remove('mini');
  movePill(true);
  from.classList.add('off');
  to.classList.remove('off');
  to.animate([{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: SPRING_SMOOTH });
  updateFab();
  renderTab(id, true);
  if (id === 'activity') pollActivity();
}

function updateFab() {
  const fab = $('.fab');
  if (!fab) return;
  const show = S.tab === 'computers' || S.tab === 'vault';
  if (show === !fab.classList.contains('hidden')) return;
  if (show) {
    fab.classList.remove('hidden');
    fab.animate([{ transform: 'scale(.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, easing: SPRING_BOUNCY });
  } else {
    fab.animate([{ transform: 'none', opacity: 1 }, { transform: 'scale(.3)', opacity: 0 }], { duration: 200, easing: 'ease-in' }).onfinish = () => fab.classList.add('hidden');
  }
}

function fabAction() {
  if (S.tab === 'computers') addComputer();
  else if (S.tab === 'vault') editAccount(null);
}

function setBadge(tabId, count) {
  const tab = $(`.tab[data-tab="${tabId}"]`);
  if (!tab) return;
  let badge = $('.badge', tab);
  if (!count) { badge?.remove(); return; }
  if (!badge) { badge = h('span', { class: 'badge' }); tab.append(badge); }
  badge.textContent = String(count);
}

function renderTab(id, entrance = false) {
  const view = tabs[id];
  if (!view) return;
  const keepTop = view.scroller.scrollTop;
  view.scroller.textContent = '';
  const parts = { computers: renderComputers, vault: renderVault, activity: renderActivity, settings: renderSettings }[id]();
  view.scroller.append(...parts);
  if (entrance) {
    let i = 0;
    for (const el of view.scroller.children) { el.classList.add('appear'); el.style.setProperty('--i', String(i++)); }
  }
  view.scroller.scrollTop = keepTop;
}

// ---------- formatting ----------
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
const TOOL_NAMES = {
  ui_look: '看了屏幕', ui_act: '操作了界面', bash: '运行了命令', powershell: '运行了命令', job: '查看了任务', browser: '用了浏览器',
  transfer: '传了文件', type_secret: '输入了保存的账号', secret_list: '查看了账号列表', request_human_takeover: '请你接手浏览器',
  check_human_takeover: '查看接手状态', cancel_human_takeover: '取消了接手', read_file: '读了文件', write_file: '写了文件', edit_file: '改了文件',
  computers: '查看了电脑列表', list_computers: '查看了电脑列表', memory: '用了共享记忆', memory_write: '写了共享记忆', screenshot: '截了屏',
  search: '搜索了文件', list_files: '列出了文件',
};
const toolName = (a) => TOOL_NAMES[a] || a;
function osIcon(os) {
  const s = String(os || '').toLowerCase();
  if (s.includes('mac') || s.includes('darwin')) return '💻';
  if (s.includes('linux')) return '🐧';
  return '🖥️';
}
const ROUTE_TEXT = { auto: '自动', lan: '局域网', public: '公网' };
const PALETTE = ['#24292f', '#2b7bff', '#ff5000', '#07c160', '#8e44ff', '#ff2d55', '#0fa3b1', '#f5a623'];
const colorFor = (text) => PALETTE[[...String(text)].reduce((a, c) => (a * 31 + c.codePointAt(0)) >>> 0, 7) % PALETTE.length];

// ---------- computers ----------
function computers() { return S.status?.computers || []; }

function renderComputers() {
  const list = computers();
  const online = list.filter((c) => c.online).length;
  const plan = S.status?.license?.plan === 'pro' ? 'Pro' : '免费版';
  const out = [
    h('div', { class: 'head-row' },
      h('div', null, h('div', { class: 'large-title', text: '万机' })),
      h('button', { class: 'round glass tap swell', text: '⋯', 'aria-label': '设置', onclick: () => switchTab('settings') })),
    h('div', { class: 'subtitle', text: S.status ? `${plan} · ${online} 台电脑在线${S.offline ? ' · 正在重连…' : ''}` : '正在连接…' }),
  ];
  if (S.status && !list.length) {
    out.push(h('div', { class: 'card glass empty' }, h('div', { class: 'big', text: '🖥️' }),
      '还没有电脑连进来。\n在电脑上安装万机，再用右下角的 ＋ 生成配对码。'));
  }
  for (const c of list) {
    const pending = c.takeover;
    const meta = [h('i', { class: `dot${pending ? ' warn' : c.online ? '' : ' off'}` }),
      pending ? '需要你帮忙' : c.online ? ['在线', c.via === 'lan' ? '局域网' : c.via ? '公网' : null, c.main ? '主电脑' : null].filter(Boolean).join(' · ') : `离线${c.lastSeen ? ` · ${ago(c.lastSeen)}` : ''}`];
    const canTake = c.online && (c.desktop || c.browser);
    out.push(h('div', { class: 'card glass tap', onclick: (e) => { if (!e.target.closest('.chip')) openComputer(c.id); } },
      h('div', { class: 'pc' },
        h('div', { class: 'ico', text: osIcon(c.os) }),
        h('div', null, h('div', { class: 'name', text: c.name }), h('div', { class: 'meta' }, meta)),
        h('div', { class: 'chev', text: '›' })),
      c.note ? h('div', { class: 'foot', style: { margin: '10px 0 0' }, text: c.note }) : null,
      canTake ? h('div', { class: 'chips' },
        h('button', { class: `chip glass tap${pending ? ' tint-orange' : ''}`, text: pending ? '去接手' : '接手浏览器', onclick: () => openTakeover(c.id) }),
        h('button', { class: 'chip glass tap', text: '详情', onclick: () => openComputer(c.id) })) : null));
  }
  const recent = (S.activity?.recent || []).slice(0, 3);
  if (recent.length) {
    out.push(h('div', { class: 'section', text: '刚刚' }));
    out.push(h('div', { class: 'list glass feed' }, recent.map((r) => activityRow(r))));
  }
  return out;
}

function openComputer(id) {
  const view = makePage({ title: '', back: true, pushed: true });
  const render = () => {
    const c = computers().find((x) => x.id === id);
    view.scroller.textContent = '';
    if (!c) { view.scroller.append(h('div', { class: 'empty', text: '这台电脑已被移除' })); return; }
    view.small.textContent = c.name;
    const rows = [
      ['状态', c.takeover ? '需要你帮忙' : c.online ? '在线' : `离线${c.lastSeen ? ` · ${ago(c.lastSeen)}` : ''}`],
      ['系统', c.os || '未知'],
      c.online && c.via ? ['当前线路', c.via === 'lan' ? '局域网' : '公网'] : null,
      c.lanProblem ? ['局域网', String(c.lanProblem)] : null,
      ['能力', [c.desktop ? '桌面' : null, c.browser ? '浏览器' : null].filter(Boolean).join(' · ') || '命令行'],
    ].filter(Boolean);
    view.scroller.append(
      h('div', { class: 'large-title', text: c.name }),
      h('div', { class: 'subtitle', text: c.main ? '主电脑' : '已加入的电脑' }),
      h('div', { class: 'list glass' }, rows.map(([k, v]) => h('div', { class: 'row' }, h('div', { class: 'grow t', style: { fontWeight: 500 }, text: k }), h('div', { class: 'v', text: v })))),
      (c.desktop || c.browser) ? h('button', { class: `btn ${c.takeover ? 'primary' : 'secondary'} tap`, style: { margin: '6px 0 14px' }, text: c.takeover ? '去接手（AI 在等你）' : '接手浏览器', disabled: !c.online, onclick: () => openTakeover(c.id) }) : null,
      c.main ? null : h('div', { class: 'section', text: '连接方式' }),
      c.main ? null : segmented(['auto', 'lan', 'public'], c.route || 'auto', (v) => ROUTE_TEXT[v], async (v) => {
        try { await api(`computers/${c.id}`, { method: 'POST', body: { route: v } }); toast(`已改为${ROUTE_TEXT[v]}`); refresh(); } catch (e) { toast(e.message); }
      }),
      c.main ? null : h('div', { class: 'foot', style: { marginTop: '8px' }, text: '自动：同一个局域网时走局域网，否则走公网。选定的线路连不上会直接报错，不会偷偷换。' }),
      h('div', { class: 'section', text: '备注' }),
      noteField(c),
      c.main ? null : h('div', { class: 'list glass', style: { marginTop: '18px' } },
        h('button', { class: 'row tap', style: { width: '100%' }, onclick: () => renameComputer(c) }, h('div', { class: 'grow t', style: { textAlign: 'left', fontWeight: 500 }, text: '重命名' }), h('div', { class: 'chev', text: '›' })),
        h('button', { class: 'row tap', style: { width: '100%' }, onclick: () => removeComputer(c) }, h('div', { class: 'grow t', style: { textAlign: 'left', color: '#ff8a8d', fontWeight: 500 }, text: '移除这台电脑' }))),
    );
  };
  view.render = render;
  render();
  push(view);
}

function noteField(c) {
  const input = h('textarea', { class: 'field', rows: '2', placeholder: '给 AI 看的备注，例如“办公室，周末关机”', maxlength: '200' });
  input.value = c.note || '';
  input.addEventListener('blur', async () => {
    if (input.value === (c.note || '')) return;
    try { await api(`computers/${c.id}`, { method: 'POST', body: { note: input.value } }); c.note = input.value; toast('备注已保存'); } catch (e) { toast(e.message); }
  });
  return input;
}

function segmented(values, current, label, onChange) {
  const thumb = h('div', { class: 'thumb' });
  const seg = h('div', { class: 'seg' }, thumb);
  const buttons = values.map((v) => h('button', { class: v === current ? 'on' : '', text: label(v), onclick: () => {
    if (v === current) return;
    current = v;
    for (const b of buttons) b.classList.toggle('on', b === buttons[values.indexOf(v)]);
    place();
    onChange(v);
  } }));
  seg.append(...buttons);
  const place = () => {
    const b = buttons[values.indexOf(current)];
    thumb.style.left = `${b.offsetLeft}px`;
    thumb.style.width = `${b.offsetWidth}px`;
  };
  requestAnimationFrame(() => requestAnimationFrame(place));
  return seg;
}

async function renameComputer(c) {
  const name = await promptSheet({ title: '重命名', value: c.name, ok: '保存' });
  if (!name || name === c.name) return;
  try { await api(`computers/${c.id}`, { method: 'POST', body: { name } }); toast('已重命名'); await refresh(); } catch (e) { toast(e.message); }
}

async function removeComputer(c) {
  const ok = await confirmSheet({ title: `移除“${c.name}”？`, sub: '移除后 AI 不能再控制它。要再连上，需要在那台电脑上重新配对。', ok: '移除', danger: true });
  if (!ok) return;
  try { await api(`computers/${c.id}`, { method: 'DELETE' }); toast('已移除'); pop(); await refresh(); } catch (e) { toast(e.message); }
}

async function addComputer() {
  let invite;
  try { invite = await api('invites', { method: 'POST', body: {} }); } catch (e) { toast(e.message); return; }
  const mins = Math.round((invite.expiresIn || 600) / 60);
  let entry;
  entry = openSheet([
    h('h3', { text: '添加一台电脑' }),
    h('div', { class: 'sub', text: `在新电脑上安装万机，打开管理器，点“这台是新电脑”，粘贴下面的配对码。${mins} 分钟内有效，只能用一次。` }),
    h('div', { class: 'card', style: { background: 'rgba(255,255,255,.1)', margin: '18px 0 12px', textAlign: 'center' } },
      h('div', { class: 'mono', style: { fontSize: '20px', letterSpacing: '1px' }, text: invite.pair })),
    h('div', { class: 'btns' },
      h('button', { class: 'btn secondary tap', text: '完成', onclick: () => entry.close() }),
      h('button', { class: 'btn primary tap', text: '复制配对码', onclick: () => copy(invite.pair) })),
  ]);
}

async function copy(text, done = '已复制') {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('复制失败，请长按选中复制'); }
}

// ---------- takeover ----------
let takeover = null;
async function openTakeover(id) {
  if (takeover) return;
  const c = computers().find((x) => x.id === id);
  if (!c) return;
  const img = h('img', { alt: '' });
  const frameBox = h('div', { class: 'loading-frame' }, h('div', { class: 'spinner' }), h('div', { text: '正在连接浏览器…' }));
  const screen = h('div', { class: 'screen' }, frameBox);
  const t1 = h('div', { class: 't1', text: c.takeover ? 'AI 需要你帮忙' : `接手 ${c.name}` });
  const t2 = h('div', { class: 't2', text: c.takeover ? `${c.name} · AI 已暂停操作` : '你操作时 AI 会等你' });
  const top = h('div', { class: `bar-top glass ${c.takeover ? 'tint-orange' : 'dark'}` },
    h('div', { style: { flex: '1', minWidth: '0' } }, t1, t2),
    h('button', { class: 'mini tap swell', icon: 'windows', 'aria-label': '换窗口', onclick: () => pickWindow(true) }));
  const info = h('div', { class: 'info', text: '点按＝单击 · 滑动＝滚动 · 长按后拖＝拖动 · 双指缩放' });
  const tools = h('div', { class: 'tools glass dark' }, info,
    h('div', { class: 'rowx' },
      h('button', { class: 'mini tap swell', icon: 'keyboard', 'aria-label': '键盘', onclick: () => keyboardSheet() }),
      h('button', { class: 'mini tap swell', icon: 'refresh', 'aria-label': '刷新', onclick: () => act({ action: 'key', keys: 'f5' }) }),
      h('button', { class: 'btn primary tap done', text: c.takeover ? '完成，交还给 AI' : '完成', onclick: () => finish() })));
  const el = h('div', { class: 'takeover' }, screen, top, tools);
  document.body.append(el);
  takeover = { id, el, img, screen, frameBox, t1, t2, running: true, url: null };
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  bindGestures(img, screen);

  const start = async () => {
    try {
      await api(`computers/${id}/browser/start`, { method: 'POST', body: {} });
      return true;
    } catch (e) {
      if (e.pick) return pickWindow(false);
      frameBox.lastChild.textContent = e.message;
      return false;
    }
  };
  if (await start()) frameLoop();
}

async function pickWindow(fromButton) {
  const t = takeover;
  if (!t) return false;
  let list;
  try { list = (await api(`computers/${t.id}/browser/windows`, { timeout: 30000 })).windows || []; } catch (e) { toast(e.message); return false; }
  if (!list.length) {
    t.frameBox.lastChild.textContent = '这台电脑上没有打开的浏览器窗口';
    return false;
  }
  return new Promise((resolve) => {
    let entry;
    const choose = async (w) => {
      entry.close('picked');
      try {
        await api(`computers/${t.id}/browser/select`, { method: 'POST', body: { hwnd: w.hwnd }, timeout: 30000 });
        if (!t.looping) frameLoop();
        resolve(true);
      } catch (e) { toast(e.message); resolve(false); }
    };
    entry = openSheet([
      h('h3', { text: '选一个浏览器窗口' }),
      h('div', { class: 'sub', text: 'AI 自己用的自动化浏览器标了“AI”' }),
      h('div', { class: 'list', style: { background: 'rgba(255,255,255,.08)', marginTop: '16px' } },
        list.map((w) => h('button', { class: 'row tap', style: { width: '100%', textAlign: 'left' }, onclick: () => choose(w) },
          h('div', { class: 'grow' }, h('div', { class: 't', style: { fontWeight: 500 }, text: w.title || '（无标题）' })),
          w.automation ? h('span', { class: 'pill orange', text: 'AI' }) : null,
          h('div', { class: 'chev', text: '›' })))),
    ], { onClose: (r) => { if (r !== 'picked') { resolve(false); if (!fromButton && !t.looping) closeTakeover(); } } });
  });
}

async function frameLoop() {
  const t = takeover;
  if (!t || t.looping) return;
  t.looping = true;
  let fails = 0;
  while (takeover === t && t.running) {
    const began = performance.now();
    if (document.hidden) { await sleep(500); continue; }
    try {
      const res = await api(`computers/${t.id}/browser/frame`, { raw: true, timeout: 20000 });
      const title = decodeURIComponent(res.headers.get('X-Window-Title') || '');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      await new Promise((r) => { t.img.onload = r; t.img.onerror = r; t.img.src = url; });
      if (t.url) URL.revokeObjectURL(t.url);
      t.url = url;
      if (!t.img.isConnected) { t.frameBox.replaceWith(t.img); t.img.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: SPRING }); }
      if (title && !S.status?.computers?.find((c) => c.id === t.id)?.takeover) t.t2.textContent = title;
      fails = 0;
    } catch (e) {
      if (e.pick) { t.looping = false; await pickWindow(false); return; }
      fails += 1;
      if (fails === 3) toast(e.message);
      await sleep(Math.min(3000, 400 * fails));
    }
    const spent = performance.now() - began;
    if (spent < 280) await sleep(280 - spent);
  }
  t.looping = false;
}

async function act(body) {
  const t = takeover;
  if (!t) return;
  try { await api(`computers/${t.id}/browser/input`, { method: 'POST', body, timeout: 20000 }); } catch (e) { toast(e.message); }
}

// Tap = click, pan = scroll, long-press = right click, long-press then move = drag.
// Two fingers zoom and move the picture (like Photos); zoomed in, one finger moves it too.
function bindGestures(img, screen) {
  let g = null;
  const pointers = new Map();
  const view = { s: 1, tx: 0, ty: 0 };
  let pinch = null;
  img.style.transformOrigin = '0 0';
  const apply = (animate = false) => {
    img.style.transition = animate ? `transform 500ms ${SPRING_SMOOTH}` : 'none';
    img.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
  };
  const resetZoom = () => { Object.assign(view, { s: 1, tx: 0, ty: 0 }); apply(true); };
  // Keep at least a third of the picture on screen.
  const clampView = () => {
    const r = img.getBoundingClientRect();
    const box = screen.getBoundingClientRect();
    const minH = Math.min(r.width, box.width) / 3;
    const minV = Math.min(r.height, box.height) / 3;
    if (r.right < box.left + minH) view.tx += box.left + minH - r.right;
    if (r.left > box.right - minH) view.tx -= r.left - (box.right - minH);
    if (r.bottom < box.top + minV) view.ty += box.top + minV - r.bottom;
    if (r.top > box.bottom - minV) view.ty -= r.top - (box.bottom - minV);
    apply(true);
  };
  const onImage = (x, y) => {
    const r = img.getBoundingClientRect();
    return img.isConnected && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const norm = (x, y) => {
    const r = img.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (x - r.left) / r.width)), y: Math.min(1, Math.max(0, (y - r.top) / r.height)) };
  };
  const mark = (x, y, cls = '') => {
    const r = screen.getBoundingClientRect();
    const dot = h('div', { class: `touch ${cls}`, style: { left: `${x - r.left}px`, top: `${y - r.top}px` } });
    screen.append(dot);
    if (!cls) setTimeout(() => dot.remove(), 500);
    return dot;
  };
  const cancelSingle = () => {
    if (!g) return;
    clearTimeout(g.timer);
    g.dot?.remove();
    g.trail?.remove();
    g = null;
  };
  const pinchStart = () => {
    const [a, b] = [...pointers.values()];
    const r = img.getBoundingClientRect();
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: view.s,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      left: r.left - view.tx, top: r.top - view.ty, tx0: view.tx, ty0: view.ty,
    };
  };
  screen.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    screen.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && img.isConnected) { cancelSingle(); pinchStart(); return; }
    if (pointers.size > 1 || !img.isConnected) return;
    const zoomed = view.s > 1.01;
    const inside = onImage(e.clientX, e.clientY);
    if (!inside && !zoomed) return;
    g = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, sent: e.clientY, mode: 'tap', zoomed, inside, tx0: view.tx, ty0: view.ty };
    g.timer = setTimeout(() => {
      if (g?.mode !== 'tap' || !g.inside) return;
      g.mode = 'lift';
      g.dot = mark(g.x0, g.y0, 'lift');
    }, 450);
  });
  screen.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.min(6, Math.max(0.8, pinch.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0)));
      // The point under the fingers stays under the fingers.
      const px = (pinch.m0.x - pinch.left - pinch.tx0) / pinch.s0;
      const py = (pinch.m0.y - pinch.top - pinch.ty0) / pinch.s0;
      Object.assign(view, { s, tx: m.x - pinch.left - s * px, ty: m.y - pinch.top - s * py });
      apply();
      return;
    }
    if (!g) return;
    g.x = e.clientX;
    g.y = e.clientY;
    const moved = Math.hypot(g.x - g.x0, g.y - g.y0);
    if (g.mode === 'tap' && moved > 10) { g.mode = g.zoomed || !g.inside ? 'pan' : 'scroll'; clearTimeout(g.timer); }
    if (g.mode === 'lift' && moved > 10) g.mode = 'drag';
    if (g.mode === 'pan') {
      view.tx = g.tx0 + (g.x - g.x0);
      view.ty = g.ty0 + (g.y - g.y0);
      apply();
    } else if (g.mode === 'drag') {
      const r = screen.getBoundingClientRect();
      g.dot.style.left = `${g.x - r.left}px`;
      g.dot.style.top = `${g.y - r.top}px`;
      if (!g.trail) { g.trail = h('div', { class: 'trail' }); screen.append(g.trail); }
      Object.assign(g.trail.style, { left: `${g.x0 - r.left}px`, top: `${g.y0 - r.top - 2}px`, width: `${moved}px`, transform: `rotate(${Math.atan2(g.y - g.y0, g.x - g.x0)}rad)` });
    } else if (g.mode === 'scroll') {
      const r = img.getBoundingClientRect();
      const amount = Math.round(((g.sent - g.y) / r.height) * 12);
      if (Math.abs(amount) >= 1) {
        g.sent = g.y;
        act({ action: 'scroll', ...norm(g.x0, g.y0), amount: Math.max(-10, Math.min(10, amount)) });
      }
    }
  });
  screen.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        if (view.s < 1.05) resetZoom(); else clampView();
      }
      return;
    }
    if (!g) return;
    clearTimeout(g.timer);
    const a = norm(g.x0, g.y0);
    const b = norm(g.x, g.y);
    if (g.mode === 'tap' && g.inside) { mark(g.x0, g.y0); act({ action: 'click', ...a }); }
    else if (g.mode === 'lift') { g.dot.remove(); mark(g.x0, g.y0); act({ action: 'right_click', ...a }); }
    else if (g.mode === 'pan') clampView();
    else if (g.mode === 'drag') {
      act({ action: 'drag', ...a, to_x: b.x, to_y: b.y });
      const { dot, trail } = g;
      dot.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 400 }).onfinish = () => dot.remove();
      trail?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400 }).addEventListener('finish', () => trail.remove());
    }
    g = null;
  });
  screen.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; cancelSingle(); });
  screen.addEventListener('contextmenu', (e) => e.preventDefault());
}

function keyboardSheet() {
  let entry;
  const input = h('input', { class: 'field', placeholder: '要输入的文字', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send' });
  const send = async () => {
    if (!input.value) return;
    const text = input.value;
    input.value = '';
    await act({ action: 'type', text });
    toast('已输入');
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  const keys = [['Enter ↵', 'enter'], ['Tab ⇥', 'tab'], ['⌫', 'backspace'], ['Esc', 'esc'], ['全选', 'ctrl+a'], ['粘贴', 'ctrl+v'], ['↑', 'up'], ['↓', 'down']];
  entry = openSheet([
    h('h3', { text: '输入' }),
    h('div', { class: 'sub', text: '先在画面上点一下输入框，再在这里打字' }),
    h('div', { style: { height: '14px' } }),
    input,
    h('button', { class: 'btn primary tap', text: '发送到电脑', onclick: send }),
    h('div', { class: 'keyrow' }, keys.map(([label, k]) => h('button', { class: 'tap', text: label, onclick: () => act({ action: 'key', keys: k }) }))),
  ]);
  setTimeout(() => input.focus(), 350);
}

async function finish() {
  const t = takeover;
  if (!t) return;
  try { await api(`computers/${t.id}/browser/finish`, { method: 'POST', body: {} }); } catch (e) { toast(e.message); }
  closeTakeover();
  toast('已交还给 AI');
  refresh();
}

function closeTakeover() {
  const t = takeover;
  if (!t) return;
  t.running = false;
  takeover = null;
  t.el.classList.remove('show');
  setTimeout(() => { t.el.remove(); if (t.url) URL.revokeObjectURL(t.url); }, 700);
}

// ---------- vault (passwords on this phone only) ----------
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

function loadVault() {
  try { return JSON.parse(localStorage.getItem(VAULT_STORE) || 'null'); } catch { return null; }
}
function saveVault(v) { localStorage.setItem(VAULT_STORE, JSON.stringify(v)); }
function deviceId() {
  let id = localStorage.getItem(DEVICE_STORE);
  if (!id) { id = `web-${Array.from(rand(5), (b) => b.toString(16).padStart(2, '0')).join('')}`; localStorage.setItem(DEVICE_STORE, id); }
  return id;
}

let vaultKey = null;
let vaultKeyTimer = null;
function holdKey(k) {
  vaultKey = k;
  clearTimeout(vaultKeyTimer);
  vaultKeyTimer = setTimeout(() => { vaultKey = null; }, 60000);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) vaultKey = null; });

async function aesFromSecret(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('wanji-vault-v1'), info: new Uint8Array() }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function aesFromCode(code, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(k, secrets) {
  const iv = rand(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(secrets)));
  return { iv: b64(iv), data: b64(data) };
}
async function openSealed(k, v) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, k, unb64(v.data));
  return JSON.parse(dec.decode(plain));
}

async function passkeyPrf(credId, prfSalt) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), rpId: location.hostname, userVerification: 'required', timeout: 60000,
    allowCredentials: [{ type: 'public-key', id: credId }],
    extensions: { prf: { eval: { first: prfSalt } } },
  } });
  const first = assertion?.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new Error('这台手机的 Face ID 不能用来加密（需要 iOS 18 或更新），请改用主密码');
  return first;
}

async function setupVault(mode) {
  let k;
  let v;
  if (mode === 'faceid') {
    if (!window.PublicKeyCredential) throw new Error('这个浏览器不支持 Face ID 通行密钥');
    const prfSalt = rand(32);
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: '万机', id: location.hostname },
      user: { id: rand(16), name: '万机密码库', displayName: '万机密码库' },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: prfSalt } } },
      timeout: 60000,
    } });
    const ext = cred.getClientExtensionResults?.() || {};
    if (ext.prf && ext.prf.enabled === false) throw new Error('这台手机的 Face ID 不能用来加密（需要 iOS 18 或更新），请改用主密码');
    const credId = new Uint8Array(cred.rawId);
    const secret = ext.prf?.results?.first || await passkeyPrf(credId, prfSalt);
    k = await aesFromSecret(secret);
    v = { v: 1, mode, cred: b64(credId), prfSalt: b64(prfSalt), meta: [] };
  } else {
    const code = await newCodeSheet();
    if (!code) return false;
    const salt = rand(16);
    const iterations = 310000;
    k = await aesFromCode(code, salt, iterations);
    v = { v: 1, mode: 'code', salt: b64(salt), iterations, meta: [] };
  }
  Object.assign(v, await seal(k, {}));
  saveVault(v);
  holdKey(k);
  return true;
}

function newCodeSheet() {
  return new Promise((resolve) => {
    let entry;
    const a = h('input', { class: 'field', type: 'password', placeholder: '主密码（至少 8 位）', autocomplete: 'new-password' });
    const b = h('input', { class: 'field', type: 'password', placeholder: '再输一次', autocomplete: 'new-password' });
    const err = h('div', { class: 'note', style: { color: '#ff8a8d' } });
    const ok = () => {
      if (a.value.length < 8) { err.textContent = '至少 8 位'; return; }
      if (a.value !== b.value) { err.textContent = '两次不一样'; return; }
      entry.close(a.value);
    };
    entry = openSheet([
      h('h3', { text: '设一个主密码' }),
      h('div', { class: 'sub', text: '用它加密这台手机上的所有账号。忘了就打不开，没人能帮你找回。' }),
      h('div', { style: { height: '16px' } }), a, b, err,
      h('button', { class: 'btn primary tap', text: '好', onclick: ok }),
    ], { onClose: (r) => resolve(typeof r === 'string' ? r : null) });
    setTimeout(() => a.focus(), 350);
  });
}

function codeSheet() {
  return new Promise((resolve) => {
    let entry;
    const a = h('input', { class: 'field', type: 'password', placeholder: '主密码', autocomplete: 'current-password' });
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter') entry.close(a.value); });
    entry = openSheet([
      h('h3', { text: '输入主密码' }),
      h('div', { style: { height: '16px' } }), a,
      h('button', { class: 'btn primary tap', text: '解锁', onclick: () => entry.close(a.value) }),
    ], { onClose: (r) => resolve(typeof r === 'string' && r ? r : null) });
    setTimeout(() => a.focus(), 350);
  });
}

// Always asks again (Face ID or master password) unless unlocked in the last minute.
async function unlockVault({ fresh = false } = {}) {
  const v = loadVault();
  if (!v) throw new Error('还没有设置密码库');
  if (vaultKey && !fresh) return vaultKey;
  let k;
  if (v.mode === 'faceid') {
    k = await aesFromSecret(await passkeyPrf(unb64(v.cred), unb64(v.prfSalt)));
  } else {
    const code = await codeSheet();
    if (!code) throw Object.assign(new Error('已取消'), { cancelled: true });
    k = await aesFromCode(code, unb64(v.salt), v.iterations);
  }
  try { await openSealed(k, v); } catch { throw new Error('密码不对，解不开'); }
  holdKey(k);
  return k;
}

async function readSecrets(opts) {
  const k = await unlockVault(opts);
  return { k, secrets: await openSealed(k, loadVault()) };
}

async function writeAccount(account, password) {
  const { k, secrets } = await readSecrets();
  const v = loadVault();
  if (password !== undefined) secrets[account.id] = password;
  const meta = v.meta.filter((m) => m.id !== account.id);
  meta.push({ id: account.id, label: account.label, username: account.username, updated: Date.now() });
  meta.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  Object.assign(v, { meta }, await seal(k, secrets));
  saveVault(v);
  syncVaultMeta();
}

async function deleteAccount(id) {
  const { k, secrets } = await readSecrets();
  const v = loadVault();
  delete secrets[id];
  v.meta = v.meta.filter((m) => m.id !== id);
  Object.assign(v, await seal(k, secrets));
  saveVault(v);
  syncVaultMeta();
}

// Labels and usernames only, so the AI can name the right account. Never passwords.
async function syncVaultMeta() {
  const v = loadVault();
  if (!key || !v) return;
  try {
    await api('vault-meta', { method: 'POST', body: { device: deviceId(), entries: v.meta.map(({ id, label, username }) => ({ id, label, username, autoAllow: false })) } });
  } catch { /* the next open syncs again */ }
}

function vaultErr(e) {
  if (e?.cancelled || e?.name === 'NotAllowedError' || e?.name === 'AbortError') return;
  toast(e?.message || String(e));
}

function renderVault() {
  const v = loadVault();
  const out = [h('div', { class: 'large-title', text: '密码' }),
    h('div', { class: 'subtitle', text: v ? `${v.meta.length} 个账号 · 只存在这台手机上` : '账号只存在这台手机上，AI 看不到明文' })];
  if (!v) {
    out.push(h('div', { class: 'card glass' },
      h('div', { class: 'faceid', icon: 'faceid' }),
      h('div', { class: 'sub', style: { textAlign: 'center', marginBottom: '18px' }, text: 'AI 需要登录时，会在这里问你。你用 Face ID 同意后，手机把密码直接输进那台电脑。' }),
      h('button', { class: 'btn primary tap', text: '用 Face ID 加密（推荐）', onclick: async () => { try { if (await setupVault('faceid')) { toast('密码库已就绪'); renderTab('vault', true); } } catch (e) { vaultErr(e); } } }),
      h('div', { style: { height: '10px' } }),
      h('button', { class: 'btn secondary tap', text: '用主密码加密', onclick: async () => { try { if (await setupVault('code')) { toast('密码库已就绪'); renderTab('vault', true); } } catch (e) { vaultErr(e); } } })));
    return out;
  }
  if (!v.meta.length) {
    out.push(h('div', { class: 'card glass empty' }, h('div', { class: 'big', text: '🔑' }), '还没有账号。点右下角 ＋ 添加。'));
    return out;
  }
  out.push(h('div', { class: 'list glass' }, v.meta.map((m) => h('button', { class: 'row tap', style: { width: '100%', textAlign: 'left' }, onclick: () => openAccount(m.id) },
    h('div', { class: 'logo', style: { background: colorFor(m.label) }, text: [...m.label][0]?.toUpperCase() || '?' }),
    h('div', { class: 'grow' }, h('div', { class: 't', text: m.label }), h('div', { class: 's', text: m.username || '（没有用户名）' })),
    h('div', { class: 'chev', text: '›' })))));
  out.push(h('div', { class: 'foot', text: '电脑上只会看到名称和用户名，用来让 AI 说清是哪个账号。' }));
  return out;
}

function openAccount(id) {
  const view = makePage({ title: '', back: true, pushed: true, right: h('button', { class: 'right glass tap swell', text: '编辑', onclick: () => editAccount(id) }) });
  view.render = () => {
    const m = loadVault()?.meta.find((x) => x.id === id);
    view.scroller.textContent = '';
    if (!m) { view.scroller.append(h('div', { class: 'empty', text: '这个账号已删除' })); return; }
    view.small.textContent = m.label;
    const pw = h('div', { class: 'v mono', text: '••••••••' });
    let shown = false;
    view.scroller.append(
      h('div', { class: 'logo', style: { background: colorFor(m.label), width: '72px', height: '72px', borderRadius: '20px', fontSize: '32px', margin: '8px auto 12px' }, text: [...m.label][0]?.toUpperCase() || '?' }),
      h('div', { class: 'large-title', style: { textAlign: 'center' }, text: m.label }),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'list glass' },
        h('button', { class: 'row tap', style: { width: '100%' }, onclick: () => m.username && copy(m.username, '用户名已复制') },
          h('div', { class: 'grow t', style: { textAlign: 'left', fontWeight: 500 }, text: '用户名' }), h('div', { class: 'v', text: m.username || '—' })),
        h('button', { class: 'row tap', style: { width: '100%' }, onclick: async () => {
          try {
            if (shown) { pw.textContent = '••••••••'; shown = false; return; }
            const { secrets } = await readSecrets();
            pw.textContent = secrets[id] || '（空）';
            shown = true;
          } catch (e) { vaultErr(e); }
        } }, h('div', { class: 'grow t', style: { textAlign: 'left', fontWeight: 500 }, text: '密码' }), pw)),
      h('div', { class: 'btns', style: { marginTop: '6px' } },
        h('button', { class: 'btn secondary tap', text: '复制密码', onclick: async () => { try { const { secrets } = await readSecrets(); await copy(secrets[id] || '', '密码已复制'); } catch (e) { vaultErr(e); } } })),
      h('div', { class: 'foot', style: { marginTop: '14px' }, text: `更新于 ${new Date(m.updated || Date.now()).toLocaleString('zh-CN')}` }),
      h('button', { class: 'btn danger tap', style: { marginTop: '14px' }, text: '删除账号', onclick: async () => {
        if (!(await confirmSheet({ title: `删除“${m.label}”？`, sub: '删除后无法恢复。', ok: '删除', danger: true }))) return;
        try { await deleteAccount(id); toast('已删除'); pop(); renderTab('vault'); } catch (e) { vaultErr(e); }
      } }),
    );
  };
  view.render();
  push(view);
}

function editAccount(id) {
  const v = loadVault();
  if (!v) { switchTab('vault'); toast('先设置密码库'); return; }
  const m = id ? v.meta.find((x) => x.id === id) : null;
  let entry;
  const label = h('input', { class: 'field', placeholder: '名称，例如 GitHub、公司邮箱', value: m?.label || '', autocomplete: 'off' });
  const user = h('input', { class: 'field', placeholder: '用户名 / 邮箱 / 手机号', value: m?.username || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: m ? '新密码（不改就留空）' : '密码', autocomplete: 'new-password' });
  const err = h('div', { class: 'note', style: { color: '#ff8a8d' } });
  const save = async () => {
    const account = { id: m?.id || Array.from(rand(8), (b) => b.toString(16).padStart(2, '0')).join(''), label: label.value.trim().slice(0, 60), username: user.value.trim().slice(0, 120) };
    if (!account.label) { err.textContent = '请填名称'; return; }
    if (!m && !pass.value) { err.textContent = '请填密码'; return; }
    try {
      await writeAccount(account, pass.value || undefined);
      entry.close();
      toast(m ? '已保存' : '已添加');
      renderTab('vault');
      for (const view of stack) view.render?.();
    } catch (e) { vaultErr(e); }
  };
  entry = openSheet([
    h('h3', { text: m ? '编辑账号' : '添加账号' }),
    h('div', { style: { height: '16px' } }),
    h('div', { class: 'label', text: '名称' }), label,
    h('div', { class: 'label', text: '用户名' }), user,
    h('div', { class: 'label', text: '密码' }), pass,
    err,
    h('div', { class: 'btns' },
      h('button', { class: 'btn secondary tap', text: '取消', onclick: () => entry.close() }),
      h('button', { class: 'btn primary tap', text: '保存', onclick: save })),
  ]);
  if (!m) setTimeout(() => label.focus(), 350);
}

// ---------- AI asks for a saved account ----------
let secretSheet = null;
function handleSecretRequests() {
  const requests = S.status?.secretRequests || [];
  if (secretSheet && !requests.some((r) => r.id === secretSheet.id)) {
    secretSheet.entry.close('gone');
    secretSheet = null;
  }
  const next = requests.find((r) => !S.seenSecrets.has(r.id));
  if (!next || secretSheet || takeover) return;
  S.seenSecrets.add(next.id);
  showSecretRequest(next);
}

function bestMatch(meta, hint) {
  const w = hint.toLowerCase();
  return meta.find((m) => m.label.toLowerCase() === w)
    || meta.find((m) => m.label.toLowerCase().includes(w) || w.includes(m.label.toLowerCase()))
    || meta.find((m) => (m.username || '').toLowerCase().includes(w)) || null;
}

function showSecretRequest(r) {
  const v = loadVault();
  const meta = v?.meta || [];
  let picked = bestMatch(meta, r.hint);
  const choices = h('div', { class: 'choice-list' });
  const drawChoices = () => {
    choices.textContent = '';
    for (const m of meta) {
      choices.append(h('button', { class: `choice tap${picked?.id === m.id ? ' on' : ''}`, style: { width: '100%', textAlign: 'left' }, onclick: () => { picked = m; drawChoices(); yes.disabled = false; } },
        h('div', { class: 'logo', style: { background: colorFor(m.label) }, text: [...m.label][0]?.toUpperCase() || '?' }),
        h('div', { class: 'grow' }, h('div', { class: 't', style: { fontSize: '15px', fontWeight: 600 }, text: m.label }), h('div', { class: 's', style: { fontSize: '12.5px', color: 'var(--text-2)' }, text: m.username || '' }))));
    }
  };
  const what = r.part === 'username' ? '用户名' : '密码';
  const face = h('div', { class: 'faceid', icon: 'faceid' });
  const yes = h('button', { class: 'btn primary tap', text: v?.mode === 'code' ? '解锁并允许' : '用 Face ID 允许', disabled: !picked, onclick: async () => {
    if (!picked) return;
    face.classList.add('scan');
    try {
      const { secrets } = await readSecrets({ fresh: true });
      await api(`secrets/${r.id}`, { method: 'POST', body: { approve: true, label: picked.label, username: picked.username || '', password: secrets[picked.id] || '' } });
      done('approved');
      toast(`已发送${what}，AI 看不到明文`);
    } catch (e) { face.classList.remove('scan'); vaultErr(e); }
  } });
  const no = h('button', { class: 'btn secondary tap', text: '拒绝', onclick: async () => {
    try { await api(`secrets/${r.id}`, { method: 'POST', body: { approve: false } }); } catch { /* expired anyway */ }
    done('denied');
    toast('已拒绝');
  } });
  const win = /window "([^"]*)"/.exec(r.where || '')?.[1];
  const field = /field "([^"]*)"/.exec(r.where || '')?.[1];
  const facts = [['想要', `${r.hint} 的${what}`], ['电脑', r.computer], win ? ['窗口', win] : null, field ? ['输入框', field] : null,
    !win && r.where ? ['位置', r.where] : null, r.reason ? ['原因', r.reason] : null].filter(Boolean);
  const content = [
    face,
    h('h3', { text: `AI 想输入${what}` }),
    h('div', { class: 'sub', text: '密码只在这台手机上解密，直接输进那台电脑，AI 看不到明文。' }),
    h('div', { class: 'facts' }, facts.map(([k, val]) => h('div', { class: 'row', style: { minHeight: '44px', padding: '10px 0' } }, h('div', { style: { color: 'var(--text-2)', flex: 'none', fontSize: '14px' }, text: k }), h('div', { class: 'grow', style: { textAlign: 'right', fontSize: '14px', overflowWrap: 'anywhere' }, text: val })))),
    meta.length ? h('div', { class: 'label', text: '用哪个账号' }) : null,
    meta.length ? choices : h('div', { class: 'note', text: '密码库里还没有账号。' }),
    meta.length ? null : h('button', { class: 'btn secondary tap', style: { marginBottom: '10px' }, text: v ? '添加账号' : '设置密码库', onclick: () => { done('later'); if (v) editAccount(null); else switchTab('vault'); } }),
    h('div', { class: 'note', text: '批准后 10 分钟内，这台电脑再用这个账号不用再问' }),
    h('div', { class: 'btns' }, no, yes),
  ];
  drawChoices();
  const entry = openSheet(content, { dismissable: false });
  secretSheet = { id: r.id, entry };
  const done = (why) => { if (secretSheet?.id === r.id) secretSheet = null; entry.close(why); setTimeout(handleSecretRequests, 700); };
}

// ---------- activity ----------
function activityRow(r) {
  const running = r.durationMs === undefined;
  const secs = running ? '' : `${(r.durationMs / 1000).toFixed(1)} 秒`;
  const sub = running ? h('div', { class: 's', text: '进行中…' })
    : r.status === 'failed' ? h('div', { class: 's', style: { color: '#ff8a8d' }, text: `没成功 · ${secs}` })
      : r.status === 'background' ? h('div', { class: 's', text: '在后台继续运行' })
        : h('div', { class: 's', text: secs });
  return h('div', { class: 'row' },
    running ? h('div', { class: 'spinner' }) : null,
    h('div', { class: 'grow' },
      h('div', { class: 't', style: { fontWeight: 500, fontSize: '15px' } }, h('span', { class: 'who', text: r.computer || '' }), ` ${toolName(r.action)}`),
      sub),
    h('div', { class: 'when', text: ago(r.startedAt) }));
}

function renderActivity() {
  const a = S.activity;
  const out = [h('div', { class: 'large-title', text: '动态' }), h('div', { class: 'subtitle', text: 'AI 最近在你的电脑上做了什么' })];
  if (!a) { out.push(h('div', { class: 'empty' }, h('div', { class: 'spinner', style: { margin: '0 auto' } }))); return out; }
  if (a.active?.length) {
    out.push(h('div', { class: 'section', text: '正在进行' }));
    out.push(h('div', { class: 'list glass feed' }, a.active.map((r) => activityRow(r))));
  }
  out.push(h('div', { class: 'section', text: '最近' }));
  if (!a.recent?.length) out.push(h('div', { class: 'card glass empty', text: 'AI 还没有做过什么' }));
  else out.push(h('div', { class: 'list glass feed' }, a.recent.slice(0, 50).map((r) => activityRow(r))));
  return out;
}

let activityTimer = null;
async function pollActivity() {
  clearTimeout(activityTimer);
  if (!key) return;
  if (!document.hidden) {
    try {
      S.activity = await api('activity');
      if (S.tab === 'activity' && !stack.length) renderTab('activity');
      if (S.tab === 'computers' && !stack.length) renderTab('computers');
    } catch { /* shown by the main loop */ }
  }
  activityTimer = setTimeout(pollActivity, S.tab === 'activity' ? 3000 : 15000);
}

// ---------- settings ----------
function renderSettings() {
  const st = S.status;
  const lic = st?.license;
  const push = pushState();
  const row = (label, value, onclick, color) => h(onclick ? 'button' : 'div', { class: `row${onclick ? ' tap' : ''}`, style: { width: '100%' }, onclick },
    h('div', { class: 'grow t', style: { textAlign: 'left', fontWeight: 500, color } , text: label }),
    value != null ? (value instanceof Node ? value : h('div', { class: 'v', text: value })) : null,
    onclick && value == null ? h('div', { class: 'chev', text: '›' }) : null);
  const pushSwitch = h('div', { class: `switch${push === 'on' ? ' on' : ''}` });
  return [
    h('div', { class: 'large-title', text: '设置' }),
    h('div', { class: 'subtitle', text: location.host }),
    h('div', { class: 'section', text: '通知' }),
    h('div', { class: 'list glass' },
      row('AI 需要我时提醒我', pushSwitch, () => togglePush(pushSwitch)),
      push === 'on' ? row('发一条测试通知', null, async () => { try { const r = await api('push/test', { method: 'POST', body: {} }); toast(r.sent ? '已发送' : '没有送达，请重新打开通知'); } catch (e) { toast(e.message); } }) : null),
    h('div', { class: 'foot', text: isStandalone() ? 'AI 请你接手浏览器、或想输入密码时，手机会收到通知。' : '先把万机“添加到主屏幕”，再从主屏幕打开，才能开通知（iOS 16.4 或更新）。' }),
    h('div', { class: 'section', text: '给 AI 的链接' }),
    h('div', { class: 'list glass' },
      row('复制完整链接', null, () => st?.mcp?.full && copy(st.mcp.full, '链接已复制')),
      row('只复制地址', null, () => st?.mcp?.address && copy(st.mcp.address, '地址已复制')),
      row('只复制密钥', null, () => st?.mcp?.key && copy(st.mcp.key, '密钥已复制'))),
    h('div', { class: 'foot', text: '把完整链接给 ChatGPT、Claude 等 AI，它就能控制你的电脑。不要给别人。' }),
    h('div', { class: 'section', text: '版本' }),
    h('div', { class: 'list glass' },
      row('方案', lic?.plan === 'pro' ? 'Pro' : '免费版'),
      lic?.expiresAt ? row('到期', new Date(lic.expiresAt).toLocaleDateString('zh-CN')) : null),
    h('div', { class: 'section', text: '密码库' }),
    h('div', { class: 'list glass' },
      row('加密方式', loadVault() ? (loadVault().mode === 'faceid' ? 'Face ID' : '主密码') : '未设置'),
      loadVault() ? row('导出加密备份', null, exportVault) : null,
      row('从备份恢复', null, importVault),
      loadVault() ? row('删除这台手机上的密码库', null, async () => {
        if (!(await confirmSheet({ title: '删除密码库？', sub: '这台手机上的所有账号都会删掉，无法恢复。', ok: '删除', danger: true }))) return;
        localStorage.removeItem(VAULT_STORE);
        vaultKey = null;
        syncVaultMeta();
        try { await api('vault-meta', { method: 'POST', body: { device: deviceId(), entries: [] } }); } catch { /* ignore */ }
        toast('已删除');
        renderTab('vault');
        renderTab('settings');
      }, '#ff8a8d') : null),
    h('div', { class: 'foot', text: '备份文件是加密的。Face ID 加密的备份，要用同一个 Apple 账号的设备（通行密钥会经 iCloud 钥匙串同步）才能打开。' }),
    h('div', { class: 'list glass', style: { marginTop: '22px' } },
      row('断开这台手机', null, async () => {
        if (!(await confirmSheet({ title: '断开这台手机？', sub: '要再连，需要在电脑上重新扫码。密码库会留着。', ok: '断开', danger: true }))) return;
        await disablePush();
        unpair();
      }, '#ff8a8d')),
    h('div', { class: 'foot', style: { textAlign: 'center', marginTop: '18px' }, text: '万机 · 网页版' }),
  ];
}

function exportVault() {
  const v = loadVault();
  if (!v) return;
  const blob = new Blob([JSON.stringify({ wanjiVault: 1, ...v }, null, 2)], { type: 'application/json' });
  const name = `wanji-vault-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function importVault() {
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.wanjiVault !== 1 || !data.iv || !data.data || !Array.isArray(data.meta)) throw new Error('这不是万机密码库的备份');
      if (loadVault() && !(await confirmSheet({ title: '用备份替换？', sub: '这台手机上现有的账号会被备份里的替换。', ok: '替换', danger: true }))) return;
      const { wanjiVault, ...v } = data;
      const before = localStorage.getItem(VAULT_STORE);
      saveVault(v);
      vaultKey = null;
      try { await unlockVault({ fresh: true }); } catch (e) {
        if (before) localStorage.setItem(VAULT_STORE, before); else localStorage.removeItem(VAULT_STORE);
        throw e;
      }
      syncVaultMeta();
      toast('已恢复');
      renderTab('vault');
      renderTab('settings');
    } catch (e) { vaultErr(e); }
  });
  input.click();
}

// ---------- push notifications ----------
function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem('wanji.push') === 'on' && Notification.permission === 'granted' ? 'on' : 'off';
}

async function togglePush(sw) {
  const state = pushState();
  if (state === 'unsupported') { toast(isIOS && !isStandalone() ? '先添加到主屏幕，再从主屏幕打开' : '这个浏览器不支持通知'); if (isIOS && !isStandalone()) installGuide(); return; }
  if (state === 'denied') { toast('通知被关了：去 iPhone 设置 › 通知 › 万机 打开'); return; }
  if (state === 'on') { await disablePush(); sw.classList.remove('on'); toast('通知已关闭'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('没有允许通知'); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('push/key');
    const appKey = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    let sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await api('push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: isIOS ? 'iPhone' : 'browser' } });
    localStorage.setItem('wanji.push', 'on');
    sw.classList.add('on');
    toast('通知已打开');
    renderTab('settings');
  } catch (e) { toast(e.message || '打开通知失败'); }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/app/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* nothing to undo */ }
  localStorage.removeItem('wanji.push');
}

// ---------- live connection ----------
let loopToken = 0;
async function refresh() {
  if (!key) return;
  const st = await api('status');
  const firstLoad = !S.status;
  S.status = st;
  S.version = st.version;
  S.offline = false;
  const pending = computers().filter((c) => c.takeover);
  setBadge('computers', pending.length);
  if (!stack.length) {
    if (S.tab === 'computers') renderTab('computers', firstLoad);
    if (S.tab === 'settings') renderTab('settings');
  }
  for (const view of stack) view.render?.();
  for (const c of pending) {
    const tag = `${c.id}:${c.takeover.title}`;
    if (S.seenTakeovers.has(tag) || takeover?.id === c.id) continue;
    S.seenTakeovers.add(tag);
    banner({ title: 'AI 需要你帮忙', sub: `${c.name} 的浏览器${c.takeover.title ? `：${c.takeover.title}` : ''}`, onTap: () => openTakeover(c.id) });
  }
  if (takeover) {
    const c = computers().find((x) => x.id === takeover.id);
    if (c?.takeover) { takeover.t1.textContent = 'AI 需要你帮忙'; takeover.t2.textContent = `${c.name} · AI 已暂停操作`; }
  }
  handleSecretRequests();
}

async function liveLoop() {
  const me = ++loopToken;
  while (key && me === loopToken) {
    if (document.hidden) { await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true })); continue; }
    try {
      const w = await api(`wait?since=${S.version ?? ''}`, { timeout: 40000 });
      if (me !== loopToken) return;
      if (w.version !== S.version || !S.status) await refresh();
    } catch {
      if (me !== loopToken || !key) return;
      if (!S.offline) { S.offline = true; if (S.tab === 'computers' && !stack.length) renderTab('computers'); }
      await sleep(2500);
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && key) { refresh().catch(() => {}); pollActivity(); syncVaultMeta(); }
});

navigator.serviceWorker?.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'open' && msg.kind === 'takeover' && msg.computer) openTakeover(msg.computer);
  refresh().catch(() => {});
});

// ---------- pairing ----------
function parsePair(text) {
  const s = String(text || '').trim();
  let m = /[#&]pair=([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) {
    try { if (new URL(s).host !== location.host) return { error: `这个配对链接属于 ${new URL(s).host}，请在那个地址打开` }; } catch { /* bare fragment */ }
    return { key: m[1] };
  }
  m = /^wanji:\/\/([^/\s]+)\/([A-Za-z0-9_-]{20,})$/.exec(s);
  if (m) return m[1] === location.host ? { key: m[2] } : { error: `这个配对码属于 ${m[1]}，请在 https://${m[1]}/app/ 打开` };
  if (/^[A-Za-z0-9_-]{40,}$/.test(s)) return { key: s };
  return { error: '这不是万机的配对码' };
}

async function tryPair(candidate) {
  const parsed = parsePair(candidate);
  if (parsed.error) { toast(parsed.error); return false; }
  try {
    await api('status', { auth: parsed.key });
  } catch (e) {
    toast(e.status === 401 || /连接已失效/.test(e.message) ? '配对码不对或已失效，请在电脑上重新显示' : e.message);
    return false;
  }
  key = parsed.key;
  localStorage.setItem(KEY_STORE, key);
  return true;
}

function unpair(message) {
  key = null;
  localStorage.removeItem(KEY_STORE);
  loopToken++;
  S.status = null;
  S.version = null;
  closeTakeover();
  while (sheets.length) sheets[0].close();
  showPair(message);
}

function showPair(message) {
  const app = $('#app');
  app.textContent = '';
  const field = h('input', { class: 'field', placeholder: '或者把配对链接粘贴到这里', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const go = async (text) => { if (await tryPair(text)) start(); };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(field.value); });
  const box = h('div', { class: 'pair' },
    h('div', { class: 'logo-big glass strong appear', text: '万' }),
    h('h1', { class: 'appear', vars: { '--i': '1' }, text: '连接万机' }),
    h('p', { class: 'lead appear', vars: { '--i': '2' }, text: message || '用手机管住你所有的电脑：接手浏览器做人机验证，用 Face ID 批准 AI 输入密码。' }),
    h('div', { class: 'card glass appear', vars: { '--i': '3' } },
      h('div', { class: 'steps' },
        h('div', { text: '在电脑上打开“万机管理器”，点“连接手机 App”，切到 iPhone。' }),
        h('div', { text: '用 iPhone 相机扫二维码，会打开这个页面并自动连上。' }),
        h('div', { text: '已经扫过？点下面的按钮，粘贴配对链接。' }))),
    h('button', { class: 'btn primary tap appear', vars: { '--i': '4' }, style: { margin: '6px 0 12px' }, text: '粘贴配对链接', onclick: async () => {
      try { const text = await navigator.clipboard.readText(); if (text) go(text); else toast('剪贴板是空的'); } catch { toast('读不到剪贴板，请粘贴到下面的框里'); field.focus(); }
    } }),
    h('div', { class: 'appear', vars: { '--i': '5' } }, field));
  app.append(box);
}

// Safari to the Home Screen: a Home Screen app has its own storage, so carry the key over by clipboard.
function installGuide() {
  let entry;
  const link = `${location.origin}/app/#pair=${key}`;
  entry = openSheet([
    h('h3', { text: '添加到主屏幕' }),
    h('div', { class: 'sub', text: '添加后像 App 一样全屏打开，也能收到通知。' }),
    h('div', { class: 'card', style: { background: 'rgba(255,255,255,.1)', margin: '16px 0 12px' } },
      h('div', { class: 'steps' },
        h('div', null, '点下面的按钮复制配对链接'),
        h('div', null, '点 Safari 底部的 ', h('span', { icon: 'share', style: { display: 'inline-flex', verticalAlign: '-3px' } }), ' 分享，选“添加到主屏幕”'),
        h('div', null, '从主屏幕打开万机，点“粘贴配对链接”'))),
    h('div', { class: 'note', text: '配对链接等于你所有电脑的钥匙，不要发给别人。' }),
    h('div', { class: 'btns' },
      h('button', { class: 'btn secondary tap', text: '以后再说', onclick: () => entry.close() }),
      h('button', { class: 'btn primary tap', text: '复制配对链接', onclick: () => copy(link, '已复制，现在去添加到主屏幕') })),
  ]);
}

async function start() {
  buildShell();
  try {
    await refresh();
  } catch (e) {
    if (!key) return;
    S.offline = true;
    toast(e.message);
  }
  liveLoop();
  pollActivity();
  syncVaultMeta();
  const hash = location.hash;
  if (hash.startsWith('#takeover=')) openTakeover(decodeURIComponent(hash.slice('#takeover='.length)));
  if (hash) history.replaceState(null, '', location.pathname);
  if (isIOS && !isStandalone() && !sessionStorage.getItem('wanji.guided')) {
    sessionStorage.setItem('wanji.guided', '1');
    setTimeout(installGuide, 900);
  }
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: '/app/' }).catch(() => {});
  const pairHash = /[#&]pair=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if (pairHash) {
    history.replaceState(null, '', location.pathname);
    if (pairHash[1] !== key && await tryPair(`#pair=${pairHash[1]}`)) toast('已连接');
  }
  if (key) start();
  else showPair();
}

boot();
