import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { PublicPool } from '../src/public-pool.mjs';
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
