import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createMcpServer } from '../src/server.mjs';
import { decodeFile, decodeOutput, encodeFile } from '../src/text.mjs';
import { resolvePath } from '../src/tools.mjs';

const TOKEN = 'test-secret';
let token = TOKEN;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-test-'));
const auditFile = path.join(dir, 'logs', 'audit.jsonl');
let server;
let base;

before(async () => {
  server = createMcpServer({ name: 'test', getToken: () => token, auditFile });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(url, body, headers = {}) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function rpc(method, params) {
  const res = await post(`/t/${token}/mcp`, { jsonrpc: '2.0', id: 1, method, params });
  const text = await res.text();
  if (res.headers.get('content-type').includes('event-stream')) {
    return JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  }
  return JSON.parse(text);
}

async function call(name, args) {
  const { result } = await rpc('tools/call', { name, arguments: args });
  return { text: result.content[0].text, isError: result.isError === true };
}

test('auth: path token, bearer token, and rejections', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await post(`/t/${TOKEN}/mcp`, init)).status, 200);
  assert.equal((await post('/t/wrong/mcp', init)).status, 404);
  assert.equal((await post('/mcp', init)).status, 401);
  assert.equal((await post('/mcp', init, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post('/mcp', init, { Authorization: `Bearer ${TOKEN}` })).status, 200);
  assert.equal((await fetch(`${base}/t/${TOKEN}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('rotating the token rejects the old link at once', async () => {
  token = 'rotated';
  const init = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await post(`/t/${TOKEN}/mcp`, init)).status, 404);
  assert.equal((await post('/t/rotated/mcp', init)).status, 200);
  token = TOKEN;
});

test('protocol: initialize, version negotiation, notifications, tool list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'computer-mcp-test');
  const odd = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(odd.result.protocolVersion, '2025-11-25');
  const note = await post(`/t/${TOKEN}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const { result } = await rpc('tools/list');
  const desktopTools = process.platform === 'win32' ? ['ui_look', 'ui_act', 'request_human_takeover', 'check_human_takeover', 'cancel_human_takeover'] : [];
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'job', 'read_file', 'write_file', 'edit_file', 'browser', ...desktopTools, 'recent_calls']);
  assert.equal((await rpc('nope')).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'nope' })).error.code, -32602);
  const bad = await fetch(`${base}/t/${TOKEN}/mcp`, { method: 'POST', body: '{oops' });
  assert.equal(bad.status, 400);
});

test('bash: output, exit code, Chinese, cwd, stderr', async () => {
  const ok = await call('bash', { command: 'echo 你好; echo err >&2; pwd', cwd: dir });
  assert.match(ok.text, /exit_code: 0/);
  assert.match(ok.text, /你好/);
  assert.match(ok.text, /--- stderr ---\nerr/);
  const failed = await call('bash', { command: 'exit 7' });
  assert.match(failed.text, /exit_code: 7/);
  assert.equal(failed.isError, false);
  const missing = await call('bash', { command: 'echo hi', cwd: path.join(dir, 'nope') });
  assert.equal(missing.isError, true);
});

test('bash: quotes, dollars and newlines survive unchanged', async () => {
  const { text } = await call('bash', { command: `a='x "y" $HOME \\ z'\nprintf '%s\\n' "$a"` });
  assert.ok(text.includes('x "y" $HOME \\ z'), text);
});

test('bash: long command lines work', async () => {
  const { text } = await call('bash', { command: `echo ${'a'.repeat(40000)} | wc -c` });
  assert.match(text, /40001/);
});

test('bash: stdin is closed so a read cannot hang', async () => {
  const { text } = await call('bash', { command: 'cat; echo after', timeout: 20 });
  assert.match(text, /after/);
});

test('bash: timeout kills the command', async () => {
  const started = Date.now();
  const { text, isError } = await call('bash', { command: 'sleep 30', timeout: 1 });
  assert.equal(isError, true);
  assert.match(text, /timed_out/);
  assert.ok(Date.now() - started < 15000);
});

test('bash: a process left running does not block the reply', async () => {
  const started = Date.now();
  const { text } = await call('bash', { command: 'sleep 20 & echo done', timeout: 15 });
  assert.match(text, /done/);
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
  assert.match(text, /still holds its output/);
});

test('bash: huge output is cut, with the full copy on disk', async () => {
  const { text } = await call('bash', { command: 'seq 1 500000' });
  assert.ok(text.length < 32000, `reply was ${text.length}`);
  assert.match(text, /\n1\n2\n/);
  assert.match(text, /\n500000$/);
  const file = /full output: (.+?) \.\.\./.exec(text)[1];
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 500000);
});

