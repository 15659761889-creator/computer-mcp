import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from '../src/config.mjs';
import {
  buildMacLaunchAgentPlist,
  installMacAutostart,
  MACOS_AGENT_LABEL,
  macAutostartState,
  removeMacAutostart,
  startMacService,
  stopMacService,
} from '../src/autostart-macos.mjs';

test('macOS LaunchAgent uses an absolute executable and argument array, not a shell command', () => {
  const plist = buildMacLaunchAgentPlist({
    node: '/opt/node/bin/node',
    cli: '/Users/test user/.config/wanji/app/bin/wanji.mjs',
    workingDirectory: '/Users/test user',
    output: '/Users/test user/.config/wanji/logs/service.log',
    error: '/Users/test user/.config/wanji/logs/service-error.log',
    env: { PATH: '/opt/node/bin:/usr/bin', COMPUTER_MCP_HOME: '/Users/test & data/wanji' },
  });
  assert.match(plist, new RegExp(`<string>${MACOS_AGENT_LABEL}</string>`));
  assert.match(plist, /<key>ProgramArguments<\/key>[\s\S]*?<string>\/opt\/node\/bin\/node<\/string>[\s\S]*?<string>\/Users\/test user\/\.config\/wanji\/app\/bin\/wanji\.mjs<\/string>[\s\S]*?<string>run<\/string>/);
  assert.ok(plist.indexOf('<string>/opt/node/bin/node</string>') < plist.indexOf('<string>/Users/test user/.config/wanji/app/bin/wanji.mjs</string>'));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/test user\/\.config\/wanji\/logs\/service\.log<\/string>/);
  assert.match(plist, /Users\/test &amp; data\/wanji/);
  assert.doesNotMatch(plist, /<key>Shell<\/key>|bash -c|sh -c/);
});

test('macOS LaunchAgent keeps a stable label and a usable PATH fallback', () => {
  const plist = buildMacLaunchAgentPlist({ env: {} });
  assert.equal(MACOS_AGENT_LABEL, 'com.wanji.service');
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/opt\/homebrew\/sbin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
});

test('macOS homeDir defaults to ~/.config/wanji and supports WANJI_HOME', () => {
  assert.ok(homeDir('darwin', {}).endsWith(path.join('.config', 'wanji')));
  assert.equal(homeDir('darwin', { WANJI_HOME: '/tmp/my-wanji' }), '/tmp/my-wanji');
  const plist = buildMacLaunchAgentPlist({ env: { WANJI_HOME: '/Users/alice/wanji-data' } });
  assert.match(plist, /<key>WANJI_HOME<\/key>\s*<string>\/Users\/alice\/wanji-data<\/string>/);
});

test('installMacAutostart bootstraps the agent so it is loaded immediately, and reloads cleanly if already loaded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanji-mac-autostart-'));
  const agentPath = path.join(tmp, 'LaunchAgents', `${MACOS_AGENT_LABEL}.plist`);
  const logs = path.join(tmp, 'logs');
  let isLoaded = false;
  const calls = [];
  const mockLaunchctl = (...args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'print') return isLoaded ? { status: 0, stdout: 'state = running\n', stderr: '' } : { status: 113, stdout: '', stderr: 'not loaded' };
    if (cmd === 'enable' || cmd === 'disable') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'bootout') {
      isLoaded = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'bootstrap') {
      isLoaded = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'kickstart') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };

  try {
    const first = installMacAutostart({
      node: '/opt/homebrew/bin/node',
      platform: 'darwin',
      getUid: () => 501,
      agentPath,
      logs,
      launchctl: mockLaunchctl,
    });
    assert.equal(first.installed, true);
    assert.equal(first.loaded, true);
    assert.equal(isLoaded, true);
    assert.ok(fs.existsSync(agentPath));
    assert.ok(calls.some((c) => c[0] === 'bootstrap' && c[1] === 'gui/501' && c[2] === agentPath));
    assert.equal(macAutostartState({ platform: 'darwin', getUid: () => 501, agentPath, launchctl: mockLaunchctl }), 'LaunchAgent, running');

    // Re-installing while already loaded must bootout then bootstrap again.
    calls.length = 0;
    const second = installMacAutostart({
      node: '/opt/homebrew/bin/node',
      platform: 'darwin',
      getUid: () => 501,
      agentPath,
      logs,
      launchctl: mockLaunchctl,
    });
    assert.equal(second.installed, true);
    assert.equal(isLoaded, true);
    const bootoutIdx = calls.findIndex((c) => c[0] === 'bootout');
    const bootstrapIdx = calls.findIndex((c) => c[0] === 'bootstrap');
    assert.ok(bootoutIdx >= 0 && bootstrapIdx > bootoutIdx);

    // Start kickstarts when already loaded, stop boots out, remove cleans plist.
    startMacService({ platform: 'darwin', getUid: () => 501, agentPath, launchctl: mockLaunchctl });
    assert.equal(calls.at(-1)[0], 'kickstart');

    stopMacService({ platform: 'darwin', getUid: () => 501, launchctl: mockLaunchctl });
    assert.equal(isLoaded, false);

    assert.equal(removeMacAutostart({ platform: 'darwin', getUid: () => 501, agentPath, launchctl: mockLaunchctl }), true);
    assert.equal(fs.existsSync(agentPath), false);
    assert.equal(macAutostartState({ platform: 'darwin', getUid: () => 501, agentPath, launchctl: mockLaunchctl }), 'not installed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
