import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { globToRegex, resetRipgrepCache } from '../src/search.mjs';
import { encodeFile } from '../src/text.mjs';
import { callTool } from '../src/tools.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-search-'));
const write = (rel, data) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

before(() => {
  write('.gitignore', 'build/\n*.log\n!keep.log\n');
  write('src/main.lua', 'local x = 1\nfunction hello()\n  print("needle one")\nend\n');
  write('src/util/helper.lua', 'return { needle = 2 }\n');
  write('src/app.js', 'const a = 1;\n// NEEDLE in caps\nconst b = 2;\nconst c = 3;\n');
  write('docs/readme.md', 'nothing here\n');
  write('build/out.lua', 'needle in build output\n');
  write('debug.log', 'needle in a log\n');
  write('keep.log', 'needle kept\n');
  write('node_modules/pkg/index.js', 'needle in a dependency\n');
  write('.git/config', 'needle in git\n');
  write('enc/utf16.txt', encodeFile('第一行\n中文针 needle16\n', 'utf16le'));
  write('enc/gbk.txt', encodeFile('你好\n这是中文针\n', 'gbk'));
  write('enc/blob.bin', Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
  // Distinct times so newest-first order is testable.
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(root, 'src/util/helper.lua'), now - 100, now - 100);
  fs.utimesSync(path.join(root, 'src/main.lua'), now - 50, now - 50);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WANJI_RG;
  resetRipgrepCache();
});

const rel = (text) => text.split('\n').filter((l) => !l.startsWith('[')).map((l) => path.relative(root, l.split(/:(?=\d)/)[0] === l ? l : l.slice(0, l.lastIndexOf(':'))).replace(/\\/g, '/'));

test('glob to regex', () => {
  assert.ok(globToRegex('**/*.lua').test('a/b/c.lua'));
  assert.ok(globToRegex('**/*.lua').test('c.lua'));
  assert.ok(!globToRegex('*.lua').test('a/c.lua'));
  assert.ok(globToRegex('src/**/*.{js,lua}').test('src/x/y.js'));
  assert.ok(globToRegex('file?.[ch]').test('file1.c'));
});

// Same behaviour from the built-in walker and from ripgrep (when this machine has one).
const RG = [process.env.WANJI_TEST_RG, 'C:/Users/30323/AppData/Local/Programs/Microsoft VS Code/16507d91be/resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe']
  .find((file) => file && fs.existsSync(file));
for (const engine of ['walker', ...(RG ? ['ripgrep'] : [])]) {
  describe(`search via ${engine}`, () => {
    before(() => { process.env.WANJI_RG = engine === 'walker' ? 'off' : RG; resetRipgrepCache(); });

    test('grep: files, skips .git, node_modules, .gitignore, binary; reads UTF-16 and GBK', async () => {
      const out = await callTool('grep', { pattern: 'needle', path: root });
      assert.equal(out.isError, undefined, out.text);
      const files = rel(out.text).sort();
      assert.deepEqual(files, ['enc/utf16.txt', 'keep.log', 'src/main.lua', 'src/util/helper.lua'].sort());
      // Lookahead: JavaScript regex that ripgrep rejects, so its prefilter must step aside.
      assert.deepEqual(rel((await callTool('grep', { pattern: 'needle(?= one)', path: root })).text), ['src/main.lua']);
      const gbk = await callTool('grep', { pattern: '中文针', path: root });
      assert.deepEqual(rel(gbk.text).sort(), ['enc/gbk.txt', 'enc/utf16.txt']);
    });

    test('grep: newest first, -i, glob, type, ignored', async () => {
      const out = await callTool('grep', { pattern: 'needle', path: path.join(root, 'src') });
      assert.deepEqual(rel(out.text), ['src/main.lua', 'src/util/helper.lua']);
      assert.ok(rel((await callTool('grep', { pattern: 'needle', path: root, '-i': true })).text).includes('src/app.js'));
      assert.deepEqual(rel((await callTool('grep', { pattern: 'needle', path: root, glob: '**/*.lua' })).text).sort(), ['src/main.lua', 'src/util/helper.lua']);
      assert.deepEqual(rel((await callTool('grep', { pattern: 'needle', path: root, type: 'js', '-i': true })).text), ['src/app.js']);
      const all = rel((await callTool('grep', { pattern: 'needle', path: root, ignored: true })).text);
      for (const f of ['build/out.lua', 'debug.log', 'node_modules/pkg/index.js']) assert.ok(all.includes(f), f);
      assert.ok(!all.includes('.git/config'));
    });

    test('grep: content with line numbers and context, count, head_limit', async () => {
      const out = await callTool('grep', { pattern: 'needle', path: path.join(root, 'src/main.lua'), output_mode: 'content', context: 1 });
      const lines = out.text.split('\n');
      assert.match(lines[0], /main\.lua-2-function hello\(\)$/);
      assert.match(lines[1], /main\.lua:3:  print\("needle one"\)$/);
      assert.match(lines[2], /main\.lua-4-end$/);
      const count = await callTool('grep', { pattern: 'const', path: root, output_mode: 'count' });
      assert.match(count.text, /app\.js:3/);
      const cut = await callTool('grep', { pattern: 'needle', path: root, head_limit: 1 });
      assert.equal(rel(cut.text).length, 1);
      assert.match(cut.text, /head_limit 1/);
    });

    test('glob: newest first, gitignore, limit', async () => {
      const out = await callTool('glob', { pattern: '**/*.lua', path: root });
      assert.deepEqual(rel(out.text), ['src/main.lua', 'src/util/helper.lua']);
      assert.deepEqual(rel((await callTool('glob', { pattern: '*.log', path: root })).text), ['keep.log']);
      assert.ok(rel((await callTool('glob', { pattern: '**/*.lua', path: root, ignored: true })).text).includes('build/out.lua'));
      assert.equal(rel((await callTool('glob', { pattern: '**/*', path: root, limit: 2 })).text).length, 2);
      assert.match((await callTool('glob', { pattern: '*.nope', path: root })).text, /no files match/);
    });
  });
}

