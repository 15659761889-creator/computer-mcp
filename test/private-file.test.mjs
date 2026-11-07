import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { securePrivateDirectory, securePrivateFile, writePrivateFile } from '../src/private-file.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-private-file-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('credential files are restricted to the current user and system principals', () => {
  const file = path.join(dir, 'credential.json');
  writePrivateFile(file, JSON.stringify({ token: 'test-only-secret' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"token":"test-only-secret"}');

  if (process.platform === 'win32') {
    const result = spawnSync('icacls.exe', [file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /S-1-5-18|NT AUTHORITY\\SYSTEM/i);
    assert.match(result.stdout, /S-1-5-32-544|BUILTIN\\Administrators/i);
    assert.doesNotMatch(result.stdout, /BUILTIN\\Users:|NT AUTHORITY\\Authenticated Users:|Everyone:/i);
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  // Re-applying the helper also tightens an existing, previously permissive file.
  if (process.platform === 'win32') {
    const broad = spawnSync('icacls.exe', [file, '/grant', '*S-1-5-32-545:(F)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(broad.status, 0, broad.stderr);
  } else fs.chmodSync(file, 0o666);
  securePrivateFile(file);
  if (process.platform === 'win32') {
    const acl = spawnSync('icacls.exe', [file], { encoding: 'utf8', windowsHide: true });
    assert.equal(acl.status, 0, acl.stderr);
    assert.doesNotMatch(acl.stdout, /BUILTIN\\Users:|S-1-5-32-545:/i);
  } else assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('private directories remove broad grants and protect their future children', () => {
  const privateDir = path.join(dir, 'private-jobs');
  fs.mkdirSync(privateDir);
  if (process.platform === 'win32') {
    const broad = spawnSync('icacls.exe', [privateDir, '/grant', '*S-1-5-32-545:(OI)(CI)(F)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(broad.status, 0, broad.stderr);
  } else fs.chmodSync(privateDir, 0o777);
  securePrivateDirectory(privateDir);
  if (process.platform === 'win32') {
    const acl = spawnSync('icacls.exe', [privateDir], { encoding: 'utf8', windowsHide: true });
    assert.equal(acl.status, 0, acl.stderr);
    assert.doesNotMatch(acl.stdout, /BUILTIN\\Users:|S-1-5-32-545:/i);
  } else assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
});
