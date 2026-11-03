import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { OWNER, PublicPool, inviteText } from '../src/public-pool.mjs';
import { createMcpServer } from '../src/server.mjs';

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'computer-pool-discuss-')); }

async function withPool(fn, options = {}) {
  const dir = workspace();
  const pool = new PublicPool(path.join(dir, 'p.sqlite'), undefined, options);
  try { return await fn(pool, dir); } finally { pool.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const two = (pool) => [pool.join({ agent: 'GPT', conversation: 'g' }), pool.join({ agent: 'Claude', conversation: 'c' })];

test('a discussion: start, read the whole history once, talk, conclude, reopen', () => withPool((pool) => {
  const [a, b] = two(pool);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'Next step for Computer MCP', goal: 'Agree on the next feature' });
  assert.equal(topic.status, 'open');
  assert.match(topic.invite, new RegExp(`topic_id=${topic.topic_id}`));
  pool.post({ ...a, topic_id: topic.topic_id, type: 'proposal', content: 'Ship discussion mode first.' });
  pool.post({ ...a, content: 'unrelated general message' });
  const first = pool.read({ ...b, topic_id: topic.topic_id });
  assert.deepEqual(first.messages.map((m) => m.type), ['topic', 'proposal'], 'whole topic history, nothing else');
  assert.equal(first.topic.title, 'Next step for Computer MCP');
  assert.equal(pool.read({ ...b, topic_id: topic.topic_id }).messages.length, 0, 'topic cursor saved');
  assert.equal(pool.read(b).messages.length, 5, 'the general read still sees everything (2 joins, topic, proposal, general)');
  pool.post({ ...b, topic_id: topic.topic_id, content: 'Agree, but add owner messages too.' });
  const listed = pool.topic({ ...b, action: 'list' }).topics;
  assert.equal(listed[0].topic_id, topic.topic_id);
  assert.equal(listed[0].message_count, 3);
  assert.deepEqual(listed[0].participants.map((p) => p.agent), ['GPT', 'Claude']);
  const done = pool.topic({ ...b, action: 'conclude', topic_id: topic.topic_id, conclusion: 'Plan: discussion mode, then owner messages.' }).topic;
  assert.equal(done.status, 'concluded');
  assert.equal(done.concluded_by.agent, 'Claude');
  assert.throws(() => pool.post({ ...a, topic_id: topic.topic_id, content: 'late' }), /concluded/);
  assert.throws(() => pool.topic({ ...a, action: 'conclude', topic_id: topic.topic_id, conclusion: 'again' }), /already concluded/);
  const reopened = pool.reopenTopic(topic.topic_id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.conclusion, null);
  pool.post({ ...a, topic_id: topic.topic_id, content: 'back again' });
  assert.throws(() => pool.topic({ ...a, action: 'show', topic_id: 999 }), /unknown topic_id/);
  assert.throws(() => pool.topic({ ...a, action: 'start', title: ' ' }), /title/);
  assert.throws(() => pool.topic({ ...a, action: 'nope' }), /action/);
}));

test('in a discussion a normal reply answers a mention; outside, reply_to does', () => withPool((pool) => {
  const [a, b] = two(pool);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'T' });
  const ask = pool.post({ ...a, topic_id: topic.topic_id, content: 'Claude, what do you think?', mentions: [b.session_id] }).message;
  assert.equal(pool.summary().pending_ack_count, 1);
  const answer = pool.post({ ...b, topic_id: topic.topic_id, content: 'I think yes.' }).message;
  assert.deepEqual(answer.acknowledges, [ask.seq]);
  assert.equal(pool.summary().pending_ack_count, 0);
  const direct = pool.post({ ...a, content: 'Direct question', mentions: [b.session_id] }).message;
  pool.post({ ...b, content: 'unrelated', topic_id: topic.topic_id });
  assert.equal(pool.summary().pending_ack_count, 1, 'speaking in a topic does not answer a mention outside it');
  const reply = pool.post({ ...b, content: 'Answer', reply_to: direct.seq }).message;
  assert.deepEqual(reply.acknowledges, [direct.seq]);
  assert.equal(pool.feed().messages.find((m) => m.seq === direct.seq).mention_status[0].acknowledged, true);
  assert.equal(pool.summary().pending_ack_count, 0);
}));

