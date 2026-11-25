import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { homeDir, logDir } from './config.mjs';

export const MACOS_AGENT_LABEL = 'com.wanji.service';

const defaultUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
const resolveDomain = (getUid = defaultUid) => {
  const userId = getUid();
  if (userId === null || userId === 0) {
    throw new Error('macOS LaunchAgents must be installed from the logged-in user account; do not run Wanji with sudo.');
  }
  return `gui/${userId}`;
};
const defaultAgentPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${MACOS_AGENT_LABEL}.plist`);
const serviceTarget = (getUid) => `${resolveDomain(getUid)}/${MACOS_AGENT_LABEL}`;

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plistString(value) {
  return `<string>${xml(value)}</string>`;
}

export function buildMacLaunchAgentPlist({ node = process.execPath, cli = path.join(homeDir(), 'app', 'bin', 'wanji.mjs'),
  workingDirectory = homeDir(), output = path.join(logDir(), 'service.log'), error = path.join(logDir(), 'service-error.log'),
  env = process.env } = {}) {
  const fallbackPath = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const environment = { PATH: env.PATH || fallbackPath };
  if (env.WANJI_HOME) environment.WANJI_HOME = env.WANJI_HOME;
  if (env.COMPUTER_MCP_HOME) environment.COMPUTER_MCP_HOME = env.COMPUTER_MCP_HOME;
  const envItems = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    ${plistString(value)}`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>\n  ${plistString(MACOS_AGENT_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${plistString(node)}`,
    `    ${plistString(cli)}`,
    '    <string>run</string>',
    '  </array>',
    `  <key>WorkingDirectory</key>\n  ${plistString(workingDirectory)}`,
    `  <key>StandardOutPath</key>\n  ${plistString(output)}`,
    `  <key>StandardErrorPath</key>\n  ${plistString(error)}`,
    `  <key>EnvironmentVariables</key>\n  <dict>\n${envItems}\n  </dict>`,
    '  <key>RunAtLoad</key>\n  <true/>',
    '  <key>KeepAlive</key>\n  <true/>',
    '  <key>ProcessType</key>\n  <string>Background</string>',
    '  <key>ThrottleInterval</key>\n  <integer>5</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function defaultLaunchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8', timeout: 15000 });
}

export function installMacAutostart({
  node = process.execPath,
  start = true,
  platform = process.platform,
  getUid = defaultUid,
  agentPath = defaultAgentPath(),
  logs = logDir(),
  launchctl = defaultLaunchctl,
} = {}) {
  if (platform !== 'darwin') return { installed: false, note: 'macOS LaunchAgents are available only on macOS.' };
  const dom = resolveDomain(getUid);
  const target = `${dom}/${MACOS_AGENT_LABEL}`;
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const temporary = `${agentPath}.tmp`;
  fs.writeFileSync(temporary, buildMacLaunchAgentPlist({ node, output: path.join(logs, 'service.log'), error: path.join(logs, 'service-error.log') }), { mode: 0o600 });
  fs.renameSync(temporary, agentPath);

  const enable = launchctl('enable', target);
  if (enable.status !== 0) {
    return { installed: false, note: `launchd could not enable the Wanji agent: ${(enable.stderr || enable.stdout || '').trim()}` };
  }
  const isLoaded = () => launchctl('print', target).status === 0;
  if (isLoaded()) {
    const stopped = launchctl('bootout', target);
    if (stopped.status !== 0 && isLoaded()) {
      return { installed: false, note: `launchd could not reload the Wanji agent: ${(stopped.stderr || stopped.stdout || '').trim()}` };
    }
  }
  if (start) {
    const boot = launchctl('bootstrap', dom, agentPath);
    if (boot.status !== 0 && !isLoaded()) {
      return { installed: false, note: `launchd could not load the Wanji agent: ${(boot.stderr || boot.stdout || '').trim()}` };
    }
  }
  return { installed: true, level: 'LaunchAgent', loaded: start };
}

export function startMacService({
  platform = process.platform,
  getUid = defaultUid,
  agentPath = defaultAgentPath(),
  launchctl = defaultLaunchctl,
} = {}) {
  if (platform !== 'darwin') throw new Error('macOS service control is available only on macOS');
  if (!fs.existsSync(agentPath)) {
    throw new Error('macOS automatic start is not installed; run `wanji autostart` to enable it, or `wanji run` to start the service in the foreground.');
  }
  const dom = resolveDomain(getUid);
  const target = `${dom}/${MACOS_AGENT_LABEL}`;
  const isLoaded = () => launchctl('print', target).status === 0;
  const enable = launchctl('enable', target);
  if (enable.status !== 0) throw new Error(`could not enable the Wanji LaunchAgent: ${(enable.stderr || enable.stdout || '').trim()}`);
  if (!isLoaded()) {
    const boot = launchctl('bootstrap', dom, agentPath);
    if (boot.status !== 0 && !isLoaded()) throw new Error(`could not load the Wanji agent: ${(boot.stderr || boot.stdout || '').trim()}`);
    return; // RunAtLoad starts it as part of bootstrap.
  }
  const kick = launchctl('kickstart', '-k', target);
  if (kick.status !== 0) throw new Error(`could not start the Wanji service: ${(kick.stderr || kick.stdout || '').trim()}`);
}

export function stopMacService({
  platform = process.platform,
  getUid = defaultUid,
  launchctl = defaultLaunchctl,
} = {}) {
  if (platform !== 'darwin') return;
  const target = serviceTarget(getUid);
  const isLoaded = () => launchctl('print', target).status === 0;
  if (isLoaded()) {
    const result = launchctl('bootout', target);
    if (result.status !== 0 && isLoaded()) throw new Error(`could not stop the Wanji service: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

export function removeMacAutostart({
  platform = process.platform,
  getUid = defaultUid,
  agentPath = defaultAgentPath(),
  launchctl = defaultLaunchctl,
} = {}) {
  if (platform !== 'darwin') return true;
  stopMacService({ platform, getUid, launchctl });
  const target = serviceTarget(getUid);
  const disable = launchctl('disable', target);
  if (disable.status !== 0) throw new Error(`could not disable the Wanji LaunchAgent: ${(disable.stderr || disable.stdout || '').trim()}`);
  fs.rmSync(agentPath, { force: true });
  fs.rmSync(`${agentPath}.tmp`, { force: true });
  return !fs.existsSync(agentPath);
}

export function macAutostartState({
  platform = process.platform,
  getUid = defaultUid,
  agentPath = defaultAgentPath(),
  launchctl = defaultLaunchctl,
} = {}) {
  if (platform !== 'darwin') return 'not supported';
  if (!fs.existsSync(agentPath)) return 'not installed';
  const target = serviceTarget(getUid);
  const status = launchctl('print', target);
  if (status.status !== 0) return 'LaunchAgent installed, not loaded';
  const text = `${status.stdout || ''}\n${status.stderr || ''}`;
  const state = text.match(/^\s*state\s*=\s*(.+)$/m)?.[1]?.trim() || 'loaded';
  return `LaunchAgent, ${state}`;
}
