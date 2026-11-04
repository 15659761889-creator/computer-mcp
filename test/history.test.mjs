import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { HISTORY_TOOL, latestHandoff, maskSecrets, readAuditEntries, renderRecentCalls } from '../src/history.mjs';
import { Hub } from '../src/hub.mjs';
import { MemoryStore } from '../src/memory.mjs';
import { createMcpServer } from '../src/server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-history-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60 * 1000;
const at = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();

let counter = 0;
function auditFile(rows, extra = '') {
  counter += 1;
  const file = path.join(dir, `audit-${counter}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${extra}`);
  return file;
}

const bash = (minutesAgo, command, more = {}) => ({ ts: at(minutesAgo), tool: 'bash', computer: 'pc-test', args: { command }, ms: 400, ...more });
const render = (file, options = {}) => renderRecentCalls({ file, now: NOW, ...options });
const callLines = (text) => text.split('\n').filter((line) => /^\s*\d+\. \d{4}-/.test(line));

// ---- What is shown ----

test('calls come newest first and read-only noise is hidden', () => {
  const file = auditFile([
    bash(30, 'echo first'),
    { ts: at(20), tool: 'memory_read', args: {}, ms: 3 },
    bash(10, 'echo second'),
    { ts: at(5), tool: 'list_computers', args: {}, ms: 3 },
    { ts: at(1), tool: 'recent_calls', args: {}, ms: 3 },
  ]);
  const text = render(file);
  const lines = callLines(text);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /bash on pc-test/);
  assert.ok(text.indexOf('echo second') < text.indexOf('echo first'));
  assert.ok(!/^\s*\d+\. .* (memory_read|list_computers|recent_calls) /m.test(text));
  assert.match(text, /2 of 2 matching calls shown\./);
  // Naming a hidden tool brings it back.
  assert.equal(callLines(render(file, { args: { tool: 'memory_read' } })).length, 1);
});

test('limit, computer, tool and since_minutes narrow the list', () => {
  const file = auditFile([
    bash(50, 'echo a'),
    { ts: at(40), tool: 'ui_look', computer: 'pc-test', args: { window: 'Notepad' }, ms: 90 },
    bash(30, 'echo b', { computer: 'linux-vm' }),
    bash(20, 'echo c'),
    bash(2, 'echo d', { computer: 'linux-vm' }),
  ]);
  assert.equal(callLines(render(file, { args: { limit: 2 } })).length, 2);
  assert.match(render(file, { args: { limit: 2 } }), /2 of 5 matching calls shown; raise limit/);
  const linux = render(file, { args: { computer: 'LINUX-VM' } });
  assert.equal(callLines(linux).length, 2);
  assert.ok(!linux.includes('echo a') && !linux.includes('echo c'));
  assert.equal(callLines(render(file, { args: { tool: 'ui_look' } })).length, 1);
  assert.match(render(file, { args: { tool: 'ui_look' } }), /"window":"Notepad"/);
  assert.equal(callLines(render(file, { args: { since_minutes: 25 } })).length, 2);
  assert.match(render(file, { args: { computer: 'nowhere' } }), /No recorded calls match those filters\./);
  // A bad limit is clamped, not an error.
  assert.equal(callLines(render(file, { args: { limit: 9999 } })).length, 5);
  assert.equal(callLines(render(file, { args: { limit: -4 } })).length, 1);
});

test('failures, exit codes and background jobs are marked', () => {
  const file = auditFile([
    bash(30, 'npm test', { exit_code: 1 }),
    bash(20, 'long job', { job: 'j1', pid: 4242, background: true }),
    { ts: at(10), tool: 'edit_file', computer: 'pc-test', args: { path: 'a.txt' }, ms: 5, error: 'old text was not found in the file' },
    bash(5, 'echo fine', { exit_code: 0 }),
  ]);
  const text = render(file);
  assert.match(text, /bash on pc-test  failed, exit 1/);
  assert.match(text, /still running in the background/);
  assert.match(text, /edit_file on pc-test  failed/);
  assert.match(text, /error: old text was not found in the file/);
  assert.match(text, /echo fine/);
  assert.match(text, /\d+\. [\d: -]+ \(\d+ min ago\)  bash on pc-test  ok, took 0 s/);
});

