import { spawn } from 'node:child_process';
import os from 'node:os';
import { memoryPath, newToken } from './config.mjs';
import { clearQuickLink, connectionParts, copyToClipboard, saveQuickLink } from './link.mjs';
import { MemoryStore } from './memory.mjs';
import { createMcpServer } from './server.mjs';
import { ensureCloudflared } from './tunnel.mjs';

// Quick Tunnels are accountless and use a random URL that changes every launch.
// The MCP secret is independently generated for each session.
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export function extractQuickUrl(output) {
  return QUICK_URL.exec(output)?.[0] ?? null;
}

export function spawnQuickTunnel({ cloudflared, port, proxy }) {
  const env = proxy ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : process.env;
  return spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function waitForQuickUrl(child, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let text = '';
    let finished = false;
    const finish = (error, url) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(url);
    };
    const onData = (buffer) => {
      text = (text + buffer.toString('utf8')).slice(-8192);
      const url = extractQuickUrl(text);
      if (url) finish(null, url);
    };
    const onError = (error) => finish(new Error(`cloudflared failed to start: ${error.message}`));
    const onExit = (code) => finish(new Error(`cloudflared stopped before opening the tunnel (exit ${code}): ${text.slice(-800)}`));
    const timer = setTimeout(() => finish(new Error(`timed out waiting for the trycloudflare.com address; cloudflared output: ${text.slice(-800)}`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export async function runQuick({ port, name = os.hostname(), proxy, cloudflared: cloudflaredPath, copy = false }) {
  const cloudflared = ensureCloudflared({ explicit: cloudflaredPath, proxy });
  const token = newToken();
  let quickOrigin = null;
  // Notes outlive the temporary link, so they sit in the same file the fixed setup uses. A broken
  // notes file must not stop the tunnel, so memory is simply left off then.
  let memory = null;
  try {
    memory = new MemoryStore({ file: memoryPath(), secrets: () => [token] });
  } catch (err) {
    console.log(`Warning: shared memory is off: ${err.message}`);
  }
  const server = createMcpServer({ name, getToken: () => token, auditFile: null, allowSse: false, publicOrigin: () => quickOrigin, memory });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  let child;
  try {
    child = spawnQuickTunnel({ cloudflared, port, proxy });
    const url = await waitForQuickUrl(child);
    quickOrigin = url;
    saveQuickLink({ origin: url, token, port });
    console.log(`\n万机 quick tunnel is ready for "${name}".`);
    console.log(`MCP host: ${url} (the secret is hidden; run wanji link --quick to copy it)`);
    console.log('Temporary address: changes on restart. Keep this terminal open; Ctrl+C to stop.');
    console.log('Quick Tunnels do not support SSE; long-running calls may time out. Use bash background:true for long jobs.');
    console.log('Open another terminal and run: wanji link --quick');
    console.log('Copy separately: wanji link --quick --address --copy or --key --copy.\n');
    if (copy) {
      try {
        copyToClipboard(connectionParts(url, token).full);
        console.log('Complete temporary MCP link copied to clipboard.');
      } catch (err) { console.log(`Warning: could not copy link: ${err.message}`); }
    }
  } catch (error) {
    child?.kill();
    clearQuickLink();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  let stopping = false;
  try {
    await new Promise((resolve) => {
      const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill();
      server.close(() => resolve());
    };
    const onExit = (code) => {
      if (!stopping) {
        console.error(`Cloudflare temporary tunnel disconnected (exit ${code}). Run wanji quick to obtain a new link.`);
        process.exitCode = 1;
        stopping = true;
        server.close(() => resolve());
      }
    };
    process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      child.once('exit', onExit);
    });
  } finally {
    clearQuickLink();
  }
}
