import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

let cachedSid;
const securedFiles = new Map();
const securedDirectories = new Set();

function fileStamp(file) {
  const stat = fs.statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`;
}

function windowsUserSid() {
  if (cachedSid) return cachedSid;
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  const sid = /S-1-\d+(?:-\d+)+/.exec(result.stdout || '')?.[0];
  if (result.status !== 0 || !sid) throw new Error('could not identify the current Windows user to protect a credential file');
  cachedSid = sid;
  return sid;
}

/**
 * Restrict an existing file to the current user, SYSTEM and local administrators.
 * POSIX uses owner-only mode 0600. Windows mode bits are not an ACL, so use the
 * caller's SID and icacls to remove inherited/broad access explicitly.
 */
export function securePrivateFile(file) {
  if (process.platform !== 'win32') {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
    return file;
  }
  const before = fileStamp(file);
  if (securedFiles.get(file) === before) return file;
  const sid = windowsUserSid();
  const reset = spawnSync('icacls.exe', [file, '/reset'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (reset.status !== 0) throw new Error('could not reset old permissions on a credential file');
  const result = spawnSync('icacls.exe', [
    file,
    '/inheritance:r',
    '/grant:r', `*${sid}:(F)`,
    '/grant', '*S-1-5-18:(F)',
    '*S-1-5-32-544:(F)',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) {
    throw new Error('could not restrict access to a credential file with icacls');
  }
  securedFiles.set(file, fileStamp(file));
  if (securedFiles.size > 5000) securedFiles.delete(securedFiles.keys().next().value);
  return file;
}

export function securePrivateDirectory(dir, { recursive = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cacheKey = `${dir}:${recursive ? 'tree' : 'root'}`;
  if (securedDirectories.has(cacheKey)) return dir;
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
  } else {
    const sid = windowsUserSid();
    const resetArgs = recursive ? [dir, '/reset', '/T', '/C'] : [dir, '/reset'];
    const reset = spawnSync('icacls.exe', resetArgs, {
      encoding: 'utf8', windowsHide: true, timeout: recursive ? 30000 : 10000,
    });
    if (reset.status !== 0) throw new Error('could not reset old permissions on the private directory');
    const protectArgs = [
      dir, '/inheritance:r',
      '/grant:r', `*${sid}:(OI)(CI)(F)`,
      '/grant', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)',
    ];
    if (recursive) protectArgs.push('/T', '/C');
    const result = spawnSync('icacls.exe', protectArgs, {
      encoding: 'utf8', windowsHide: true, timeout: recursive ? 30000 : 10000,
    });
    if (result.status !== 0) throw new Error('could not restrict access to the private directory with icacls');
  }
  securedDirectories.add(cacheKey);
  return dir;
}

export function writePrivateFile(file, data, options = {}) {
  try {
    // Create/truncate an empty file first, establish its ACL, and only then write
    // credential bytes. Do not briefly expose a secret through inherited ACLs.
    fs.writeFileSync(file, '', { mode: 0o600, ...(options.flag === 'wx' ? { flag: 'wx' } : {}) });
    securePrivateFile(file);
    fs.writeFileSync(file, data, { ...options, ...(options.flag === 'wx' ? { flag: 'w' } : {}) });
    // Cache the final content stamp too; writing data preserves the file ACL.
    securePrivateFile(file);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  return file;
}