test('a long quiet spell separates one working session from the next', () => {
  const file = auditFile([bash(400, 'echo old session'), bash(390, 'echo old again'), bash(60, 'echo new session')]);
  const text = render(file);
  assert.match(text, /--- quiet for 5 h ---/);
  assert.equal((text.match(/--- quiet for/g) || []).length, 1);
  assert.ok(text.indexOf('echo new session') < text.indexOf('quiet for'));
  assert.ok(text.indexOf('quiet for') < text.indexOf('echo old again'));
});

// ---- Did the last session finish? ----

const note = (minutesAgo, author = 'claude-ai') => ({ at: NOW - minutesAgo * MIN, author, id: 'm_test' });

test('a call that is still running means someone may be working', () => {
  const file = auditFile([bash(30, 'echo a')]);
  const text = render(file, { active: [{ action: 'bash', computer: 'pc-test', startedAt: NOW - 42 * 1000 }] });
  assert.match(text, /Running now \(1\): bash on pc-test, started 42 s ago\./);
  assert.match(text, /Assessment: A call is still running/);
});

test('a handoff note newer than the last call means the session finished', () => {
  const file = auditFile([bash(60, 'echo a'), bash(50, 'echo b')]);
  const text = render(file, { handoff: note(20) });
  assert.match(text, /Assessment: The newest handoff note \(by claude-ai, 20 min ago\) is newer than the last call/);
  assert.match(text, /memory_read/);
});

test('calls after the last handoff note and a long quiet spell mean the session was cut off', () => {
  const file = auditFile([bash(300, 'echo before'), bash(100, 'echo after 1'), bash(90, 'echo after 2')]);
  const text = render(file, { handoff: note(200, 'codex') });
  assert.match(text, /2 calls were made after the newest handoff note \(by codex, 3 h ago\)/);
  assert.match(text, /nothing has happened for 90 min/);
  assert.match(text, /probably stopped before it wrote a handoff note/);
  assert.match(text, /check the real state/);
});

test('a very recent call means another AI may still be working', () => {
  const file = auditFile([bash(4, 'echo busy')]);
  const text = render(file, { handoff: note(90) });
  assert.match(text, /1 call was made after the newest handoff note/);
  assert.match(text, /the last call finished 4 min ago\. Another AI session may still be working/);
});

test('without any handoff note the assessment says so, and a failed last call is flagged', () => {
  const file = auditFile([bash(100, 'echo x'), bash(90, 'git push', { exit_code: 128 })]);
  const text = render(file);
  assert.match(text, /2 calls were made and no handoff note exists/);
  assert.match(text, /The last call FAILED \(failed, exit 128\)/);
});

test('an empty or missing log says so', () => {
  assert.match(render(path.join(dir, 'does-not-exist.jsonl')), /No calls are recorded yet/);
  assert.match(render(path.join(dir, 'does-not-exist.jsonl')), /The audit log has no calls yet\./);
});

// ---- Secrets and size ----