test('bash: background start returns at once and writes its log', async () => {
  const started = Date.now();
  const { text } = await call('bash', { command: 'echo 后台; sleep 1; echo end', background: true });
  assert.ok(Date.now() - started < 3000);
  const log = /log: (.+)/.exec(text)[1];
  await new Promise((resolve) => { setTimeout(resolve, 2500); });
  assert.match(fs.readFileSync(log, 'utf8'), /后台\s+end/);
});

test('bash: a slow command returns a job id, keeps running, and its result can be fetched', async () => {
  const started = Date.now();
  const first = await call('bash', { command: 'sleep 3; echo 结果; exit 4', wait: 1, timeout: 30 });
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
  assert.match(first.text, /still running/);
  const id = /job: ([0-9a-f]{8})/.exec(first.text)[1];
  const running = await call('job', { id });
  assert.match(running.text, /still running/);
  const done = await call('job', { id, wait: 10 });
  assert.match(done.text, /finished/);
  assert.match(done.text, /exit_code: 4/);
  assert.match(done.text, /结果/);
  assert.match((await call('job', {})).text, new RegExp(`${id}  finished exit 4`));
});

test('job: killing stops the whole process tree, and the PID is the real shell', async () => {
  const started = await call('bash', { command: 'sleep 60 & sleep 60; echo never', background: true });
  const id = /job: ([0-9a-f]{8})/.exec(started.text)[1];
  const pid = Number(/pid: (\d+)/.exec(started.text)[1]);
  assert.doesNotThrow(() => process.kill(pid, 0));
  const killed = await call('job', { id, action: 'kill' });
  assert.match(killed.text, /killed/);
  assert.doesNotMatch(killed.text, /never/);
  assert.throws(() => process.kill(pid, 0));
  const unknown = await call('job', { id: 'ffffffff' });
  assert.equal(unknown.isError, true);
  assert.equal((await call('job', { id: '../../x' })).isError, true);
});

test('bash: slow calls come back through the keepalive stream', async () => {
  const res = await post(`/t/${TOKEN}/mcp`, {
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'bash', arguments: { command: 'sleep 6; echo slow' } },
  });
  assert.match(res.headers.get('content-type'), /event-stream/);
  const body = await res.text();
  assert.match(body, /: running/);
  const message = JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  assert.equal(message.id, 9);
  assert.match(message.result.content[0].text, /slow/);
});

if (process.platform === 'win32') {
  test('powershell: Chinese, exit codes, native GBK output', async () => {
    const ok = await call('bash', { command: 'Write-Output "你好"; $PSVersionTable.PSVersion.Major', shell: 'powershell' });
    assert.match(ok.text, /exit_code: 0[\s\S]*你好/);
    const failed = await call('bash', { command: 'cmd /c "exit 5"', shell: 'powershell' });
    assert.match(failed.text, /exit_code: 5/);
    const thrown = await call('bash', { command: 'throw "boom"', shell: 'powershell' });
    assert.doesNotMatch(thrown.text, /exit_code: 0/);
  });

  test('bash: native Windows programs do not come back garbled', async () => {
    const { text } = await call('bash', { command: 'cmd //c dir nosuchfile_cmcp', cwd: dir });
    assert.doesNotMatch(text, /\ufffd/);
    assert.match(text, /找不到|File Not Found/);
  });

  test('paths: /c/ form from Git Bash resolves', () => {
    assert.equal(resolvePath('/c/Users/x'), 'C:\\Users\\x');
  });
}

test('read_file: numbers lines, paging, folders, missing, binary', async () => {
  const file = path.join(dir, '读.txt');
  fs.writeFileSync(file, 'one\r\n二\r\nthree\r\n');
  const all = await call('read_file', { path: file });
  assert.match(all.text, /^1\tone\n2\t二\n3\tthree\n/);
  assert.match(all.text, /lines 1-3 of 3, utf8/);
  const page = await call('read_file', { path: file, offset: 2, limit: 1 });
  assert.match(page.text, /^2\t二\n/);
  assert.match(page.text, /continue with offset 3/);
  const past = await call('read_file', { path: file, offset: 99 });
  assert.match(past.text, /lines none of 3/);
  assert.equal((await call('read_file', { path: dir })).isError, true);
  assert.equal((await call('read_file', { path: path.join(dir, 'nope') })).isError, true);
  const binary = path.join(dir, 'b.bin');
  fs.writeFileSync(binary, Buffer.from([1, 0, 2, 0, 255]));
  assert.match((await call('read_file', { path: binary })).text, /binary file, not shown/);
});

