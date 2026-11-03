#!/usr/bin/env node
// Account-free, disposable browser handoff; starts its own localhost MCP server
// and a Cloudflare Quick Tunnel, without touching existing MCP instances.
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { createMcpServer } from '../src/server.mjs';
import { stopDesktop } from '../src/desktop.mjs';
import { ensureCloudflared } from '../src/tunnel.mjs';
import { spawnQuickTunnel, waitForQuickUrl } from '../src/quick.mjs';

const flags = process.argv.slice(2);
const value = (name) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
};
const proxy = value('--proxy');
const name = value('--name') || os.hostname();
const token = randomBytes(32).toString('base64url');
let publicOrigin = null;
let cloudflared = null;
let closed = false;
let timer = null;
let watcher = null;
let id = null;
const server = createMcpServer({ name, getToken: () => token, auditFile: null, allowSse: false, publicOrigin: () => publicOrigin });
const shutdown = async () => {
  if (closed) return;
  closed = true;
  if (timer) clearTimeout(timer);
  if (watcher) clearInterval(watcher);
  if (cloudflared) { cloudflared.removeAllListeners('exit'); cloudflared.kill(); }
  stopDesktop();
  await new Promise(resolve => server.close(resolve));
};
process.once('SIGINT', () => { shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
async function rpc(method, params) {
  const port = server.address().port;
  const res = await fetch('http://127.0.0.1:' + port + '/t/' + token + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error('local MCP request failed (' + res.status + ')');
  return (await res.json()).result;
}
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const executable = ensureCloudflared({ proxy });
  cloudflared = spawnQuickTunnel({ cloudflared: executable, port: server.address().port, proxy });
  publicOrigin = await waitForQuickUrl(cloudflared, 50000);
  const created = await rpc('tools/call', { name: 'request_human_takeover', arguments: {} });
  if (created.isError) throw new Error(created.content?.[0]?.text || 'could not select browser');
  const msg = created.content[0].text;
  const url = /https:\/\/[^\s]+\/handoff#key=[A-Za-z0-9_-]+/.exec(msg)?.[0];
  id = /^id: ([a-f0-9]+)/m.exec(msg)?.[1];
  if (!url || !id) throw new Error('invalid takeover response');
  console.log('--- Browser takeover link (expires after 15 minutes) ---');
  console.log(url);
  console.log('--- Open on a phone, complete verification, then tap Return to AI ---');
  console.log('The tunnel closes automatically after handoff or expiry; Ctrl+C also closes it.');
  timer = setTimeout(() => { shutdown().then(() => process.exit(0)); }, 16 * 60 * 1000);
  watcher = setInterval(async () => {
    if (closed) return;
    try {
      const reply = await rpc('tools/call', { name: 'check_human_takeover', arguments: { id } });
      if (/\b(complete|expired|cancelled)\b/.test(reply.content?.[0]?.text || '')) {
        console.log('Handoff finished. Closing temporary tunnel.');
        await shutdown();
        process.exit(0);
      }
    } catch (e) { console.error('Handoff status check failed: ' + e.message); }
  }, 3000);
  cloudflared.once('exit', async code => {
    if (closed) return;
    console.error('Temporary tunnel disconnected (' + code + ')');
    await shutdown(); process.exit(1);
  });
} catch (err) {
  console.error('Browser takeover startup failed: ' + err.message);
  await shutdown();
  process.exitCode = 1;
}