test('secrets in command lines are masked and long commands are clipped unless full is asked for', () => {
  assert.ok(!maskSecrets('curl -H "Authorization: Bearer abcdef1234567890xyz" https://x.test').includes('abcdef1234567890xyz'));
  assert.equal(maskSecrets('set password=hunter2 now'), 'set password=[masked] now');
  assert.equal(maskSecrets('DB_PASSWORD=hunter2'), 'DB_PASSWORD=[masked]');
  assert.equal(maskSecrets('{"token": "abc123"}'), '{"token": [masked]}');
  assert.equal(maskSecrets('tool --api-key sk-1234567890abcdefghij'), 'tool --api-key [masked]');
  assert.equal(maskSecrets('key sk-1234567890abcdefghij'), 'key [masked-key]');
  assert.equal(maskSecrets('https://pc-test-mcp.example.app/t/redacted-cf031b13e48872ca/mcp'), 'https://pc-test-mcp.example.app/t/[masked]/mcp');
  assert.equal(maskSecrets('hash a3f9c2e1b4d5a3f9c2e1b4d5a3f9c2e1b4d5a3f9c2e1'), 'hash [masked-long-string]');
  // Ordinary text survives.
  const plain = 'git status --short; compass: north; C:\\Users\\me\\android-workstation-removed-20261104';
  assert.equal(maskSecrets(plain), plain);

  const long = `echo ${'x'.repeat(900)}`;
  const file = auditFile([bash(1, long), bash(2, 'echo token=abc999 done')]);
  const brief = render(file);
  assert.ok(!brief.includes('x'.repeat(400)));
  assert.match(brief, /x{50,}\.\.\./);
  assert.ok(!brief.includes('abc999'));
  assert.match(brief, /token=\[masked\]/);
  assert.ok(render(file, { args: { full: true } }).includes('x'.repeat(800)));
});

test('typed text never reaches the log, so it cannot reach the reader either', () => {
  const file = auditFile([{ ts: at(1), tool: 'ui_act', computer: 'pc-test', args: { action: 'type', text_chars: 12 }, ms: 40 }]);
  const text = render(file);
  assert.match(text, /"text_chars":12/);
});

// ---- The log itself ----

test('damaged lines are skipped and the rolled-over file is read too', () => {
  const file = auditFile([bash(30, 'echo newer')], 'this is not json\n{"ts":"nope","tool":"bash"}\n{"half":');
  fs.writeFileSync(`${file}.1`, `${[bash(300, 'echo older one'), bash(200, 'echo older two')].map((r) => JSON.stringify(r)).join('\n')}\n`);
  const entries = readAuditEntries(file);
  assert.deepEqual(entries.map((e) => e.args.command), ['echo older one', 'echo older two', 'echo newer']);
  const text = render(file);
  assert.ok(text.indexOf('echo newer') < text.indexOf('echo older two'));
  assert.equal(callLines(text).length, 3);
});

test('a log far larger than the read window still gives the newest calls', () => {
  const rows = [];
  for (let i = 0; i < 7000; i += 1) rows.push({ ts: new Date(NOW - (7000 - i) * 1000).toISOString(), tool: 'bash', computer: 'pc-test', args: { command: `echo row-${i} ${'x'.repeat(150)}` }, ms: 1 });
  const file = auditFile(rows);
  assert.ok(fs.statSync(file).size > 1024 * 1024);
  const text = render(file, { args: { limit: 3 } });
  assert.match(text, /echo row-6999 /);
  assert.match(text, /echo row-6997 /);
  assert.ok(!text.includes('echo row-6996 '));
});

test('latestHandoff picks the newest handoff and ignores facts', () => {
  let clock = Date.UTC(2026, 10, 4, 9, 0, 0);
  const store = new MemoryStore({ file: path.join(dir, 'hand.jsonl'), clock: () => clock });
  assert.equal(latestHandoff(store), null);
  store.write({ kind: 'fact', key: 'f', text: 'a fact', author: 'a', by: 'ai' });
  assert.equal(latestHandoff(store), null);
  store.write({ kind: 'handoff', text: 'first', author: 'codex', by: 'ai' });
  clock += 60 * MIN;
  store.write({ kind: 'handoff', text: 'second', author: 'claude-ai', by: 'ai' });
  const found = latestHandoff(store);
  assert.equal(found.author, 'claude-ai');
  assert.equal(found.at, Date.UTC(2026, 10, 4, 10, 0, 0));
  assert.equal(latestHandoff(null), null);
});

// ---- Over the wire ----

