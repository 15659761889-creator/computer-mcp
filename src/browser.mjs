import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { homeDir, loadConfig } from './config.mjs';

// A browser only the AI uses: Chromium driven by Playwright, headless, with its own profile, so
// it works on a computer without a screen (a Linux VM or server) and never takes over the owner's
// windows. Pages are read the way ui_look reads the desktop: numbered elements and visible text.

const VERSION = '1.64.1';
// Pinned: the package is fetched from whichever registry answers and checked against this.
const INTEGRITY = 'sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ==';
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const DOWNLOAD_MIRROR = 'https://registry.npmmirror.com/-/binary/playwright';
const IDLE_MS = 30 * 60 * 1000;
const MAX_ELEMENTS = 150;
const MAX_TEXT = 6000;

const browserDir = () => path.join(homeDir(), 'browser');
const coreDir = () => path.join(browserDir(), 'node_modules', 'playwright-core');
const browsersPath = () => path.join(browserDir(), 'ms-playwright');
const profileDir = () => path.join(browserDir(), 'profile');

export const browserInstalled = () => fs.existsSync(path.join(coreDir(), 'package.json')) && fs.existsSync(browsersPath());

// ---- Installing ----

async function fetchCore(proxy) {
  const env = proxy ? { HTTPS_PROXY: proxy } : {};
  Object.assign(process.env, env);
  const file = path.join(browserDir(), `playwright-core-${VERSION}.tgz`);
  for (const registry of REGISTRIES) {
    try {
      const res = await fetch(`${registry}/playwright-core/-/playwright-core-${VERSION}.tgz`, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const got = `sha512-${createHash('sha512').update(data).digest('base64')}`;
      if (got !== INTEGRITY) throw new Error('checksum does not match');
      fs.writeFileSync(file, data);
      return file;
    } catch (err) {
      console.log(`  ${new URL(registry).host}: ${err.message}`);
    }
  }
  throw new Error('could not download playwright-core; if this network needs a proxy, add --proxy http://host:port');
}

function run(exe, args, env = {}) {
  const result = spawnSync(exe, args, { stdio: 'inherit', env: { ...process.env, ...env }, windowsHide: true });
  return result.status === 0;
}

// Installs Playwright and Chromium into the 万机 folder; on Linux also the system
// libraries and Chinese fonts Chromium needs, when sudo works without a password.
export async function installBrowser({ proxy } = {}) {
  fs.mkdirSync(browserDir(), { recursive: true });
  if (!fs.existsSync(path.join(coreDir(), 'package.json'))) {
    console.log(`Downloading Playwright ${VERSION}...`);
    const tgz = await fetchCore(proxy);
    const target = coreDir();
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    if (!run('tar', ['-xzf', tgz, '-C', target, '--strip-components=1'])) throw new Error('unpacking playwright-core failed');
    fs.rmSync(tgz, { force: true });
  }
  const cli = path.join(coreDir(), 'cli.js');
  const env = { PLAYWRIGHT_BROWSERS_PATH: browsersPath(), ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}) };
  if (process.platform === 'linux') {
    console.log('Installing the system libraries and Chinese fonts Chromium needs (sudo)...');
    const deps = run('sudo', ['-n', process.execPath, cli, 'install-deps', 'chromium'], env)
      && run('sudo', ['-n', 'apt-get', 'install', '-y', '-q', 'fonts-noto-cjk'], env);
    if (!deps) console.log(`Could not install them without a password. Run as root:\n  ${process.execPath} ${cli} install-deps chromium && apt-get install -y fonts-noto-cjk`);
  }
  console.log('Downloading Chromium...');
  const ok = run(process.execPath, [cli, 'install', '--no-shell', 'chromium'], env)
    || (console.log('Trying the npmmirror copy...'), run(process.execPath, [cli, 'install', '--no-shell', 'chromium'], { ...env, PLAYWRIGHT_DOWNLOAD_HOST: DOWNLOAD_MIRROR }));
  if (!ok) throw new Error('downloading Chromium failed');
  console.log('Checking that it starts...');
  const reply = await browserTool({ action: 'open', url: 'about:blank' });
  await closeBrowser();
  if (reply.isError) throw new Error(`Chromium does not start: ${reply.text}`);
  console.log('The browser is ready.');
}

// ---- Running ----

let context = null;
let starting = null;
let current = null;
let idleTimer = null;
let queue = Promise.resolve();
const notes = [];
const looks = new WeakMap();