test('grep and glob: errors are clear', async () => {
  assert.match((await callTool('grep', { pattern: '(', path: root })).text, /bad regex/);
  assert.match((await callTool('grep', { pattern: 'x', path: path.join(root, 'missing') })).text, /no such file/);
  assert.equal((await callTool('glob', { pattern: '*', path: path.join(root, 'keep.log') })).isError, true);
});

test('wait_for: file_match fires on appended text, new_only ignores old text', async () => {
  const log = write('wait/app.log', 'starting\nListening on 1\n');
  const now = await callTool('wait_for', { file_match: { path: log, regex: 'Listening' }, timeout: 5 });
  assert.match(now.text, /^file_match: .*Listening on 1/);
  const pending = callTool('wait_for', { file_match: { path: log, regex: 'Listening on \\d', new_only: true }, timeout: 10 });
  await sleep(700);
  fs.appendFileSync(log, 'Listening on 2\n');
  const fired = await pending;
  assert.match(fired.text, /Listening on 2/);
});

test('wait_for: file_changed, timeout reply, bad input', async () => {
  const file = path.join(root, 'wait/flag.txt');
  const pending = callTool('wait_for', { file_changed: { path: file }, timeout: 10 });
  await sleep(700);
  fs.writeFileSync(file, 'x');
  assert.match((await pending).text, /file_changed: .*was created/);
  const started = Date.now();
  const idle = await callTool('wait_for', { file_changed: { path: file }, timeout: 1 });
  assert.match(idle.text, /^timeout/);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await callTool('wait_for', {})).isError, true);
  assert.equal((await callTool('wait_for', { process_exit: { pid: 'x' } })).isError, true);
});

test('wait_for: process_exit and port_open', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
  const exited = await callTool('wait_for', { process_exit: { pid: child.pid }, timeout: 10 });
  assert.match(exited.text, /process_exit: pid \d+ is not running/);

  const probe = net.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  probe.close();
  const pending = callTool('wait_for', { port_open: { port }, timeout: 10 });
  await sleep(700);
  const server = net.createServer((s) => s.destroy());
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  try {
    assert.match((await pending).text, new RegExp(`port_open: 127.0.0.1:${port}`));
  } finally {
    server.close();
  }
});

test('wait_for: job_done after a bash job', async () => {
  const started = await callTool('bash', { command: 'node -e "setTimeout(() => console.log(42), 1200)"', background: true });
  const id = /job: (\S+)/.exec(started.text)[1];
  const done = await callTool('wait_for', { job_done: { id }, timeout: 20 });
  assert.match(done.text, new RegExp(`job_done: job ${id} (exited|done|finished)`));
  assert.equal((await callTool('wait_for', { job_done: { id: 'nope' } })).isError, true);
});
