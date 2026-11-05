import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillStore, parseSkillFile } from '../src/skills.mjs';

const mkEnv = (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-skills-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dir = path.join(temp, 'skills');
  fs.mkdirSync(dir);
  const root = path.join(dir, 'python-workflow');
  fs.mkdirSync(root);
  const md = `---\nname: python-workflow\ndescription: Test Python project setup safely\ndesigned_for:\n  os: [windows, linux]\nrequires:\n  commands: [python]\n---\n# Python workflow\nRun only on the selected target computer.\n`;
  fs.writeFileSync(path.join(root, 'SKILL.md'), md);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'check.py'), 'print("ready")\n');
  const computers = [
    { name: 'pc-test', os: 'Windows_NT 10.0.26200', online: true, home: 'C:/Users/testuser' },
    { name: 'linux-vm', os: 'Linux 6.18', online: true, home: '/home/ai' },
    { name: 'offline-linux', os: 'Linux 6.18', online: false, home: '/home/offline' },
  ];
  const store = new SkillStore({ dir, stateFile: path.join(temp, 'state.json'), computers: () => computers });
  return { temp, dir, root, store, computers };
};

test('load finds a skill and its helper without executing the helper', (t) => {
  const { store } = mkEnv(t);
  const listing = JSON.parse(store.list({ computer: 'pc-test' }).text);
  assert.equal(listing.count, 1);
  assert.equal(listing.skills[0].status['pc-test'], 'needs_setup');
  assert.match(store.load({ name: 'python-workflow', computer: 'pc-test' }).text, /Run only on the selected target computer/);
  assert.match(store.load({ name: 'python-workflow', computer: 'pc-test' }).text, /scripts\/check\.py/);
  assert.match(store.read({ name: 'python-workflow', path: 'scripts/check.py' }).text, /print\("ready"\)/);
});

test('per-computer config only changes the selected load and not skill identity', (t) => {
  const { store, root } = mkEnv(t);
  const ref = JSON.parse(store.list().text).skills[0].ref;
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'pc-test.yaml'), 'workspace: C:/project\n');
  assert.equal(JSON.parse(store.list().text).skills[0].ref, ref);
  assert.match(store.load({ name: 'python-workflow', computer: 'pc-test' }).text, /workspace: C:\/project/);
  assert.doesNotMatch(store.load({ name: 'python-workflow', computer: 'linux-vm' }).text, /workspace: C:\/project/);
});

test('malformed and traversal requests fail closed', (t) => {
  const { store, dir } = mkEnv(t);
  const bad = path.join(dir, 'bad-skill');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: not-the-folder\ndescription: Invalid\n---\n# Invalid\n');
  const result = JSON.parse(store.list().text);
  assert.equal(result.count, 1);
  assert.equal(result.problems[0].folder, 'bad-skill');
  for (const candidate of ['../secrets.txt', '../../outside.txt', 'C:/Windows/win.ini']) {
    assert.equal(store.tool('skill_read', { name: 'python-workflow', path: candidate }).isError, true, candidate);
  }
  assert.equal(store.tool('skill_load', { name: 'missing', computer: 'pc-test' }).isError, true);
  assert.equal(store.tool('skill_load', { name: 'python-workflow', computer: 'not-a-real-pc' }).isError, true);
});

test('offline target and unsupported OS are explicitly labelled', (t) => {
  const { store } = mkEnv(t);
  const r = JSON.parse(store.list({ computer: ['pc-test', 'offline-linux'] }).text);
  assert.equal(r.skills[0].status['offline-linux'], 'offline');
  assert.equal(r.skills[0].status['pc-test'], 'needs_setup');
});

test('designed_for.computers excludes a different computer even when its OS matches', (t) => {
  const { store, root } = mkEnv(t);
  const source = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'SKILL.md'), source.replace('  os: [windows, linux]', '  os: [windows, linux]\\n  computers: [pc-test]'.replace('\\n', '\n')));
  const listing = JSON.parse(store.list({ computer: ['pc-test', 'linux-vm'] }).text);
  assert.equal(listing.skills[0].status['pc-test'], 'needs_setup');
  assert.equal(listing.skills[0].status['linux-vm'], 'incompatible');
});

test('per-computer config never follows a folder link outside the skill root', (t) => {
  const { store, temp, root } = mkEnv(t);
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'pc-test.yaml'), 'SECRET-OUTSIDE-SKILL\n');
  try { fs.symlinkSync(outside, path.join(root, 'config'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('directory symlinks unavailable'); return; } throw error; }
  assert.doesNotMatch(store.load({ name: 'python-workflow', computer: 'pc-test' }).text, /SECRET-OUTSIDE-SKILL/);
});

test('parseSkillFile requires structured frontmatter', () => {
  assert.throws(() => parseSkillFile('# No frontmatter\n'));
  assert.deepEqual(parseSkillFile('---\nname: test\ndescription: Basic\n---\nGo.\n').data.name, 'test');
});

test('skill_verify records a check and goes stale when the skill changes', (t) => {
  const { store, root, temp } = mkEnv(t);
  const status = () => JSON.parse(store.list({ computer: 'pc-test' }).text).skills[0].status['pc-test'];
  assert.equal(status(), 'needs_setup');
  assert.equal(store.tool('skill_verify', { name: 'python-workflow', computer: 'offline-linux' }).isError, true);
  const verified = store.tool('skill_verify', { name: 'python-workflow', computer: 'pc-test', note: 'python 3.12 present' });
  assert.equal(verified.isError, undefined);
  assert.equal(status(), 'ready');
  const state = JSON.parse(fs.readFileSync(path.join(temp, 'state.json'), 'utf8'));
  assert.equal(state.adaptations['pc-test']['python-workflow'].note, 'python 3.12 present');
  assert.equal(store.tool('skill_verify', { name: 'python-workflow', computer: 'pc-test' }).isError, undefined);
  fs.appendFileSync(path.join(root, 'SKILL.md'), '\nExtra line.\n');
  assert.equal(status(), 'stale');
  store.tool('skill_verify', { name: 'python-workflow', computer: 'pc-test', note: 're-checked after edit' });
  assert.equal(status(), 'ready');
});

