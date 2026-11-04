import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, loadConfig, logDir, requireConfig, saveConfig, statePath, tokenReader } from './config.mjs';
import { BROWSER_METHODS, Hub, hubPath } from './hub.mjs';
import { startNodeLink } from './node-link.mjs';
import { auditLogger, createMcpServer } from './server.mjs';
import { callTool, hasTool, summarizeArgs } from './tools.mjs';
import { callDesktop, desktopSupported, stopDesktop, warmDesktop } from './desktop.mjs';
import { cleanWorkDir } from './shell.mjs';
import { LAN_PORT, allowThroughFirewall, lanAddresses, startDiscovery, startLanServer } from './lan.mjs';
import { Transfers, handleXferLan, isXferTool, runXfer, transfersFile, xferPsk } from './transfer.mjs';
import { spawnTunnel, tunnelConfigPath } from './tunnel.mjs';
import {
  installLinuxAutostart, linuxAutostartState, removeLinuxAutostart, startLinuxService, stopLinuxService,
} from './autostart-linux.mjs';

const IS_WINDOWS = process.platform === 'win32';
const TASK_NAME = 'ComputerMCP';
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function commandLineOf(pid) {
  if (!pid) return null;
  if (IS_WINDOWS) {
    const result = powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`);
    return result.stdout.trim() || null;
  }
  const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return result.stdout.trim() || null;
}

// PIDs get reused, so a process is only killed if its command line proves it is ours.
function killIfOurs(pid, marker) {
  const commandLine = commandLineOf(pid);
  if (!commandLine?.includes(marker)) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state));
}

// Opens this machine's LAN port: the main computer serves its computers' polling there, and every
// computer serves direct file copies. config.lan = false keeps it closed.
async function openLan(config, { pskFor, handle, findMe }) {
  if (config.lan === false) return null;
  const log = (line) => console.log(line);
  // Never the MCP port: Windows lets a wildcard bind shadow it instead of failing.
  let wanted = config.lanPort || LAN_PORT;
  if (wanted === config.port) wanted += 2;
  const server = await startLanServer({ port: wanted, pskFor, handle, log });
  if (!server) return null;
  const { port } = server.address();
  console.log(`LAN port ${port} open on ${lanAddresses().join(', ') || 'no network yet'}; firewall: ${allowThroughFirewall(port)}`);
  if (findMe) startDiscovery({ answer: (message) => (findMe(message) ? { port } : null), log });
  return { port, addrs: lanAddresses, server };
}

// Keeps what the main computer last said about routes, so a LAN-only computer still knows after a restart.
function rememberSettings(changed) {
  const config = loadConfig();
  if (!config?.joined) return;
  saveConfig({ ...config, joined: { ...config.joined, ...changed } });
}

// A computer joined to a hub opens no tunnel: its only link is the one it makes to the main computer.
// The local server remains so `computer-mcp stop` can reach an elevated service.
async function runJoinedComputer(config) {
  let shutdown = () => {};
  const server = createMcpServer({
    name: config.name,
    getToken: tokenReader(),
    auditFile: null,
    onShutdown: () => shutdown(),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  writeState({ pid: process.pid, startedAt: new Date().toISOString() });
  const audit = auditLogger(path.join(logDir(), 'audit.jsonl'));
  const lan = await openLan(config, { pskFor: xferPsk, handle: handleXferLan });
  const link = startNodeLink({
    origin: config.joined.origin,
    key: config.joined.key,
    id: config.joined.id,
    proxy: config.proxy,
    route: config.joined.route,
    hubLan: config.joined.hubLan,
    onSettings: rememberSettings,
    lanSelf: () => (lan ? { addrs: lan.addrs(), port: lan.port } : null),
    log: (line) => console.log(line),
    execute: async (tool, args) => {
      // File copies the main computer drives; too many and too small for the audit log.
      if (isXferTool(tool)) return runXfer(tool, args);
      // The phone's browser view, relayed by the hub: not tools the AI can call.
      if (tool.startsWith('_') && BROWSER_METHODS.includes(tool.slice(1))) {
        if (!desktopSupported) return { text: 'this computer has no desktop control', isError: true };
        return callDesktop(tool.slice(1), args).catch((err) => ({ text: err.message, isError: true }));
      }
      if (!hasTool(tool)) return { text: `${tool} is not available on this computer`, isError: true };
      const started = Date.now();
      const outcome = await callTool(tool, args);
      audit({ tool, args: summarizeArgs(tool, args), ms: Date.now() - started, error: outcome.isError ? outcome.text.slice(0, 500) : undefined, ...outcome.meta });
      return outcome;
    },
  });
  warmDesktop();
  console.log(`computer-mcp "${config.name}" joined to ${config.joined.origin}`);
  shutdown = () => {
    link.stop();
    lan?.server.close();
    stopDesktop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function runService() {
  const config = requireConfig();
  cleanWorkDir();
  if (config.joined) return runJoinedComputer(config);
  const previous = readState();
  killIfOurs(previous.cloudflaredPid, tunnelConfigPath());

  let shutdown = () => {};
  const getToken = tokenReader();
  const hub = config.hubEnabled ? new Hub({
    file: hubPath(homeDir()),
    selfName: config.name,
    origin: () => `https://${config.hostname}`,
    getToken,
  }) : null;
  if (hub) {
    hub.transfers = new Transfers({ hub, file: transfersFile(hubPath(homeDir())) });
    const lan = await openLan(config, {
      pskFor: (identity) => (identity.startsWith('n:') ? hub.lanPsk(identity) : xferPsk(identity)),
      handle: (req, res, identity) => (identity.startsWith('t:') ? handleXferLan(req, res, identity) : hub.handleLan(req, res, identity)),
      findMe: (message) => typeof message.id === 'string' && Object.hasOwn(hub.state.computers, message.id),
    });
    if (lan) hub.lan = { port: lan.port, addrs: lan.addrs };
  }
  const server = createMcpServer({
    name: config.name,
    getToken,
    publicOrigin: () => 'https://' + config.hostname,
    auditFile: path.join(logDir(), 'audit.jsonl'),
    onShutdown: () => shutdown(),
    hub,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(`computer-mcp "${config.name}" listening on 127.0.0.1:${config.port}`);

  let tunnel = null;
  let stopping = false;
  let delayMs = 1000;
  const startTunnel = () => {
    const startedAt = Date.now();
    tunnel = spawnTunnel(config);
    writeState({ pid: process.pid, cloudflaredPid: tunnel.pid, startedAt: new Date().toISOString() });
    const onGone = () => {
      if (stopping) return;
      delayMs = Date.now() - startedAt > 60000 ? 1000 : Math.min(delayMs * 2, 30000);
      setTimeout(startTunnel, delayMs);
    };
    tunnel.once('error', (err) => {
      console.error(`cloudflared: ${err.message}`);
      onGone();
    });
    tunnel.once('exit', onGone);
  };
  startTunnel();
  warmDesktop();

  shutdown = () => {
    stopping = true;
    stopDesktop();
    tunnel?.kill();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// The service must outlive an npx cache cleanup, so it runs from its own copy.
export function installAppCopy() {
  const app = path.join(homeDir(), 'app');
  if (path.resolve(app) === path.resolve(PACKAGE_ROOT)) return app;
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const entry of ['bin', 'src', 'desktop', 'web', 'package.json']) {
    fs.cpSync(path.join(PACKAGE_ROOT, entry), path.join(app, entry), { recursive: true });
  }
  return app;
}

// The check Windows itself uses: only an elevated process may run this.
export function isElevated() {
  return IS_WINDOWS && spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
}

// Windows asks for confirmation once here; at each logon the task then starts elevated with no prompt.
function runElevated(script) {
  const file = path.join(homeDir(), 'elevated-setup.ps1');
  const done = path.join(homeDir(), 'elevated-setup.result');
  fs.rmSync(done, { force: true });
  fs.writeFileSync(file, `\ufeff${script}\nSet-Content -LiteralPath '${done.replace(/'/g, "''")}' -Value 'ok'\n`);
  const launch = powershell(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${file}"'`);
  const ok = launch.status === 0 && fs.existsSync(done);
  fs.rmSync(file, { force: true });
  fs.rmSync(done, { force: true });
  return ok;
}

export function installAutostart({ limited = false } = {}) {
  if (process.platform === 'linux') return installLinuxAutostart();
  if (!IS_WINDOWS) {
    return { installed: false, note: 'Automatic start is not built for this system yet; run `computer-mcp run` from your service manager.' };
  }
  const cli = path.join(homeDir(), 'app', 'bin', 'computer-mcp.mjs');
  const launcher = path.join(homeDir(), 'launcher.vbs');
  // wscript starts node without a window; the loop brings the service back if it ever dies.
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    'Do',
    `  shell.Run """${process.execPath}"" ""${cli}"" run", 0, True`,
    '  WScript.Sleep 5000',
    'Loop',
    '',
  ].join('\r\n');
  fs.writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));

  const quoted = (value) => `'${value.replace(/'/g, "''")}'`;
  // Named now, because an elevated script could be running as a different administrator account.
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const registerAt = (level) => `
$ErrorActionPreference = 'Stop'
$user = ${quoted(user)}
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + ${quoted(launcher)} + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel ${level}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName ${quoted(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`;
  if (!limited) {
    if (isElevated()) {
      const direct = powershell(registerAt('Highest'));
      if (direct.status !== 0) throw new Error(`could not register the startup task: ${direct.stderr.trim()}`);
      return { installed: true, level: 'Highest' };
    }
    if (runElevated(registerAt('Highest'))) return { installed: true, level: 'Highest' };
  }
  const plain = powershell(registerAt('Limited'));
  if (plain.status !== 0) throw new Error(`could not register the startup task: ${plain.stderr.trim()}`);
  return { installed: true, level: 'Limited' };
}

