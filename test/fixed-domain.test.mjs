import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { findNamedTunnel } from '../src/tunnel.mjs';
import { hostnameFor } from '../src/config.mjs';

const cliPath = fileURLToPath(new URL('../bin/wanji.mjs', import.meta.url));

function isolatedSetup(...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-domain-test-'));
  try {
    return spawnSync(process.execPath, [cliPath, 'setup', 'pc1', ...args], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      env: { ...process.env, COMPUTER_MCP_HOME: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('fixed tunnel: first setup requires an explicitly provided domain', () => {
  const result = isolatedSetup();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --domain <your-domain>/);
});

test('fixed tunnel: rejects missing or malformed domain flags', () => {
  for (const args of [['--domain'], ['--domain', 'invalid'], ['--domain', '-bad.example']]) {
    const result = isolatedSetup(...args);
    assert.equal(result.status, 1, `expected validation error for ${args.join(' ')}`);
    assert.match(result.stderr, /requires --domain <your-domain>/);
  }
});

test('fixed tunnel: hostname is derived only from the supplied domain', () => {
  assert.equal(hostnameFor('pc1', 'my-own-site.com'), 'pc1-mcp.my-own-site.com');
});

test('fixed tunnel: Cloudflare null/empty tunnel lists are treated as no match', () => {
  assert.equal(findNamedTunnel('null', 'computer-mcp-pc1'), null);
  assert.equal(findNamedTunnel('[]', 'computer-mcp-pc1'), null);
  assert.equal(findNamedTunnel('', 'computer-mcp-pc1'), null);
  assert.equal(findNamedTunnel('[{"name":"computer-mcp-pc1","id":"id-123"}]', 'computer-mcp-pc1').id, 'id-123');
});
