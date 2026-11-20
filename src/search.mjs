// grep and glob: find files and text without a shell. ripgrep, when present, only walks the
// folders (fast, honours .gitignore); the text itself is always matched here, so UTF-16 and GBK
// files are found the same way read_file decodes them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFile, looksBinary } from './text.mjs';

export const DEFAULT_HEAD_LIMIT = 250;
export const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 5000;
const MAX_CONTEXT = 20;
const MAX_FILES = 200000;
const MAX_SEARCH_BYTES = 50 * 1024 * 1024;
const MAX_LINE_CHARS = 500;
// The reply has to beat the 90 s call limit of the relay.
const BUDGET_MS = 60000;
const ALWAYS_SKIPPED = new Set(['.git', 'node_modules']);

// The small set of --type names the built-in walker knows; ripgrep knows many more.
const TYPES = {
  js: ['js', 'mjs', 'cjs', 'jsx'], ts: ['ts', 'mts', 'cts', 'tsx'], py: ['py', 'pyi'], lua: ['lua'], go: ['go'],
  rust: ['rs'], java: ['java'], kotlin: ['kt', 'kts'], c: ['c', 'h'], cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
  cs: ['cs'], json: ['json'], md: ['md', 'markdown'], html: ['html', 'htm'], css: ['css', 'scss', 'less'],
  sh: ['sh', 'bash'], ps: ['ps1', 'psm1', 'psd1'], yaml: ['yaml', 'yml'], toml: ['toml'], xml: ['xml'], txt: ['txt'],
  php: ['php'], rb: ['rb'], swift: ['swift'], sql: ['sql'], vue: ['vue'], ini: ['ini', 'cfg', 'conf'],
};

class SearchError extends Error {}

// Glob to RegExp: ** crosses folders, * and ? stay inside one, {a,b} picks one of them.
export function globToRegex(glob, ignoreCase = process.platform === 'win32') {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; continue; }
      out += `(?:${glob.slice(i + 1, end).split(',').map((part) => globToRegex(part, ignoreCase).source.slice(1, -1)).join('|')})`;
      i = end;
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { out += '\\['; continue; }
      out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else out += /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`, ignoreCase ? 'i' : '');
}

// A pattern without a slash matches the file name anywhere below the root, as in ripgrep.
// A leading ! excludes instead.
function globMatcher(glob) {
  const negate = glob.startsWith('!');
  const clean = glob.slice(negate ? 1 : 0).replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegex(clean);
  const test = clean.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
  return negate ? (rel) => !test(rel) : test;
}

function parseIgnore(text) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    const body = globToRegex(line).source.slice(1, -1);
    rules.push({ negate, dirOnly, re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`, process.platform === 'win32' ? 'i' : '') });
  }
  return rules;
}

// Last matching rule wins, folders' own .gitignore after their parents'.
function ignoredBy(stack, rel, isDir) {
  let ignored = false;
  for (const { base, rules } of stack) {
    const sub = base ? (rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : null) : rel;
    if (sub === null) continue;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(sub)) ignored = !rule.negate;
    }
  }
  return ignored;
}

// Built-in walker for computers without ripgrep. Yields paths relative to root, with / separators.
async function* walk(root, { ignored = false, deadline }) {
  const queue = [{ rel: '', stack: [] }];
  let seen = 0;
  while (queue.length) {
    const { rel, stack: parentStack } = queue.shift();
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let stack = parentStack;
    if (!ignored) {
      const gi = entries.find((e) => e.name === '.gitignore' && e.isFile());
      if (gi) {
        const rules = parseIgnore(await fsp.readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => ''));
        if (rules.length) stack = [...parentStack, { base: rel, rules }];
      }
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (isDir && entry.name === '.git') continue;
      if (!ignored && ((isDir && ALWAYS_SKIPPED.has(entry.name)) || ignoredBy(stack, childRel, isDir))) continue;
      if (isDir) queue.push({ rel: childRel, stack });
      else if (entry.isFile() || entry.isSymbolicLink()) {
        seen += 1;
        if (seen > MAX_FILES || Date.now() > deadline) { yield { stop: seen > MAX_FILES ? 'files' : 'time' }; return; }
        yield { rel: childRel };
      }
    }
  }
}

