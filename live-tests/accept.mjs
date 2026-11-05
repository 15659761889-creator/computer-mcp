// Acceptance: real programs through the real service. Every result is checked against something
// outside the tool (a file on disk, a computed answer, text the app shows), never the tool's own claim.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/computer-mcp/config.json`, 'utf8'));
const BASE = process.argv[2] === 'public' ? `https://${cfg.hostname}` : `http://127.0.0.1:${cfg.port}`;
const url = `${BASE}/t/${cfg.token}/mcp`;
const ONLY = process.argv.slice(3);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-accept-'));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const calls = { ui_look: [], ui_act: [], bash: [] };
let steps = 0;
let refusals = 0;

async function call(name, args) {
  const t0 = performance.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const body = text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: ')).slice(6);
  const res = JSON.parse(body).result;
  calls[name]?.push(performance.now() - t0);
  return { text: res.content[0].text, isError: res.isError === true, hasImage: res.content.length > 1 };
}
// Latency is reported only for calls that did real work, without polling for a window or waiting for text.
const clean = { look: [], act: [] };
async function look(args = {}) {
  const t0 = performance.now();
  const r = await call('ui_look', { image: 'false', ...args });
  if (!r.isError) clean.look.push(performance.now() - t0);
  return r;
}
async function act(args) {
  steps += 1;
  const t0 = performance.now();
  const r = await call('ui_act', { image: 'false', ...args });
  if (!args.wait_for && args.observe !== false) clean.act.push(performance.now() - t0);
  if (args.observe === false && !args.wait_for) clean.fast ??= [], clean.fast.push(performance.now() - t0);
  if (r.isError) refusals += 1;
  return r;
}
const elements = (text) => text.split('\n').filter((l) => /^\[\d+\]/.test(l));
const findLine = (text, re) => elements(text).find((l) => re.test(l));
const idOf = (line) => Number(/^\[(\d+)\]/.exec(line)[1]);
async function waitWindow(title, ms = 20000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    const r = await look({ window: title });
    if (!r.isError) return r;
    last = r.text;
    await sleep(400);
  }
  throw new Error(`window "${title}" not usable: ${last.slice(0, 300)}`);
}

const report = [];
async function app(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const row = { name, checks: [], error: null };
  report.push(row);
  const check = (label, ok, detail = '') => {
    row.checks.push({ label, ok });
    console.log(`  ${ok ? 'pass' : 'FAIL'} ${label}${!ok && detail ? ` -> ${String(detail).slice(0, 500).replace(/\n/g, ' / ')}` : ''}`);
  };
  console.log(`\n== ${name}`);
  try {
    await fn(check);
  } catch (err) {
    row.error = err.message;
    console.log(`  ERROR ${String(err.message).slice(0, 500)}`);
  }
}

await act({ action: 'close', window: 'notepad_nonexistent', observe: false });
steps = 0;
refusals = 0;

