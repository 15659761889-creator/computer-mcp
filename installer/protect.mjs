// Minifies every .mjs file of a staged app in place, one file at a time, so the
// installed copy ships no readable source. Files keep their names and folders,
// because the code finds its own files relative to import.meta.url.
// esbuild lives in build/tools (not in the repo); build-windows.ps1 installs it there.
// Usage: node installer/protect.mjs <staged app dir>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'tools', 'package.json');
const { transformSync } = createRequire(tools)('esbuild');

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error('usage: node installer/protect.mjs <staged app dir>');
  process.exit(2);
}

let files = 0;
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.mjs')) {
      const source = fs.readFileSync(full, 'utf8');
      // Keep a #! line: bin/wanji.mjs is run directly on Linux.
      const shebang = /^#!.*\n/.exec(source)?.[0] || '';
      const { code } = transformSync(source.slice(shebang.length), {
        loader: 'js', format: 'esm', platform: 'node', target: 'node20',
        minify: true, legalComments: 'none', charset: 'utf8', sourcefile: path.relative(root, full),
      });
      fs.writeFileSync(full, shebang + code);
      files += 1;
      before += source.length;
      after += shebang.length + code.length;
    }
  }
};
for (const dir of ['bin', 'src']) walk(path.join(root, dir));
console.log(`PROTECTED_FILES=${files} ${before} -> ${after} chars`);
