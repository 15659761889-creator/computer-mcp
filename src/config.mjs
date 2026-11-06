import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 8765;

export function homeDir() {
  if (process.env.COMPUTER_MCP_HOME) return process.env.COMPUTER_MCP_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'computer-mcp');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'computer-mcp');
}

export const configPath = () => path.join(homeDir(), 'config.json');
export const statePath = () => path.join(homeDir(), 'run.json');
export const logDir = () => path.join(homeDir(), 'logs');
export const memoryPath = () => path.join(homeDir(), 'memory.jsonl');

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function choosePort(requested) {
  if (requested) return requested;
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 100; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error('no free local port found; pass --port');
}

// Join file: the host pre-registers a computer and writes its credentials here;
// the owner then joins with `wanji join --file` (or the Windows manager offers it).
// The service never reads it on its own.
export const joinFilePath = () => path.join(homeDir(), 'join.json');

export function readJoinFileAt(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('加入文件无效：不是有效的 JSON');
  }
  const { origin, id, key, code, name } = parsed ?? {};
  // Either pre-registered credentials (id/key) or a one-use pairing code (the joiner EXE).
  const hasKey = typeof id === 'string' && id && typeof key === 'string' && key;
  const hasCode = typeof code === 'string' && code;
  if (typeof origin !== 'string' || !origin || (!hasKey && !hasCode)) {
    throw new Error('加入文件无效：缺少 origin/id/key');
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('加入文件无效：origin 不是合法的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('加入文件无效：origin 必须是 http:// 或 https:// 开头');
  }
  const wanted = typeof name === 'string' && name ? name : undefined;
  return hasKey ? { origin, id, key, name: wanted } : { origin, code, name: wanted };
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function requireConfig() {
  const config = loadConfig();
  if (!config) throw new Error('not set up yet; run: wanji setup <name> --domain <your-domain>');
  return config;
}

export function saveConfig(config) {
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

export function hostnameFor(name, domain) {
  // One label on purpose: Cloudflare's free certificate covers *.domain only.
  return `${name}-mcp.${domain}`;
}

export function publicLink(config) {
  return `https://${config.hostname}/t/${config.token}/mcp`;
}

// Re-reads the token only when the file changes, so `rotate` takes effect
// on the next request without restarting anything.
export function tokenReader() {
  let mtime = 0;
  let token = null;
  return () => {
    const stat = fs.statSync(configPath());
    if (stat.mtimeMs !== mtime) {
      token = loadConfig().token;
      mtime = stat.mtimeMs;
    }
    return token;
  };
}