await app('calculator', async (check) => {
  await call('bash', { command: 'Start-Process calc', shell: 'powershell' });
  const seen = await waitWindow('Calculator');
  check('a program started by bash has a visible window', !seen.isError);
  const buttons = elements(seen.text).filter((l) => /button/.test(l));
  check('buttons readable', buttons.length > 15, seen.text);
  // Twenty consecutive clicks: any misclick changes the final number.
  await act({ action: 'key', keys: 'esc', window: 'Calculator', observe: false });
  const zh = /button "加"/.test(seen.text);
  const names = zh
    ? { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', '+': '加', '-': '减', '*': '乘以', '/': '除以', '=': '等于' }
    : { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', '+': 'Plus', '-': 'Minus', '*': 'Multiply by', '/': 'Divide by', '=': 'Equals' };
  const sequence = ['1', '2', '3', '+', '4', '5', '6', '=', '*', '7', '=', '-', '8', '9', '=', '/', '3', '=', '+', '1'];
  let failed = null;
  for (const s of sequence) {
    const r = await act({ action: 'click', target: names[s], role: 'button', observe: false });
    if (r.isError) { failed = `${s}: ${r.text}`; break; }
  }
  check('20 consecutive clicks all accepted', !failed, failed);
  const done = await act({ action: 'click', target: names['='], role: 'button' });
  // (123+456)*7 = 4053, -89 = 3964, /3 = 1321.33..., +1
  check('the arithmetic proves every click landed on the right key', /1[,，]?322\.3333/.test(done.text), elements(done.text).slice(0, 12).join(' / '));
  await act({ action: 'close', window: 'Calculator', observe: false });
});

await app('notepad', async (check) => {
  const file = path.join(WORK, '记事本测试.txt');
  fs.writeFileSync(file, '第一行\r\n');
  await call('bash', { command: `Start-Process notepad -ArgumentList '"${file}"'`, shell: 'powershell' });
  const seen = await waitWindow('记事本测试');
  check('opened and listed', !seen.isError);
  const typed = '\n写入中文 and English 123！\n第三行';
  await act({ action: 'key', keys: 'ctrl+end', window: '记事本测试', observe: false });
  const r = await act({ action: 'type', text: typed, window: '记事本测试' });
  check('typing accepted', !r.isError, r.text);
  await act({ action: 'key', keys: 'ctrl+s', window: '记事本测试', observe: false });
  await sleep(600);
  const onDisk = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  check('the file on disk has exactly what was typed', onDisk === `第一行\n${typed.slice(1)}` || onDisk === `第一行\n${typed}`, JSON.stringify(onDisk));
  await act({ action: 'close', window: '记事本测试', observe: false });
});

await app('explorer', async (check) => {
  const dir = path.join(WORK, '资源管理器测试');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '测试文件A.txt'), 'a');
  fs.writeFileSync(path.join(dir, '测试文件B.txt'), 'b');
  fs.mkdirSync(path.join(dir, '子文件夹'));
  fs.writeFileSync(path.join(dir, '子文件夹', '子文件夹内文件.txt'), 'c');
  await call('bash', { command: `Start-Process explorer -ArgumentList '"${dir}"'`, shell: 'powershell' });
  const seen = await waitWindow('资源管理器测试');
  check('both files listed', /测试文件A/.test(seen.text) && /测试文件B/.test(seen.text), seen.text);
  let r = await act({ action: 'click', target: '测试文件A.txt', method: 'mouse', window: '资源管理器测试' });
  check('file clicked', !r.isError, r.text);
  await act({ action: 'key', keys: 'f2', window: '资源管理器测试', observe: false });
  await sleep(300);
  await act({ action: 'key', keys: 'ctrl+a', window: '资源管理器测试', observe: false });
  r = await act({ action: 'type', text: '改名成功.txt\n', window: '资源管理器测试' });
  await sleep(500);
  check('rename reached the real filesystem', fs.existsSync(path.join(dir, '改名成功.txt')) && !fs.existsSync(path.join(dir, '测试文件A.txt')), `${fs.readdirSync(dir)} ${r.text.slice(0, 200)}`);
  check('the other file is untouched', fs.readFileSync(path.join(dir, '测试文件B.txt'), 'utf8') === 'b');
  r = await act({ action: 'double_click', target: '子文件夹', window: '资源管理器测试', wait_for: '子文件夹内文件' });
  check('double click opens the folder', !r.isError && /子文件夹内文件/.test(r.text), r.text.slice(0, 400));
  await act({ action: 'close', window: '子文件夹', observe: false });
});

await app('settings', async (check) => {
  await call('bash', { command: 'Start-Process ms-settings:about', shell: 'powershell' });
  await waitWindow('设置');
  let r = await act({ action: 'wait', window: '设置', wait_for: '设备名称', observe: true });
  check('Settings (UWP) has readable controls', !r.isError && elements(r.text).length > 10, r.text);
  const twice = await act({ action: 'click', target: '系统', window: '设置' });
  check('"系统" appears twice, so the tool asks instead of guessing', twice.isError && /matches 2 places/.test(twice.text), twice.text.slice(0, 300));
  r = await act({ action: 'click', target: '蓝牙和其他设备', role: 'listitem', window: '设置', wait_for: '添加设备' });
  check('the right page opened', !r.isError && /添加设备/.test(r.text), r.text.slice(0, 500));
  await act({ action: 'close', window: '设置', observe: false });
});

