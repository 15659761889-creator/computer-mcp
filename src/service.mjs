import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, loadConfig, logDir, memoryPath, requireConfig, saveConfig, statePath, tokenReader } from './config.mjs';
import { BROWSER_METHODS, Hub, hubPath } from './hub.mjs';
import { MemoryStore } from './memory.mjs';
import { startNodeLink } from './node-link.mjs';
import { auditLogger, createMcpServer } from './server.mjs';
import { callTool, hasTool, summarizeArgs } from './tools.mjs';
import { stopDesktop, warmDesktop } from './desktop.mjs';
import { cleanWorkDir } from './shell.mjs';
import { localHandoff } from './handoff-local.mjs';
import { LAN_PORT, allowThroughFirewall, lanAddresses, startDiscovery, startLanServer } from './lan.mjs';
import { Transfers, handleXferLan, isXferTool, runXfer, transfersFile, xferPsk } from './transfer.mjs';
import { refreshHubLicense } from './license.mjs';
import { spawnTunnel, tunnelConfigPath } from './tunnel.mjs';
import {
  installLinuxAutostart, linuxAutostartState, removeLinuxAutostart, startLinuxService, stopLinuxService,
} from './autostart-linux.mjs';

const IS_WINDOWS = process.platform === 'win32';
// COMPUTER_MCP_TASK lets a test install next to the real service without touching it.
const TASK_NAME = process.env.COMPUTER_MCP_TASK || 'ComputerMCP';
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wanji-${TASK_NAME}`;
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
// The local server remains so `wanji stop` can reach an elevated service.
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
      if (tool.startsWith('_') && BROWSER_METHODS.includes(tool.slice(1))) return localHandoff(tool.slice(1), args);
      if (!hasTool(tool)) return { text: `${tool} is not available on this computer`, isError: true };
      const started = Date.now();
      const outcome = await callTool(tool, args);
      audit({ tool, args: summarizeArgs(tool, args), ms: Date.now() - started, error: outcome.isError ? outcome.text.slice(0, 500) : undefined, ...outcome.meta });
      return outcome;
    },
  });
  warmDesktop();
  console.log(`wanji "${config.name}" joined to ${config.joined.origin}`);
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
  // A join.json in the config folder is never picked up here: anything that can
  // write a file there (an AI's write_file included) could otherwise move this
  // computer to another main computer. Joining from a file is the owner's step,
  // through `wanji join --file` or the Windows manager.
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
  // Pro is a license check, never a blocker: a failed check keeps the cached verdict.
  if (hub) refreshHubLicense(hub).catch((err) => console.error(`license check failed: ${err.message}`));
  // The notes AIs leave each other. A note can never hold this server's own keys.
  // A notes file that cannot be opened must not keep the computer from being controlled.
  let memory = null;
  try {
    memory = new MemoryStore({
      file: memoryPath(),
      secrets: () => [getToken(), hub?.state?.adminKey],
    });
  } catch (err) {
    console.error(`shared memory is off: ${err.message}`);
  }
  // The phone app manages the notes through the hub.
  if (hub) hub.memory = memory;
  const server = createMcpServer({
    name: config.name,
    getToken,
    publicOrigin: () => 'https://' + config.hostname,
    auditFile: path.join(logDir(), 'audit.jsonl'),
    onShutdown: () => shutdown(),
    hub,
    memory,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(`wanji "${config.name}" listening on 127.0.0.1:${config.port}`);

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

const fileHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The joiner EXE runs node from a temp folder, so the service gets its own copy.
// Called after stopService: a running service holds the old copy open, hence the retries.
// An elevated launcher loop that a normal process cannot stop restarts the service
// within seconds, so the same node.exe already in place is left alone.
export const runtimeNodePath = () => path.join(homeDir(), 'runtime', 'node.exe');

export function installRuntimeCopy() {
  const target = runtimeNodePath();
  if (path.resolve(target).toLowerCase() === path.resolve(process.execPath).toLowerCase()) return target;
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(process.execPath).size
    && fileHash(target) === fileHash(process.execPath)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.copyFileSync(process.execPath, target);
      return target;
    } catch (err) {
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw new Error(`could not copy node.exe to ${target}: ${err.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

// A computer set up by the joiner EXE has no installer, so it gets its own entry
// in Settings > Apps; removing it there runs `wanji uninstall --purge`.
export function registerUninstallEntry({ node, displayName, version }) {
  if (!IS_WINDOWS) return;
  const cli = path.join(homeDir(), 'app', 'bin', 'wanji.mjs');
  const values = [
    ['DisplayName', 'REG_SZ', displayName],
    ['DisplayVersion', 'REG_SZ', version],
    ['Publisher', 'REG_SZ', '万机'],
    ['InstallLocation', 'REG_SZ', homeDir()],
    ['DisplayIcon', 'REG_SZ', node],
    ['UninstallString', 'REG_SZ', `"${node}" "${cli}" uninstall --purge --from-settings`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
  ];
  for (const [name, type, data] of values) {
    const result = spawnSync('reg.exe', ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', data, '/f'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`could not add the uninstall entry: ${(result.stderr || result.stdout).trim()}`);
  }
}

export function removeUninstallEntry() {
  if (!IS_WINDOWS) return;
  spawnSync('reg.exe', ['delete', UNINSTALL_KEY, '/f'], { stdio: 'ignore', windowsHide: true });
}

// The check Windows itself uses: only an elevated process may run this.
export function isElevated() {
  return IS_WINDOWS && spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
}

// A PowerShell single-quoted literal; paths may hold apostrophes (C:\Users\O'Brien).
const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;
const TASK = psq(TASK_NAME);

// Only members of Administrators can run a task elevated; a standard account that got
// an administrator's password at the prompt would end up with a task it cannot start.
function isAdminUser() {
  if (!IS_WINDOWS) return false;
  const groups = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true });
  return groups.status === 0 && groups.stdout.includes('S-1-5-32-544');
}

const taskRunLevel = () => powershell(`(Get-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue).Principal.RunLevel`).stdout.trim();

// Stops the task and its launcher loop (found by the launcher path in its command line,
// killed by PID). Elevated, this also ends a loop that runs with highest privileges.
const stopTaskScript = (launcher) => `
Stop-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psq(launcher)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;

// Windows asks for confirmation once here; at each logon the task then starts elevated with no prompt.
function runElevated(script) {
  const file = path.join(homeDir(), 'elevated-setup.ps1');
  const done = path.join(homeDir(), 'elevated-setup.result');
  fs.rmSync(done, { force: true });
  fs.writeFileSync(file, `\ufeff${script}\nSet-Content -LiteralPath ${psq(done)} -Value 'ok'\n`);
  // The path sits in a single-quoted literal and is passed on in double quotes.
  const launch = powershell(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psq(`"${file}"`)}`);
  const ok = launch.status === 0 && fs.existsSync(done);
  fs.rmSync(file, { force: true });
  fs.rmSync(done, { force: true });
  return ok;
}

