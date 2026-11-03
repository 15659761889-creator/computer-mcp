import fs from 'node:fs';
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

export function newToken() {
  return randomBytes(32).toString('base64url');
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
  if (!config) throw new Error('not set up yet; run: computer-mcp setup <name> --domain <your-domain>');
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
