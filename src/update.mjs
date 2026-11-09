import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RELAY } from './license.mjs';

// One-click updates for the Windows app. The relay serves a small manifest signed with
// the vendor's update key (kept offline from the relay, separate from the license key);
// an installer is only run if the manifest verifies and the download matches its SHA-256.

const UPDATE_PUBLIC_KEYS = ['MCowBQYDK2VwAyEAsjVQJMUG0GVpN31cjGa92CcenQeoqoivaNZgW4XCimY='];
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;

export const updateUrl = () => process.env.WANJI_UPDATE_URL || `${DEFAULT_RELAY}/update/latest.json`;

export function currentVersion() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

// 0.6.16 > 0.6.15; anything that is not plain dotted numbers never counts as newer.
export function newerThan(a, b) {
  const parse = (v) => (/^\d+(\.\d+){1,3}$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// Release side: { payload: base64(JSON), signature: base64 } over the exact payload bytes.
export function signManifest(info, privateKeyPem) {
  const payload = Buffer.from(JSON.stringify(info), 'utf8');
  return { payload: payload.toString('base64'), signature: sign(null, payload, privateKeyPem).toString('base64') };
}

export function openManifest(manifest, keys = UPDATE_PUBLIC_KEYS) {
  if (!manifest || typeof manifest.payload !== 'string' || typeof manifest.signature !== 'string') throw new Error('the update manifest is malformed');
  const payload = Buffer.from(manifest.payload, 'base64');
  const signature = Buffer.from(manifest.signature, 'base64');
  const trusted = keys.some((der) => {
    try {
      return verify(null, payload, createPublicKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'spki' }), signature);
    } catch {
      return false;
    }
  });
  if (!trusted) throw new Error('the update manifest is not signed by 万机; refusing it');
  const info = JSON.parse(payload.toString('utf8'));
  if (!newerThan(info.version, '0.0') || typeof info.url !== 'string' || !/^[a-f0-9]{64}$/.test(info.sha256 || '')) throw new Error('the update manifest is incomplete');
  if (!/^https:\/\//.test(info.url) && !process.env.WANJI_UPDATE_URL) throw new Error('the update must be downloaded over HTTPS');
  return info;
}

export async function checkUpdate({ fetchImpl = fetch, current = currentVersion(), url = updateUrl(), keys } = {}) {
  const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return { current, available: false };
  if (!res.ok) throw new Error(`the update server answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new Error('the update manifest is too large');
  const info = openManifest(JSON.parse(text), keys);
  return { current, available: newerThan(info.version, current), ...info };
}

// Downloads to a private temp folder and checks the SHA-256 before returning the path.
export async function downloadUpdate(info, { fetchImpl = fetch, dir = path.join(os.tmpdir(), 'wanji-update') } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `Wanji-Setup-${String(info.version).replace(/[^0-9.]/g, '')}-update.exe`;
  const file = path.join(dir, name);
  const res = await fetchImpl(info.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok) throw new Error(`downloading the update failed: ${res.status}`);
  const hash = createHash('sha256');
  const part = `${file}.part`;
  const out = fs.createWriteStream(part);
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_INSTALLER_BYTES) throw new Error('the update download is too large');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== info.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('the downloaded update does not match its signature; it was deleted');
  }
  fs.rmSync(file, { force: true });
  fs.renameSync(part, file);
  return file;
}
