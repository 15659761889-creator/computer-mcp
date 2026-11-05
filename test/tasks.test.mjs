import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TaskStore } from '../src/tasks.mjs';
import { createMcpServer, leaseRenewalExpired } from '../src/server.mjs';
import { Hub } from '../src/hub.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-task-'));
  let now = Date.UTC(2026, 10, 4, 18, 0);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new TaskStore({ dir: path.join(dir, 'tasks'), now: () => now }),
    advance: ms => { now += ms; } };
}
function create(store) {
  return store.create({ project: 'campus', computer: 'pc-test',
    goal: 'Build a playable campus and verify the camera follows the player.',
    steps: ['Check game source', 'Fix camera', 'Run playable validation'],
    next: 'Inspect Git status and game project README.' }).task;
}

test('survives a vanished AI with plan, durable checkpoint, exact next step and files', t => {
  const { store, advance, dir } = fixture(t);
  const start = create(store);
  const claimed = store.claim({ id: start.id, actor: 'gpt-6:old-chat' });
  assert.equal(claimed.task.lease.holder, 'gpt-6:old-chat');
  store.update({ id: start.id, lease_token: claimed.lease_token, step_index: 0,
    step_status: 'done', evidence: 'git status clean at rev abc123',
    summary: 'Game source checked, camera bug still present.',
    next: 'Open scenes/main.tscn; inspect camera follow script.',
    files: ['C:/games/campus/scenes/main.tscn'] });
  const fresh = new TaskStore({ dir: path.join(dir, 'tasks'), now: () => Date.UTC(2026, 10, 4, 18, 0) });
  assert.equal(fresh.get({ id: start.id }).task.steps[0].status, 'done');
  assert.equal(fresh.get({ id: start.id }).task.next, 'Open scenes/main.tscn; inspect camera follow script.');
  assert.deepEqual(fresh.get({ id: start.id }).task.files, ['C:/games/campus/scenes/main.tscn']);
  assert.equal(fresh.list({ project: 'campus' }).tasks[0].recoverable, false);
  advance(16 * 60_000);
  assert.equal(store.get({ id: start.id }).task.recoverable, true);
  const next = store.claim({ id: start.id, actor: 'claude:new-chat' });
  assert.equal(next.task.last_actor, 'claude:new-chat');
  assert.equal(next.task.steps[0].evidence, 'git status clean at rev abc123');
  assert.throws(() => store.update({ id: start.id, lease_token: claimed.lease_token, summary: 'stale overwrite' }), /held by another AI/);
  store.update({ id: start.id, lease_token: next.lease_token, step_index: 1,
    step_status: 'done', status: 'paused', next: 'Run game and verify on GPU.' });
  assert.equal(store.get({ id: start.id }).task.recoverable, true);
});

test('refuses stealing another active AI lease, stale revisions and credentials', t => {
  const { store } = fixture(t);
  const created = create(store);
  const owned = store.claim({ id: created.id, actor: 'agent-one' });
  assert.throws(() => store.claim({ id: created.id, actor: 'agent-two' }), /held by agent-one/);
  assert.throws(() => store.update({ id: created.id, lease_token: 'wrong', summary: 'fake' }), /missing, expired or held/);
  assert.throws(() => store.update({ id: created.id, lease_token: owned.lease_token, if_rev: 1, summary: 'bad' }), /changed since revision/);
  assert.throws(() => store.update({ id: created.id, lease_token: owned.lease_token, summary: 'Bearer secret-that-must-not-be-saved' }), /credential/);
  assert.equal(store.get({ id: created.id }).task.summary, '');
});

test('explicit task-linked actions create content-free activity breadcrumbs and refresh lease', t => {
  const { store, advance, dir } = fixture(t);
  const id = create(store).id;
  const owned = store.claim({ id, actor: 'gpt6:one' });
  advance(14 * 60_000);
  store.recordAction(id, owned.lease_token, { tool: 'write_file', computer: 'pc-test', status: 'succeeded', duration_ms: 78 });
  advance(14 * 60_000);
  assert.equal(store.get({ id }).task.recoverable, false);
  assert.equal(store.get({ id }).task.events.at(-1).tool, 'write_file');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'tasks', id + '.json'), 'utf8'), new RegExp(owned.lease_token));
  assert.equal(store.get({ id }).task.rev, owned.task.rev);
});

