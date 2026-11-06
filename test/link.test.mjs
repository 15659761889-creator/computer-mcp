import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createMcpServer } from '../src/server.mjs';
import { clearQuickLink, connectionParts, getQuickLink, quickLinkPath, saveQuickLink } from '../src/link.mjs';

const cli = fileURLToPath(new URL('../bin/wanji.mjs', import.meta.url));
const fixtureToken = 'abcdEFGHijklMNOPqrstUVWX01234567';

test('copy choices: combined URL and separate address / Bearer token are consistent', () => {
  const parts = connectionParts('https://pc-mcp.example.com', fixtureToken);
  assert.equal(parts.full, 'https://pc-mcp.example.com/t/' + fixtureToken + '/mcp');
  assert.equal(parts.address, 'https://pc-mcp.example.com/mcp');
  assert.equal(parts.key, fixtureToken);
  assert.throws(() => connectionParts('http://pc-mcp.example.com', fixtureToken), /HTTPS/);
});

test('fixed link CLI exposes each copy choice without changing live config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-copy-options-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hostname: 'pc-mcp.example.com', token: fixtureToken }));
    const run = (...args) => spawnSync(process.execPath, [cli, 'link', '--fixed', ...args], {
      env: { ...process.env, COMPUTER_MCP_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 8000,
    });
    const address = run('--address');
    const key = run('--key');
    const full = run('--show');
    assert.equal(address.status, 0, address.stderr);
    assert.equal(address.stdout.trim(), 'https://pc-mcp.example.com/mcp');
    assert.equal(key.status, 0, key.stderr);
    assert.equal(key.stdout.trim(), fixtureToken);
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.stdout.trim(), 'https://pc-mcp.example.com/t/' + fixtureToken + '/mcp');
    const bad = run('--address', '--key');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /choose either/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('temporary link can be recovered, but only while its secret matches the live server', async () => {
  const previousHome = process.env.COMPUTER_MCP_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-quick-link-'));
  process.env.COMPUTER_MCP_HOME = home;
  const server = createMcpServer({ name: 'temp-link-test', getToken: () => fixtureToken, auditFile: null, allowSse: false });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    saveQuickLink({ origin: 'https://unit-test.trycloudflare.com', token: fixtureToken, port });
    assert.equal(fs.existsSync(quickLinkPath()), true);
    const parts = await getQuickLink();
    assert.equal(parts.address, 'https://unit-test.trycloudflare.com/mcp');
    assert.equal(parts.key, fixtureToken);
    clearQuickLink(process.pid + 1);
    assert.equal(fs.existsSync(quickLinkPath()), true, 'another process must not clear the active link');
    saveQuickLink({ origin: 'https://unit-test.trycloudflare.com', token: 'wrong-token-1234567890123456', port });
    assert.equal(await getQuickLink(), null, 'stale or wrong key must not be shown');
    clearQuickLink();
    assert.equal(fs.existsSync(quickLinkPath()), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.COMPUTER_MCP_HOME;
    else process.env.COMPUTER_MCP_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
