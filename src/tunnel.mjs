import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, logDir } from './config.mjs';

const IS_WINDOWS = process.platform === 'win32';
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export const tunnelNameFor = (name) => `computer-mcp-${name}`;
const credentialsPath = () => path.join(homeDir(), 'tunnel-credentials.json');
export const tunnelConfigPath = () => path.join(homeDir(), 'tunnel.yml');
export const tunnelLogPath = () => path.join(logDir(), 'cloudflared.log');

function proxyEnv(proxy) {
  return proxy ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : process.env;
}

function run(exe, args, { proxy, stdio = 'pipe' } = {}) {
  const result = spawnSync(exe, args, { encoding: 'utf8', env: proxyEnv(proxy), windowsHide: true, stdio });
  if (result.error) throw new Error(`could not run ${path.basename(exe)}: ${result.error.message}`);
  return result;
}

function bundledPath() {
  return path.join(homeDir(), 'bin', IS_WINDOWS ? 'cloudflared.exe' : 'cloudflared');
}

function onPath() {
  const result = spawnSync(IS_WINDOWS ? 'where.exe' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : null;
}

function downloadUrl() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!arch) throw new Error(`no cloudflared build for ${process.arch}; install it yourself and pass --cloudflared <path>`);
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  if (IS_WINDOWS) return `${base}/cloudflared-windows-${arch}.exe`;
  if (process.platform === 'darwin') return `${base}/cloudflared-darwin-${arch}.tgz`;
  return `${base}/cloudflared-linux-${arch}`;
}

// curl ships with every supported OS and, unlike fetch, honours the proxy settings.
export function ensureCloudflared({ explicit, proxy }) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`cloudflared not found at ${explicit}`);
    return explicit;
  }
  const existing = onPath() || (fs.existsSync(bundledPath()) ? bundledPath() : null);
  if (existing) return existing;

  const url = downloadUrl();
  const target = bundledPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`Downloading cloudflared from ${url}`);
  const isArchive = url.endsWith('.tgz');
  const download = `${target}.download${isArchive ? '.tgz' : ''}`;
  const curl = run('curl', ['-fL', '--retry', '3', '--connect-timeout', '20', '-o', download, url], { proxy, stdio: 'inherit' });
  if (curl.status !== 0) {
    fs.rmSync(download, { force: true });
    throw new Error('downloading cloudflared failed; if this network needs a proxy, retry with --proxy http://host:port');
  }
  if (isArchive) {
    const tar = run('tar', ['-xzf', download, '-C', path.dirname(target)]);
    fs.rmSync(download, { force: true });
    if (tar.status !== 0) throw new Error(`unpacking cloudflared failed: ${tar.stderr}`);
  } else {
    fs.renameSync(download, target);
  }
  if (!IS_WINDOWS) fs.chmodSync(target, 0o755);
  return target;
}

