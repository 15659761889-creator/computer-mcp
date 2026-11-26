import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homeDir } from './config.mjs';
import { download } from './bash-install.mjs';

const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';
const DESKTOP_DIR = fileURLToPath(new URL('../desktop/', import.meta.url));
const REQUEST_TIMEOUT_MS = 120000;
const PYTHON_VERSIONS = ['3.12', '3.11', '3.10', '3.13'];

export const desktopSupported = IS_WINDOWS || IS_MACOS;

const macHelperDir = () => path.join(homeDir(), 'desktop');
const macHelperAppPath = () => path.join(macHelperDir(), 'Wanji Desktop Control.app');
const macHelperPath = () => path.join(macHelperAppPath(), 'Contents', 'MacOS', 'wanji-desktop-control');
const macHelperSource = () => path.join(DESKTOP_DIR, 'macos', 'helper.swift');
const macHelperInfoPlist = () => path.join(DESKTOP_DIR, 'macos', 'Info.plist');
const macHelperBuildStamp = (app = macHelperAppPath()) => path.join(app, 'Contents', 'Resources', 'wanji-build.sha256');
const venvDir = () => path.join(homeDir(), 'desktop-venv');

function venvPython() {
  return process.env.COMPUTER_MCP_PYTHON || path.join(venvDir(), 'Scripts', 'python.exe');
}

// Present while an install runs and left behind if it fails or is cut off, so a
// half-made environment does not count as installed and the next install starts clean.
const unfinishedMark = () => path.join(venvDir(), '.wanji-installing');

export const desktopInstalled = () => {
  if (IS_MACOS) return fs.existsSync(macHelperPath()) && fs.statSync(macHelperPath()).size > 0;
  return IS_WINDOWS && fs.existsSync(venvPython())
    && (Boolean(process.env.COMPUTER_MCP_PYTHON) || !fs.existsSync(unfinishedMark()));
};

// Prints the interpreter only for 64-bit x86: onnxruntime-directml has wheels for
// win_amd64 alone, so an ARM64 or 32-bit Python could never install desktop control.
const PYTHON_PROBE = "import sys,platform;print(sys.executable if sys.maxsize>2**32 and platform.machine() in ('AMD64','x86_64') else '')";

function systemPython() {
  for (const version of PYTHON_VERSIONS) {
    const result = spawnSync('py', [`-${version}`, '-c', PYTHON_PROBE], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  // On a fresh Windows `python` is the Store alias, which exits 9009 when given arguments.
  const result = spawnSync('python', ['-c', `import sys;print(sys.version_info[0],sys.version_info[1]);${PYTHON_PROBE}`], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    const [versionLine, exe] = result.stdout.trim().split(/\r?\n/);
    const [major, minor] = versionLine.split(' ').map(Number);
    if (major === 3 && minor >= 10 && minor <= 13 && exe?.trim()) return exe.trim();
  }
  return null;
}

// No usable Python: a private one, the official CPython build that python.org publishes
// as the NuGet package "python" (a plain zip, no installer, no registry, no admin).
// Pinned by SHA-256; x64 also runs on ARM64 Windows.
const PORTABLE_PYTHON = { version: '3.12.10', sha256: '0eb85c2dfccccf1b17352de4c397f69194035b7d37149eacc16f1147d93de3b8' };
const PYTHON_SOURCES = [
  (v) => `https://www.nuget.org/api/v2/package/python/${v}`,
  (v) => `https://globalcdn.nuget.org/packages/python.${v}.nupkg`,
];
export const portablePythonDir = () => path.join(homeDir(), 'python');

export async function installPortablePython({ proxy } = {}) {
  const dir = portablePythonDir();
  const python = path.join(dir, 'python.exe');
  if (fs.existsSync(python)) return python;
  const partial = `${dir}.partial`;
  const archive = `${dir}.download.zip`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(partial, { recursive: true, force: true });
  let ok = false;
  for (const source of PYTHON_SOURCES) {
    const url = source(PORTABLE_PYTHON.version);
    console.log(`No Python found; downloading Python ${PORTABLE_PYTHON.version} (about 15 MB) from ${new URL(url).host}...`);
    try {
      if (await download(url, archive, proxy) === PORTABLE_PYTHON.sha256) {
        ok = true;
        break;
      }
      console.log('  the file does not match the pinned checksum; trying the next source');
    } catch (err) {
      console.log(`  failed: ${err.message}`);
    }
  }
  if (!ok) {
    fs.rmSync(archive, { force: true });
    throw new Error('could not download Python; if this network needs a proxy, retry with: wanji desktop --proxy http://host:port');
  }
  const quoted = (value) => `'${value.replace(/'/g, "''")}'`;
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quoted(archive)}, ${quoted(partial)})`;
  const unpack = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  fs.rmSync(archive, { force: true });
  const tools = path.join(partial, 'tools');
  if (unpack.status !== 0 || !fs.existsSync(path.join(tools, 'python.exe'))) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new Error(`unpacking Python failed: ${(unpack.stderr || '').trim().slice(-300)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tools, dir);
  fs.rmSync(partial, { recursive: true, force: true });
  return python;
}

