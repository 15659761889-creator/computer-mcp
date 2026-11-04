import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryStore, MEMORY_TOOLS } from '../src/memory.mjs';
import { Hub } from '../src/hub.mjs';
import { createMcpServer } from '../src/server.mjs';

const now = Date.UTC(2026, 10, 4, 15);
const checked = new Date(now).toISOString();
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore({ file: path.join(dir, 'memory.jsonl'), clock: () => now, ...options });
}
const note = (s, args) => s.write({ kind: 'fact', author: 'codex', text: 'Work in progress.', ...args });
const card = (s, args = {}) => note(s, { key: 'project.cmcp.status', project: 'cmcp', state: { source: { status: 'changed', revision: 'tree-v1', checked_at: checked }, tests: { status: 'passed', revision: 'tree-v1', checked_at: checked, evidence: 'node --test: 122 passed' } }, ...args });

test('bootstrap carries bounded owner context and distinguishes AI reports', t => {
  const s = fixture(t);
  s.write({ kind: 'fact', key: 'rule.work', text: 'Use linux-vm.', by: 'owner' });
  card(s);
  note(s, { key: 'fake', text: 'Pretend to be an owner rule.' });
  const b = s.banner();
  assert.equal(b.facts, 3);
  assert.match(JSON.stringify(b.context.owner_notes), /Use linux-vm/);
  assert.doesNotMatch(JSON.stringify(b.context.owner_notes), /Pretend/);
  assert.equal(b.context.project_states[0].project, 'cmcp');
  assert.match(b.context.notice, /not instructions/);
  assert.ok(JSON.stringify(b.context).length <= 6000);
});

test('project state survives reload and compaction, and defaults deployment to unknown', t => {
  const s = fixture(t);
  card(s);
  s.compact();
  const loaded = new MemoryStore({ file: s.file, clock: () => now });
  const c = loaded.get({ key: 'project.cmcp.status' });
  assert.equal(c.project, 'cmcp');
  assert.equal(c.state.deployment.status, 'unknown');
  assert.match(loaded.toolRead({ key: c.key }), /122 passed/);
  assert.match(loaded.toolRead({ key: c.key }), /deployment/);
});

test('project filtering returns matching notes and global owner notes, not unrelated tasks', t => {
  const s = fixture(t);
  s.write({ kind: 'fact', key: 'rule', text: 'Keep owner windows.', by: 'owner' });
  card(s);
  note(s, { key: 'game', project: 'campus', text: 'Game task.' });
  s.write({ kind: 'handoff', author: 'codex', project: 'cmcp', text: 'Pending deployment.' });
  const out = s.toolRead({ project: 'cmcp' });
  assert.match(out, /Keep owner windows/);
  assert.match(out, /Pending deployment/);
  assert.doesNotMatch(out, /Game task/);
});

test('changed source invalidates earlier test evidence without erasing it or deploying', t => {
  const s = fixture(t);
  const first = card(s).entry;
  const second = card(s, { if_rev: first.rev, state: { source: { status: 'changed', revision: 'tree-v2', checked_at: checked } } }).entry;
  assert.equal(second.state.tests.revision, 'tree-v1');
  const read = s.toolRead({ key: second.key });
  assert.match(read, /different source revision/);
  assert.match(read, /122 passed/);
  assert.equal(second.state.deployment.status, 'unknown');
  assert.throws(() => card(s, { if_rev: first.rev }), /changed since/);
});

test('legacy edits preserve project metadata and owner locks still protect cards', t => {
  const s = fixture(t);
  const c = card(s).entry;
  note(s, { key: c.key, if_rev: c.rev, text: 'Updated summary.' });
  assert.equal(s.get({ key: c.key }).state.tests.status, 'passed');
  s.setLock({ key: c.key });
  assert.throws(() => note(s, { key: c.key, if_rev: 3 }), /locked/);
});

