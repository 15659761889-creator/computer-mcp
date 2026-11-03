import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer } from '../src/server.mjs';
import { HandoffManager } from '../src/handoff.mjs';

async function withServer(check) {
  const server = createMcpServer({ name: 'handoff-test', getToken: () => 'main-mcp-secret', auditFile: null, publicOrigin: () => 'https://unit-test.example' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await check('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('handoff page loads without exposing MCP credential and has strict browser headers', async () => {
  await withServer(async base => {
    const page = await fetch(base + '/handoff');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /人工接管/);
    assert.match(html, /交还给 AI/);
    assert.equal(html.includes('main-mcp-secret'), false);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const frame = await fetch(base + '/handoff/api/frame');
    assert.equal(frame.status, 401);
    const click = await fetch(base + '/handoff/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"click","x":0.5,"y":0.5}' });
    assert.equal(click.status, 401);
    const fake = await fetch(base + '/handoff/api/status', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(fake.status, 401);
  });
});
test('handoff manager session closes on finish and expires based on absolute and idle limits', () => {
  const m = new HandoffManager();
  assert.equal(m.locked(), false);
  m.session = { secret: 'x', state: 'waiting', deadline: Date.now() + 50000, lastAccess: Date.now() };
  assert.equal(m.locked(), true);
  m.session.lastAccess = Date.now() - 6 * 60 * 1000;
  assert.equal(m.locked(), false);
  assert.equal(m.status(), 'expired');
});
test('handoff unauthorized tools do not allocate sessions', async () => {
  await withServer(async base => {
    const req = await fetch(base + '/t/main-mcp-secret/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'check_human_takeover',arguments:{id:'fake'}} })
    });
    const reply = await req.json();
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /unknown session/);
  });
});