async function findPython(proxy) {
  return systemPython() || installPortablePython({ proxy });
}

function runStep(exe, args, proxy) {
  const env = proxy ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : process.env;
  const result = spawnSync(exe, args, { stdio: 'inherit', env, windowsHide: true });
  if (result.status !== 0) throw new Error(`failed: ${path.basename(exe)} ${args.join(' ')}`);
}

// PyPI is often slow or cut off in mainland China; a failed install retries from a mirror there.
const PIP_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

// Installs the engine and downloads the OCR models now, so the first look is not a long wait.
export async function installDesktop({ proxy } = {}) {
  if (IS_MACOS) return installMacDesktop();
  if (!IS_WINDOWS) throw new Error('desktop control is available on Windows and macOS');
  const python = path.join(venvDir(), 'Scripts', 'python.exe');
  // An earlier attempt was cut off: keep its environment only if pip still runs in it.
  if (fs.existsSync(unfinishedMark()) && spawnSync(python, ['-m', 'pip', '--version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    fs.rmSync(venvDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  fs.mkdirSync(venvDir(), { recursive: true });
  fs.writeFileSync(unfinishedMark(), '');
  if (!fs.existsSync(python)) {
    const base = await findPython(proxy);
    console.log('Creating the desktop control environment...');
    runStep(base, ['-m', 'venv', venvDir()], proxy);
  }
  console.log('Installing desktop control packages (about 500 MB)...');
  const pip = ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', path.join(DESKTOP_DIR, 'requirements.txt')];
  try {
    runStep(python, pip, proxy);
  } catch {
    console.log(`  retrying from ${new URL(PIP_MIRROR).host}...`);
    runStep(python, [...pip, '-i', PIP_MIRROR], proxy);
  }
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
  fs.rmSync(unfinishedMark(), { force: true });
  console.log('Desktop control is ready.');
}

// The macOS installer ships a helper that CI built from this exact source (Contents/Resources/desktop next to app/).
// Installing that copy means a Mac without Apple Command Line Tools still gets desktop control.
const macBundledHelperAppPath = () => path.resolve(DESKTOP_DIR, '..', '..', 'desktop', 'Wanji Desktop Control.app');
const MAC_PERMISSION_HINT = 'Grant Accessibility, Screen Recording and event-control permissions to “Wanji Desktop Control” when macOS asks, then restart the service (`wanji stop && wanji start`). A changed ad-hoc-signed helper may require macOS permissions to be approved again.';

function swapInMacHelper(temporary, target) {
  const backup = `${target}.old-${process.pid}`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(temporary, target);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    fs.rmSync(temporary, { recursive: true, force: true });
    throw err;
  }
}

function installBundledMacHelper(buildHash) {
  const bundled = macBundledHelperAppPath();
  const stamp = macHelperBuildStamp(bundled);
  if (!fs.existsSync(path.join(bundled, 'Contents', 'MacOS', 'wanji-desktop-control')) || !fs.existsSync(stamp)) return null;
  if (fs.readFileSync(stamp, 'utf8').trim() !== buildHash) return null;
  const check = (app) => spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8', timeout: 30000 }).status === 0;
  if (!check(bundled)) return null;
  const target = macHelperAppPath();
  const temporary = `${target}.new-${process.pid}`;
  try {
    fs.mkdirSync(macHelperDir(), { recursive: true });
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.cpSync(bundled, temporary, { recursive: true, verbatimSymlinks: true });
    if (!check(temporary)) throw new Error('signature check failed after copying');
    swapInMacHelper(temporary, target);
  } catch {
    fs.rmSync(temporary, { recursive: true, force: true });
    return null;
  }
  return target;
}

// macOS uses native Accessibility, CoreGraphics input/screen capture, and Vision OCR.
// Build locally so the app is signed locally against this Mac's installed SDK and receives a stable bundle identity for macOS privacy permissions.
export function installMacDesktop() {
  if (!IS_MACOS) throw new Error('the native desktop helper can only be built on macOS');
  const systemVersion = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 10000 });
  const versionParts = systemVersion.status === 0 ? systemVersion.stdout.trim().split('.').map(Number) : [];
  if (versionParts.length < 2 || !versionParts.every(Number.isFinite)) {
    throw new Error('could not determine the macOS version with sw_vers');
  }
  if (versionParts[0] < 12 || (versionParts[0] === 12 && versionParts[1] < 3)) {
    throw new Error(`native desktop control requires macOS 12.3 or later; this Mac reports ${systemVersion.stdout.trim()}`);
  }
  if (!fs.existsSync(macHelperSource())) throw new Error(`missing native desktop source: ${macHelperSource()}`);
  if (!fs.existsSync(macHelperInfoPlist())) throw new Error(`missing macOS app metadata: ${macHelperInfoPlist()}`);
  const buildHash = createHash('sha256')
    .update(fs.readFileSync(macHelperSource()))
    .update('\0')
    .update(fs.readFileSync(macHelperInfoPlist()))
    .digest('hex');
  if (fs.existsSync(macHelperPath()) && fs.existsSync(macHelperBuildStamp())) {
    const installedHash = fs.readFileSync(macHelperBuildStamp(), 'utf8').trim();
    if (installedHash === buildHash) {
      const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', macHelperAppPath()], { encoding: 'utf8', timeout: 30000 });
      if (verified.status === 0) {
        console.log('macOS desktop helper is already up to date; preserving its signed app identity and permissions.');
        return macHelperAppPath();
      }
    }
  }
  const prebuilt = installBundledMacHelper(buildHash);
  if (prebuilt) {
    console.log(`Installed the prebuilt macOS desktop helper that ships with Wanji. ${MAC_PERMISSION_HINT}`);
    return prebuilt;
  }
  const probe = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8', timeout: 15000 });
  const swiftc = probe.status === 0 ? probe.stdout.trim() : null;
  if (!swiftc) {
    throw new Error('Swift compiler not found. Install Apple Command Line Tools first with: xcode-select --install; then run: wanji desktop');
  }
  fs.mkdirSync(macHelperDir(), { recursive: true });
  const target = macHelperAppPath();
  const temporary = `${target}.new-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  const executableDir = path.join(temporary, 'Contents', 'MacOS');
  fs.mkdirSync(executableDir, { recursive: true });
  const binary = path.join(executableDir, 'wanji-desktop-control');
  const sdkProbe = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8', timeout: 15000 });
  const sdkArgs = sdkProbe.status === 0 && sdkProbe.stdout.trim() ? ['-sdk', sdkProbe.stdout.trim()] : [];
  const build = spawnSync(swiftc, [
    ...sdkArgs, '-O', '-target', `${os.machine()}-apple-macosx12.3`, '-framework', 'AppKit', '-framework', 'ApplicationServices',
    '-framework', 'Vision', '-framework', 'ScreenCaptureKit', '-framework', 'CoreGraphics', '-framework', 'ImageIO',
    '-o', binary, macHelperSource(),
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (build.status !== 0 || !fs.existsSync(binary)) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error(`could not build the macOS desktop helper: ${(build.stderr || build.stdout || '').trim().slice(-2500)}`);
  }
  fs.copyFileSync(macHelperInfoPlist(), path.join(temporary, 'Contents', 'Info.plist'));
  const resources = path.join(temporary, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'wanji-build.sha256'), `${buildHash}\n`, { mode: 0o644 });
  const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.wanji.desktop-control', temporary], {
    encoding: 'utf8', timeout: 30000,
  });
  if (signed.status !== 0) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error(`could not sign the macOS desktop app: ${(signed.stderr || signed.stdout || '').trim().slice(-1000)}`);
  }
  const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', temporary], { encoding: 'utf8', timeout: 30000 });
  if (verified.status !== 0) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error(`macOS desktop app signature verification failed: ${(verified.stderr || verified.stdout || '').trim().slice(-1000)}`);
  }
  swapInMacHelper(temporary, target);
  console.log(`macOS desktop app built. ${MAC_PERMISSION_HINT}`);
  return target;
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
    const child = IS_MACOS
      ? spawn(macHelperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
      : spawn(venvPython(), [path.join(DESKTOP_DIR, 'helper.py')], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
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
  if (!desktopSupported || !desktopInstalled()) return;
  try {
    helper.call('ping', {}).catch(() => {});
  } catch {
    // Reported on first use.
  }
}

export function stopDesktop() {
  helper.stop();
}