let rgCache;
// ripgrep from WANJI_RG (off: never), next to the app (bin/rg.exe) or on PATH.
export function findRipgrep() {
  if (rgCache !== undefined) return rgCache;
  if (process.env.WANJI_RG === 'off') return (rgCache = null);
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.WANJI_RG, path.join(here, '..', 'bin', exe), path.join(here, '..', '..', 'bin', exe),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe))];
  rgCache = candidates.find((file) => file && fs.existsSync(file)) || null;
  return rgCache;
}
export function resetRipgrepCache() { rgCache = undefined; }

// No --glob from the caller: ripgrep lets a glob override .gitignore, so globMatcher filters names.
// With prefilter, ripgrep also reads the files and lists only those that may match.
async function* ripgrepFiles(rg, root, { type, ignored, deadline, prefilter }) {
  const args = [...(prefilter ? ['--files-with-matches', '--max-filesize', '50M', ...(prefilter.ignoreCase ? ['-i'] : []), '-e', prefilter.pattern] : ['--files']), '--hidden', '--no-require-git', '--no-messages', '--glob', '!.git'];
  if (ignored) args.push('--no-ignore');
  else args.push('--glob', '!node_modules');
  if (type) args.push('--type', type);
  const child = spawn(rg, [...args, '.'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => { child.on('close', resolve); child.on('error', (err) => { stderr += err.message; resolve(2); }); });
  let rest = '';
  let seen = 0;
  try {
    for await (const chunk of child.stdout) {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const rel = line.replace(/\r$/, '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (!rel) continue;
        seen += 1;
        if (seen > MAX_FILES || Date.now() > deadline) { yield { stop: seen > MAX_FILES ? 'files' : 'time' }; return; }
        yield { rel };
      }
    }
    const code = await exited;
    if (code === 2 && !seen && stderr) throw new SearchError(`ripgrep: ${stderr.trim().split('\n')[0]}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

// Every file below root that passes the filters, from ripgrep or the built-in walker.
async function* candidates(root, { glob, type, ignored, deadline, prefilter }) {
  const rg = findRipgrep();
  let exts = null;
  if (type && !rg) {
    exts = TYPES[type.toLowerCase()];
    if (!exts) throw new SearchError(`unknown type "${type}"; known: ${Object.keys(TYPES).join(', ')}. Or use glob, e.g. *.ext`);
  }
  const match = glob ? globMatcher(glob) : null;
  const source = rg ? ripgrepFiles(rg, root, { type, ignored, deadline, prefilter }) : walk(root, { ignored, deadline });
  for await (const item of source) {
    if (item.stop) { yield item; return; }
    if (exts && !exts.includes(path.extname(item.rel).slice(1).toLowerCase())) continue;
    if (match && !match(item.rel)) continue;
    yield item;
  }
}

async function statRoot(root) {
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat) throw new SearchError(`no such file or folder: ${root}`);
  return stat;
}

const stopNote = (stop) => (stop === 'time'
  ? `stopped after ${BUDGET_MS / 1000} s; results are partial. Narrow path, glob or type.`
  : `stopped after ${MAX_FILES} files; results are partial. Narrow path, glob or type.`);

function cutLine(line) {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [... ${line.length} chars]` : line;
}

function readLines(buf) {
  if (looksBinary(buf)) return null;
  const lines = decodeFile(buf).text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function needCount(value, name, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new SearchError(`${name} must be a whole number, 0 or more`);
  return max === undefined ? value : Math.min(value, max);
}

export async function grep(args, root) {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new SearchError('pattern must be a non-empty string');
  let re;
  try {
    re = new RegExp(args.pattern, args['-i'] === true ? 'i' : '');
  } catch (err) {
    throw new SearchError(`bad regex: ${err.message}`);
  }
  const mode = args.output_mode ?? 'files_with_matches';
  if (!['files_with_matches', 'content', 'count'].includes(mode)) throw new SearchError('output_mode must be files_with_matches, content or count');
  const both = needCount(args.context, 'context', 0, MAX_CONTEXT);
  const before = needCount(args['-B'], '-B', both, MAX_CONTEXT);
  const afterN = needCount(args['-A'], '-A', both, MAX_CONTEXT);
  const headLimit = needCount(args.head_limit, 'head_limit', DEFAULT_HEAD_LIMIT) || Infinity;
  const stat = await statRoot(root);
  const deadline = Date.now() + BUDGET_MS;

  const files = [];
  let stop = null;
  if (stat.isFile()) files.push(root);
  else {
    const options = { glob: args.glob, type: args.type, ignored: args.ignored === true, deadline };
    // ripgrep can skip non-matching files itself, but it reads GBK as bytes and its regex
    // syntax differs a little, so only ASCII patterns use it and a pattern it rejects falls back.
    const prefilter = findRipgrep() && /^[ -]*$/.test(args.pattern) ? { pattern: args.pattern, ignoreCase: args['-i'] === true } : null;
    for (const pre of prefilter ? [prefilter, null] : [null]) {
      try {
        for await (const item of candidates(root, { ...options, prefilter: pre })) {
          if (item.stop) { stop = item.stop; break; }
          files.push(path.join(root, item.rel));
        }
        break;
      } catch (err) {
        if (!pre || !(err instanceof SearchError)) throw err;
        files.length = 0;
        stop = null;
      }
    }
  }

  // Each file: matching line numbers, or null when nothing matched.
  const hits = [];
  let next = 0;
  let outputLines = 0;
  const enough = () => mode === 'content' && outputLines >= headLimit;
  async function worker() {
    while (next < files.length && !enough()) {
      if (Date.now() > deadline) { stop = 'time'; return; }
      const index = next++;
      const file = files[index];
      const info = await fsp.stat(file).catch(() => null);
      if (!info?.isFile() || info.size > MAX_SEARCH_BYTES) continue;
      const buf = await fsp.readFile(file).catch(() => null);
      const lines = buf && readLines(buf);
      if (!lines) continue;
      const matched = [];
      for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) matched.push(i);
      if (!matched.length) continue;
      hits.push({ index, file, mtime: info.mtimeMs, lines, matched });
      outputLines += mode === 'content' ? matched.length : 1;
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));

  const out = [];
  let more = false;
  if (mode === 'content') {
    hits.sort((a, b) => a.index - b.index);
    for (const hit of hits) {
      const show = new Set();
      for (const i of hit.matched) for (let j = Math.max(0, i - before); j <= Math.min(hit.lines.length - 1, i + afterN); j += 1) show.add(j);
      const matchedSet = new Set(hit.matched);
      let last = -2;
      for (const j of [...show].sort((a, b) => a - b)) {
        if (out.length >= headLimit) { more = true; break; }
        if ((before || afterN) && last >= 0 && j > last + 1) out.push('--');
        out.push(`${hit.file}${matchedSet.has(j) ? ':' : '-'}${j + 1}${matchedSet.has(j) ? ':' : '-'}${cutLine(hit.lines[j])}`);
        last = j;
      }
      if (more) break;
    }
    if (outputLines > headLimit || (enough() && next < files.length)) more = true;
  } else {
    // Newest first, as an AI usually wants the file it was just working on.
    hits.sort((a, b) => b.mtime - a.mtime);
    for (const hit of hits) {
      if (out.length >= headLimit) { more = true; break; }
      out.push(mode === 'count' ? `${hit.file}:${hit.matched.length}` : hit.file);
    }
  }
  const notes = [];
  if (!out.length) notes.push(`no matches in ${root}`);
  else if (mode === 'count') notes.push(`${hits.reduce((n, h) => n + h.matched.length, 0)} matches in ${hits.length} files`);
  else if (mode === 'files_with_matches') notes.push(`${hits.length} files`);
  if (more) notes.push(`cut at head_limit ${headLimit}; raise it or narrow the search`);
  if (stop) notes.push(stopNote(stop));
  return { text: [...out, `[${notes.join('; ')}]`].join('\n') };
}

export async function glob(args, root) {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new SearchError('pattern must be a non-empty string, e.g. **/*.lua');
  const limit = needCount(args.limit, 'limit', DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT) || DEFAULT_GLOB_LIMIT;
  const stat = await statRoot(root);
  if (!stat.isDirectory()) throw new SearchError(`path is a file, not a folder: ${root}`);
  const deadline = Date.now() + BUDGET_MS;
  const found = [];
  let stop = null;
  for await (const item of candidates(root, { glob: args.pattern, ignored: args.ignored === true, deadline })) {
    if (item.stop) { stop = item.stop; break; }
    found.push(path.join(root, item.rel));
  }
  const dated = await Promise.all(found.map(async (file) => ({ file, mtime: (await fsp.stat(file).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.mtime - a.mtime);
  const lines = dated.slice(0, limit).map((d) => d.file);
  const notes = [found.length ? `${found.length} files, newest first` : `no files match ${args.pattern} under ${root}`];
  if (found.length > limit) notes.push(`showing ${limit}; raise limit or narrow the pattern`);
  if (stop) notes.push(stopNote(stop));
  return { text: [...lines, `[${notes.join('; ')}]`].join('\n') };
}

export { SearchError };
