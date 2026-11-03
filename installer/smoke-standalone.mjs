import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CMCP_STANDALONE_ROOT;
if (!root) throw new Error('CMCP_STANDALONE_ROOT must be provided');
const mod = await import(pathToFileURL(path.join(root, 'app', 'src', 'server.mjs')).href);
const sh = await import(pathToFileURL(path.join(root, 'app', 'src', 'shell.mjs')).href);
console.log('ENV_PROGRAM_FILES=' + process.env.ProgramFiles);
console.log('ENV_PROGRAM_FILES_X86=' + process.env['ProgramFiles(x86)']);
console.log('DETECTED_GIT_BASH=' + sh.findBash());
const server = mod.createMcpServer({ name: 'windows-standalone-smoke', getToken: () => 'fixture-token-not-a-real-secret', auditFile: null, allowSse: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/t/fixture-token-not-a-real-secret/mcp`;
async function rpc(method, params) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(14000),
  });
  assert.equal(response.status, 200);
  return await response.json();
}
try {
  const list = await rpc('tools/list');
  const names = list.result.tools.map(t => t.name);
  assert.deepEqual(names, ['bash','job','read_file','write_file','edit_file','ui_look','ui_act']);
  console.log('PACKAGED_MCP_TOOL_LIST=OK ('+names.length+' tools)');
  // This workstation has Git Bash installed. Explicitly select PowerShell here;
  // on a clean Windows machine with no Git Bash, the tool selects it automatically.
  const shellOptions = sh.findBash() ? { shell: 'powershell' } : {};
  const output = await rpc('tools/call', { name: 'bash', arguments: { command: 'Write-Output STANDALONE_POWERSHELL_OK', wait: 10, timeout: 12, ...shellOptions } });
  assert.match(output.result.content[0].text, /STANDALONE_POWERSHELL_OK/);
  assert.equal(output.result.isError, undefined);
  console.log('PACKAGED_POWERSHELL_COMMAND=OK');
  console.log('STANDALONE_TEST=PASS');
} finally {
  await new Promise(resolve => server.close(resolve));
}