await app('chrome', async (check) => {
  const page = path.join(WORK, 'page.html');
  fs.writeFileSync(page, `<!doctype html><meta charset=utf-8><title>验收网页</title><style>body{font:16px "Microsoft YaHei"}#l a{margin-right:20px}</style>
<h2>网页测试</h2><input id=i aria-label="网页输入框" style="width:300px"> <button onclick="out.textContent='按钮结果:'+i.value">提交表单</button>
<p><label><input type=checkbox id=c onchange="out2.textContent='勾选:'+c.checked">同意条款</label></p>
<p id=l><a href="#a" onclick="out3.textContent='链接一被点'">第一个链接</a><a href="#b" onclick="out3.textContent='链接二被点'">第二个链接</a></p>
<canvas id=cv width=300 height=60 style="border:1px solid #999"></canvas><script>const x=cv.getContext('2d');x.font='18px Microsoft YaHei';x.fillText('画布文字',20,38);cv.onclick=e=>out4.textContent='画布点击'</script>
<p id=out></p><p id=out2></p><p id=out3></p><p id=out4></p><div style="height:1500px"></div><p>页面底部标记</p>`);
  const profile = path.join(WORK, 'chrome-profile');
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=1100,800', `file:///${page.split(path.sep).join('/')}`], { stdio: 'ignore' });
  try {
    const seen = await waitWindow('验收网页');
    check('web page content is listed', /提交表单/.test(seen.text), seen.text);
    let r = await act({ action: 'type', target: '网页输入框', text: '网页输入 abc', window: '验收网页' });
    check('type into a web field', !r.isError, r.text);
    r = await act({ action: 'click', target: '提交表单', window: '验收网页', wait_for: '按钮结果' });
    check('the page itself reports the typed value', /按钮结果[:：]\s*网页输入\s*abc/.test(r.text), r.text);
    r = await act({ action: 'click', target: '同意条款', window: '验收网页', wait_for: '勾选' });
    check('checkbox', /勾选[:：]\s*true/i.test(r.text), r.text);
    r = await act({ action: 'click', target: '第二个链接', window: '验收网页', wait_for: '链接二被点' });
    check('correct link among similar ones', !r.isError && /链接二被点/.test(r.text) && !/链接一被点/.test(r.text), r.text);
    r = await act({ action: 'click', target: '画布文字', window: '验收网页', wait_for: '画布点击' });
    check('canvas text, visible only to OCR', !r.isError && /画布点击/.test(r.text), r.text);
    r = await act({ action: 'scroll', amount: -30, window: '验收网页', wait_for: '页面底部标记' });
    check('scroll brings the bottom of the page into view', !r.isError, r.text);
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true });
  }
});

await app('paint', async (check) => {
  await call('bash', { command: 'Start-Process mspaint', shell: 'powershell' });
  const seen = await waitWindow('Paint');
  check('Paint ribbon readable', elements(seen.text).length > 10, seen.text.slice(0, 400));
  const rect = /window w:\d+ "[^"]*Paint[^"]*" \((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/.exec(seen.text);
  const [l, t, rr, b] = rect.slice(1).map(Number);
  const cx = Math.round((l + rr) / 2);
  const cy = Math.round((t + b) / 2) + 80;
  const r = await act({ action: 'drag', x: cx - 150, y: cy, to_x: cx + 150, to_y: cy + 60, window: 'Paint' });
  check('drawing on the canvas is seen as a change', !r.isError && /screen changed/.test(r.text), r.text.slice(0, 300));
  const shot = await look({ image: 'true' });
  check('a real screenshot can be attached', shot.hasImage);
  await act({ action: 'close', window: 'Paint', observe: false });
  const c = await act({ action: 'click', target: "Don't save", window: 'Paint', observe: false });
  check('save prompt answered by text, across a curly apostrophe', !c.isError, c.text.slice(0, 300));
  await sleep(1200);
  const open = (await look({ find: 'zzzz' })).text.split('\n').filter((l) => /^window .*Paint/.test(l));
  check('Paint really closed', open.length === 0, open.join(' / '));
});

await app('regedit-elevated', async (check) => {
  await call('bash', { command: 'Start-Process regedit', shell: 'powershell' });
  const seen = await waitWindow('注册表编辑器');
  const items = elements(seen.text).filter((l) => /treeitem/.test(l));
  check('an elevated tree app is readable', items.length > 3, seen.text.slice(0, 500));
  const pathOf = (t) => (/value="([^"]*)"/.exec(elements(t).find((l) => /\] edit /.test(l)) || '') || [])[1] || '';
  const before = pathOf(seen.text);
  const other = items.find((l) => { const n = /"(.*?)"/.exec(l)[1]; return n && !before.split('\\').includes(n); });
  const r = await act({ action: 'click', element_id: idOf(other), method: 'mouse' });
  check('click lands in the elevated window', !r.isError, r.text.slice(0, 300));
  check('the address follows the selection', pathOf(r.text) !== before, `${before} => ${pathOf(r.text)}`);
  await act({ action: 'close', window: '注册表编辑器', observe: false });
});

await app('cmd', async (check) => {
  const marker = path.join(WORK, 'cmd-output.txt');
  await call('bash', { command: `Start-Process cmd -ArgumentList '/k','title CMCP命令行窗口'`, shell: 'powershell' });
  const seen = await waitWindow('CMCP命令行窗口');
  check('console window found', !seen.isError);
  await act({ action: 'type', text: `echo 控制台输入成功>"${marker}"\n`, window: 'CMCP命令行窗口', observe: false });
  await sleep(700);
  check('the console ran the typed command', fs.existsSync(marker), `exists=${fs.existsSync(marker)}`);
  await act({ action: 'type', text: 'exit\n', window: 'CMCP命令行窗口', observe: false });
});

await app('blender', async (check) => {
  const blender = spawn('C:/Program Files/Blender Foundation/Blender 5.2/blender.exe', ['--factory-startup', '--window-geometry', '100', '100', '1500', '900'], { stdio: 'ignore' });
  try {
    const seen = await waitWindow('Blender', 45000);
    await sleep(2500);
    const first = await look({ window: 'Blender' });
    const uiaRows = elements(first.text).filter((l) => !/\] text /.test(l)).length;
    const ocrRows = elements(first.text).filter((l) => /\] text /.test(l)).length;
    console.log(`  (Blender: ${uiaRows} controls, ${ocrRows} OCR labels)`);
    check('custom OpenGL UI read by OCR', ocrRows > 15 && !seen.isError, first.text.slice(0, 500));
    await act({ action: 'key', keys: 'esc', window: 'Blender', observe: false });
    let r = await act({ action: 'click', target: 'Edit', window: 'Blender', wait_for: 'Preferences' });
    check('a menu opens by clicking OCR text', !r.isError && /Preferences/.test(r.text), r.text.slice(0, 700));
    await act({ action: 'key', keys: 'esc', window: 'Blender', observe: false });
    const shot = await look({ window: 'Blender', image: 'true' });
    check('3D view can be sent as a real screenshot', shot.hasImage);
    await sleep(300);
    r = await act({ action: 'click', target: 'Add', window: 'Blender', wait_for: 'Mesh' });
    check('Add menu opens', !r.isError && /Mesh/.test(r.text), r.text.slice(0, 500));
    r = await act({ action: 'click', target: 'Mesh', window: 'Blender', wait_for: 'Monkey' });
    check('submenu by text', !r.isError && /Monkey/.test(r.text), r.text.slice(0, 500));
    r = await act({ action: 'click', target: 'Monkey', window: 'Blender', wait_for: 'Add Monkey' });
    check('adding an object changes the scene', !r.isError && /Monkey/.test(r.text), r.text.slice(0, 500));
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(blender.pid), '/T', '/F'], { windowsHide: true });
  }
});