// Writes the logon launcher that starts the service; `update` rewrites it too,
// so a renamed entry file does not leave the old launcher pointing nowhere.
export function writeLauncher(node = process.execPath) {
  const cli = path.join(homeDir(), 'app', 'bin', 'wanji.mjs');
  const launcher = path.join(homeDir(), 'launcher.vbs');
  // wscript starts node without a window; the loop brings the service back if it ever dies.
  // A custom home must reach the service too, or it would run on the default home's config.
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    ...(process.env.COMPUTER_MCP_HOME ? [`shell.Environment("PROCESS")("COMPUTER_MCP_HOME") = "${process.env.COMPUTER_MCP_HOME.replace(/"/g, '""')}"`] : []),
    'Do',
    `  shell.Run """${node}"" ""${cli}"" run", 0, True`,
    '  WScript.Sleep 5000',
    'Loop',
    '',
  ].join('\r\n');
  fs.writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
  return launcher;
}

// COMPUTER_MCP_AUTOSTART=limited skips the administrator prompt (used by tests).
//
// stopFirst: the same (single) elevated step first stops the running task and its
// launcher loop, so a re-run (joiner repair) can replace files without a loop that a
// normal process cannot stop bringing the old service back. Call stopService after it.
export function installAutostart({ limited: asked = false, node, stopFirst = false } = {}) {
  const limited = asked || process.env.COMPUTER_MCP_AUTOSTART === 'limited' || (IS_WINDOWS && !isAdminUser());
  if (process.platform === 'linux') return installLinuxAutostart();
  if (!IS_WINDOWS) {
    return { installed: false, note: 'Automatic start is not built for this system yet; run `wanji run` from your service manager.' };
  }
  const launcher = writeLauncher(node);

  // Named now, because an elevated script could be running as a different administrator account.
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const registerAt = (level) => `${stopFirst ? stopTaskScript(launcher) : ''}
$ErrorActionPreference = 'Stop'
$user = ${psq(user)}
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + ${psq(launcher)} + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel ${level}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName ${TASK} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`;
  if (!limited) {
    if (isElevated()) {
      const direct = powershell(registerAt('Highest'));
      if (direct.status !== 0) throw new Error(`could not register the startup task: ${direct.stderr.trim()}`);
      return { installed: true, level: 'Highest' };
    }
    if (runElevated(registerAt('Highest'))) return { installed: true, level: 'Highest' };
  }
  const existing = taskRunLevel();
  const plain = powershell(registerAt('Limited'));
  if (plain.status !== 0) {
    // A normal process may not replace a task that runs with highest privileges (the
    // prompt was declined). That task starts the same launcher.vbs, just rewritten, so keep it.
    if (existing === 'Highest') return { installed: true, level: 'Highest', note: 'Kept the existing startup task (administrator rights were not granted to replace it).' };
    throw new Error(`could not register the startup task: ${plain.stderr.trim()}`);
  }
  return { installed: true, level: 'Limited' };
}

