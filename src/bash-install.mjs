import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { findBash, portableGitDir } from './shell.mjs';

// Portable Git needs no administrator rights and no winget; pinned with its published SHA-256,
// because the file is run to unpack itself.
const VERSION = '2.56.0.4';
const TAG = 'v2.56.0.windows.4';
const FILES = {
  x64: { name: `PortableGit-${VERSION}-64-bit.7z.exe`, sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1' },
  arm64: { name: `PortableGit-${VERSION}-arm64.7z.exe`, sha256: '044110f9d951858452ddb5e4b5415ea0f2b5b2598e794d6fec77fe28b9aa8cc0' },
};
// The mirror first: GitHub downloads are often slow or blocked in mainland China.
const SOURCES = [
  (name) => `https://registry.npmmirror.com/-/binary/git-for-windows/${TAG}/${name}`,
  (name) => `https://github.com/git-for-windows/git/releases/download/${TAG}/${name}`,
];

// Resolves to the file's SHA-256 (hex); the caller compares it with the pinned one.
export function download(url, target, proxy, redirects = 5) {
  const agent = new https.Agent(proxy ? { proxyEnv: { HTTPS_PROXY: proxy } } : {});
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, target, proxy, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      const hash = createHash('sha256');
      const out = fs.createWriteStream(target);
      let got = 0;
      let shown = -10;
      res.on('data', (chunk) => {
        hash.update(chunk);
        got += chunk.length;
        const percent = total ? Math.floor((got / total) * 100) : 0;
        if (total && percent >= shown + 10) {
          shown = percent;
          console.log(`  ${percent}% of ${Math.round(total / 1048576)} MB`);
        }
      });
      // A broken transfer closes the file, so the caller can delete it or try the next source.
      const fail = (err) => { out.destroy(); reject(err); };
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('the download was cut off')));
      out.on('error', reject);
      out.on('finish', () => resolve(hash.digest('hex')));
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('no response for 30 s')));
    req.on('error', reject);
  });
}

// Downloads Portable Git into the 万机 folder, so the bash tool can use it.
export async function installBash({ proxy } = {}) {
  if (process.platform !== 'win32') throw new Error('downloading Bash is only needed on Windows');
  const existing = findBash();
  if (existing) return existing;
  const file = FILES[os.arch() === 'arm64' ? 'arm64' : 'x64'];
  const dir = portableGitDir();
  const partial = `${dir}.partial`;
  const archive = `${dir}.download.exe`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(partial, { recursive: true, force: true });

  let ok = false;
  for (const source of SOURCES) {
    const url = source(file.name);
    console.log(`Downloading Git Bash ${VERSION} from ${new URL(url).host}...`);
    try {
      const sha256 = await download(url, archive, proxy);
      if (sha256 === file.sha256) {
        ok = true;
        break;
      }
      console.log('  the file does not match the published checksum; trying the next source');
    } catch (err) {
      console.log(`  failed: ${err.message}`);
    }
  }
  if (!ok) {
    fs.rmSync(archive, { force: true });
    throw new Error('could not download Git Bash; if this network needs a proxy, retry with --proxy http://host:port');
  }

  console.log('Unpacking...');
  const unpack = spawnSync(archive, [`-o${partial}`, '-y'], { windowsHide: true, timeout: 600000 });
  fs.rmSync(archive, { force: true });
  const bash = path.join(partial, 'bin', 'bash.exe');
  if (unpack.status !== 0 || !fs.existsSync(bash)) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new Error(`unpacking Git Bash failed (exit ${unpack.status})`);
  }
  // What git-bash.exe would do on its first start; it deletes itself when done.
  // A full path, because some computers set NoDefaultCurrentDirectoryInExePath.
  const postInstall = path.join(partial, 'post-install.bat');
  if (fs.existsSync(postInstall)) {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', postInstall], { cwd: partial, windowsHide: true, timeout: 120000 });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  const found = findBashNow();
  if (!found) throw new Error('Git Bash was unpacked but cannot be found');
  return found;
}

function findBashNow() {
  const bash = path.join(portableGitDir(), 'bin', 'bash.exe');
  const check = spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return check.stdout?.trim() === 'ok' ? bash : null;
}
