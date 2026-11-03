import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { PublicPool, poolFile } from '../src/public-pool.mjs';
import { createMcpServer } from '../src/server.mjs';

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'computer-pool-test-')); }

test('one shared pool: session identity, mentions, public acknowledgment, refusal, cursor and persistence', () => {
  const dir = workspace();
  const file = path.join(dir, 'pool.sqlite');
  let pool;
  try {
    pool = new PublicPool(file);
    const a = pool.join({ agent: 'GPT', conversation: 'gpt-conv-1', computer: 'pc-a' });
    const b = pool.join({ agent: 'Claude', model: 'test-model', conversation: 'claude-conv-2', computer: 'pc-b' });
    assert.notEqual(a.session_id, b.session_id);
    assert.ok(a.session_token.length >= 32);
    assert.ok(!JSON.stringify(pool.summary()).includes(a.session_token));
    const request = pool.post({ ...a, type: 'help_request', content: 'Can you check concurrency?', mentions: [b.session_id], client_message_id: 'req-1' });
    assert.equal(request.message.mentions[0], b.session_id);
    assert.equal(pool.post({ ...a, type: 'help_request', content: 'Can you check concurrency?', mentions: [b.session_id], client_message_id: 'req-1' }).duplicate, true);
    assert.equal(pool.summary().pending_ack_count, 1);
    const read = pool.read(b);
    assert.equal(read.messages.length, 3, 'two join announcements and one help request');
    assert.equal(read.pending_mentions[0].message_id, request.message.seq);
    assert.ok(read.pending_mentions[0].fetched_at);
    assert.equal(pool.summary().pending_ack_count, 1, 'fetch does not publicly acknowledge');
    assert.throws(() => pool.ack({ ...a, message_id: request.message.seq }), /did not mention/);
    assert.throws(() => pool.ack({ ...b, message_id: request.message.seq, decision: 'decline' }), /reason/);
    const refusal = pool.ack({ ...b, message_id: request.message.seq, decision: 'decline', reason: 'Busy with my current project.' });
    assert.equal(refusal.message.type, 'ack');
    assert.equal(refusal.message.reply_to, request.message.seq);
    assert.equal(refusal.message.decision, 'decline');
    assert.equal(pool.summary().pending_ack_count, 0);
    assert.equal(pool.ack({ ...b, message_id: request.message.seq }).duplicate, true);
    const receivedReply = pool.read(b);
    assert.deepEqual(receivedReply.pending_mentions, []);
    assert.equal(receivedReply.messages.length, 1, 'only newly fetched replies appear');
    assert.equal(pool.read(b).messages.length, 0, 'cursor is persisted');
    assert.throws(() => pool.read({ ...b, session_token: a.session_token }), /wrong session token/);
    assert.throws(() => pool.post({ ...b, content: 'x'.repeat(4001) }), /content/);
    pool.close();
    pool = null;
    pool = new PublicPool(file);
    assert.equal(pool.read(b).messages.length, 0, 'read cursor survives reopen');
    assert.equal(pool.feed().messages.length, 4, 'join messages, request and acknowledgment survive reopen');
    const ordinary = pool.post({ ...a, content: 'General broadcast' });
    assert.equal(ordinary.message.mentions.length, 0);
    assert.equal(pool.read(b).messages.length, 1);
    assert.equal(pool.summary().pending_ack_count, 0, 'ordinary messages need no public acknowledgment');
    pool.close();
    pool = null;
  } finally {
    pool?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('combined reply+ack is atomic and a recipient may accept or defer', () => {
  const dir = workspace();
  const pool = new PublicPool(path.join(dir, 'p.sqlite'));
  try {
    const a = pool.join({ agent: 'GPT', conversation: 'g1' });
    const b = pool.join({ agent: 'Claude', conversation: 'c2' });
    const request = pool.post({ ...a, content: 'Review module', mentions: [b.session_id] }).message;
    const reply = pool.post({ ...b, content: '已读，可以检查。', type: 'response', reply_to: request.seq, ack: true, decision: 'accept' });
    assert.equal(reply.message.decision, 'accept');
    assert.equal(pool.summary().pending_ack_count, 0);
    assert.throws(() => pool.post({ ...b, content: 'reack', reply_to: request.seq, ack: true }), /already acknowledged/);
    const bad = pool.post({ ...a, content: 'I can reply normally', reply_to: request.seq });
    assert.equal(bad.message.type, 'message');
    assert.equal(pool.summary().pending_ack_count, 0);
  } finally { pool.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MCP tools and phone feed use one pool but enforce separate credentials', async () => {
  const dir = workspace();
  const token = 'mcp-client-shared-test-token';
  const hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'host', origin: () => 'https://unit.example', getToken: () => token });
  const server = createMcpServer({ name: 'host', getToken: () => token, auditFile: null, hub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  async function call(name, args) {
    const res = await fetch(url + '/t/' + token + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const value = await res.json();
    assert.equal(res.status, 200);
    const text = value.result.content[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { result: value.result, body };
  }
  try {
    const listed = await fetch(url + '/t/' + token + '/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await listed.json()).result.tools;
    assert.ok(tools.some((t) => t.name === 'pool_join'));
    assert.ok(tools.some((t) => t.name === 'pool_ack'));
    const a = (await call('pool_join', { agent: 'GPT', conversation: 'g1' })).body;
    const b = (await call('pool_join', { agent: 'Claude', conversation: 'c2' })).body;
    const msg = (await call('pool_post', { ...a, content: 'Please check this', mentions: [b.session_id] })).body.message;
    const seen = (await call('pool_read', b)).body;
    assert.equal(seen.pending_mentions[0].message_id, msg.seq);
    const forbidden = await call('pool_ack', { ...a, message_id: msg.seq });
    assert.equal(forbidden.result.isError, true);
    const ack = (await call('pool_ack', { ...b, message_id: msg.seq, decision: 'defer', reason: 'Currently running tests' })).body;
    assert.equal(ack.message.decision, 'defer');
    const anonymous = await fetch(url + '/hub/api/pool');
    assert.equal(anonymous.status, 401);
    const mcpKey = await fetch(url + '/hub/api/pool', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(mcpKey.status, 401);
    const phone = await fetch(url + '/hub/api/pool', { headers: { Authorization: 'Bearer ' + hub.state.adminKey } });
    assert.equal(phone.status, 200);
    const feed = await phone.json();
    assert.equal(feed.messages.length, 4);
    assert.equal(feed.pending_ack_count, 0);
    assert.ok(feed.sessions.every((session) => !('token_hash' in session)));
    const incremental = await fetch(url + '/hub/api/pool?after_seq=' + msg.seq, { headers: { Authorization: 'Bearer ' + hub.state.adminKey } });
    assert.equal((await incremental.json()).messages.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withPool(options, fn) {
  const dir = workspace();
  const pool = new PublicPool(path.join(dir, 'p.sqlite'), undefined, options);
  try { return fn(pool, dir); } finally { pool.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('an acknowledgment cannot be faked by type, and only the server record marks one', () => withPool({}, (pool) => {
  const a = pool.join({ agent: 'GPT', conversation: 'g' });
  const b = pool.join({ agent: 'Claude', conversation: 'c' });
  const request = pool.post({ ...a, content: 'help', mentions: [b.session_id] }).message;
  assert.throws(() => pool.post({ ...a, type: 'ack', content: 'read #' + request.seq, reply_to: request.seq }), /type ack/);
  assert.equal(request.mention_status[0].acknowledged, false);
  assert.equal(request.acknowledges, null);
  const viaPost = pool.post({ ...b, content: 'on it', reply_to: request.seq, ack: true, decision: 'accept' }).message;
  assert.equal(viaPost.type, 'ack', 'ack:true without a type is an ack');
  assert.equal(viaPost.acknowledges, request.seq);
  const original = pool.feed().messages.find((m) => m.seq === request.seq);
  assert.deepEqual(original.mention_status, [{ session_id: b.session_id, acknowledged: true, decision: 'accept', ack_message_id: viaPost.seq }]);
}));

test('a caller-chosen client id can never block the real acknowledgment', () => withPool({}, (pool) => {
  const a = pool.join({ agent: 'GPT', conversation: 'g' });
  const b = pool.join({ agent: 'Claude', conversation: 'c' });
  const request = pool.post({ ...a, content: 'help', mentions: [b.session_id] }).message;
  pool.post({ ...b, content: 'unrelated', client_message_id: 'ack-' + request.seq });
  assert.throws(() => pool.post({ ...b, content: 'x', client_message_id: 'sys:ack-' + request.seq }), /must not start/);
  const ack = pool.ack({ ...b, message_id: request.seq, decision: 'accept' });
  assert.equal(ack.duplicate, false);
  assert.equal(pool.summary().pending_ack_count, 0);
  assert.equal(pool.ack({ ...b, message_id: request.seq }).duplicate, true);
}));

test('null optional fields are treated as omitted, and bad replies give clear errors', () => withPool({}, (pool) => {
  const a = JSON.parse(pool.invoke('pool_join', { agent: 'GPT', conversation: 'g', model: null, computer: null }).text);
  const posted = pool.invoke('pool_post', { ...a, content: 'hi', decision: null, reply_to: null, mentions: null, type: null, client_message_id: null });
  assert.equal(posted.isError, undefined, posted.text);
  const zero = pool.invoke('pool_post', { ...a, content: 'hi', reply_to: 0 });
  assert.equal(zero.isError, true);
  assert.match(zero.text, /reply_to/);
  assert.equal(pool.invoke('pool_read', null).isError, true);
}));

test('a session can resume with its token or hand its unanswered mentions to a new session', () => withPool({}, (pool) => {
  const a = pool.join({ agent: 'GPT', conversation: 'g' });
  const b = pool.join({ agent: 'Claude', conversation: 'c' });
  const before = pool.latestSeq();
  const resumed = pool.join({ agent: 'Claude', conversation: 'c', session_id: b.session_id, session_token: b.session_token });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.session_id, b.session_id);
  assert.equal(pool.latestSeq(), before, 'resuming posts nothing');
  const request = pool.post({ ...a, content: 'help', mentions: [b.session_id] }).message;
  pool.read(b);
  assert.throws(() => pool.join({ agent: 'Claude', conversation: 'other', previous_session_id: b.session_id }), /different agent or conversation/);
  const b2 = pool.join({ agent: 'Claude', conversation: 'c', previous_session_id: b.session_id });
  assert.equal(b2.mentions_moved, 1);
  assert.throws(() => pool.read(b), /taken over/);
  assert.throws(() => pool.post({ ...a, content: 'x', mentions: [b.session_id] }), /taken over/);
  const read = pool.read(b2);
  assert.equal(read.pending_mentions[0].message_id, request.seq);
  assert.ok(read.messages.every((m) => m.seq > request.seq), 'read progress carries over');
  assert.equal(pool.ack({ ...b2, message_id: request.seq }).message.acknowledges, request.seq);
  assert.throws(() => pool.join({ agent: 'Claude', conversation: 'c', previous_session_id: b.session_id }), /already taken over/);
}));

test('long-silent sessions stop counting as pending, and are flagged when mentioned', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  withPool({ now: () => now }, (pool) => {
    const a = pool.join({ agent: 'GPT', conversation: 'g' });
    const b = pool.join({ agent: 'Claude', conversation: 'c' });
    pool.post({ ...a, content: 'help', mentions: [b.session_id] });
    assert.equal(pool.summary().pending_ack_count, 1);
    assert.equal(pool.summary().active_sessions, 2);
    now += 25 * 3600 * 1000;
    pool.read(a);
    const summary = pool.summary();
    assert.equal(summary.pending_ack_count, 0);
    assert.equal(summary.stale_pending_count, 1);
    assert.equal(summary.active_sessions, 1);
    const flagged = pool.post({ ...a, content: 'again', mentions: [b.session_id] });
    assert.match(flagged.warnings[0], /silent/);
  });
});

test('posting and joining are rate limited, and failed attempts do not use up the limit', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  withPool({ now: () => now, postsPerMinute: 3, joinsPerMinute: 3 }, (pool) => {
    const a = pool.join({ agent: 'GPT', conversation: 'g' });
    assert.throws(() => pool.post({ ...a, content: 'x', reply_to: 999 }), /unknown reply_to/);
    pool.post({ ...a, content: 'm0', client_message_id: 'c1' });
    pool.post({ ...a, content: 'm1' });
    pool.post({ ...a, content: 'm2' });
    assert.throws(() => pool.post({ ...a, content: 'too many' }), /too many messages/);
    assert.equal(pool.post({ ...a, content: 'm0', client_message_id: 'c1' }).duplicate, true, 'a retry is still answered');
    now += 61000;
    assert.equal(pool.post({ ...a, content: 'later' }).duplicate, false);
  });
  withPool({ now: () => now, joinsPerMinute: 2 }, (pool) => {
    pool.join({ agent: 'A', conversation: '1' });
    pool.join({ agent: 'B', conversation: '2' });
    assert.throws(() => pool.join({ agent: 'C', conversation: '3' }), /too many new sessions/);
    now += 61000;
    pool.join({ agent: 'C', conversation: '3' });
  });
});

test('the database stays bounded: old messages are pruned and replies to them are cleared', () => withPool({ maxMessages: 5, postsPerMinute: 1000 }, (pool) => {
  const a = pool.join({ agent: 'GPT', conversation: 'g' });
  const b = pool.join({ agent: 'Claude', conversation: 'c' });
  const old = pool.post({ ...a, content: 'old', mentions: [b.session_id] }).message;
  for (let i = 0; i < 10; i += 1) pool.post({ ...a, content: 'n' + i });
  const reply = pool.post({ ...b, content: 'late reply', reply_to: old.seq }).message;
  pool.maintain();
  const feed = pool.feed({ limit: 100 });
  assert.equal(feed.messages.length, 5);
  assert.equal(feed.messages.find((m) => m.seq === reply.seq).reply_to, null);
  assert.equal(feed.pending_ack_count, 0, 'mentions on pruned messages are gone');
}));

test('a failing change listener does not turn a stored message into an error', () => {
  const dir = workspace();
  const pool = new PublicPool(path.join(dir, 'p.sqlite'), () => { throw new Error('listener broke'); });
  try {
    const a = pool.join({ agent: 'GPT', conversation: 'g' });
    assert.equal(pool.post({ ...a, content: 'kept' }).duplicate, false);
    assert.equal(pool.feed().messages.at(-1).content, 'kept');
  } finally { pool.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pool files sit beside the state file, never on it, and are private on POSIX', () => {
  assert.equal(poolFile('/x/hub.json'), '/x/hub.pool.sqlite');
  assert.equal(poolFile('/x/hub'), '/x/hub.pool.sqlite');
  if (process.platform === 'win32') return;
  withPool({}, (pool, dir) => {
    pool.join({ agent: 'GPT', conversation: 'g' });
    for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o077, 0, f);
  });
});

test('a pool database from 0.4.3 is upgraded in place', () => {
  const dir = workspace();
  const file = path.join(dir, 'old.sqlite');
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, conversation TEXT NOT NULL, computer TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL)');
    db.close();
    const pool = new PublicPool(file);
    try {
      const a = pool.join({ agent: 'GPT', conversation: 'g' });
      assert.equal(pool.read(a).messages.length, 1);
    } finally { pool.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pool posts do not wake the phone notification poll', () => {
  const dir = workspace();
  const hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'host', origin: () => 'https://unit.example', getToken: () => 't' });
  try {
    const before = hub.version;
    const a = hub.pool.join({ agent: 'GPT', conversation: 'g' });
    hub.pool.post({ ...a, content: 'hello' });
    assert.equal(hub.version, before);
  } finally { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without node:sqlite the server still starts and simply has no pool', (t) => {
  const probe = spawnSync(process.execPath, ['--no-experimental-sqlite', '-e', 'try { require("node:sqlite"); process.exit(1) } catch { process.exit(0) }']);
  if (probe.status !== 0) return t.skip('this Node.js cannot turn node:sqlite off');
  const dir = workspace();
  const script = [
    `import { Hub } from ${JSON.stringify(new URL('../src/hub.mjs', import.meta.url).href)};`,
    `import { createMcpServer } from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};`,
    `const token = 'no-sqlite-test-token-123';`,
    `const hub = new Hub({ file: ${JSON.stringify(path.join(dir, 'hub.json'))}, selfName: 'host', origin: () => 'https://unit.example', getToken: () => token });`,
    `const server = createMcpServer({ name: 'host', getToken: () => token, auditFile: null, hub });`,
    `await new Promise((r) => server.listen(0, '127.0.0.1', r));`,
    `const url = 'http://127.0.0.1:' + server.address().port;`,
    `const rpc = async (method, params) => (await (await fetch(url + '/t/' + token + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());`,
    `const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);`,
    `const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result.instructions;`,
    `const phone = await fetch(url + '/hub/api/pool', { headers: { Authorization: 'Bearer ' + hub.state.adminKey } });`,
    `console.log(JSON.stringify({ pool: tools.some((n) => n.startsWith('pool_')), list: tools.includes('list_computers'), mentions: init.includes('pool'), status: phone.status, error: hub.poolError }));`,
    `server.closeAllConnections(); server.close(); hub.close();`,
  ].join('\n');
  try {
    const run = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.deepEqual({ pool: out.pool, list: out.list, mentions: out.mentions, status: out.status }, { pool: false, list: true, mentions: false, status: 503 });
    assert.match(out.error, /22\.13/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
