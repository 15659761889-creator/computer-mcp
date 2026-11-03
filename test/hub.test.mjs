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

async function admin(pathname, method = 'GET') {
  return fetch(`${base}/hub/api/${pathname}`, { method, headers: { Authorization: `Bearer ${adminKey}` } });
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

test('tools list requires a computer on everything but list_computers', async () => {
  const res = await fetch(`${base}/t/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const { tools } = (await res.json()).result;
  for (const tool of tools) {
    if (tool.name === 'list_computers') continue;
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

  // The same approval covers the username, with no second question.
  const user = await call('type_secret', { computer: 'delta', secret: 'github', part: 'username' });
  assert.doesNotMatch(JSON.stringify(user), /me@example\.com/);
  assert.equal(typed[1][1].steps[0].text, 'me@example.com');
  assert.deepEqual((await (await admin('status')).json()).secretRequests, []);
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