function proxyOption() {
  const configured = loadConfig()?.proxy;
  const server = configured || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!server) return undefined;
  const bypass = process.env.NO_PROXY || process.env.no_proxy;
  return { server, ...(bypass ? { bypass } : {}) };
}

function watch(page) {
  page.on('dialog', (dialog) => {
    notes.push(`the page showed a ${dialog.type()} dialog: "${dialog.message().slice(0, 200)}" (accepted)`);
    dialog.accept().catch(() => {});
  });
  page.on('download', async (download) => {
    const file = path.join(os.homedir(), 'Downloads', download.suggestedFilename());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      await download.saveAs(file);
      notes.push(`downloaded ${file}`);
    } catch (err) {
      notes.push(`a download failed: ${err.message.split('\n')[0]}`);
    }
  });
}

async function open() {
  if (context) return context;
  if (!starting) {
    starting = (async () => {
      if (!browserInstalled()) throw new Error('the browser is not installed on this computer; the owner can run: wanji browser');
      process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();
      const { chromium } = createRequire(import.meta.url)(coreDir());
      const ctx = await chromium.launchPersistentContext(profileDir(), {
        channel: 'chromium',
        headless: true,
        acceptDownloads: true,
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
        proxy: proxyOption(),
        args: ['--disable-blink-features=AutomationControlled'],
      });
      ctx.on('page', (page) => {
        watch(page);
        current = page;
      });
      for (const page of ctx.pages()) watch(page);
      ctx.on('close', () => {
        context = null;
        current = null;
      });
      current = ctx.pages()[0] || await ctx.newPage();
      context = ctx;
      return ctx;
    })().finally(() => { starting = null; });
  }
  return starting;
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const ctx = context;
  context = null;
  current = null;
  await ctx?.close().catch(() => {});
}

function page() {
  const pages = context.pages();
  if (!current || current.isClosed()) current = pages[pages.length - 1] || null;
  return current;
}

// Numbers every visible control on the page and returns them with the visible text.
function readPage() {
  const selector = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll('[data-cmcp]')) el.removeAttribute('data-cmcp');
  for (const el of document.querySelectorAll(selector)) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width < 2 || box.height < 2 || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    n += 1;
    el.setAttribute('data-cmcp', String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag);
    const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.placeholder || '';
    items.push({
      id: n,
      role,
      name: String(label).replace(/\s+/g, ' ').trim().slice(0, 80),
      value: ['input', 'textarea', 'select'].includes(tag) && !['checkbox', 'radio', 'submit', 'button'].includes(el.type) ? String(el.value || '').slice(0, 60) : undefined,
      checked: ['checkbox', 'radio'].includes(el.type) ? el.checked : undefined,
      href: tag === 'a' ? el.href.slice(0, 120) : undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      inView: box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth,
    });
  }
  const text = document.body ? document.body.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  return { items, text, y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight };
}

function describe(item) {
  const parts = [`[${item.id}] ${item.role}`];
  if (item.name) parts.push(JSON.stringify(item.name));
  if (item.value !== undefined && item.value !== '') parts.push(`value=${JSON.stringify(item.value)}`);
  if (item.checked !== undefined) parts.push(item.checked ? 'checked' : 'unchecked');
  if (item.disabled) parts.push('disabled');
  if (item.href && !item.href.startsWith('javascript:')) parts.push(`-> ${item.href}`);
  return parts.join(' ');
}