test('pool_wait returns at once when something is new, wakes on a reply, ignores your own posts, and times out', () => withPool(async (pool) => {
  const [a, b] = two(pool);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'T' });
  const t = topic.topic_id;
  const immediate = await pool.wait({ ...b, topic_id: t, timeout_seconds: 5 });
  assert.equal(immediate.woke_by, 'message');
  assert.equal(immediate.messages[0].type, 'topic');
  pool.post({ ...b, topic_id: t, content: 'my view' });
  const started = Date.now();
  const waiting = pool.wait({ ...b, topic_id: t, timeout_seconds: 10 });
  pool.post({ ...b, topic_id: t, content: 'my own follow-up must not wake me' });
  setTimeout(() => pool.post({ ...a, topic_id: t, content: 'GPT replies' }), 150);
  const woke = await waiting;
  assert.equal(woke.woke_by, 'message');
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(woke.messages.map((m) => m.content), ['my view', 'my own follow-up must not wake me', 'GPT replies']);
  const quiet = await pool.wait({ ...b, topic_id: t, timeout_seconds: 1 });
  assert.equal(quiet.timed_out, true);
  assert.deepEqual(quiet.messages, []);
  await assert.rejects(pool.wait({ ...b, timeout_seconds: 121 }), /timeout_seconds/);
}));

test('a mention elsewhere wakes a topic wait, and closing the pool releases waiters', () => withPool(async (pool) => {
  const [a, b] = two(pool);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'T' });
  pool.read({ ...b, topic_id: topic.topic_id });
  const waiting = pool.wait({ ...b, topic_id: topic.topic_id, timeout_seconds: 10 });
  setTimeout(() => pool.post({ ...a, content: 'Claude, a direct question', mentions: [b.session_id] }), 50);
  const woke = await waiting;
  assert.equal(woke.woke_by, 'mention');
  assert.equal(woke.pending_mentions.length, 1);
  assert.equal(woke.pending_mentions[0].topic_id, null);
  const again = pool.wait({ ...b, topic_id: topic.topic_id, timeout_seconds: 10 });
  pool.close();
  await assert.rejects(again, /shutting down/);
}));

test('two AIs can hold a back-and-forth with pool_wait', () => withPool(async (pool) => {
  const [a, b] = two(pool);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'Ping pong' });
  const t = topic.topic_id;
  pool.read({ ...a, topic_id: t });
  pool.read({ ...b, topic_id: t });
  const speaker = async (me, lines, first) => {
    const heard = [];
    if (first) pool.post({ ...me, topic_id: t, content: lines.shift() });
    while (lines.length) {
      const got = await pool.wait({ ...me, topic_id: t, timeout_seconds: 5 });
      heard.push(...got.messages.filter((m) => m.sender.session_id !== me.session_id).map((m) => m.content));
      pool.post({ ...me, topic_id: t, content: lines.shift() });
    }
    return heard;
  };
  const [heardA, heardB] = await Promise.all([speaker(a, ['A1', 'A2', 'A3'], true), speaker(b, ['B1', 'B2', 'B3'], false)]);
  assert.deepEqual(heardA, ['B1', 'B2']);
  assert.deepEqual(heardB, ['A1', 'A2', 'A3']);
  const contents = pool.feed({ topicId: t }).messages.map((m) => m.content).slice(1);
  assert.deepEqual(contents, ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
}));

test('AIs can ask the owner; the owner session itself cannot be used, and survives pruning', () => withPool((pool) => {
  const [a] = two(pool);
  assert.throws(() => pool.read({ session_id: OWNER }), /unknown session/);
  assert.throws(() => pool.join({ agent: '主人', conversation: '手机 App' }), /reserved/);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'Budget' });
  const ask = pool.post({ ...a, topic_id: topic.topic_id, content: '主人，预算上限是多少？', mentions: ['主人'] }).message;
  assert.deepEqual(ask.mentions, [OWNER]);
  assert.equal(pool.summary().owner_pending, 1);
  assert.equal(pool.summary().pending_ack_count, 0, 'the owner is counted separately');
  const alert = pool.ownerAlerts().find((x) => x.kind === 'ask');
  assert.equal(alert.message_id, ask.seq);
  assert.match(alert.title, /GPT 在讨论 #\d+ 里问你/);
  assert.throws(() => pool.ownerPost({ content: 'me', mentions: ['主人'] }), /yourself/);
  const answer = pool.ownerPost({ topic_id: topic.topic_id, content: '上限 500 元' }).message;
  assert.equal(answer.sender.owner, true);
  assert.deepEqual(answer.acknowledges, [ask.seq], 'answering in the discussion answers the question');
  assert.equal(pool.summary().owner_pending, 0);
  assert.equal(pool.ownerAlerts().length, 0);
  const direct = pool.post({ ...a, content: 'owner, a direct question', mentions: ['owner'] }).message;
  assert.equal(pool.ownerAlerts()[0].title, 'GPT 找你');
  pool.ownerPost({ content: 'yes', reply_to: direct.seq });
  assert.equal(pool.ownerAlerts().length, 0);
  const msg = pool.ownerPost({ content: 'Hello AIs', mentions: [a.session_id] }).message;
  assert.equal(pool.read(a).pending_mentions.at(-1).message_id, msg.seq);
  pool.maintain();
  assert.ok(pool.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(OWNER));
  assert.ok(!pool.summary().sessions.some((s) => s.session_id === OWNER));
}, { now: () => Date.now() + 40 * 24 * 3600 * 1000 }));

