// Signs the one-click update manifest for a built installer.
// node installer/publish-update.mjs --exe <installer.exe> --url <https download url> --key <update-signing-key.pem>
//   --out <relay home>\relay\update\latest.json [--notes "what changed"]
// The installer must already be downloadable at --url; the manifest only points at it.
import { createHash, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openManifest, signManifest } from '../src/update.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const need of ['exe', 'url', 'key', 'out']) if (!args[need]) throw new Error(`missing --${need}`);
const version = /Wanji-Setup-(\d+(?:\.\d+)+)-/.exec(path.basename(args.exe))?.[1];
if (!version) throw new Error('the installer file name must look like Wanji-Setup-<version>-Windows-x64.exe');
if (!args.url.startsWith('https://')) throw new Error('--url must be https');
if (path.basename(new URL(args.url).pathname) !== path.basename(args.exe)) throw new Error('--url must end with the installer file name (a new name per version avoids stale caches)');
const bytes = fs.readFileSync(args.exe);
const info = {
  version,
  url: args.url,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
  notes: String(args.notes || '').slice(0, 300),
  released: new Date().toISOString(),
};
const manifest = signManifest(info, createPrivateKey(fs.readFileSync(args.key)));
openManifest(manifest);
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`signed ${version} (${info.size} bytes, sha256 ${info.sha256}) -> ${args.out}`);
