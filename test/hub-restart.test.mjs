import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.mjs';
import { joinHub, startNodeLink } from '../src/node-link.mjs';
import { createMcpServer } from '../src/server.mjs';

const TOKEN = 'hub-restart-token-abcdefgh';

async function serve(file, port = 0) {
  const hub = new Hub({ file, selfName: null, origin: () => 'https://hub.example.com', getToken: () => TOKEN });
  hub.state.license = { keyHash: '0'.repeat(64), plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString(), verifiedAt: new Date().toISOString() };
  hub.save();
  const server = createMcpServer({ name: 'relay', getToken: () => TOKEN, auditFile: null, hub });
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  return { hub, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop({ hub, server }) {
  hub.close();
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
}

async function call(base, name, args) {
  const res = await fetch(`${base}/t/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

async function waitOnline(hub, id) {
  for (let i = 0; i < 300 && !hub.isOnline(id); i += 1) await new Promise((r) => { setTimeout(r, 20); });
  assert.ok(hub.isOnline(id), 'the computer came back online');
}

// The node remembers call ids it has run. A restarted hub that counted from 1 again reused
// them, and the node skipped those calls silently, so they hung until the client gave up.
test('calls still run after the hub restarts while the computer stays connected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-hub-restart-'));
  const file = path.join(dir, 'hub.json');
  let first = await serve(file);
  const { port } = first.server.address();
  const invite = first.hub.createInvite();
  const joined = await joinHub({ origin: first.base, code: invite.code, name: 'alpha' });
  const ran = [];
  const link = startNodeLink({ origin: first.base, key: joined.key, execute: async (tool, args) => { ran.push(args.command); return { text: `ran ${args.command}` }; } });
  try {
    await waitOnline(first.hub, joined.id);
    for (const command of ['a', 'b', 'c']) {
      assert.equal((await call(first.base, 'bash', { computer: 'alpha', command })).content[0].text, `ran ${command}`);
    }
    await stop(first);
    first = await serve(file, port);
    await waitOnline(first.hub, joined.id);
    const after = await Promise.race([
      call(first.base, 'bash', { computer: 'alpha', command: 'd' }),
      new Promise((resolve) => { setTimeout(() => resolve({ content: [{ text: 'hung' }] }), 5000); }),
    ]);
    assert.equal(after.content[0].text, 'ran d');
    assert.deepEqual(ran, ['a', 'b', 'c', 'd']);
  } finally {
    link.stop();
    await stop(first);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