test('authenticated MCP exposes task APIs and refuses unclaimed computer actions', async t => {
  const { store, dir } = fixture(t);
  const token = 'task-mcp-e2e-test-secret';
  const hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'pc-test',
    origin: () => 'https://example.invalid', getToken: () => token });
  const server = createMcpServer({ name: 'pc-test', getToken: () => token, hub, tasksStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    hub.close();
    server.closeAllConnections();
    server.close();
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  async function rpc(method, params) {
    const res = await fetch(endpoint, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(res.status, 200);
    return (await res.json()).result;
  }
  async function invoke(name, args) {
    const out = await rpc('tools/call', { name, arguments: args });
    return { error: !!out.isError, value: out.content[0].text };
  }
  const init = await rpc('initialize', { protocolVersion: '2025-11-25' });
  assert.match(init.instructions, /task_list/);
  const tools = (await rpc('tools/list')).tools;
  for (const name of ['task_create', 'task_list', 'task_get', 'task_claim', 'task_update'])
    assert.ok(tools.some(t => t.name === name), `missing ${name}`);
  const bash = tools.find(t => t.name === 'bash');
  assert.ok(bash.inputSchema.properties.task_id);
  assert.ok(bash.inputSchema.properties.task_lease);

  const created = JSON.parse((await invoke('task_create', {
    goal: 'Test durable resume on pc-test', steps: ['Create a file', 'Confirm file'], project: 'test-task'
  })).value).task;
  const discovery = JSON.parse((await invoke('list_computers', {})).value);
  assert.ok(discovery.tasks.active.some(t => t.id === created.id), 'entrypoint should advertise unfinished durable tasks');
  const blockedFile = path.join(dir, 'blocked.txt');
  const unauthorized = await invoke('write_file', {
    computer: 'pc-test', path: blockedFile, content: 'should-not-exist',
    task_id: created.id, task_lease: 'not-my-lease',
  });
  assert.equal(unauthorized.error, true);
  assert.equal(fs.existsSync(blockedFile), false);

  const claimed = JSON.parse((await invoke('task_claim', { id: created.id, actor: 'gpt6:integration' })).value);
  const file = path.join(dir, 'tracked.txt');
  const write = await invoke('write_file', {
    computer: 'pc-test', path: file, content: 'verified',
    task_id: created.id, task_lease: claimed.lease_token,
  });
  assert.equal(write.error, false, write.value);
  assert.equal(fs.readFileSync(file, 'utf8'), 'verified');
  const checkpoint = await invoke('task_update', {
    id: created.id, lease_token: claimed.lease_token, step_index: 0, step_status: 'done',
    evidence: 'tracked.txt read back successfully',
    next: 'Verify the file and mark the task done',
  });
  assert.equal(checkpoint.error, false, checkpoint.value);
  const resumed = JSON.parse((await invoke('task_get', { id: created.id })).value).task;
  assert.equal(resumed.steps[0].status, 'done');
  assert.ok(resumed.events.some(e => e.kind === 'tool' && e.tool === 'write_file'));
  assert.equal(resumed.next, 'Verify the file and mark the task done');
  assert.equal(resumed.lease.hash, undefined);
  const finished = await invoke('task_update', { id: created.id, lease_token: claimed.lease_token, status: 'done', summary: 'Verified.' });
  assert.equal(finished.error, false);
  assert.equal(JSON.parse((await invoke('task_list', {})).value).tasks[0].status, 'done');
});

test('task limits and path validation prevent accidental storage traversal', t => {
  const { store, dir } = fixture(t);
  assert.throws(() => store.get({ id: '../secret' }), /Invalid task id/);
  assert.throws(() => store.create({ goal: 'x', project: 'UPPER' }), /project must/);
  assert.throws(() => store.create({ goal: 'x', steps: Array.from({ length: 41 }, (_, i) => String(i)) }), /at most 40/);
  assert.equal(fs.existsSync(path.join(dir, 'secret')), false);
});

test('archive hides a task from the limit and list, unarchive restores it', t => {
  const { store } = fixture(t);
  const created = create(store);
  const owned = store.claim({ id: created.id, actor: 'agent-one' });
  assert.throws(() => store.archive({ id: created.id, lease_token: 'wrong' }), /held by agent-one/);
  const archived = store.archive({ id: created.id, lease_token: owned.lease_token });
  assert.equal(archived.task.archived, true);
  assert.equal(store.list({}).count, 0);
  assert.equal(store.list({ include_archived: true }).count, 1);
  assert.throws(() => store.claim({ id: created.id, actor: 'agent-two' }), /archived/);
  const restored = store.unarchive({ id: created.id });
  assert.equal(restored.task.archived, false);
  assert.equal(store.list({}).count, 1);
  assert.equal(store.claim({ id: created.id, actor: 'agent-two' }).task.lease.holder, 'agent-two');
});

test('reopen turns a done task back into claimable work', t => {
  const { store } = fixture(t);
  const created = create(store);
  const owned = store.claim({ id: created.id, actor: 'agent-one' });
  store.update({ id: created.id, lease_token: owned.lease_token, status: 'done', summary: 'Done.' });
  assert.equal(store.get({ id: created.id }).task.status, 'done');
  assert.throws(() => store.claim({ id: created.id, actor: 'agent-two' }), /reopen/);
  const reopened = store.reopen({ id: created.id });
  assert.equal(reopened.task.status, 'active');
  assert.equal(store.claim({ id: created.id, actor: 'agent-two' }).task.lease.holder, 'agent-two');
  assert.throws(() => store.reopen({ id: created.id }), /Only a done task/);
});

test('renew extends the lease up to 60 minutes', t => {
  const { store, advance } = fixture(t);
  const created = create(store);
  const owned = store.claim({ id: created.id, actor: 'agent-one' });
  assert.throws(() => store.renew({ id: created.id, lease_token: owned.lease_token, minutes: 61 }), /between 1 and 60/);
  advance(14 * 60_000);
  const renewed = store.renew({ id: created.id, lease_token: owned.lease_token, minutes: 60 });
  assert.equal(renewed.task.recoverable, false);
  advance(30 * 60_000);
  assert.equal(store.get({ id: created.id }).task.recoverable, false);
  advance(31 * 60_000);
  assert.equal(store.get({ id: created.id }).task.recoverable, true);
});

test('unarchive refuses when the task limit is already full', t => {
  const { store } = fixture(t);
  const ids = [];
  for (let i = 0; i < 200; i++) ids.push(store.create({ goal: `filler task ${i}` }).task.id);
  assert.equal(store.archive({ id: ids[0] }).task.archived, true);
  store.create({ goal: 'one more after archiving' });
  assert.throws(() => store.unarchive({ id: ids[0] }), /Task limit of 200 reached/);
  assert.equal(store.get({ id: ids[0] }).task.archived, true);
});

test('lease auto-renewal stops after 65 minutes', () => {
  const started = Date.UTC(2026, 10, 5, 0, 0);
  assert.equal(leaseRenewalExpired(started, started + 65 * 60_000), false);
  assert.equal(leaseRenewalExpired(started, started + 65 * 60_000 + 1), true);
});

test('latestActivity returns the most recently changed task, or null when there are none', t => {
  const { store, advance } = fixture(t);
  assert.equal(store.latestActivity(), null);
  const first = create(store);
  assert.equal(store.latestActivity().id, first.id);
  assert.equal(store.latestActivity().status, 'open');
  advance(60_000);
  const second = store.create({ project: 'campus', computer: 'pc-test', goal: 'Second task', steps: ['One'], next: 'Do it.' }).task;
  assert.equal(store.latestActivity().id, second.id);
});

test('add_step appends a step and create refuses an exact duplicate goal', t => {
  const { store } = fixture(t);
  const created = create(store);
  const owned = store.claim({ id: created.id, actor: 'agent-one' });
  const updated = store.update({ id: created.id, lease_token: owned.lease_token, add_step: 'Verify on the phone' });
  assert.equal(updated.task.steps.length, 4);
  assert.equal(updated.task.steps[3].title, 'Verify on the phone');
  assert.equal(updated.task.steps[3].status, 'todo');
  assert.throws(() => store.create({ goal: 'Build a playable campus and verify the camera follows the player.' }), /already exists/);
});