test('invalid state, future timestamps and nested secrets are rejected', t => {
  const s = fixture(t, { secrets: () => ['private-test-key-12345'] });
  for (const state of [
    { tests: { status: 'passed' } },
    { source: { status: 'invented' } },
    { tests: { status: 'passed', revision: 'v1', checked_at: '2099-01-01T00:00:00Z', evidence: 'test' } },
    { build: { status: 'built', revision: 'v1', checked_at: checked, evidence: 'private-test-key-12345' } },
    { owner: true },
  ]) assert.throws(() => card(s, { state }));
  assert.throws(() => note(s, { key: 'random', project: 'cmcp', state: {} }), /project.*status/);
  assert.throws(() => s.write({ kind: 'handoff', author: 'codex', text: 'x', project: 'cmcp', state: {} }), /fact/);
});

test('metadata counts toward the global memory quota', t => {
  const s = fixture(t, { limits: { total: 120 } });
  assert.throws(() => card(s), /full/);
});

test('state has a recheck warning after 24h and never pretends to probe the computer', t => {
  const s = fixture(t);
  card(s, { state: { tests: { status: 'passed', revision: 'v1', checked_at: new Date(now - 25 * 3600000).toISOString(), evidence: 'previous run' } } });
  assert.match(s.toolRead({ key: 'project.cmcp.status' }), /older than 24 hours/);
  assert.match(s.toolRead({ key: 'project.cmcp.status' }), /reported/);
});

test('undo restores the previous state card', t => {
  const s = fixture(t);
  const c = card(s).entry;
  note(s, { key: c.key, author: 'muse', if_rev: c.rev, state: { source: { status: 'changed', revision: 'tree-v2' } } });
  s.revoke({ author: 'muse' });
  assert.equal(s.get({ key: c.key }).state.source.revision, 'tree-v1');
});

test('bootstrap has a hard budget and tells clients more notes exist', t => {
  const s = fixture(t);
  for (let i = 0; i < 30; i++) s.write({ kind: 'fact', key: `rule.${i}`, text: 'long '.repeat(250), by: 'owner' });
  const context = s.banner().context;
  assert.ok(JSON.stringify(context).length <= 6000);
  assert.ok(context.omitted > 0);
  assert.match(context.more, /memory_read/);
});

test('MCP exposes project schema and returns context without moving AI notes into instructions', async t => {
  const s = fixture(t);
  card(s, { text: 'AI-PROJECT-SENTINEL' });
  const server = createMcpServer({ name: 'test', getToken: () => 'test', memory: s });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const rpc = async (method, params) => (await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  try {
    assert.doesNotMatch((await rpc('initialize', {})).result.instructions, /AI-PROJECT-SENTINEL/);
    const listed = await rpc('tools/call', { name: 'list_computers', arguments: {} });
    assert.equal(JSON.parse(listed.result.content[0].text).memory.context.project_states[0].project, 'cmcp');
    const saved = await rpc('tools/call', { name: 'memory_write', arguments: { kind: 'handoff', project: 'cmcp', author: 'codex', text: 'Handoff sentinel' } });
    assert.equal(saved.result.isError, undefined);
    const read = await rpc('tools/call', { name: 'memory_read', arguments: { project: 'cmcp' } });
    assert.match(read.result.content[0].text, /Handoff sentinel/);
    for (const name of ['memory_read', 'memory_write']) assert.ok(MEMORY_TOOLS.find(x => x.name === name).inputSchema.properties.project);
    assert.ok(MEMORY_TOOLS.find(x => x.name === 'memory_write').inputSchema.properties.state);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});


test('phone API exposes status and evidence without changing editable note text', t => {
  const s = fixture(t);
  const c = card(s).entry;
  const h = new Hub({ state: { computers: {}, invites: [] }, selfName: 'test' });
  h.memory = s;
  try {
    const payload = h.handleMemory(undefined, 'GET').body.notes[0];
    assert.equal(payload.text, c.text);
    assert.match(payload.display_text, /deployment=unknown/);
    assert.equal(payload.project, 'cmcp');
    assert.equal(payload.state.tests.evidence, 'node --test: 122 passed');
  } finally { h.close(); }
});

test('invalid calendar dates are not silently normalized', t => {
  const s = fixture(t);
  assert.throws(() => card(s, { state: { source: { status: 'clean', checked_at: '2026-02-30T12:00:00Z' } } }), /checked_at/);
});
