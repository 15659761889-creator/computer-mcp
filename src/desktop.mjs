import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homeDir } from './config.mjs';

const IS_WINDOWS = process.platform === 'win32';
const DESKTOP_DIR = fileURLToPath(new URL('../desktop/', import.meta.url));
const REQUEST_TIMEOUT_MS = 120000;
const PYTHON_VERSIONS = ['3.12', '3.11', '3.10', '3.13'];

export const desktopSupported = IS_WINDOWS;

const venvDir = () => path.join(homeDir(), 'desktop-venv');

function venvPython() {
  return process.env.COMPUTER_MCP_PYTHON || path.join(venvDir(), 'Scripts', 'python.exe');
}

export const desktopInstalled = () => fs.existsSync(venvPython());

function findPython() {
  for (const version of PYTHON_VERSIONS) {
    const result = spawnSync('py', [`-${version}`, '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return result.stdout.trim();
  }
  const result = spawnSync('python', ['-c', 'import sys;print(sys.version_info[0],sys.version_info[1],sys.executable)'], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    const [major, minor, ...exe] = result.stdout.trim().split(' ');
    if (Number(major) === 3 && Number(minor) >= 10 && Number(minor) <= 13) return exe.join(' ');
  }
  throw new Error('desktop control needs Python 3.10-3.13; install it from python.org, then run: wanji desktop');
}

function runStep(exe, args, proxy) {
  const env = proxy ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : process.env;
  const result = spawnSync(exe, args, { stdio: 'inherit', env, windowsHide: true });
  if (result.status !== 0) throw new Error(`failed: ${path.basename(exe)} ${args.join(' ')}`);
}

// Installs the engine and downloads the OCR models now, so the first look is not a long wait.
export function installDesktop({ proxy } = {}) {
  if (!IS_WINDOWS) throw new Error('desktop control is Windows-only so far');
  if (!fs.existsSync(path.join(venvDir(), 'Scripts', 'python.exe'))) {
    console.log('Creating the desktop control environment...');
    runStep(findPython(), ['-m', 'venv', venvDir()], proxy);
  }
  const python = path.join(venvDir(), 'Scripts', 'python.exe');
  console.log('Installing desktop control packages (about 500 MB)...');
  runStep(python, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', path.join(DESKTOP_DIR, 'requirements.txt')], proxy);
  console.log('Downloading OCR models and checking they load...');
  const check = spawnSync(python, [path.join(DESKTOP_DIR, 'helper.py')], {
    input: `${JSON.stringify({ id: 1, method: 'ping' })}\n`,
    encoding: 'utf8',
    env: proxy ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : process.env,
    windowsHide: true,
    timeout: 600000,
  });
  if (!check.stdout?.includes('"text": "ok"')) {
    throw new Error(`desktop control did not start: ${(check.stdout || '').slice(-300)} ${(check.stderr || '').slice(-600)}`);
  }
  console.log('Desktop control is ready.');
}

class Helper {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.tail = [];
    this.queue = Promise.resolve();
  }

  start() {
    if (this.child) return;
    if (!desktopInstalled()) throw new Error('desktop control is not installed; run: wanji desktop');
    const child = spawn(venvPython(), [path.join(DESKTOP_DIR, 'helper.py')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk) => {
      this.tail.push(chunk.toString('utf8'));
      if (this.tail.length > 20) this.tail.shift();
    });
    const gone = (why) => {
      if (this.child !== child) return;
      this.child = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`desktop helper stopped (${why}): ${this.tail.join('').slice(-400)}`));
      }
      this.pending.clear();
    };
    child.on('error', (err) => gone(err.message));
    child.on('exit', (code) => gone(`exit ${code}`));
    child.stdin.on('error', () => {});
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    waiting.resolve(message.result);
  }

  send(method, args) {
    this.start();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A stuck helper is replaced, so one hung application does not block every later call.
        this.stop();
        reject(new Error(`the desktop did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    });
  }

  // One action at a time: two clients must not move the same mouse at once.
  call(method, args) {
    const run = () => this.send(method, args);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  stop() {
    const { child } = this;
    this.child = null;
    child?.kill();
  }
}

const helper = new Helper();

export function callDesktop(method, args) {
  return helper.call(method, args);
}

// Loading the OCR model takes seconds, so the service does it before anyone is waiting.
export function warmDesktop() {
  if (!IS_WINDOWS || !desktopInstalled()) return;
  try {
    helper.call('ping', {}).catch(() => {});
  } catch {
    // Reported on first use.
  }
}

export function stopDesktop() {
  helper.stop();
}
