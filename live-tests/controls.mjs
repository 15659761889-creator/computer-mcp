// First live run: real desktop, real events, scored by the test window's own log.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.mjs';
import { stopDesktop } from '../src/desktop.mjs';

const LOG = path.join(os.tmpdir(), `cmcp-testapp-${process.pid}.log`);
fs.writeFileSync(LOG, '');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const results = [];
const times = {};
const events = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
let mark = 0;
const newEvents = () => { const e = events().slice(mark); mark = events().length; return e; };

async function tool(name, args) {
  const t0 = performance.now();
  const r = await callTool(name, args);
  const ms = performance.now() - t0;
  (times[name] ||= []).push(ms);
  return { ...r, ms };
}
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${String(detail).slice(0, 1500)}` : ''}`);
}
const WIN = 'CMCP测试窗口';

const app = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'testapp.ps1'), '-Log', LOG], { stdio: 'ignore', windowsHide: false });
try {
  for (let i = 0; i < 100 && !events().length; i += 1) await sleep(100);
  await sleep(600);
  newEvents();
  console.log('warming engine...');
  const t0 = performance.now();
  await tool('ui_look', { find: 'zzzz-nothing' });
  console.log(`first call ${Math.round(performance.now() - t0)} ms`);
  times.ui_look = [];

  let r = await tool('ui_look', { window: WIN });
  console.log(`--- look (${Math.round(r.ms)} ms)\n${r.text}\n---`);
  check('look finds real buttons', /button "保存"/.test(r.text) && /button "取消"/.test(r.text), r.text);
  check('look reads custom-drawn text by OCR', /text "自绘开始"/.test(r.text) && /text "自绘停止"/.test(r.text), r.text);
  check('look shows disabled state', /"已禁用".*disabled/.test(r.text), r.text);

  if (!/\[active\]/.test(r.text) || r.isError) {
    console.log('ABORT: the test window is not open, so nothing further is sent to the desktop');
    throw new Error('test window missing');
  }

  r = await tool('ui_act', { action: 'click', target: '保存' });
  let ev = newEvents();
  check('click by text fires exactly the right button', ev.join() === 'click save', `${ev} | ${r.text}`);
  check('reply reports how it was done and a fresh list', /used invoke/.test(r.text) && /snapshot \d+/.test(r.text), r.text);

  r = await tool('ui_act', { action: 'click', target: '确定' });
  ev = newEvents();
  check('ambiguous text refuses and clicks nothing', r.isError && ev.length === 0 && /matches 2 places/.test(r.text), `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'click', target: '确定', nth: 2 });
  ev = newEvents();
  check('nth picks the second duplicate', ev.join() === 'click ok2', `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'click', target: '已禁用' });
  ev = newEvents();
  check('disabled button refuses', r.isError && ev.length === 0 && /disabled/.test(r.text), `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'click', target: '不存在的按钮' });
  check('missing target refuses', r.isError && /not on screen/.test(r.text), r.text);

  r = await tool('ui_act', { action: 'click', target: '自绘开始' });
  ev = newEvents();
  check('OCR-only target gets a real click that lands inside it', ev.join() === 'draw-start Left', `${ev} | ${r.text}`);
  check('OCR click reports a visible result or says none', /no visible change|screen changed/.test(r.text), r.text);

  r = await tool('ui_act', { action: 'right_click', target: '自绘停止' });
  ev = newEvents();
  check('right click lands on the OCR target', ev.join() === 'draw-stop Right', `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'type', target: '姓名输入框', text: '张三 Hello 123！' });
  ev = newEvents();
  check('Chinese, English and symbols typed exactly', ev.at(-1) === 'text 张三 Hello 123！', `${ev} | ${r.text}`);
  check('typing is verified by reading the field back', /read back: the field holds it/.test(r.text), r.text);

  r = await tool('ui_act', { action: 'type', target: '姓名输入框', text: '李四', clear: true });
  ev = newEvents();
  check('clear replaces the old text', ev.at(-1) === 'text 李四', `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'click', target: '自动更新' });
  ev = newEvents();
  check('checkbox toggles', ev.join() === 'check True', `${ev} | ${r.text}`);
  check('the fresh list shows it checked', /"自动更新".*checked/.test(r.text), r.text);

  r = await tool('ui_act', { action: 'click', target: '香蕉' });
  ev = newEvents();
  check('list item selected', ev.join() === 'select 香蕉', `${ev} | ${r.text}`);

  await tool('ui_act', { action: 'click', target: '香蕉', observe: false });
  newEvents();
  r = await tool('ui_act', { action: 'key', keys: 'ctrl+s' });
  ev = newEvents();
  check('key combination reaches the window', ev.includes('key ctrl+s'), `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'scroll', target: '香蕉', amount: -2, observe: false });
  ev = newEvents();
  check('wheel reaches the control', ev.filter((e) => e === 'wheel -120').length === 2, `${ev} | ${r.text}`);

  r = await tool('ui_look', { window: WIN });
  const dragLine = /\[(\d+)\][^\n]*"拖动区域" \((\d+),(\d+)\)/.exec(r.text);
  check('drag area listed', !!dragLine, r.text);
  if (dragLine) {
    const [x, y] = [Number(dragLine[2]), Number(dragLine[3])];
    r = await tool('ui_act', { action: 'drag', x: x - 200, y, to_x: x + 200, to_y: y, window: WIN });
    ev = newEvents();
    const moved = /dragend (-?\d+)/.exec(ev.join(' '));
    check('drag moves the real distance, allowing for scaling', moved && Math.abs(Number(moved[1])) > 250, `${ev} | ${r.text}`);
  }

  // Stale id checks: the window moves, the id must still hit the right thing.
  r = await tool('ui_look', { window: WIN });
  const stopLine = /\[(\d+)\] text "自绘停止"/.exec(r.text);
  const saveLine = /\[(\d+)\] button "保存"/.exec(r.text);
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);'; $h=[N.W]::FindWindow($null,'${WIN}'); [N.W]::SetWindowPos($h,[IntPtr]::Zero,420,260,0,0,0x15)`], { windowsHide: true });
  await sleep(200);
  r = await tool('ui_act', { action: 'click', element_id: Number(stopLine?.[1]), observe: false });
  ev = newEvents();
  check('OCR id still hits its target after the window moved', ev.join() === 'draw-stop Left', `${ev} | ${r.text}`);

  // An old id may no longer mean the same thing; observe:false kept this snapshot, so it is still current.
  r = await tool('ui_act', { action: 'click', element_id: Number(saveLine?.[1]), observe: false });
  ev = newEvents();
  check('control id still hits its target after the window moved', ev.join() === 'click save', `${ev} | ${r.text}`);

  r = await tool('ui_act', { action: 'click', element_id: 99999 });
  check('unknown id refuses', r.isError, r.text);

  // Wait for something that appears later, without a fixed sleep.
  const t1 = performance.now();
  r = await tool('ui_act', { action: 'click', target: '开始加载', wait_for: '加载完成', observe: false });
  const waited = performance.now() - t1;
  ev = newEvents();
  check('wait_for returns when the text appears', ev.includes('loaded') && /appeared after/.test(r.text) && waited < 6000, `${Math.round(waited)} ms ${ev} | ${r.text}`);
  console.log(`   wait_for took ${Math.round(waited)} ms for a 1000 ms delay`);

  // A modal dialog: Invoke blocks until it closes, which must not hang the tool.
  const t2 = performance.now();
  r = await tool('ui_act', { action: 'click', target: '打开对话框' });
  ev = newEvents();
  check('a button that opens a modal dialog does not hang', performance.now() - t2 < 8000 && ev.includes('dialog-open'), `${Math.round(performance.now() - t2)} ms ${ev} | ${r.text}`);
  check('the dialog appears in the fresh list', /确认要继续吗/.test(r.text), r.text);
  r = await tool('ui_act', { action: 'click', target: '否' });
  ev = newEvents();
  check('the dialog button works', ev.some((e) => e === 'dialog-result No'), `${ev} | ${r.text}`);

  // Several steps in one call.
  r = await tool('ui_act', { steps: [
    { action: 'click', target: '取消' },
    { action: 'type', target: '姓名输入框', text: '王五', clear: true },
    { action: 'click', target: '不存在' },
    { action: 'click', target: '保存' },
  ] });
  ev = newEvents();
  check('steps run in order and stop at the failure', r.isError && ev.includes('click cancel') && ev.at(-1) === 'text 王五' && !ev.includes('click save') && /steps 4-4 were not run/.test(r.text), `${ev} | ${r.text}`);

  // Keys must not go to some other window that took the focus.
  const other = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.Text='CMCP干扰窗口'; $t=New-Object Windows.Forms.TextBox; $t.Add_TextChanged({ [IO.File]::AppendAllText('${LOG.replaceAll('\\', '\\\\')}', "intruder-typed\`n") }); $f.Controls.Add($t); $f.TopMost=$true; $f.Add_Shown({$f.Activate()}); [Windows.Forms.Application]::Run($f)`], { stdio: 'ignore', windowsHide: false });
  await sleep(1500);
  r = await tool('ui_act', { action: 'type', text: '不该输入' });
  ev = newEvents();
  check('typing refuses when another window took the focus', r.isError && !ev.includes('intruder-typed') && /active window changed/.test(r.text), `${ev} | ${r.text}`);
  spawnSync('taskkill.exe', ['/PID', String(other.pid), '/F'], { windowsHide: true });
  await sleep(300);

  const m = (a) => { const s = [...a].sort((x, y) => x - y); return `n=${s.length} p50=${Math.round(s[Math.floor(s.length / 2)])} p95=${Math.round(s[Math.floor(s.length * 0.95)])} max=${Math.round(s.at(-1))}`; };
  console.log(`\nui_look ${m(times.ui_look)}\nui_act  ${m(times.ui_act)}`);
} finally {
  spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true });
  stopDesktop();
  fs.rmSync(LOG, { force: true });
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(0);