export function startService() {
  if (process.platform === 'linux') return startLinuxService();
  if (!IS_WINDOWS) throw new Error('on this system start it with: computer-mcp run');
  const result = powershell(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
  if (result.status !== 0) throw new Error(`could not start the task: ${result.stderr.trim()}`);
}

// An elevated service can't be killed from a normal terminal, so it is asked to stop.
async function askToStop(config) {
  try {
    await fetch(`http://127.0.0.1:${config.port}/t/${config.token}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

export async function stopService() {
  if (IS_WINDOWS) powershell(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
  // Stopped through systemd first, or Restart=always would bring it straight back.
  if (process.platform === 'linux') stopLinuxService();
  const config = loadConfig();
  if (config) await askToStop(config);
  const state = readState();
  killIfOurs(state.pid, 'computer-mcp');
  killIfOurs(state.cloudflaredPid, tunnelConfigPath());
  fs.rmSync(statePath(), { force: true });
}

export function removeAutostart() {
  if (process.platform === 'linux') return removeLinuxAutostart();
  if (!IS_WINDOWS) return;
  powershell(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`);
  fs.rmSync(path.join(homeDir(), 'launcher.vbs'), { force: true });
}

export function autostartState() {
  if (process.platform === 'linux') return linuxAutostartState();
  if (!IS_WINDOWS) return 'not supported';
  const result = powershell(`(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.State), run level $($_.Principal.RunLevel)" })`);
  return result.stdout.trim() || 'not installed';
}