test('the owner is told when an AI concludes a discussion, until they open it', () => withPool((pool) => {
  const [a] = two(pool);
  const { topic } = pool.topic({ ...a, action: 'start', title: 'Plan' });
  pool.topic({ ...a, action: 'conclude', topic_id: topic.topic_id, conclusion: 'Do X first.' });
  const alert = pool.ownerAlerts().find((x) => x.kind === 'concluded');
  assert.equal(alert.topic_id, topic.topic_id);
  assert.equal(alert.text, 'Do X first.');
  pool.feed({ topicId: topic.topic_id });
  assert.equal(pool.ownerAlerts().length, 0, 'opening the discussion on the phone clears it');
  pool.reopenTopic(topic.topic_id);
  pool.concludeTopic(OWNER, topic.topic_id, 'The owner decided.');
  assert.equal(pool.ownerAlerts().length, 0, 'no alert for the owner\'s own conclusion');
}));

test('participants show as waiting, active or away, and a discussion stuck on someone who left alerts the owner', async () => {
  let now = Date.parse('2026-11-03T10:00:00Z');
  await withPool(async (pool) => {
    const [a, b] = two(pool);
    const { topic } = pool.topic({ ...a, action: 'start', title: 'T' });
    const t = topic.topic_id;
    pool.post({ ...a, topic_id: t, content: 'GPT view' });
    pool.post({ ...b, topic_id: t, content: 'Claude view' });
    pool.read({ ...b, topic_id: t });
    const waiting = pool.wait({ ...b, topic_id: t, timeout_seconds: 10 });
    let people = pool.formatTopic(pool.topicRow(t)).participants;
    assert.deepEqual(people.map((p) => [p.agent, p.state]), [['GPT', 'active'], ['Claude', 'waiting']]);
    assert.equal(pool.online().find((s) => s.agent === 'Claude').state, 'waiting');
    assert.equal(pool.ownerAlerts().length, 0, 'not stuck while the last message is fresh');
    now += 3 * 60 * 1000;
    people = pool.formatTopic(pool.topicRow(t)).participants;
    assert.deepEqual(people.map((p) => p.state), ['away', 'waiting']);
    const stuck = pool.ownerAlerts().find((x) => x.kind === 'stuck');
    assert.equal(stuck.topic_id, t);
    assert.match(stuck.text, /Claude 在等回复，GPT 已离开/);
    pool.post({ ...a, topic_id: t, content: 'GPT is back' });
    const woke = await waiting;
    assert.equal(woke.messages.at(-1).content, 'GPT is back');
    assert.equal(pool.ownerAlerts().length, 0);
    assert.deepEqual(pool.formatTopic(pool.topicRow(t)).participants.map((p) => p.state), ['active', 'active'], 'leaving a wait counts as being seen');
  }, { now: () => now });
});

