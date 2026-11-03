import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const OLD_JOB_MS = 7 * 24 * 3600 * 1000;

export const DEFAULT_TIMEOUT_SECS = 120;
export const MAX_TIMEOUT_SECS = 3600;
export const DEFAULT_WAIT_SECS = 60;

export function workDir() {
  const dir = path.join(os.tmpdir(), 'computer-mcp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function jobsDir() {
  const dir = path.join(workDir(), 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isFinishedJob(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).running === false;
  } catch {
    return false;
  }
}

export function cleanWorkDir(maxAgeMs = OLD_JOB_MS) {
  const root = jobsDir();
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs && isFinishedJob(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // A log still open, or already gone.
    }
  }
}

let cachedBash;

export function findBash() {
  if (cachedBash !== undefined) return cachedBash;
  cachedBash = locateBash();
  return cachedBash;
}

function locateBash() {
  if (process.env.COMPUTER_MCP_BASH) return process.env.COMPUTER_MCP_BASH;
  if (!IS_WINDOWS) return fs.existsSync('/bin/bash') ? '/bin/bash' : null;
  // System32\bash.exe is WSL, not what a model expects, so only Git Bash counts.
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  const where = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const line of (where.stdout || '').split(/\r?\n/).filter(Boolean)) {
    candidates.push(path.join(path.dirname(path.dirname(line)), 'bin', 'bash.exe'));
  }
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function shellEnv() {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
}

// Git\bin\bash.exe is a thin wrapper around the real shell; going around it means the PID
// a model gets is the shell itself, which stays killable if the wrapper goes away.
function realBash(bash, env) {
  if (!IS_WINDOWS) return bash;
  const root = path.dirname(path.dirname(bash));
  const real = path.join(root, 'usr', 'bin', 'bash.exe');
  if (path.basename(path.dirname(bash)).toLowerCase() !== 'bin' || !fs.existsSync(real)) return bash;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = [path.join(root, 'mingw64', 'bin'), path.join(root, 'usr', 'bin'), env[pathKey]].join(';');
  env.MSYSTEM = 'MINGW64';
  return real;
}

// Commands run from a script file: no quoting problems, no command-line length limit.
export function buildInvocation(shell, command, dir) {
  const env = shellEnv();
  if (shell === 'powershell') {
    const script = path.join(dir, 'command.ps1');
    const body = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      command,
      '$__cmcpOk = $?',
      'if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }',
      'if (-not $__cmcpOk) { exit 1 }',
    ].join('\n');
    fs.writeFileSync(script, `﻿${body}\n`);
    const exe = IS_WINDOWS ? 'powershell.exe' : 'pwsh';
    return {
      exe,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      env,
    };
  }
  const bash = findBash();
  if (!bash) {
    throw new Error(IS_WINDOWS
      ? 'Git Bash is not installed on this computer; pass shell: "powershell" or install Git for Windows'
      : 'bash is not installed on this computer');
  }
  const script = path.join(dir, 'command.sh');
  const prefix = IS_WINDOWS ? 'chcp.com 65001 >/dev/null 2>&1\n' : '';
  fs.writeFileSync(script, `${prefix}${command}\n`);
  return { exe: realBash(bash, env), args: [script.split(path.sep).join('/')], env };
}
