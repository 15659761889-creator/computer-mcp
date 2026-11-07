import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.mjs';
import { securePrivateFile, writePrivateFile } from './private-file.mjs';

export const quickLinkPath = () => path.join(homeDir(), 'quick-link.json');

export function copyToClipboard(value) {
  const command = process.platform === 'win32' ? ['clip.exe', []]
    : process.platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
  const result = spawnSync(command[0], command[1], { input: value, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`could not copy text using ${command[0]}`);
}

export function connectionParts(origin, token) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) {
    throw new Error('connection address must be an HTTPS origin');
  }
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token || '')) throw new Error('connection secret is invalid');
  const base = parsed.origin;
  return { full: `${base}/t/${token}/mcp`, address: `${base}/mcp`, key: token };
}

export function saveQuickLink({ origin, token, port }) {
  connectionParts(origin, token);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid quick tunnel port');
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const target = quickLinkPath();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writePrivateFile(temp, JSON.stringify({ origin, token, port, pid: process.pid }), { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function clearQuickLink(pid = process.pid) {
  try {
    securePrivateFile(quickLinkPath());
    const state = JSON.parse(fs.readFileSync(quickLinkPath(), 'utf8'));
    if (state.pid === pid) fs.rmSync(quickLinkPath(), { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
}

export async function getQuickLink() {
  let state;
  try {
    securePrivateFile(quickLinkPath());
    state = JSON.parse(fs.readFileSync(quickLinkPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
  if (!state || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
      || typeof state.origin !== 'string' || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(state.origin)) return null;
  try {
    const parts = connectionParts(state.origin, state.token);
    // Don't return an old secret after a restart; verify against the live loopback server.
    const reply = await fetch(`http://127.0.0.1:${state.port}/t/${parts.key}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      signal: AbortSignal.timeout(2000),
    });
    return reply.ok ? parts : null;
  } catch {
    return null;
  }
}
