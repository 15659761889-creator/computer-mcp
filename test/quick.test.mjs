import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createMcpServer } from '../src/server.mjs';
import { extractQuickUrl, waitForQuickUrl } from '../src/quick.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('quick: recognize only Cloudflare random subdomains', () => {
  assert.equal(extractQuickUrl('Started https://quiet-stone.trycloudflare.com and waiting'), 'https://quiet-stone.trycloudflare.com');
  assert.equal(extractQuickUrl('https://example.com'), null);
  assert.equal(extractQuickUrl('https://trycloudflare.com'), null);
});

test('quick: find the generated URL across output chunks', async () => {
  const child = fakeChild();
  const ready = waitForQuickUrl(child, 3000);
  child.stderr.write('2026-11-02 INFO Visit https://abc-');
  child.stdout.write('def.trycloudflare.com now\n');
  assert.equal(await ready, 'https://abc-def.trycloudflare.com');
  child.stdout.end();
  child.stderr.end();
});

test('quick: reject when cloudflared exits before URL appears', async () => {
  const child = fakeChild();
  const ready = waitForQuickUrl(child, 3000);
  child.stderr.write('failed to connect');
  child.emit('exit', 1);
  await assert.rejects(ready, /failed to connect/);
  child.stdout.end();
  child.stderr.end();
});

test('quick: keep HTTP JSON responses, no SSE for slow tool calls', async () => {
  const server = createMcpServer({ name: 'quick-test', getToken: () => 'test-secret', auditFile: null, allowSse: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/t/test-secret/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'bash', arguments: { command: 'sleep 6; echo quick' } } }),
    });
    assert.match(res.headers.get('content-type'), /application\/json/);
    const data = await res.json();
    assert.equal(data.id, 2);
    assert.match(data.result.content[0].text, /quick/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
