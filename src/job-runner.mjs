// Owns one command from start to finish, in its own process, so the output and
// exit code reach disk even if the service restarts or the network drops.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SPILL_LIMIT_BYTES = 500 * 1024 * 1024;
const EXIT_GRACE_MS = 2000;

const jobDir = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(jobDir, 'spec.json'), 'utf8'));
const statusFile = path.join(jobDir, 'status.json');

let status = { runnerPid: process.pid, startedAt: new Date().toISOString(), running: true };

function writeStatus() {
  const tmp = `${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, statusFile);
}

function sink(file) {
  const stream = fs.createWriteStream(path.join(jobDir, file));
  let written = 0;
  return {
    stream,
    write(chunk) {
      if (written >= SPILL_LIMIT_BYTES) return;
      written += chunk.length;
      stream.write(chunk);
    },
  };
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

const out = sink(spec.merge ? 'output.log' : 'stdout.log');
const err = spec.merge ? out : sink('stderr.log');

let settled = false;
let exitCode = null;
let timedOut = false;
let graceTimer = null;
let timeoutTimer = null;

function finish(outputHeldOpen, startError) {
  if (settled) return;
  settled = true;
  clearTimeout(timeoutTimer);
  clearTimeout(graceTimer);
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  const streams = spec.merge ? [out.stream] : [out.stream, err.stream];
  let open = streams.length;
  const done = () => {
    open -= 1;
    if (open > 0) return;
    status = {
      ...status,
      running: false,
      exitCode,
      timedOut,
      outputHeldOpen: outputHeldOpen && !timedOut,
      startError,
      finishedAt: new Date().toISOString(),
    };
    writeStatus();
    process.exit(0);
  };
  for (const stream of streams) stream.end(done);
}

let child = null;
try {
  child = spawn(spec.exe, spec.args, {
    cwd: spec.cwd,
    env: spec.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
} catch (error) {
  writeStatus();
  finish(false, `could not start ${path.basename(spec.exe)}: ${error.message}`);
}

if (child) {
  child.on('error', (error) => {
    finish(false, `could not start ${path.basename(spec.exe)}: ${error.message}`);
  });
  child.on('spawn', () => {
    status.pid = child.pid;
    writeStatus();
  });
  child.stdout.on('data', (chunk) => out.write(chunk));
  child.stderr.on('data', (chunk) => err.write(chunk));
  if (spec.timeoutSecs) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      graceTimer ??= setTimeout(() => finish(true), EXIT_GRACE_MS);
    }, spec.timeoutSecs * 1000);
  }
  child.on('exit', (code, signal) => {
    exitCode = code ?? (signal ? `signal ${signal}` : null);
    // A process left running in the background keeps the pipes open, and "close" would never fire.
    graceTimer ??= setTimeout(() => finish(true), EXIT_GRACE_MS);
  });
  child.on('close', () => finish(false));
}
