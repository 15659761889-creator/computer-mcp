// Calls the local hub's pool tools over MCP for an AI that only has a shell.
// The session token is kept in a private state file and never printed.
// usage: node pool-cli.mjs <name> join|read|post|ack '<json args>'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , name, action, json = '{}'] = process.argv;
const tools = { join: 'pool_join', read: 'pool_read', post: 'pool_post', ack: 'pool_ack' };
if (!/^[a-z0-9-]+$/i.test(name || '') || !tools[action]) {
  console.error("usage: node pool-cli.mjs <name> join|read|post|ack '<json args>'");
  process.exit(2);
}
const home = process.env.COMPUTER_MCP_HOME || path.join(process.env.APPDATA || os.homedir(), 'computer-mcp');
const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
const stateFile = path.join(os.tmpdir(), `pool-cli-${name}.json`);
const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const args = JSON.parse(json);
if (action !== 'join') {
  if (!saved) { console.error('join first'); process.exit(2); }
  Object.assign(args, { session_id: saved.session_id, session_token: saved.session_token });
}
const res = await fetch(`http://127.0.0.1:${config.port}/t/${config.token}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tools[action], arguments: args } }),
});
const text = await res.text();
const body = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text);
const result = body.result;
if (!result) { console.error(JSON.stringify(body.error)); process.exit(1); }
let out = result.content[0].text;
if (action === 'join' && !result.isError) {
  const joined = JSON.parse(out);
  fs.writeFileSync(stateFile, JSON.stringify({ session_id: joined.session_id, session_token: joined.session_token }), { mode: 0o600 });
  delete joined.session_token;
  out = JSON.stringify(joined, null, 2);
}
console.log(result.isError ? `ERROR: ${out}` : out);
process.exit(result.isError ? 1 : 0);
