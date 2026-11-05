import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Hub, parsePair } from '../src/hub.mjs';
import { joinHub, startNodeLink } from '../src/node-link.mjs';
import { createMcpServer } from '../src/server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-hub-'));
const TOKEN = 'hub-test-token-abcdefgh';
let hub;
let server;
let base;
let adminKey;
const links = [];

before(async () => {
  hub = new Hub({ file: path.join(dir, 'hub.json'), selfName: 'main', origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  adminKey = hub.state.adminKey;
  server = createMcpServer({ name: 'main', getToken: () => TOKEN, auditFile: null, hub });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const link of links) link.stop();
  hub.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(name, args) {
  const res = await fetch(`${base}/t/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

async function admin(pathname, method = 'GET', body = null) {
  return fetch(`${base}/hub/api/${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${adminKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function addComputer(name, execute) {
  const invite = await (await admin('invites', 'POST')).json();
  const joined = await joinHub({ origin: base, code: invite.code, name });
  links.push(startNodeLink({ origin: base, key: joined.key, execute }));
  for (let i = 0; i < 100 && !hub.isOnline(joined.id); i += 1) await new Promise((r) => { setTimeout(r, 20); });
  return joined;
}

test('pair text survives pasting and hand typing', () => {
  assert.deepEqual(parsePair(' cmcp://Hub.Example.com/ab23cd45 '), { origin: 'https://hub.example.com', code: 'AB23CD45' });
  assert.deepEqual(parsePair('hub.example.com AB23-CD45'), { origin: 'https://hub.example.com', code: 'AB23CD45' });
  assert.throws(() => parsePair('nonsense'));
});

test('a client with a cached tool list keeps working until a second computer joins', async () => {
  const result = await call('job', {});
  assert.equal(result.isError, undefined);
});

test('wrong codes are refused and a code works once', async () => {
  await assert.rejects(joinHub({ origin: base, code: 'WRONGCOD', name: 'x' }), /wrong, expired/);
  const invite = await (await admin('invites', 'POST')).json();
  const joined = await joinHub({ origin: base, code: invite.code, name: 'once' });
  await assert.rejects(joinHub({ origin: base, code: invite.code, name: 'twice' }), /wrong, expired/);
  assert.equal((await admin(`computers/${joined.id}`, 'DELETE')).status, 200);
});

test('management needs the admin key, not the MCP key or a computer key', async () => {
  const res = await fetch(`${base}/hub/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 401);
});


test('client tokens expose only selected tools and can be edited or revoked', async () => {
  const catalogResponse = await admin('token-tools');
  assert.equal(catalogResponse.status, 200);
  const catalog = (await catalogResponse.json()).tools.map((tool) => tool.name);
  assert.ok(catalog.includes('bash'));
  assert.ok(catalog.includes('read_file'));
  assert.ok(catalog.includes('write_file'));

  const createdResponse = await admin('tokens', 'POST', { name: 'Read only AI', tools: ['bash', 'read_file'] });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const key = created.key;
  const entry = created.token;
  assert.match(key, /^cmcp_[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(entry.tools, ['bash', 'read_file']);
  assert.ok(!JSON.stringify(await (await admin('tokens')).json()).includes(key));
  assert.ok(!JSON.stringify(hub.state.clientTokens).includes(key));

  const list = async (url, headers = {}) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const deniedAdmin = await fetch(base + '/hub/api/tokens', { headers: { Authorization: 'Bearer ' + key } });
  assert.equal(deniedAdmin.status, 401);
  const pathList = await (await list(base + '/t/' + key + '/mcp')).json();
  assert.deepEqual(pathList.result.tools.map((tool) => tool.name), ['bash', 'read_file']);
  const initialized = await fetch(base + '/t/' + key + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  });
  const instructions = (await initialized.json()).result.instructions;
  assert.match(instructions, /restricted tool set/);
  assert.doesNotMatch(instructions, /DURABLE TASKS/);
  const bearerList = await (await list(base + '/mcp', { Authorization: 'Bearer ' + key })).json();
  assert.deepEqual(bearerList.result.tools.map((tool) => tool.name), ['bash', 'read_file']);

  const forbidden = await fetch(base + '/t/' + key + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'never-created', content: 'no' } } }),
  });
  assert.equal((await forbidden.json()).error.code, -32601);

  const changed = await admin('tokens/' + entry.id, 'POST', { name: 'Limited editor', tools: ['bash', 'read_file', 'write_file'] });
  assert.equal(changed.status, 200);
  const expanded = await (await list(base + '/t/' + key + '/mcp')).json();
  assert.deepEqual(expanded.result.tools.map((tool) => tool.name), ['bash', 'read_file', 'write_file']);

  assert.equal((await admin('tokens/' + entry.id, 'DELETE')).status, 200);
  assert.equal((await list(base + '/t/' + key + '/mcp')).status, 404);
  const after = await (await admin('tokens')).json();
  assert.equal(after.tokens.some((token) => token.id === entry.id), false);
});

test('calls reach only the named computer, at the same time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  await addComputer('alpha', async (tool, args) => {
    seen.push(['alpha', tool, args]);
    await gate;
    return { text: 'from alpha' };
  });
  await addComputer('beta', async (tool, args) => {
    seen.push(['beta', tool, args]);
    return { text: 'from beta', image: { data: 'AAAA', mimeType: 'image/png' } };
  });

  const slow = call('bash', { computer: 'alpha', command: 'slow' });
  const fast = await call('ui_look', { computer: 'BETA' });
  assert.equal(fast.content[0].text, 'from beta');
  assert.equal(fast.content[1].data, 'AAAA');
  release();
  assert.equal((await slow).content[0].text, 'from alpha');
  assert.deepEqual(seen.find((entry) => entry[0] === 'alpha'), ['alpha', 'bash', { command: 'slow' }]);
});

test('the owner sees safe activity while a remote call is pending and after it finishes', async () => {
  let entered;
  let release;
  const pending = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const computer = await addComputer('activity-desk', async () => {
    entered();
    await gate;
    return { text: 'private command output', meta: { exit_code: 7 } };
  });

  const callResult = call('bash', { computer: 'ACTIVITY-DESK', command: 'rg private-search-term' });
  try {
    await pending;
    for (const key of [TOKEN, computer.key]) {
      const response = await fetch(`${base}/hub/api/activity`, { headers: { Authorization: `Bearer ${key}` } });
      assert.equal(response.status, 401);
    }
    const response = await admin('activity');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const feed = await response.json();
    assert.equal(feed.active.length, 1);
    assert.deepEqual(feed.active[0], {
      id: feed.active[0].id, computer: 'activity-desk', action: 'search', startedAt: feed.active[0].startedAt,
    });
    assert.ok(Number.isSafeInteger(feed.active[0].startedAt));
    assert.ok(!JSON.stringify(feed).includes('private-search-term'));

    release();
    assert.equal((await callResult).content[0].text, 'private command output');
    const finished = await (await admin('activity')).json();
    assert.deepEqual(finished.active, []);
    assert.deepEqual(finished.recent[0], {
      ...feed.active[0], status: 'failed', durationMs: finished.recent[0].durationMs,
    });
    assert.ok(finished.recent[0].durationMs >= 0);
    assert.ok(!JSON.stringify(finished).includes('private command output'));

    await call('bash', { computer: 'invalid-private-target', command: 'not run' });
    const rejected = await (await (await admin('activity')).json()).recent[0];
    assert.equal(rejected.computer, null);
    assert.equal(rejected.status, 'failed');

    await call('list_computers', {});
    const listed = (await (await admin('activity')).json()).recent[0];
    assert.equal(listed.action, 'list_computers');
    assert.equal(listed.computer, null);
    assert.equal(listed.status, 'succeeded');
  } finally {
    release();
    await callResult;
    await admin(`computers/${computer.id}`, 'DELETE');
  }
});

test('a missing or unknown computer runs nothing and names the choices', async () => {
  for (const args of [{}, { computer: 'gamma' }]) {
    const result = await call('bash', { ...args, command: 'echo hi' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /main, alpha, beta/);
  }
});

test('the AI and the phone both see the computers', async () => {
  const listed = JSON.parse((await call('list_computers', {})).content[0].text);
  assert.deepEqual(listed.computers.map((c) => c.name), ['main', 'alpha', 'beta']);
  assert.equal(listed.computers[1].online, true);
  const status = await (await admin('status')).json();
  assert.equal(status.mcp.full, `https://hub.example.com/t/${TOKEN}/mcp`);
  assert.equal(status.computers.length, 3);
});

test('tools list requires a computer on device tools, not hub-level coordination tools', async () => {
  const res = await fetch(`${base}/t/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const { tools } = (await res.json()).result;
  for (const tool of tools) {
    if (['list_computers', 'transfer', 'skill_list', 'skill_load', 'skill_read', 'skill_risk', 'task_create', 'task_list', 'task_get', 'task_claim', 'task_update', 'task_archive', 'task_unarchive', 'task_reopen', 'task_renew'].includes(tool.name)) continue;
    assert.ok(tool.inputSchema.required.includes('computer'), tool.name);
  }
  assert.ok(tools.some((tool) => tool.name === 'ui_act'));
});

test('the phone can see and operate a joined computer\'s browser, and the AI waits meanwhile', async () => {
  const seen = [];
  const joined = await addComputer('gamma', async (tool, args) => {
    seen.push(tool);
    if (tool === '_handoff_start' || tool === '_handoff_select') return { text: 'browser selected', hwnd: 77, title: 'Chrome - 验证' };
    if (tool === '_handoff_list') return { text: '2 windows', windows: [{ hwnd: 77, title: 'Chrome - 验证', automation: false }, { hwnd: 88, title: 'AI 的浏览器', automation: true }] };
    if (tool === '_handoff_frame') return { text: 'browser frame', image: { data: Buffer.from('jpeg-bytes').toString('base64'), mimeType: 'image/jpeg' } };
    if (tool === '_handoff_input') return { text: `did ${args.action} at ${args.x},${args.y} on ${args.hwnd}` };
    return { text: `ran ${tool}` };
  });
  // Nothing is grabbed until the person picks a window.
  const unpicked = await admin(`computers/${joined.id}/browser/frame`);
  assert.equal(unpicked.status, 409);
  assert.equal((await unpicked.json()).pick, true);
  const listed = await (await admin(`computers/${joined.id}/browser/windows`)).json();
  assert.deepEqual(listed.windows.map((w) => w.automation), [false, true]);
  const picked = await fetch(`${base}/hub/api/computers/${joined.id}/browser/select`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hwnd: 77 }),
  });
  assert.equal(picked.status, 200);
  const frame = await admin(`computers/${joined.id}/browser/frame`);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await frame.arrayBuffer()).toString(), 'jpeg-bytes');
  assert.equal(decodeURIComponent(frame.headers.get('x-window-title')), 'Chrome - 验证');

  const input = await fetch(`${base}/hub/api/computers/${joined.id}/browser/input`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'click', x: 0.5, y: 0.25, evil: 'ignored' }),
  });
  assert.equal(input.status, 200);
  assert.deepEqual(seen.slice(0, 4), ['_handoff_list', '_handoff_select', '_handoff_frame', '_handoff_input']);

  // The person just touched it, so the AI's clicks are held off.
  const blocked = await call('ui_act', { computer: 'gamma', action: 'click', target: 'OK' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /phone app/);
  assert.equal((await admin(`computers/${joined.id}/browser/finish`, 'POST')).status, 200);
  assert.equal((await call('ui_act', { computer: 'gamma', action: 'click', target: 'OK' })).content[0].text, 'ran ui_act');

  // An AI request shows in the app and blocks the AI until the person returns it.
  const asked = await call('request_human_takeover', { computer: 'gamma' });
  const requestId = /id: ([a-f0-9]+)/.exec(asked.content[0].text)[1];
  const status = await (await admin('status')).json();
  assert.deepEqual(status.computers.find((c) => c.name === 'gamma').takeover, { title: 'Chrome - 验证' });
  assert.match((await call('check_human_takeover', { computer: 'gamma', id: requestId })).content[0].text, /waiting/);
  assert.equal((await call('ui_act', { computer: 'gamma', action: 'click', target: 'OK' })).isError, true);
  await admin(`computers/${joined.id}/browser/finish`, 'POST');
  assert.match((await call('check_human_takeover', { computer: 'gamma', id: requestId })).content[0].text, /complete/);
  assert.equal((await (await admin('status')).json()).computers.find((c) => c.name === 'gamma').takeover, null);
});

test('a saved password is typed after the phone allows it, and the AI never sees it', async () => {
  const typed = [];
  await addComputer('delta', async (tool, args) => {
    typed.push([tool, args]);
    return { text: `typed into the field; it reads back as ${args.steps[0].text}` };
  });
  const before = (await (await admin('status')).json()).version;
  const waiting = call('type_secret', { computer: 'delta', secret: 'GitHub', part: 'password', target: 'Password', press_enter: true, reason: 'log in to push code' });

  // The phone's long poll wakes when the request appears.
  const woke = await (await admin(`wait?since=${before}`)).json();
  assert.notEqual(woke.version, before);
  const { secretRequests } = await (await admin('status')).json();
  assert.equal(secretRequests.length, 1);
  assert.deepEqual({ ...secretRequests[0], id: undefined }, { id: undefined, computer: 'delta', hint: 'GitHub', part: 'password', reason: 'log in to push code', where: 'field "Password"' });
  const answer = await fetch(`${base}/hub/api/secrets/${secretRequests[0].id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true, label: 'GitHub 工作号', username: 'me@example.com', password: 'hunter2-秘密' }),
  });
  assert.equal(answer.status, 200);

  const result = await waiting;
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(JSON.stringify(result), /hunter2/);
  assert.match(result.content[0].text, /GitHub 工作号/);
  assert.equal(typed[0][0], 'ui_act');
  assert.deepEqual(typed[0][1], { steps: [{ action: 'type', text: 'hunter2-秘密', target: 'Password', clear: true }, { action: 'key', keys: 'enter' }], observe: false });

  // Each fill needs its own approval, even for the same account.
  const userWait = call('type_secret', { computer: 'delta', secret: 'github', part: 'username' });
  let userRequest;
  for (let i = 0; i < 50 && !userRequest; i += 1) {
    userRequest = (await (await admin('status')).json()).secretRequests[0];
    if (!userRequest) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(userRequest);
  await fetch(`${base}/hub/api/secrets/${userRequest.id}`, { method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true, label: 'GitHub 工作号', username: 'me@example.com' }) });
  const user = await userWait;
  assert.doesNotMatch(JSON.stringify(user), /me@example\.com/);
  assert.equal(typed[1][1].steps[0].text, 'me@example.com');
  assert.deepEqual((await (await admin('status')).json()).secretRequests, []);
});

test('secret_list shows labels and usernames, never passwords', async () => {
  await addComputer('vault-list', async () => ({ text: 'ok' }));
  // Nothing is listed until the phone syncs its vault metadata.
  const empty = await call('secret_list', { computer: 'vault-list' });
  assert.match(empty.content[0].text, /No saved accounts/);
  // The phone syncs metadata only; a password smuggled into the sync is dropped.
  const synced = await admin('vault-meta', 'POST', { entries: [
    { id: 'a1', label: 'google1', username: 'alice@example.com', password: 'must-not-be-stored' },
    { id: 'a2', label: 'GitHub', username: 'me@example.com' },
  ] });
  assert.equal(synced.status, 200);
  const saved = await synced.json();
  assert.equal(JSON.stringify(saved).includes('must-not-be-stored'), false);
  assert.deepEqual(saved.accounts, [
    { id: 'a2', label: 'GitHub', username: 'me@example.com' },
    { id: 'a1', label: 'google1', username: 'alice@example.com' },
  ]);
  const listed = await call('secret_list', { computer: 'vault-list' });
  const { accounts } = JSON.parse(listed.content[0].text);
  assert.deepEqual(accounts, [
    { id: 'a2', label: 'GitHub', username: 'me@example.com' },
    { id: 'a1', label: 'google1', username: 'alice@example.com' },
  ]);
  assert.doesNotMatch(JSON.stringify(listed), /must-not-be-stored/);
  assert.equal((await (await admin('status')).json()).vaultAccounts, 2);
  // A later sync replaces the whole list, so deletions reach the hub too.
  await admin('vault-meta', 'POST', { entries: [{ id: 'a1', label: 'google1', username: 'alice@example.com' }] });
  const after = JSON.parse((await call('secret_list', { computer: 'vault-list' })).content[0].text);
  assert.deepEqual(after.accounts, [{ id: 'a1', label: 'google1', username: 'alice@example.com' }]);
  // Bad syncs are rejected, and the last good list stays.
  assert.equal((await admin('vault-meta', 'POST', { entries: 'nope' })).status, 400);
  assert.equal((await admin('vault-meta', 'POST', { entries: [{ id: 'x' }] })).status, 400);
  const kept = JSON.parse((await call('secret_list', { computer: 'vault-list' })).content[0].text);
  assert.deepEqual(kept.accounts, [{ id: 'a1', label: 'google1', username: 'alice@example.com' }]);
});

test('a declined secret runs nothing', async () => {
  const typed = [];
  await addComputer('epsilon', async (tool, args) => { typed.push(args); return { text: 'typed' }; });
  const waiting = call('type_secret', { computer: 'epsilon', secret: 'Bank', part: 'password' });
  let request;
  for (let i = 0; i < 50 && !request; i += 1) {
    request = (await (await admin('status')).json()).secretRequests[0];
    if (!request) await new Promise((r) => { setTimeout(r, 20); });
  }
  await fetch(`${base}/hub/api/secrets/${request.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: false }),
  });
  const result = await waiting;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /declined/);
  assert.deepEqual(typed, []);
});

test('a phone action on a covered browser brings it back once and retries', async () => {
  let inputs = 0;
  const seen = [];
  const joined = await addComputer('zeta', async (tool) => {
    seen.push(tool);
    if (tool === '_handoff_select') return { text: 'browser selected', hwnd: 5, title: 'Chrome' };
    if (tool === '_handoff_input') {
      inputs += 1;
      return inputs === 1 ? { text: 'browser lost focus; bring it to the front on the PC', isError: true } : { text: 'clicked' };
    }
    return { text: 'ok' };
  });
  const post = (path, body) => fetch(`${base}/hub/api/computers/${joined.id}/browser/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await post('select', { hwnd: 5 });
  assert.equal((await post('input', { action: 'click', x: 0.5, y: 0.5 })).status, 200);
  assert.deepEqual(seen, ['_handoff_select', '_handoff_input', '_handoff_select', '_handoff_input']);
  await post('finish', {});
});


test('takeover rejects unknown IDs and does not overwrite a pending request', async () => {
  const joined = await addComputer('takeover-review', async (tool) => tool === '_handoff_start' ? { text: 'selected', hwnd: 77, title: 'test' } : { text: 'ok' });
  const first = await call('request_human_takeover', { computer: 'takeover-review' });
  const id = /id: ([a-f0-9]+)/.exec(first.content[0].text)[1];
  assert.equal((await call('check_human_takeover', { computer: 'takeover-review', id: 'wrong' })).isError, true);
  assert.equal((await call('request_human_takeover', { computer: 'takeover-review' })).isError, true);
  await admin(`computers/${joined.id}/browser/finish`, 'POST');
  assert.match((await call('check_human_takeover', { computer: 'takeover-review', id })).content[0].text, /complete/);
  const next = await call('request_human_takeover', { computer: 'takeover-review' });
  const nextId = /id: ([a-f0-9]+)/.exec(next.content[0].text)[1];
  assert.match((await call('check_human_takeover', { computer: 'takeover-review', id })).content[0].text, /complete/);
  assert.match((await call('check_human_takeover', { computer: 'takeover-review', id: nextId })).content[0].text, /waiting/);
  await admin(`computers/${joined.id}/browser/finish`, 'POST');
});

test('each password fill requires its own approval even after another fill', async () => {
  const hub = new Hub({ state: { adminKey: 'a', computers: {}, invites: [] }, selfName: 'mock', origin: () => 'https://example.invalid', getToken: () => 'test' });
  try {
    const run = async () => ({ text: 'typed' });
    const first = hub.typeSecret({ self: true }, { secret: 'GitHub', part: 'username', window: 'login' }, run);
    hub.answerSecret([...hub.secretRequests.keys()][0], { approve: true, username: 'dummy', password: 'dummy' });
    await first;
    const second = hub.typeSecret({ self: true }, { secret: 'GitHub', part: 'password', window: 'other' }, run);
    const request = [...hub.secretRequests.keys()][0];
    assert.ok(request, 'second fill must require approval');
    hub.answerSecret(request, { approve: false });
    assert.equal((await second).isError, true);
  } finally { hub.close(); }
});


test('starting takeover blocks other control and parallel requests', async () => {
  const h = new Hub({ state: { adminKey: 'a', computers: {}, invites: [] }, selfName: 'mock', origin: () => 'https://example.invalid', getToken: () => 'test' });
  let finish;
  h.desktopOn = () => new Promise(resolve => { finish = resolve; });
  try {
    const first = h.takeover('request_human_takeover', { self: true });
    assert.equal(h.browserLocked('self'), true);
    assert.equal((await h.takeover('request_human_takeover', { self: true })).isError, true);
    finish({ text: 'ok', hwnd: 12, title: 'test' });
    await first;
  } finally { h.close(); }
});

test('password approval is not executed after takeover begins', async () => {
  const h = new Hub({ state: { adminKey: 'a', computers: {}, invites: [] }, selfName: 'mock', origin: () => 'https://example.invalid', getToken: () => 'test' });
  try {
    let called = false;
    const pending = h.typeSecret({ self: true }, { secret: 'test', part: 'password' }, async () => { called = true; return { text: 'typed' }; });
    h.browsers.set('self', { request: { state: 'waiting', created: Date.now() } });
    h.answerSecret([...h.secretRequests.keys()][0], { approve: true, password: 'fake' });
    assert.equal((await pending).isError, true);
    assert.equal(called, false);
  } finally { h.close(); }
});


test('list_computers summaries obey memory_read and task_list token scopes', async (t) => {
  const scopedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-scoped-summary-'));
  const scopedHub = new Hub({
    file: path.join(scopedDir, 'hub.json'),
    selfName: 'scoped-main',
    origin: () => 'https://hub.example.com',
    getToken: () => 'scoped-master-token',
  });
  const scopedMemory = {
    banner: () => ({ owner_notes: [{ text: 'PRIVATE_MEMORY_SENTINEL' }] }),
    instructionsBlock: () => 'memory instructions',
    tool: () => ({ text: 'unused' }),
  };
  const scopedTasks = {
    list: () => ({ tasks: [{
      id: 't_private', project: 'private-project', computer: 'scoped-main',
      status: 'active', goal: 'PRIVATE_TASK_SENTINEL', next: 'private next step',
      updated_at: '2026-11-04T00:00:00.000Z', recoverable: true, lease: null,
    }] }),
    tool: () => ({ text: 'unused' }),
  };
  const scopedServer = createMcpServer({
    name: 'scoped-main',
    getToken: () => 'scoped-master-token',
    auditFile: null,
    hub: scopedHub,
    memory: scopedMemory,
    tasksStore: scopedTasks,
  });
  await new Promise((resolve) => scopedServer.listen(0, '127.0.0.1', resolve));
  const scopedBase = 'http://127.0.0.1:' + scopedServer.address().port;
  const createToken = async (tools) => {
    const response = await fetch(scopedBase + '/hub/api/tokens', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + scopedHub.state.adminKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'scope test', tools }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).key;
  };
  const listComputers = async (key) => {
    const response = await fetch(scopedBase + '/t/' + key + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_computers', arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    const rpc = await response.json();
    assert.equal(rpc.error, undefined);
    return JSON.parse(rpc.result.content[0].text);
  };

  try {
    const restrictedKey = await createToken(['list_computers']);
    const restricted = await listComputers(restrictedKey);
    assert.ok(restricted.computers.some((computer) => computer.name === 'scoped-main'));
    assert.equal(Object.hasOwn(restricted, 'memory'), false);
    assert.equal(Object.hasOwn(restricted, 'tasks'), false);
    assert.doesNotMatch(JSON.stringify(restricted), /PRIVATE_MEMORY_SENTINEL|PRIVATE_TASK_SENTINEL/);

    const memoryOnlyKey = await createToken(['list_computers', 'memory_read']);
    const memoryOnly = await listComputers(memoryOnlyKey);
    assert.equal(memoryOnly.memory.owner_notes[0].text, 'PRIVATE_MEMORY_SENTINEL');
    assert.equal(Object.hasOwn(memoryOnly, 'tasks'), false);
    assert.doesNotMatch(JSON.stringify(memoryOnly), /PRIVATE_TASK_SENTINEL/);

    const tasksOnlyKey = await createToken(['list_computers', 'task_list']);
    const tasksOnly = await listComputers(tasksOnlyKey);
    assert.equal(Object.hasOwn(tasksOnly, 'memory'), false);
    assert.equal(tasksOnly.tasks.active[0].goal, 'PRIVATE_TASK_SENTINEL');
    assert.doesNotMatch(JSON.stringify(tasksOnly), /PRIVATE_MEMORY_SENTINEL/);

    const scopedKey = await createToken(['list_computers', 'memory_read', 'task_list']);
    const authorized = await listComputers(scopedKey);
    assert.equal(authorized.memory.owner_notes[0].text, 'PRIVATE_MEMORY_SENTINEL');
    assert.equal(authorized.tasks.active[0].goal, 'PRIVATE_TASK_SENTINEL');
  } finally {
    scopedServer.closeAllConnections();
    await new Promise((resolve) => scopedServer.close(resolve));
    scopedHub.close();
    fs.rmSync(scopedDir, { recursive: true, force: true });
  }
});
