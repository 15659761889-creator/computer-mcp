// A real model, given only the MCP link, completes a desktop task on its own.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/computer-mcp/config.json`, 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-model-'));
const mcp = path.join(dir, 'mcp.json');
fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { computer: { type: 'http', url: `https://${cfg.hostname}/t/${cfg.token}/mcp` } } }));
const note = path.join(dir, '结果.txt').split(path.sep).join('/');
const prompt = `You control a Windows computer only through the "computer" MCP tools. Do this task end to end:
1. Open the Windows Calculator app.
2. Using its on-screen buttons, not the keyboard, calculate 1234 × 5678.
3. Read the answer from the display.
4. Open Notepad on a new file at ${note} (create the empty file first), type "计算结果: " followed by the answer into Notepad's window with ui_act, and save it with ctrl+s.
5. Close Calculator and Notepad.
Reply with only the answer number when finished.`;
const audit = path.join(process.env.APPDATA, 'computer-mcp', 'logs', 'audit.jsonl');
const before = fs.readFileSync(audit, 'utf8').split('\n').length;
const t0 = Date.now();
const run = spawnSync('claude.exe', ['-p', '--mcp-config', mcp, '--strict-mcp-config', '--allowedTools', 'mcp__computer__*', '--disallowedTools', 'Bash,PowerShell,Read,Write,Edit,Glob,Grep,Agent', '--model', 'sonnet', '--max-turns', '40', '--output-format', 'json'], { cwd: dir, encoding: 'utf8', timeout: 500000, input: prompt, windowsHide: true });
fs.rmSync(mcp, { force: true });
const secs = Math.round((Date.now() - t0) / 1000);
let result = {};
try { result = JSON.parse(run.stdout); } catch { console.log('raw', (run.stdout || '').slice(0, 500), (run.stderr || '').slice(0, 500)); }
console.log(`model finished in ${secs}s; turns=${result.num_turns}; is_error=${result.is_error}; cost=${result.total_cost_usd}`);
console.log('model answer:', String(result.result).slice(0, 300));
console.log('correct answer: 7006652');
const content = fs.existsSync(note.replaceAll('/', path.sep)) ? fs.readFileSync(note.replaceAll('/', path.sep), 'utf8') : '(no file)';
console.log('file on disk:', JSON.stringify(content));
const used = fs.readFileSync(audit, 'utf8').split('\n').slice(before - 1).filter(Boolean).map((l) => JSON.parse(l));
const byTool = {};
let errors = 0;
for (const e of used) { byTool[e.tool] = (byTool[e.tool] || 0) + 1; if (e.error) { errors += 1; console.log('  refused/failed:', e.tool, JSON.stringify(e.args).slice(0, 120), '->', e.error.split('\n')[0].slice(0, 160)); } }
console.log('tool calls:', JSON.stringify(byTool), 'errors:', errors);
console.log('sequence:', used.map((e) => (e.tool === 'ui_act' ? `act:${e.args.action || 'steps'}` : e.tool)).join(' '));
fs.rmSync(dir, { recursive: true, force: true });