export function startService() {
  if (process.platform === 'linux') return startLinuxService();
  if (!IS_WINDOWS) throw new Error('on this system start it with: wanji run');
  const result = powershell(`Start-ScheduledTask -TaskName ${TASK}`);
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
  if (IS_WINDOWS) powershell(`Stop-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue`);
  // Stopped through systemd first, or Restart=always would bring it straight back.
  if (process.platform === 'linux') stopLinuxService();
  const config = loadConfig();
  if (config) await askToStop(config);
  const state = readState();
  // The marker changed with the rename; the old one still catches a service
  // started before the rename, the new one catches everything after it.
  killIfOurs(state.pid, 'wanji') || killIfOurs(state.pid, 'computer-mcp');
  killIfOurs(state.cloudflaredPid, tunnelConfigPath());
  fs.rmSync(statePath(), { force: true });
}

// Ends the logon task for good, launcher loop included, so call it before stopService:
// a loop left running brings the service straight back. A task that runs with highest
// privileges can only be stopped and removed elevated, and Settings > Apps runs
// uninstallers unelevated, so that case asks once for administrator rights.
// Returns false if the task is still registered (e.g. the prompt was declined).
export function removeAutostart() {
  if (process.platform === 'linux') return removeLinuxAutostart();
  if (!IS_WINDOWS) return true;
  const launcher = path.join(homeDir(), 'launcher.vbs');
  const script = `${stopTaskScript(launcher)}
Unregister-ScheduledTask -TaskName ${TASK} -Confirm:$false -ErrorAction SilentlyContinue
`;
  if (taskRunLevel() === 'Highest' && !isElevated()) runElevated(script);
  // Also unelevated: covers a Limited task, and whatever a declined prompt left.
  powershell(script);
  const gone = powershell(`[bool](Get-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue)`).stdout.trim() !== 'True';
  // A task left in place still points at the launcher; without it every logon shows a script error.
  if (gone) fs.rmSync(launcher, { force: true });
  return gone;
}

export function autostartState() {
  if (process.platform === 'linux') return linuxAutostartState();
  if (!IS_WINDOWS) return 'not supported';
  const result = powershell(`(Get-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.State), run level $($_.Principal.RunLevel)" })`);
  return result.stdout.trim() || 'not installed';
}
