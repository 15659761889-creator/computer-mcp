import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { Relay } from '../src/relay.mjs';
import { checkUpdate, downloadUpdate, newerThan, openManifest, signManifest } from '../src/update.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-update-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};
const ours = keyPair();
const bytes = Buffer.from('MZ fake installer bytes');
const info = { version: '0.7.0', url: 'https://wanji.3618.app/downloads/Wanji-Setup-0.7.0-Windows-x64.exe', sha256: createHash('sha256').update(bytes).digest('hex'), notes: 'iPhone 版' };
const respond = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body, body: Readable.from([Buffer.from(body)]) });

test('version comparison', () => {
  assert.equal(newerThan('0.6.16', '0.6.15'), true);
  assert.equal(newerThan('0.7.0', '0.6.99'), true);
  assert.equal(newerThan('0.6.15', '0.6.15'), false);
  assert.equal(newerThan('0.6.9', '0.6.15'), false);
  assert.equal(newerThan('1.0', '0.9.9'), true);
  assert.equal(newerThan('0.7.0-beta', '0.6.0'), false);
  assert.equal(newerThan(undefined, '0.6.0'), false);
});

test('a manifest opens only with the right key and untouched payload', () => {
  const manifest = signManifest(info, ours.privateKey);
  assert.deepEqual(openManifest(manifest, [ours.pub]), info);
  assert.throws(() => openManifest(manifest, [keyPair().pub]), /not signed/);
  assert.throws(() => openManifest(manifest), /not signed/, 'the embedded vendor key does not trust a test key');
  const tampered = { ...manifest, payload: Buffer.from(JSON.stringify({ ...info, url: 'https://evil.example/x.exe' })).toString('base64') };
  assert.throws(() => openManifest(tampered, [ours.pub]), /not signed/);
  assert.throws(() => openManifest({ payload: 1 }, [ours.pub]), /malformed/);
  assert.throws(() => openManifest(signManifest({ ...info, url: 'http://insecure/x.exe' }, ours.privateKey), [ours.pub]), /HTTPS/);
  assert.throws(() => openManifest(signManifest({ ...info, sha256: 'nope' }, ours.privateKey), [ours.pub]), /incomplete/);
});

test('checkUpdate says whether the signed version is newer', async () => {
  const body = JSON.stringify(signManifest(info, ours.privateKey));
  const newer = await checkUpdate({ fetchImpl: async () => respond(200, body), current: '0.6.16', keys: [ours.pub] });
  assert.equal(newer.available, true);
  assert.equal(newer.version, '0.7.0');
  const same = await checkUpdate({ fetchImpl: async () => respond(200, body), current: '0.7.0', keys: [ours.pub] });
  assert.equal(same.available, false);
  assert.equal((await checkUpdate({ fetchImpl: async () => respond(404, '{}'), current: '0.6.16' })).available, false);
  await assert.rejects(checkUpdate({ fetchImpl: async () => respond(200, body), current: '0.6.16' }), /not signed/);
});

test('download keeps the file only if its SHA-256 matches', async () => {
  const target = path.join(dir, 'dl');
  const file = await downloadUpdate(info, { fetchImpl: async () => respond(200, bytes.toString()), dir: target });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.match(path.basename(file), /^Wanji-Setup-0\.7\.0-update\.exe$/);
  await assert.rejects(downloadUpdate(info, { fetchImpl: async () => respond(200, 'something else'), dir: path.join(dir, 'bad') }), /does not match/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bad')), [], 'a mismatching download is deleted');
});

test('the relay serves the published manifest without caching', async () => {
  const relayDir = path.join(dir, 'relay');
  const relay = new Relay({ dir: relayDir, config: { host: '127.0.0.1', tls: 'none', origin: 'https://relay.example.com', shared: false } });
  const server = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/update/latest.json`;
  try {
    assert.equal((await fetch(url)).status, 404);
    fs.mkdirSync(path.join(relayDir, 'update'), { recursive: true });
    const manifest = signManifest(info, ours.privateKey);
    fs.writeFileSync(path.join(relayDir, 'update', 'latest.json'), JSON.stringify(manifest));
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(openManifest(await res.json(), [ours.pub]), info);
  } finally {
    relay.close();
    server.closeAllConnections();
    server.close();
  }
});