async function start(options) {
  const server = createMcpServer({ name: options.name, getToken: () => 'tok', auditFile: options.auditFile ?? null, memory: options.memory ?? null, hub: options.hub ?? null });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const rpc = async (method, params, headers = {}) => {
    id += 1;
    const res = await fetch(`${base}/t/tok/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    if (res.headers.get('content-type').includes('event-stream')) return JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    return JSON.parse(text);
  };
  const call = async (name, args, headers) => {
    const reply = await rpc('tools/call', { name, arguments: args }, headers);
    return reply.error ? { error: reply.error } : { text: reply.result.content[0].text, isError: reply.result.isError === true };
  };
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  return { rpc, call, close };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 250); });

test('a server with an audit log offers recent_calls and shows what really ran', async () => {
  const memory = new MemoryStore({ file: path.join(dir, 'solo-mem.jsonl') });
  const file = path.join(dir, 'wire', 'audit.jsonl');
  const { rpc, call, close } = await start({ name: 'solo-test', memory, auditFile: file });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.match(init.result.instructions, /recent_calls/);
    const tools = (await rpc('tools/list')).result.tools;
    const tool = tools.find((t) => t.name === 'recent_calls');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema, HISTORY_TOOL.inputSchema);
    assert.ok(!(tool.inputSchema.required ?? []).includes('computer'));
    assert.equal(tool.annotations.readOnlyHint, true);

    const ran = await call('bash', { command: 'echo hello-unit password=hunter2' }, { 'User-Agent': 'unit-agent/9' });
    assert.equal(ran.isError, false);
    await call('memory_write', { kind: 'handoff', text: 'SENTINEL-HANDOFF-TEXT', author: 'unit-ai' });
    await settle();

    const result = await call('recent_calls', {});
    assert.equal(result.isError, false);
    assert.match(result.text, /Recent tool calls on this server/);
    assert.match(result.text, /echo hello-unit password=\[masked\]/);
    assert.ok(!result.text.includes('hunter2'));
    assert.match(result.text, /memory_write/);
    assert.ok(!result.text.includes('SENTINEL-HANDOFF-TEXT'), 'note text is not in the audit log, so not here');
    assert.match(result.text, /Assessment: .*handoff note \(by unit-ai/);

    // The audit log now records which client made each call.
    assert.match(fs.readFileSync(file, 'utf8'), /"agent":"unit-agent\/9"/);

    // Asking for the history does not put the history in the history.
    await settle();
    assert.ok(!/^\s*\d+\. .* recent_calls /m.test((await call('recent_calls', {})).text));
  } finally {
    await close();
  }
});

test('on a hub, recent_calls sits beside the memory tools, needs no computer, and stays out of the phone feed', async () => {
  const memory = new MemoryStore({ file: path.join(dir, 'hub-mem.jsonl') });
  const hub = new Hub({ file: path.join(dir, 'hub-hist.json'), selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => 'tok' });
  const file = path.join(dir, 'hubwire', 'audit.jsonl');
  const { rpc, call, close } = await start({ name: 'main', memory, hub, auditFile: file });
  try {
    const tools = (await rpc('tools/list')).result.tools;
    const tool = tools.find((t) => t.name === 'recent_calls');
    assert.ok(tool);
    assert.ok(!(tool.inputSchema.required ?? []).includes('computer'));
    assert.equal(tool.inputSchema.properties.computer.description, 'Only calls on this computer.');

    // A call still running on the hub shows up under "Running now".
    hub.startActivity('bash', 'pc-test');
    const result = await call('recent_calls', {});
    assert.match(result.text, /Running now \(1\): bash on pc-test, started/);
    assert.match(result.text, /Assessment: A call is still running/);
    assert.deepEqual(hub.recentCalls.map((row) => row.action), []);
  } finally {
    await close();
    hub.close();
  }
});

test('a server without an audit log has no recent_calls', async () => {
  const { rpc, call, close } = await start({ name: 'quiet-test', memory: null, auditFile: null });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.ok(!/recent_calls/.test(init.result.instructions));
    assert.ok(!(await rpc('tools/list')).result.tools.some((t) => t.name === 'recent_calls'));
    assert.equal((await call('recent_calls', {})).error.code, -32602);
  } finally {
    await close();
  }
});