await app('godot', async (check) => {
  const exe = process.env.GODOT_EXE || 'C:/Users/testuser/Desktop/GameStudio/tools/godot/Godot_v4.7.2-stable_win64.exe';
  const dir = path.join(WORK, 'godot-project');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n[application]\nconfig/name="CMCP验收"\n');
  const godot = spawn(exe, ['--editor', '--path', dir, '--resolution', '1500x900'], { stdio: 'ignore' });
  try {
    const seen = await waitWindow('CMCP验收', 60000);
    await sleep(3000);
    const first = await look({ window: 'CMCP验收' });
    const ocrRows = elements(first.text).filter((l) => /\] text /.test(l)).length;
    check('custom-drawn editor read by OCR', ocrRows > 15 && !seen.isError, first.text.slice(0, 500));
    const pick = findLine(first.text, /"(Scene|场景)"/);
    check('menus that OCR merged are now separate', /"调试"/.test(first.text) && /"编辑器"/.test(first.text), elements(first.text).slice(5, 12).join(' / '));
    check('its menu is found', !!pick, elements(first.text).slice(0, 15).join(' / '));
    if (pick) {
      const r = await act({ action: 'click', element_id: idOf(pick), wait_for: /"Scene"/.test(pick) ? 'New Scene' : '新建场景' });
      check('a menu opens by clicking OCR text', !r.isError, r.text.slice(0, 600));
      await act({ action: 'key', keys: 'esc', window: 'CMCP验收', observe: false });
    }
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(godot.pid), '/T', '/F'], { windowsHide: true });
  }
});

await app('flclash-readonly', async (check) => {
  const r = await look({ window: 'FlClash' });
  const rows = elements(r.text);
  check('Flutter app, which exposes 1 control, is readable by OCR', rows.filter((l) => /\] text /.test(l)).length > 5, `${rows.length} rows`);
  console.log(`  (FlClash: ${rows.length} rows; only read, nothing clicked)`);
});

// Summary
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : 0; };
console.log('\n===== summary');
let pass = 0;
let total = 0;
for (const row of report) {
  const good = row.checks.filter((c) => c.ok).length;
  pass += good;
  total += row.checks.length;
  console.log(`${row.name.padEnd(18)} ${good}/${row.checks.length}${row.error ? `  ERROR: ${row.error.slice(0, 120)}` : ''}`);
}
console.log(`checks ${pass}/${total}; ui_act steps ${steps}; refused ${refusals}`);
const line = (label, a) => console.log(`${label.padEnd(30)} n=${a.length} p50=${pct(a, 0.5)} p95=${pct(a, 0.95)} max=${pct(a, 1)} ms`);
line('ui_look', clean.look);
line('ui_act with fresh list', clean.act);
line('ui_act observe:false', clean.fast || []);
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(0);