test('read_file: GBK and UTF-16 files are decoded', async () => {
  const gbk = path.join(dir, 'gbk.txt');
  fs.writeFileSync(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  assert.match((await call('read_file', { path: gbk })).text, /1\t你好/);
  const utf16 = path.join(dir, 'u16.txt');
  fs.writeFileSync(utf16, encodeFile('你好', 'utf16le'));
  assert.match((await call('read_file', { path: utf16 })).text, /1\t你好/);
});

test('write_file: new folders, overwrite, base64, no leftovers', async () => {
  const file = path.join(dir, 'a', 'b', '写.txt');
  assert.equal((await call('write_file', { path: file, content: '第一版' })).isError, false);
  await call('write_file', { path: file, content: '第二版' });
  assert.equal(fs.readFileSync(file, 'utf8'), '第二版');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['写.txt']);
  const bin = path.join(dir, 'x.bin');
  await call('write_file', { path: bin, content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' });
  assert.deepEqual([...fs.readFileSync(bin)], [0, 1, 2, 255]);
  assert.equal((await call('write_file', { path: dir, content: 'x' })).isError, true);
});

test('edit_file: unique match rule', async () => {
  const file = path.join(dir, 'e.txt');
  fs.writeFileSync(file, 'cat dog\ncat\n');
  const many = await call('edit_file', { path: file, old: 'cat', new: 'x' });
  assert.equal(many.isError, true);
  assert.match(many.text, /2 places/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'cat dog\ncat\n');
  assert.equal((await call('edit_file', { path: file, old: 'none', new: 'x' })).isError, true);
  assert.equal((await call('edit_file', { path: file, old: '', new: 'x' })).isError, true);
  const one = await call('edit_file', { path: file, old: 'cat\n', new: 'bird\n' });
  assert.equal(one.isError, false, one.text);
  assert.equal(fs.readFileSync(file, 'utf8'), 'cat dog\nbird\n');
});

test('edit_file: replace and replace_all report what changed', async () => {
  const file = path.join(dir, 'e2.txt');
  fs.writeFileSync(file, 'a\nb b\nc\n');
  const one = await call('edit_file', { path: file, old: 'c', new: 'd' });
  assert.match(one.text, /replaced 1 place .*line 3/);
  await call('edit_file', { path: file, old: 'b', new: 'z', replace_all: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nz z\nd\n');
});

test('edit_file: keeps CRLF, and a model sending LF still matches', async () => {
  const file = path.join(dir, 'crlf.txt');
  fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\n');
  await call('edit_file', { path: file, old: 'one\ntwo', new: '1\n2' });
  assert.equal(fs.readFileSync(file, 'utf8'), '1\r\n2\r\nthree\r\n');
});

test('edit_file: keeps GBK, BOM and UTF-16 encodings', async () => {
  for (const encoding of ['gbk', 'utf8-bom', 'utf16le', 'utf16be']) {
    const file = path.join(dir, `enc-${encoding}.txt`);
    fs.writeFileSync(file, encodeFile('你好 world', encoding));
    const { isError, text } = await call('edit_file', { path: file, old: 'world', new: '世界' });
    assert.equal(isError, false, text);
    const decoded = decodeFile(fs.readFileSync(file));
    assert.equal(decoded.encoding, encoding);
    assert.equal(decoded.text, '你好 世界');
  }
});

test('edit_file: a character GBK cannot store fails without touching the file', async () => {
  const file = path.join(dir, 'gbk2.txt');
  const original = encodeFile('你好', 'gbk');
  fs.writeFileSync(file, original);
  const { isError } = await call('edit_file', { path: file, old: '好', new: '😀' });
  assert.equal(isError, true);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('text: mixed UTF-8 and GBK output is decoded line by line', () => {
  const mixed = Buffer.concat([Buffer.from('好\n', 'utf8'), Buffer.from([0xc4, 0xe3, 0x0a])]);
  assert.equal(decodeOutput(mixed), '好\n你\n');
});

test('audit: records calls, never file content or the token', async () => {
  await call('write_file', { path: path.join(dir, 'secret.txt'), content: 'TOPSECRETCONTENT' });
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  const log = fs.readFileSync(auditFile, 'utf8');
  assert.match(log, /"tool":"write_file"/);
  assert.doesNotMatch(log, /TOPSECRETCONTENT/);
  assert.doesNotMatch(log, new RegExp(TOKEN));
});