export function ensureCloudflareLogin(cloudflared, proxy) {
  if (fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'))) return;
  console.log('A browser window opens now: log in to Cloudflare and authorize your domain.');
  const login = run(cloudflared, ['tunnel', 'login'], { proxy, stdio: 'inherit' });
  if (login.status !== 0) throw new Error('Cloudflare login failed');
}

export function findNamedTunnel(tunnelListJson, tunnelName) {
  const tunnels = JSON.parse(tunnelListJson || '[]');
  return (Array.isArray(tunnels) ? tunnels : []).find((tunnel) => tunnel.name === tunnelName) || null;
}

function findTunnel(cloudflared, tunnelName, proxy) {
  const list = run(cloudflared, ['tunnel', 'list', '--output', 'json', '--name', tunnelName], { proxy });
  if (list.status !== 0) throw new Error(`could not list tunnels: ${list.stderr.trim()}`);
  return findNamedTunnel(list.stdout, tunnelName);
}

// Safe to repeat: an existing tunnel and DNS route are reused, so the link never changes.
export function ensureTunnel({ cloudflared, name, hostname, port, proxy }) {
  const tunnelName = tunnelNameFor(name);
  fs.mkdirSync(homeDir(), { recursive: true });
  const credentials = credentialsPath();
  let tunnel = findTunnel(cloudflared, tunnelName, proxy);
  if (!tunnel) {
    fs.rmSync(credentials, { force: true });
    const create = run(cloudflared, ['tunnel', 'create', '--credentials-file', credentials, '--output', 'json', tunnelName], { proxy });
    if (create.status !== 0) throw new Error(`could not create tunnel: ${create.stderr.trim()}`);
    tunnel = JSON.parse(create.stdout);
  } else if (!fs.existsSync(credentials)) {
    const token = run(cloudflared, ['tunnel', 'token', '--cred-file', credentials, tunnel.id], { proxy });
    if (token.status !== 0) throw new Error(`could not fetch tunnel credentials: ${token.stderr.trim()}`);
  }

  const route = run(cloudflared, ['tunnel', 'route', 'dns', tunnel.id, hostname], { proxy });
  const routeOutput = `${route.stdout}\n${route.stderr}`;
  if (route.status !== 0) {
    throw new Error(`could not point ${hostname} at the tunnel (nothing was overwritten): ${route.stderr.trim()}`);
  }
  // cloudflared appends the login certificate's zone to names outside it, and still exits 0.
  if (!routeOutput.includes(hostname) || routeOutput.includes(`${hostname}.`)) {
    throw new Error(`the Cloudflare login does not manage ${hostname}; cloudflared said: ${routeOutput.trim()}`);
  }

  const yaml = [
    `tunnel: ${tunnel.id}`,
    `credentials-file: '${credentials.replace(/\\/g, '/')}'`,
    // QUIC needs UDP, which many networks and proxies block.
    'protocol: http2',
    'loglevel: info',
    `logfile: '${tunnelLogPath().replace(/\\/g, '/')}'`,
    'no-autoupdate: true',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${port}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
  fs.writeFileSync(tunnelConfigPath(), yaml, { mode: 0o600 });
  return tunnel.id;
}

export function deleteTunnel({ cloudflared, name, proxy }) {
  const tunnelName = tunnelNameFor(name);
  if (!findTunnel(cloudflared, tunnelName, proxy)) return false;
  run(cloudflared, ['tunnel', 'cleanup', tunnelName], { proxy });
  const result = run(cloudflared, ['tunnel', 'delete', tunnelName], { proxy });
  if (result.status !== 0) throw new Error(`could not delete tunnel: ${result.stderr.trim()}`);
  fs.rmSync(credentialsPath(), { force: true });
  return true;
}

function rotateLog() {
  fs.mkdirSync(logDir(), { recursive: true });
  const log = tunnelLogPath();
  if (fs.existsSync(log) && fs.statSync(log).size > LOG_ROTATE_BYTES) fs.renameSync(log, `${log}.1`);
}

export function spawnTunnel(config) {
  rotateLog();
  return spawn(config.cloudflared, ['tunnel', '--config', tunnelConfigPath(), 'run', config.tunnelId], {
    env: proxyEnv(config.proxy),
    stdio: 'ignore',
    windowsHide: true,
  });
}

// Two clients because each fails on some machines: Windows curl's TLS can break behind a
// local proxy client, and fetch ignores proxy settings. Either one answering is proof.
export async function checkPublic(hostname, proxy) {
  try {
    const res = await fetch(`https://${hostname}/healthz`, { signal: AbortSignal.timeout(10000) });
    if (res.ok && (await res.text()).includes('computer-mcp')) return true;
  } catch {
    // Fall through to curl.
  }
  const result = spawnSync('curl', ['-fsS', '-m', '10', `https://${hostname}/healthz`], {
    encoding: 'utf8',
    env: proxyEnv(proxy),
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.includes('computer-mcp');
}
