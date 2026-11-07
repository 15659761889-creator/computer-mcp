import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvocation, jobsDir } from './shell.mjs';
import { cleanOutput, decodeOutput } from './text.mjs';
import { securePrivateDirectory, writePrivateFile } from './private-file.mjs';

const RUNNER = fileURLToPath(new URL('./job-runner.mjs', import.meta.url));
const KEEP_BYTES = 256 * 1024;
const OUTPUT_CHARS = 30000;
const MIN_STDERR_CHARS = 10000;
const COMMAND_PREVIEW_CHARS = 200;

function readStatus(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let elevated;

function serviceElevated() {
  elevated ??= process.platform === 'win32' && spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
  return elevated;
}

// An elevated process has no direct way to start a normal one, but Task Scheduler does.
function startAsUser(id, dir) {
  const vbs = path.join(dir, 'start.vbs');
  const text = `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${RUNNER}"" ""${dir}""", 0, False\r\n`;
  fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const name = `Wanji-user-${id}`;
  const script = `
$ErrorActionPreference = 'Stop'
$user = "$env:USERDOMAIN\\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbs}"'
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${name}' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName '${name}'
Start-Sleep -Seconds 2
Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false
`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export async function startJob({ command, cwd, timeoutSecs, shell, merge = false, asUser = false }) {
  const id = randomBytes(4).toString('hex');
  const dir = path.join(jobsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  securePrivateDirectory(dir);
  const { exe, args, env } = buildInvocation(shell, command, dir);
  const viaTask = asUser && serviceElevated();
  writePrivateFile(path.join(dir, 'spec.json'), JSON.stringify({
    exe, args, cwd, timeoutSecs, merge, shell, command, ...(viaTask ? { env } : {}),
  }));
  if (viaTask) {
    startAsUser(id, dir);
  } else {
    const runner = spawn(process.execPath, [RUNNER, dir], {
      cwd,
      env,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    runner.on('error', () => {});
    runner.unref();
  }

  // The PID is only useful once the real process has started.
  const deadline = Date.now() + (viaTask ? 20000 : 5000);
  while (Date.now() < deadline) {
    const status = readStatus(dir);
    if (status?.startError) throw new Error(status.startError);
    if (status?.pid || status?.running === false) return { id, dir, pid: status.pid };
    await sleep(5);
  }
  throw new Error('the command did not start in time');
}

function jobDir(id) {
  if (!/^[0-9a-f]{8}$/.test(String(id))) return null;
  const dir = path.join(jobsDir(), id);
  return fs.existsSync(path.join(dir, 'spec.json')) ? dir : null;
}

function currentState(dir) {
  const status = readStatus(dir);
  if (!status) return { state: 'starting' };
  if (!status.running) return { state: status.killed ? 'killed' : 'finished', ...status };
  // The owner died without recording an end, so the exit code can never be known.
  if (!pidAlive(status.runnerPid)) return { state: 'lost', ...status };
  return { state: 'running', ...status };
}

export async function waitForJob(dir, waitMs) {
  const deadline = Date.now() + waitMs;
  let delay = 5;
  for (;;) {
    const state = currentState(dir);
    if (state.state !== 'running' && state.state !== 'starting') return state;
    const left = deadline - Date.now();
    if (left <= 0) return state;
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 1.5, 200);
  }
}

function readEdges(file) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size === 0) return { size, text: '' };
  const fd = fs.openSync(file, 'r');
  try {
    if (size <= KEEP_BYTES * 2) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return { size, text: cleanOutput(decodeOutput(buf)) };
    }
    const head = Buffer.alloc(KEEP_BYTES);
    const tail = Buffer.alloc(KEEP_BYTES);
    fs.readSync(fd, head, 0, KEEP_BYTES, 0);
    fs.readSync(fd, tail, 0, KEEP_BYTES, size - KEEP_BYTES);
    // A cut can land inside a character, so the partial edge lines are dropped.
    const headEnd = head.lastIndexOf(0x0a);
    const tailStart = tail.indexOf(0x0a);
    return {
      size,
      head: cleanOutput(decodeOutput(headEnd > 0 ? head.subarray(0, headEnd + 1) : head)),
      tail: cleanOutput(decodeOutput(tailStart >= 0 ? tail.subarray(tailStart + 1) : tail)),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function charCount(edges) {
  return edges.text === undefined ? Infinity : edges.text.length;
}

function render(edges, file, limit) {
  if (edges.text !== undefined && edges.text.length <= limit) return edges.text;
  const head = edges.head ?? edges.text;
  const tail = edges.tail ?? edges.text;
  const half = Math.floor(limit / 2);
  return `${head.slice(0, half)}\n[... output truncated, ${edges.size} bytes in total, full output: ${file} ...]\n${tail.slice(-half)}`;
}

export function jobOutput(dir) {
  const merged = path.join(dir, 'output.log');
  if (fs.existsSync(merged)) {
    return { stdout: render(readEdges(merged), merged, OUTPUT_CHARS), stderr: '' };
  }
  const stdoutFile = path.join(dir, 'stdout.log');
  const stderrFile = path.join(dir, 'stderr.log');
  const stdout = readEdges(stdoutFile);
  const stderr = readEdges(stderrFile);
  const outChars = charCount(stdout);
  const errChars = charCount(stderr);
  let stdoutLimit = OUTPUT_CHARS;
  let stderrLimit = OUTPUT_CHARS;
  if (outChars + errChars > OUTPUT_CHARS) {
    stderrLimit = Math.max(MIN_STDERR_CHARS, OUTPUT_CHARS - outChars);
    stdoutLimit = OUTPUT_CHARS - Math.min(errChars, stderrLimit);
  }
  return { stdout: render(stdout, stdoutFile, stdoutLimit), stderr: render(stderr, stderrFile, stderrLimit) };
}

export function logPathOf(dir) {
  const merged = path.join(dir, 'output.log');
  return fs.existsSync(merged) ? merged : path.join(dir, 'stdout.log');
}

function duration(state) {
  if (!state.startedAt) return null;
  const end = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  return end - Date.parse(state.startedAt);
}

export function describeJob(id, dir, state) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  return { id, state: state.state, pid: state.pid, exitCode: state.exitCode, timedOut: state.timedOut, durationMs: duration(state), command: spec.command };
}

export function listJobs(limit = 20) {
  const root = jobsDir();
  const rows = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    try {
      rows.push({ id, dir, mtime: fs.statSync(path.join(dir, 'spec.json')).mtimeMs });
    } catch {
      // A job being created or removed.
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit).map(({ id, dir }) => {
    const job = describeJob(id, dir, currentState(dir));
    job.command = job.command.length > COMMAND_PREVIEW_CHARS ? `${job.command.slice(0, COMMAND_PREVIEW_CHARS)}...` : job.command;
    return job;
  });
}

export function findJob(id) {
  const dir = jobDir(id);
  return dir ? { dir, state: currentState(dir) } : null;
}

export function killJob(dir) {
  const state = currentState(dir);
  if (state.state !== 'running' || !state.pid) return state;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-state.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  return null;
}