async function look(p, { find, image } = {}) {
  let state;
  try {
    state = await p.evaluate(readPage);
  } catch (err) {
    // The page navigated while it was being read: once more after it settles.
    await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    state = await p.evaluate(readPage);
  }
  looks.set(p, state);
  const pages = context.pages();
  const lines = [`tab ${pages.indexOf(p) + 1} of ${pages.length}: ${await p.title().catch(() => '')}`, `address: ${p.url()}`];
  if (state.height > state.view) lines.push(`scrolled to ${state.y}-${state.y + state.view} of ${state.height} px`);
  let items = state.items;
  let text = state.text;
  if (find) {
    const wanted = String(find).toLowerCase();
    items = items.filter((i) => `${i.name} ${i.value || ''} ${i.href || ''}`.toLowerCase().includes(wanted));
    text = text.split('\n').filter((line) => line.toLowerCase().includes(wanted)).join('\n');
  }
  const ordered = [...items.filter((i) => i.inView), ...items.filter((i) => !i.inView)];
  lines.push(`elements (${items.length}${items.length > MAX_ELEMENTS ? `, first ${MAX_ELEMENTS} shown; use find` : ''}; those on screen first):`);
  for (const item of ordered.slice(0, MAX_ELEMENTS)) lines.push(`${describe(item)}${item.inView ? '' : ' (off screen)'}`);
  lines.push('--- text ---', text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... (${text.length - MAX_TEXT} more characters; use find, or js)` : text || '(no text)');
  if (notes.length) lines.push('--- notes ---', ...notes.splice(0));
  const outcome = { text: lines.join('\n') };
  if (image) {
    const shot = await p.screenshot({ type: 'jpeg', quality: 60 });
    outcome.image = { data: shot.toString('base64'), mimeType: 'image/jpeg' };
  }
  return outcome;
}

class BrowserError extends Error {}

// An element from the last look, by id or by its text. Ambiguity is an error, never a guess.
async function target(p, args) {
  if (args.id !== undefined) {
    const locator = p.locator(`[data-cmcp="${Number(args.id)}"]`);
    if (await locator.count() === 0) throw new BrowserError(`element ${args.id} is no longer on the page; look again`);
    return locator.first();
  }
  if (typeof args.text === 'string' && args.text.trim()) {
    const wanted = args.text.trim().toLowerCase();
    const items = looks.get(p)?.items || (await p.evaluate(readPage)).items;
    const exact = items.filter((i) => i.name.toLowerCase() === wanted);
    const partial = items.filter((i) => i.name.toLowerCase().includes(wanted));
    const found = exact.length ? exact : partial;
    if (found.length === 1) return p.locator(`[data-cmcp="${found[0].id}"]`).first();
    if (found.length > 1) throw new BrowserError(`"${args.text}" matches ${found.length} elements, so nothing was done:\n${found.slice(0, 8).map(describe).join('\n')}\nUse id.`);
    const loose = p.getByText(args.text, { exact: false });
    const count = await loose.count();
    if (count === 1) return loose;
    throw new BrowserError(count ? `"${args.text}" appears ${count} times on the page; look and use an id` : `nothing on the page says "${args.text}"; look again`);
  }
  throw new BrowserError('name the element with id (from look) or text');
}

async function settle(p) {
  await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await p.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
}

const clean = (err) => String(err.message || err).split('\n')[0].replace(/^\w+\.\w+: /, '');

async function act(args) {
  await open();
  let p = page() || await context.newPage();
  const timeout = Math.min(Math.max(Number(args.timeout) || 15, 1), 120) * 1000;
  switch (args.action) {
    case 'open': {
      if (typeof args.url !== 'string' || !args.url.trim()) throw new BrowserError('open needs url');
      let url = args.url.trim();
      if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
      if (args.new_tab) {
        p = await context.newPage();
        current = p;
      }
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30000) });
      break;
    }
    case 'look':
      break;
    case 'click':
      await (await target(p, args)).click({ timeout });
      break;
    case 'type': {
      if (typeof args.value !== 'string') throw new BrowserError('type needs value, the text to enter');
      const field = await target(p, args);
      if (args.append) await field.pressSequentially(args.value, { timeout });
      else await field.fill(args.value, { timeout });
      if (args.submit) await field.press('Enter', { timeout });
      break;
    }
    case 'press':
      if (typeof args.key !== 'string') throw new BrowserError('press needs key, such as Enter, Escape or Control+A');
      if (args.id !== undefined || args.text) await (await target(p, args)).press(args.key, { timeout });
      else await p.keyboard.press(args.key);
      break;
    case 'select':
      await (await target(p, args)).selectOption(String(args.value ?? ''), { timeout });
      break;
    case 'upload':
      if (typeof args.path !== 'string') throw new BrowserError('upload needs path, a file on this computer');
      await (await target(p, args)).setInputFiles(args.path, { timeout });
      break;
    case 'scroll':
      if (args.id !== undefined || args.text) {
        await (await target(p, args)).scrollIntoViewIfNeeded({ timeout });
      } else {
        const view = p.viewportSize()?.height || 900;
        await p.mouse.move(640, 450);
        await p.mouse.wheel(0, (args.direction === 'up' ? -1 : 1) * (Number(args.amount) || Math.round(view * 0.8)));
        await p.waitForTimeout(300);
      }
      break;
    case 'back':
      await p.goBack({ timeout, waitUntil: 'domcontentloaded' });
      break;
    case 'forward':
      await p.goForward({ timeout, waitUntil: 'domcontentloaded' });
      break;
    case 'reload':
      await p.reload({ timeout, waitUntil: 'domcontentloaded' });
      break;
    case 'tabs': {
      const pages = context.pages();
      const lines = await Promise.all(pages.map(async (x, i) => `${i + 1}${x === p ? ' (current)' : ''}: ${await x.title().catch(() => '')} - ${x.url()}`));
      return { text: lines.join('\n') || 'no tabs' };
    }
    case 'tab': {
      const pages = context.pages();
      const chosen = pages[Number(args.index) - 1];
      if (!chosen) throw new BrowserError(`there is no tab ${args.index}; there are ${pages.length}`);
      if (args.close) {
        await chosen.close();
        p = page() || await context.newPage();
      } else {
        p = chosen;
        current = chosen;
        await p.bringToFront();
      }
      break;
    }
    case 'wait':
      if (typeof args.text === 'string' && args.text) await p.getByText(args.text).first().waitFor({ timeout });
      else await p.waitForTimeout(Math.min(Number(args.amount) || 1000, 30000));
      break;
    case 'js': {
      if (typeof args.value !== 'string') throw new BrowserError('js needs value, a JavaScript expression');
      const result = await p.evaluate(args.value);
      const shown = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
      return { text: shown.length > 20000 ? `${shown.slice(0, 20000)}\n... (${shown.length - 20000} more characters)` : shown };
    }
    case 'close':
      await closeBrowser();
      return { text: 'browser closed; the profile (logins, cookies) is kept for next time' };
    default:
      throw new BrowserError(`unknown action ${args.action}`);
  }
  await settle(page() || p);
  return look(page() || p, { find: args.find, image: args.image === true });
}

export const BROWSER_TOOL = {
  name: 'browser',
  description: 'A web browser on this computer for you alone: Chromium without a window, with its own profile that keeps logins, so it works on computers without a screen and never touches the owner\'s windows. action: open (url, new_tab), look, click, type (value, submit, append), press (key), select (value), upload (path), scroll (direction, amount; or an element), back, forward, reload, tabs, tab (index, close), wait (text, or amount in ms), js (value: an expression, returns JSON), close. Elements are numbered in each reply; act on them by id, or by text when that matches exactly one. Every action returns the page afterwards: tab, address, numbered elements and visible text, plus dialogs it accepted and files it downloaded to ~/Downloads. find filters the reply; image: true adds a screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'look', 'click', 'type', 'press', 'select', 'upload', 'scroll', 'back', 'forward', 'reload', 'tabs', 'tab', 'wait', 'js', 'close'] },
      url: { type: 'string' },
      id: { type: 'number', description: 'Element number from the last reply.' },
      text: { type: 'string', description: 'Visible text of the element, instead of id; for wait, the text to wait for.' },
      value: { type: 'string', description: 'Text to type, option to select, or JavaScript for js.' },
      key: { type: 'string' },
      submit: { type: 'boolean', description: 'type: press Enter afterwards.' },
      append: { type: 'boolean', description: 'type: add to the field instead of replacing it.' },
      new_tab: { type: 'boolean' },
      index: { type: 'number', description: 'Tab number for tab.' },
      close: { type: 'boolean', description: 'tab: close that tab.' },
      direction: { type: 'string', enum: ['up', 'down'] },
      amount: { type: 'number', description: 'scroll: pixels; wait: milliseconds.' },
      path: { type: 'string' },
      find: { type: 'string', description: 'Only elements and text lines containing this.' },
      image: { type: 'boolean' },
      timeout: { type: 'number', description: 'Seconds per step. Default 15.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  annotations: { title: 'Use a web browser', destructiveHint: true, openWorldHint: true },
};

// One action at a time; the browser closes after half an hour unused.
export function browserTool(args = {}) {
  const run = queue.then(async () => {
    clearTimeout(idleTimer);
    try {
      return await act(args);
    } catch (err) {
      return { text: err instanceof BrowserError ? err.message : `browser: ${clean(err)}`, isError: true };
    } finally {
      idleTimer = setTimeout(() => { closeBrowser(); }, IDLE_MS);
      idleTimer.unref();
    }
  });
  queue = run.catch(() => {});
  return run;
}

// ---- Taking over from the phone: the same calls as the desktop's handoff_*, for this browser ----

const pageIds = new WeakMap();
let nextPageId = 1;
// Negative, so it can never be mistaken for a Windows window handle.
function handleOf(p) {
  if (!pageIds.has(p)) pageIds.set(p, nextPageId++);
  return -pageIds.get(p);
}

export const isAiBrowserHandle = (hwnd) => Number(hwnd) < 0;
export const aiBrowserRunning = () => Boolean(context);

const KEYS = {
  enter: 'Enter', tab: 'Tab', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', 'ctrl+a': 'Control+A', 'shift+tab': 'Shift+Tab', space: 'Space',
};

const titleOf = async (p) => `AI 浏览器 · ${(await p.title().catch(() => '')) || p.url()}`;

function pageByHandle(hwnd) {
  const found = context?.pages().find((p) => handleOf(p) === Number(hwnd));
  if (!found) throw new BrowserError('that browser tab is no longer available');
  return found;
}

async function handoff(method, args) {
  if (method === 'handoff_list') {
    if (!context && args.launch && browserInstalled()) await open();
    const windows = context ? await Promise.all(context.pages().map(async (p) => ({ hwnd: handleOf(p), title: await titleOf(p), automation: false, minimized: false }))) : [];
    return { text: `${windows.length} AI browser tabs`, windows };
  }
  if (method === 'handoff_start') {
    await open();
    const p = page() || await context.newPage();
    return { text: 'browser selected', hwnd: handleOf(p), title: await titleOf(p) };
  }
  if (!context) throw new BrowserError('that browser tab is no longer available');
  const p = pageByHandle(args.hwnd);
  if (method === 'handoff_select') {
    current = p;
    await p.bringToFront();
    return { text: 'browser selected', hwnd: handleOf(p), title: await titleOf(p) };
  }
  if (method === 'handoff_frame') {
    const shot = await p.screenshot({ type: 'jpeg', quality: 66 });
    return { text: 'browser frame', image: { data: shot.toString('base64'), mimeType: 'image/jpeg' } };
  }
  if (method !== 'handoff_input') throw new BrowserError(`unknown method ${method}`);
  const view = p.viewportSize() || { width: 1280, height: 900 };
  const at = (x, y) => {
    if (![x, y].every((v) => typeof v === 'number' && v >= 0 && v <= 1)) throw new BrowserError('coordinates outside browser');
    return [Math.min(view.width - 1, Math.round(x * view.width)), Math.min(view.height - 1, Math.round(y * view.height))];
  };
  switch (args.action) {
    case 'click': await p.mouse.click(...at(args.x, args.y)); break;
    case 'double_click': await p.mouse.dblclick(...at(args.x, args.y)); break;
    case 'right_click': await p.mouse.click(...at(args.x, args.y), { button: 'right' }); break;
    case 'drag': {
      await p.mouse.move(...at(args.x, args.y));
      await p.mouse.down();
      await p.mouse.move(...at(args.to_x, args.to_y), { steps: 12 });
      await p.mouse.up();
      break;
    }
    case 'scroll': {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount < -10 || amount > 10) throw new BrowserError('scroll amount out of range');
      await p.mouse.move(...at(args.x, args.y));
      // A wheel notch up is positive on Windows; in the browser positive scrolls down.
      await p.mouse.wheel(0, -amount * 120);
      break;
    }
    case 'type':
      if (typeof args.text !== 'string' || args.text.length > 2000) throw new BrowserError('text must be at most 2000 characters');
      await p.keyboard.insertText(args.text);
      break;
    case 'key':
      if (!KEYS[args.keys]) throw new BrowserError('key not permitted');
      await p.keyboard.press(KEYS[args.keys]);
      break;
    default:
      throw new BrowserError('unsupported input action');
  }
  return { text: `${args.action} performed in browser` };
}

// Runs a phone takeover call against this browser, in turn with the AI's own actions.
export function aiBrowserHandoff(method, args = {}) {
  const run = queue.then(async () => {
    try {
      return await handoff(method, args);
    } catch (err) {
      return { text: err instanceof BrowserError ? err.message : `browser: ${clean(err)}`, isError: true };
    } finally {
      // The person using it from the phone keeps it open, like the AI does.
      if (context) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { closeBrowser(); }, IDLE_MS);
        idleTimer.unref();
      }
    }
  });
  queue = run.catch(() => {});
  return run;
}
