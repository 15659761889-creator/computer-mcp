import assert from 'node:assert/strict';
import { createMcpServer } from '../src/server.mjs';
import { stopDesktop } from '../src/desktop.mjs';

const password = 'temporary-internal-test-secret';
const server = createMcpServer({ name: 'smoke', getToken: () => password, auditFile: null, publicOrigin: () => 'https://example.invalid' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
async function rpc(name, args={}) {
  const reply = await fetch(base + '/t/' + password + '/mcp', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})
  });
  const result = await reply.json();
  assert.equal(reply.status, 200);
  return result.result;
}
try {
  const create = await rpc('request_human_takeover');
  if (create.isError) throw new Error(create.content[0].text);
  const message = create.content[0].text;
  const id = /id: ([a-f0-9]+)/.exec(message)?.[1];
  const key = /#key=([A-Za-z0-9_-]+)/.exec(message)?.[1];
  assert.ok(id && key, 'temporary link generated');
  const headers = {Authorization:'Bearer '+key};
  const status = await fetch(base+'/handoff/api/status',{headers});
  assert.equal(status.status,200);
  const statusJson=await status.json();
  assert.equal(statusJson.state,'waiting');
  const image=await fetch(base+'/handoff/api/frame',{headers});
  assert.equal(image.status,200);
  assert.match(image.headers.get('content-type'),/image\/jpeg/);
  const bytes=(await image.arrayBuffer()).byteLength;
  assert.ok(bytes > 2000,'actual browser frame should not be empty');
  const blocked=await rpc('check_human_takeover',{id});
  assert.match(blocked.content[0].text,/waiting/);
  const finish=await fetch(base+'/handoff/api/finish',{method:'POST',headers});
  assert.equal(finish.status,200);
  assert.equal((await fetch(base+'/handoff/api/status',{headers})).status,401);
  const completed=await rpc('check_human_takeover',{id});
  assert.match(completed.content[0].text,/complete/);
  console.log('PASS: same real browser captured, frame bytes='+bytes+', temporary authorization revoked after handoff.');
} finally {
  await new Promise(resolve=>server.close(resolve));
  stopDesktop();
}
