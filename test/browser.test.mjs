import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { homeDir } from '../src/config.mjs';

// Runs only where `wanji browser` has installed Chromium; it borrows that install with a
// fresh profile, so the AI's own logins are not touched.
const installed = path.join(homeDir(), 'browser');
const ready = fs.existsSync(path.join(installed, 'ms-playwright')) && fs.existsSync(path.join(installed, 'node_modules', 'playwright-core'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-browser-'));
let browserTool;
let closeBrowser;
let server;
let base;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>测试页</title></head><body>
<h1>你好，浏览器</h1>
<form action="/search"><label>关键词 <input name="q" placeholder="搜索"></label><button>搜索</button></form>
<a href="/second">第二页</a> <a href="/second">第二页</a>
<button onclick="document.getElementById('out').textContent = confirm('确定吗?') ? '已确定' : '已取消'">删除</button>
<p id="out"></p>
<select name="fruit"><option value="a">苹果</option><option value="b">香蕉</option></select>
<a href="/file.txt" download>下载文件</a>
</body></html>`;

before(async () => {
  if (!ready) return;
  fs.mkdirSync(path.join(dir, 'browser', 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(installed, 'node_modules', 'playwright-core'), path.join(dir, 'browser', 'node_modules', 'playwright-core'), 'junction');
  fs.symlinkSync(path.join(installed, 'ms-playwright'), path.join(dir, 'browser', 'ms-playwright'), 'junction');
  process.env.COMPUTER_MCP_HOME = dir;
  ({ browserTool, closeBrowser } = await import('../src/browser.mjs'));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/file.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="cmcp-test-download.txt"' }).end('downloaded');
    } else if (url.pathname === '/search') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<title>结果</title><p>你搜索了：${url.searchParams.get('q')}</p>`);
    } else if (url.pathname === '/second') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>第二页</title><p>这是第二页</p>');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeBrowser?.();
  server?.close();
  fs.rmSync(path.join(os.homedir(), 'Downloads', 'cmcp-test-download.txt'), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const go = (args) => browserTool(args);
const idOf = (text, name) => Number(new RegExp(`\\[(\\d+)\\] [^\\n]*"${name}"`).exec(text)?.[1]);

test('open reads a page as numbered elements and text', { skip: !ready && 'browser not installed' }, async () => {
  const { text, isError } = await go({ action: 'open', url: base });
  assert.equal(isError, undefined, text);
  assert.match(text, /tab 1 of 1: 测试页/);
  assert.match(text, /\[\d+\] text "关键词"/);
  assert.match(text, /你好，浏览器/);
});

test('typing and submitting goes to the next page', { skip: !ready && 'browser not installed' }, async () => {
  const page = await go({ action: 'look' });
  const { text } = await go({ action: 'type', id: idOf(page.text, '关键词'), value: '猫咪', submit: true });
  assert.match(text, /你搜索了：猫咪/);
  await go({ action: 'back' });
});

test('ambiguous text is refused, not guessed', { skip: !ready && 'browser not installed' }, async () => {
  const reply = await go({ action: 'click', text: '第二页' });
  assert.equal(reply.isError, true);
  assert.match(reply.text, /matches 2 elements, so nothing was done/);
});

test('dialogs are accepted and reported, selects and js work', { skip: !ready && 'browser not installed' }, async () => {
  const clicked = await go({ action: 'click', text: '删除' });
  assert.match(clicked.text, /confirm dialog: "确定吗\?" \(accepted\)/);
  assert.match(clicked.text, /已确定/);
  const page = await go({ action: 'look' });
  await go({ action: 'select', id: Number(/\[(\d+)\] select/.exec(page.text)[1]), value: 'b' });
  assert.equal((await go({ action: 'js', value: 'document.querySelector("select").value' })).text, '"b"');
});

test('downloads land in ~/Downloads and tabs can be listed and closed', { skip: !ready && 'browser not installed' }, async () => {
  // The note comes with whichever reply follows the finished download.
  const replies = [await go({ action: 'click', text: '下载文件' }), await go({ action: 'wait', amount: 500 }), await go({ action: 'look' })];
  assert.match(replies.map((r) => r.text).join('\n'), /downloaded .*cmcp-test-download\.txt/);
  assert.equal(fs.readFileSync(path.join(os.homedir(), 'Downloads', 'cmcp-test-download.txt'), 'utf8'), 'downloaded');
  await go({ action: 'open', url: `${base}/second`, new_tab: true });
  assert.match((await go({ action: 'tabs' })).text, /2 \(current\): 第二页/);
  const closed = await go({ action: 'tab', index: 2, close: true });
  assert.match(closed.text, /tab 1 of 1/);
});

test('a screenshot comes back when asked', { skip: !ready && 'browser not installed' }, async () => {
  const shot = await go({ action: 'look', image: true });
  assert.equal(shot.image.mimeType, 'image/jpeg');
  assert.ok(shot.image.data.length > 1000);
});

test('the phone can take over the AI browser: list, frame, click, type, keys', { skip: !ready && 'browser not installed' }, async () => {
  const { aiBrowserHandoff } = await import('../src/browser.mjs');
  const { localHandoff } = await import('../src/handoff-local.mjs');
  await go({ action: 'open', url: base });
  const list = await localHandoff('handoff_list', {});
  const tab = list.windows.find((w) => w.title.includes('测试页'));
  assert.ok(tab && tab.hwnd < 0, JSON.stringify(list));
  assert.equal((await aiBrowserHandoff('handoff_select', { hwnd: tab.hwnd })).title, tab.title);
  const frame = await aiBrowserHandoff('handoff_frame', { hwnd: tab.hwnd });
  assert.equal(frame.image.mimeType, 'image/jpeg');
  // Click the search box by its place on the page, as a finger on the phone would.
  const box = JSON.parse((await go({ action: 'js', value: 'JSON.stringify((() => { const r = document.querySelector("input[name=q]").getBoundingClientRect(); return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight }; })())' })).text.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
  await aiBrowserHandoff('handoff_input', { hwnd: tab.hwnd, action: 'click', x: box.x, y: box.y });
  await aiBrowserHandoff('handoff_input', { hwnd: tab.hwnd, action: 'type', text: '手机输入' });
  await aiBrowserHandoff('handoff_input', { hwnd: tab.hwnd, action: 'key', keys: 'enter' });
  await go({ action: 'wait', text: '你搜索了' });
  assert.match((await go({ action: 'look' })).text, /你搜索了：手机输入/);
  assert.equal((await aiBrowserHandoff('handoff_input', { hwnd: tab.hwnd, action: 'key', keys: 'f12' })).isError, true);
  assert.match((await aiBrowserHandoff('handoff_frame', { hwnd: -9999 })).text, /no longer available/);
});
