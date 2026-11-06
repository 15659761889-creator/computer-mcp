import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from './config.mjs';

// Linux starts the service as a systemd user unit, kept running at boot by lingering, so it
// needs no root beyond what enabling lingering may ask. Inside WSL the VM shuts down once no
// Windows program is attached to it, so a small hidden script in the Windows Startup folder
// keeps it attached from logon; systemd then starts the service inside.

const UNIT = 'wanji.service';
// Pre-rename names, removed when the new ones are installed so a renamed
// service does not leave a stale unit/keeper behind.
const LEGACY_UNIT = 'computer-mcp.service';
const legacyKeeperName = () => `ComputerMCP-WSL-${(process.env.WSL_DISTRO_NAME || 'Linux').replace(/[^\w.-]/g, '_')}.vbs`;
const unitFile = () => path.join(os.homedir(), '.config', 'systemd', 'user', UNIT);
const legacyUnitFile = () => path.join(os.homedir(), '.config', 'systemd', 'user', LEGACY_UNIT);
const hasSystemd = () => fs.existsSync('/run/systemd/system');

export function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// systemctl --user needs the user's bus, which a shell started by wsl.exe or cron may not have set.
function userEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus` };
}

const systemctl = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env: userEnv() });

function lingering() {
  const user = os.userInfo().username;
  const shown = spawnSync('loginctl', ['show-user', user, '-p', 'Linger'], { encoding: 'utf8' });
  if (/Linger=yes/.test(shown.stdout || '')) return true;
  if (spawnSync('loginctl', ['enable-linger', user]).status === 0) return true;
  // Some systems want root for it; sudo -n never prompts, it just fails without a password-free sudo.
  return spawnSync('sudo', ['-n', 'loginctl', 'enable-linger', user]).status === 0;
}

// ---- WSL: the Windows side ----

const WIN = '/mnt/c/Windows/System32';

function windowsStartupDir() {
  const appdata = spawnSync(`${WIN}/cmd.exe`, ['/d', '/c', 'echo %APPDATA%'], { encoding: 'utf8', cwd: '/mnt/c' }).stdout?.trim();
  if (!appdata || appdata.includes('%')) return null;
  const linux = spawnSync('wslpath', ['-u', appdata], { encoding: 'utf8' }).stdout?.trim();
  return linux ? path.join(linux, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null;
}

const keeperName = () => `Wanji-WSL-${(process.env.WSL_DISTRO_NAME || 'Linux').replace(/[^\w.-]/g, '_')}.vbs`;

function installKeeper() {
  const distro = process.env.WSL_DISTRO_NAME;
  const dir = windowsStartupDir();
  if (!distro || !dir || !fs.existsSync(dir)) return 'the Windows Startup folder was not found, so the VM stops when nothing else uses it';
  const file = path.join(dir, keeperName());
  const vbs = [
    `' Keeps the WSL distro "${distro}" running from logon, so 万机 (a systemd service inside it) stays up.`,
    `' Written by wanji; wanji uninstall inside the distro removes it.`,
    'Set shell = CreateObject("WScript.Shell")',
    'Do',
    // No quotes around the name: wsl.exe started this way fails at once with -d "name".
    `    shell.Run "wsl.exe -d ${distro} --exec sleep infinity", 0, True`,
    '    WScript.Sleep 5000',
    'Loop',
    '',
  ].join('\r\n');
  const fresh = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== vbs;
  fs.writeFileSync(file, vbs);
  if (fresh) {
    // Started now too, so the service keeps running without waiting for the next logon. Explorer
    // opens it the way logon does, outside this WSL session.
    const win = spawnSync('wslpath', ['-w', file], { encoding: 'utf8' }).stdout.trim();
    spawn('/mnt/c/Windows/explorer.exe', [win], { detached: true, stdio: 'ignore', cwd: '/mnt/c' }).unref();
  }
  return null;
}

function removeKeeper() {
  const dir = windowsStartupDir();
  if (dir) {
    fs.rmSync(path.join(dir, keeperName()), { force: true });
    fs.rmSync(path.join(dir, legacyKeeperName()), { force: true });
  }
}

// ---- What service.mjs calls ----

// A systemd unit value: quoted for spaces (WSL puts Windows folders on PATH), % doubled because systemd expands it.
const quoted = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function installLinuxAutostart() {
  if (!hasSystemd()) {
    return { installed: false, note: 'This system does not run systemd; start `wanji run` from your own service manager.' };
  }
  const cli = path.join(homeDir(), 'app', 'bin', 'wanji.mjs');
  const env = [
    // The PATH of whoever installed it, so the AI's commands find the same tools.
    `Environment=${quoted(`PATH=${process.env.PATH}`)}`,
    ...(process.env.COMPUTER_MCP_HOME ? [`Environment=${quoted(`COMPUTER_MCP_HOME=${process.env.COMPUTER_MCP_HOME}`)}`] : []),
  ];
  const unit = [
    '[Unit]',
    'Description=万机',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${quoted(process.execPath)} ${quoted(cli)} run`,
    'WorkingDirectory=%h',
    ...env,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  // Drop the pre-rename unit so it cannot keep starting the old entry file.
  const legacyFile = legacyUnitFile();
  if (fs.existsSync(legacyFile)) {
    systemctl('disable', '--now', LEGACY_UNIT);
    fs.rmSync(legacyFile, { force: true });
  }
  fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
  fs.writeFileSync(unitFile(), unit);
  const reload = systemctl('daemon-reload');
  if (reload.status !== 0) return { installed: false, note: `systemd did not take the unit: ${(reload.stderr || '').trim()}` };
  const enable = systemctl('enable', UNIT);
  if (enable.status !== 0) return { installed: false, note: `could not enable ${UNIT}: ${(enable.stderr || '').trim()}` };
  const notes = [];
  if (!lingering()) notes.push('lingering could not be turned on, so it starts at login rather than at boot (an administrator can run: loginctl enable-linger ' + os.userInfo().username + ')');
  if (isWsl()) {
    const problem = installKeeper();
    if (problem) notes.push(problem);
  }
  return { installed: true, level: 'systemd user service', note: notes.join('; ') || undefined };
}

export function startLinuxService() {
  // An install from before the rename has only the legacy unit (`update` does
  // not install autostart): move it to the new unit first.
  if (!fs.existsSync(unitFile()) && fs.existsSync(legacyUnitFile())) {
    const migrated = installLinuxAutostart();
    if (!migrated.installed) throw new Error(migrated.note);
  }
  const result = systemctl('restart', UNIT);
  if (result.status !== 0) throw new Error(`could not start ${UNIT}: ${(result.stderr || '').trim()}`);
}

export function stopLinuxService() {
  if (fs.existsSync(legacyUnitFile())) systemctl('stop', LEGACY_UNIT);
  if (fs.existsSync(unitFile())) systemctl('stop', UNIT);
}

export function removeLinuxAutostart() {
  if (fs.existsSync(unitFile())) {
    systemctl('disable', '--now', UNIT);
    fs.rmSync(unitFile(), { force: true });
    systemctl('daemon-reload');
  }
  if (isWsl()) removeKeeper();
}

export function linuxAutostartState() {
  if (!fs.existsSync(unitFile())) return 'not installed';
  const enabled = systemctl('is-enabled', UNIT).stdout.trim() || 'unknown';
  const active = systemctl('is-active', UNIT).stdout.trim() || 'unknown';
  return `systemd user service, ${enabled}, ${active}${isWsl() ? ', kept up from the Windows Startup folder' : ''}`;
}