test('the hub wakes the phone only when what it should show changes', () => {
  const dir = workspace();
  const hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'host', origin: () => 'https://unit.example', getToken: () => 't' });
  try {
    const a = hub.pool.join({ agent: 'GPT', conversation: 'g' });
    const start = hub.version;
    hub.pool.post({ ...a, content: 'ordinary' });
    assert.equal(hub.version, start);
    hub.pool.post({ ...a, content: '主人，请看一下', mentions: ['主人'] });
    assert.equal(hub.version, start + 1);
    assert.equal(hub.status().poolAlerts[0].kind, 'ask');
    hub.pool.post({ ...a, content: 'another ordinary one' });
    assert.equal(hub.version, start + 1);
  } finally { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a pool database from 0.4.4 gains topics in place', () => {
  const dir = workspace();
  const file = path.join(dir, 'old.sqlite');
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, conversation TEXT NOT NULL, computer TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, replaced_by TEXT);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), type TEXT NOT NULL, content TEXT NOT NULL, reply_to INTEGER REFERENCES messages(seq), decision TEXT, client_message_id TEXT, created_at TEXT NOT NULL, UNIQUE(session_id,client_message_id));
      INSERT INTO sessions VALUES('s_old','h','GPT','','g','','2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z',NULL);
      INSERT INTO messages(session_id,type,content,created_at) VALUES('s_old','message','from 0.4.4','2026-11-03T00:00:00.000Z');`);
    db.close();
    const pool = new PublicPool(file);
    try {
      const a = pool.join({ agent: 'Claude', conversation: 'c' });
      const { topic } = pool.topic({ ...a, action: 'start', title: 'After upgrade' });
      pool.post({ ...a, topic_id: topic.topic_id, content: 'works' });
      const feed = pool.feed();
      assert.equal(feed.messages[0].content, 'from 0.4.4');
      assert.equal(feed.messages[0].topic_id, null);
      assert.equal(feed.topics[0].message_count, 2);
    } finally { pool.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invite text names the topic and the tools an AI needs', () => {
  const text = inviteText({ id: 7, title: '下一步' });
  for (const part of ['#7', '下一步', 'pool_join', 'topic_id=7', 'pool_wait', 'conclude']) assert.ok(text.includes(part), part);
});

test('over MCP and the phone API: owner starts a topic, an AI waits through a slow stream, the owner speaks', async () => {
  const dir = workspace();
  const token = 'discussion-test-token-0123456789';
  const hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'host', origin: () => 'https://unit.example', getToken: () => token });
  const server = createMcpServer({ name: 'host', getToken: () => token, auditFile: null, hub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const admin = { Authorization: 'Bearer ' + hub.state.adminKey, 'Content-Type': 'application/json' };
  const api = async (method, pathname, body) => {
    const res = await fetch(url + '/hub/api/' + pathname, { method, headers: admin, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const call = async (name, args) => {
    const res = await fetch(url + '/t/' + token + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    const value = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text);
    return { stream: text.startsWith(':'), isError: value.result.isError === true, body: (() => { try { return JSON.parse(value.result.content[0].text); } catch { return value.result.content[0].text; } })() };
  };
  try {
    const tools = (await (await fetch(url + '/t/' + token + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()).result.tools.map((t) => t.name);
    for (const name of ['pool_join', 'pool_topic', 'pool_read', 'pool_wait', 'pool_post', 'pool_ack']) assert.ok(tools.includes(name), name);
    assert.equal((await fetch(url + '/hub/api/pool/topics', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await api('POST', 'pool/topics', {})).status, 400);
    const started = await api('POST', 'pool/topics', { title: '下一步做什么', goal: '商量出方案' });
    assert.equal(started.status, 200);
    const t = started.body.topic.topic_id;
    assert.equal(started.body.topic.created_by.owner, true);
    const ai = (await call('pool_join', { agent: 'Claude', conversation: 'c' })).body;
    assert.equal(ai.open_topics[0].topic_id, t);
    const history = (await call('pool_read', { ...ai, topic_id: t })).body;
    assert.equal(history.messages[0].sender.owner, true);
    const waiting = call('pool_wait', { ...ai, topic_id: t, timeout_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const spoke = await api('POST', 'pool/messages', { topic_id: t, content: '主人：先做讨论模式' });
    assert.equal(spoke.status, 200);
    const woke = await waiting;
    assert.equal(woke.stream, true, 'a wait longer than five seconds is kept open as a stream');
    assert.equal(woke.body.woke_by, 'message');
    assert.equal(woke.body.messages[0].content, '主人：先做讨论模式');
    assert.equal(woke.body.messages[0].sender.owner, true);
    await call('pool_post', { ...ai, topic_id: t, type: 'proposal', content: '同意，方案如下……' });
    const concluded = await api('POST', `pool/topics/${t}/conclude`, { conclusion: '先做讨论模式' });
    assert.equal(concluded.body.topic.status, 'concluded');
    assert.equal(concluded.body.topic.concluded_by.owner, true);
    assert.equal((await call('pool_post', { ...ai, topic_id: t, content: 'late' })).isError, true);
    assert.equal((await api('POST', `pool/topics/${t}/reopen`)).body.topic.status, 'open');
    const feed = await api('GET', `pool?topic=${t}`);
    assert.deepEqual(feed.body.messages.map((m) => m.type), ['topic', 'message', 'proposal', 'result', 'message']);
    const overview = await api('GET', 'pool');
    assert.equal(overview.body.topics[0].topic_id, t);
    assert.equal((await api('GET', 'pool?topic=99')).status, 400);
    assert.equal((await api('GET', 'pool?topic=abc')).status, 400);
    assert.equal((await api('POST', 'pool/messages', { content: '' })).status, 400);
    assert.equal((await api('POST', 'pool/topics/99/conclude', { conclusion: 'x' })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
