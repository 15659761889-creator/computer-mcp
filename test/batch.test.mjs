import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { runBatch } from '../src/batch.mjs';
import { createMcpServer } from '../src/server.mjs';
import { encodeFile } from '../src/text.mjs';

const TOKEN = 'batch-test-token';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-batch-'));
const auditFile = path.join(dir, 'logs', 'audit.jsonl');
let server;
let base;

before(async () => {
  server = createMcpServer({ name: 'solo', getToken: () => TOKEN, auditFile });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(name, args) {
  const res = await fetch(`${base}/t/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  return { text: result.content[0].text, isError: result.isError === true, content: result.content };
}

const rpcOk = (text) => ({ result: { content: [{ type: 'text', text }] } });
const rpcFail = (text) => ({ result: { content: [{ type: 'text', text }], isError: true } });

test('batch: listed, runs real tools in parallel, each item audited', async () => {
  const list = await (await fetch(`${base}/t/${TOKEN}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
  assert.ok(list.result.tools.some((t) => t.name === 'batch'));
  const a = path.join(dir, 'a.txt');
  fs.writeFileSync(a, 'alpha\n');
  const started = Date.now();
  const out = await call('batch', { calls: [
    { tool: 'bash', args: { command: 'node -e "setTimeout(()=>console.log(1),800)"' } },
    { tool: 'bash', args: { command: 'node -e "setTimeout(()=>console.log(2),800)"' } },
    { tool: 'read_file', args: { path: a } },
    { tool: 'grep', args: { pattern: 'alpha', path: dir } },
  ] });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^batch: 4 ok, 0 failed, 0 skipped/);
  assert.ok(Date.now() - started < 2500, 'ran in parallel');
  assert.match(out.text, /=== \[3\] read_file ok \d+ ms\n1\talpha/);
  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.slice(-4).map((e) => e.tool).sort(), ['bash', 'bash', 'grep', 'read_file']);
});

test('batch: sequence stops at the first error unless continue_on_error', async () => {
  const f = path.join(dir, 'seq.txt');
  const calls = [
    { tool: 'write_file', args: { path: f, content: 'one' } },
    { tool: 'read_file', args: { path: path.join(dir, 'missing.txt') } },
    { tool: 'edit_file', args: { path: f, old: 'one', new: 'two' } },
  ];
  const stopped = await call('batch', { mode: 'sequence', calls });
  assert.match(stopped.text, /^batch: 1 ok, 1 failed, 1 skipped/);
  assert.match(stopped.text, /=== \[3\] edit_file skipped/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'one');
  const kept = await call('batch', { mode: 'sequence', continue_on_error: true, calls });
  assert.match(kept.text, /^batch: 2 ok, 1 failed, 0 skipped/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'two');
});

test('batch: bad input is refused before anything runs', async () => {
  assert.equal((await call('batch', { calls: [] })).isError, true);
  assert.match((await call('batch', { calls: [{ tool: 'batch' }] })).text, /cannot contain another batch/);
  assert.match((await call('batch', { calls: Array.from({ length: 21 }, () => ({ tool: 'job' })) })).text, /at most 20/);
  assert.match((await call('batch', { calls: [{ tool: 'nope' }] })).text, /\[1\] nope ERROR[\s\S]*unknown tool/);
});

test('batch: long output is cut per item and says so', async () => {
  const out = await runBatch({ calls: [{ tool: 'x' }, { tool: 'y' }] }, async (tool) => rpcOk(tool === 'x' ? 'a'.repeat(80000) : 'short'));
  assert.match(out.text, /\[\.\.\. cut: 80000 chars in total; run this call alone/);
  assert.match(out.text, /=== \[2\] y ok \d+ ms\nshort/);
  assert.ok(out.text.length < 60000);
});

test('batch: item waits are shortened to fit the budget; one failed item does not fail the batch', async () => {
  const seen = [];
  const out = await runBatch({ calls: [{ tool: 'bash', args: { command: 'x', wait: 300 } }, { tool: 'wait_for', args: { timeout: 500 } }, { tool: 'job', args: { id: 'j', wait: 200 } }] },
    async (tool, args) => { seen.push([tool, args]); return rpcOk('ok'); });
  assert.ok(seen.every(([, a]) => (a.wait ?? a.timeout) <= 85), JSON.stringify(seen));
  assert.match(out.text, /3 ok/);
  const failed = await runBatch({ calls: [{ tool: 'a' }, { tool: 'b' }] }, async (tool) => (tool === 'a' ? rpcFail('bad') : rpcOk('fine')));
  assert.equal(failed.isError, false);
  assert.match(failed.text, /1 ok, 1 failed/);
});

test('read_file: paths reads several files, each with its own errors and encodings', async () => {
  const p1 = path.join(dir, 'p1.txt');
  const p2 = path.join(dir, 'p2.txt');
  fs.writeFileSync(p1, 'first\nsecond\n');
  fs.writeFileSync(p2, encodeFile('中文GBK\n', 'gbk'));
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const out = await call('read_file', { paths: [p1, p2, path.join(dir, 'nope.txt'), path.join(dir, 'pic.png')], limit: 1 });
  assert.equal(out.isError, false);
  assert.ok(out.text.includes(`=== ${p1}\n1\tfirst\n[`), out.text);
  assert.match(out.text, /lines 1-1 of 2/);
  assert.match(out.text, /1\t中文GBK/);
  assert.match(out.text, /nope\.txt\nERROR: no such file/);
  assert.match(out.text, /pic\.png\nimage, 4 bytes: read it on its own/);
  assert.equal((await call('read_file', { paths: [path.join(dir, 'nope.txt')] })).isError, true);
  assert.match((await call('read_file', { path: p1, paths: [p1] })).text, /not both/);
  assert.match((await call('read_file', {})).text, /path must be a string/);
});
