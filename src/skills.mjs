// Skills: reusable procedures kept on the host (the computer that runs this server) and applied to
// whichever computer the AI names. The files exist once, on the host; a computer is only a target.
//
// Layout, under <home>/skills/:
//   <name>/SKILL.md          frontmatter (--- ... ---) and instructions
//   <name>/scripts, references, assets, setup/   anything else the skill needs
//   <name>/config/<computer>.(yaml|yml|json|md|txt)   settings that differ per computer; never hashed
// Facts about which computer a skill was verified on live in <home>/skills-state.json, not in the
// skill, so adapting a skill to a new computer never changes the skill itself.
//
// Frontmatter keys: name (same as the folder), description, designed_for {computers, os},
// requires {...}, hints, check, setup. Only name and description are required.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homeDir } from './config.mjs';
import { classifyStep, RISK_TAGS } from './skill-risk.mjs';

export const SKILL_LIMITS = {
  skillMd: 64 * 1024,
  file: 256 * 1024,
  files: 500,
  totalBytes: 8 * 1024 * 1024,
  description: 1024,
  config: 16 * 1024,
  listedFiles: 100,
};
export const SKILL_TOOL_NAMES = new Set(['skill_list', 'skill_load', 'skill_read', 'skill_risk']);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OS_NAMES = ['windows', 'linux', 'macos'];
const CONFIG_EXTENSIONS = ['yaml', 'yml', 'json', 'md', 'txt'];

export class SkillError extends Error {}

export const skillsDir = () => path.join(homeDir(), 'skills');
export const skillsStatePath = () => path.join(homeDir(), 'skills-state.json');

export const SKILL_GUIDE = 'Skills: reusable procedures kept on the host and applied to any computer. Before you start a task on a computer, call skill_list with that computer; when a skill matches the task, call skill_load for it and follow it, using the computer parameter of the other tools to act on the target. Skill files are on the host: read them with skill_read, never with read_file on the target.';

// "Windows_NT 10.0.26200" -> windows, "Linux 6.1..." -> linux, "Darwin ..." -> macos.
export function osOf(text) {
  const s = String(text ?? '');
  if (/^windows/i.test(s)) return 'windows';
  if (/^linux/i.test(s)) return 'linux';
  if (/^darwin/i.test(s)) return 'macos';
  return null;
}

// ---- A small YAML subset: maps, lists, flow [a, b] and {k: v}, quoted text and | > blocks. ----
// No dependencies on purpose; anything outside this subset is reported, never guessed.

function stripComment(s) {
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      if (c === '\\' && quote === '"') k++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (k === 0 || /[\s[{,:]/.test(s[k - 1])) quote = c;
    } else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) {
      return s.slice(0, k);
    }
  }
  return s;
}

function scalar(raw) {
  const s = raw.trim();
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length > 1 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      if (c === '\\' && quote === '"') k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (k === 0 || /[\s[{,:]/.test(s[k - 1])) quote = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// First colon, outside quotes and brackets, that is followed by a space or the end.
function colonIndex(s) {
  let depth = 0;
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      if (c === '\\' && quote === '"') k++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (k === 0 || /[\s[{,:]/.test(s[k - 1])) quote = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === ':' && depth === 0 && (k === s.length - 1 || /\s/.test(s[k + 1]))) {
      return k;
    }
  }
  return -1;
}

function put(obj, key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new SkillError(`frontmatter: the key "${key}" is not allowed.`);
  obj[key] = value;
}

function flow(raw) {
  const s = raw.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    const close = s[0] === '[' ? ']' : '}';
    if (!s.endsWith(close)) throw new SkillError('frontmatter: a [list] or {map} written on one line must close on that line; use a block list for longer ones.');
    const inner = s.slice(1, -1);
    if (s[0] === '[') return splitTop(inner).map(flow);
    const out = {};
    for (const part of splitTop(inner)) {
      const c = colonIndex(part);
      if (c < 0) put(out, String(scalar(part)), null);
      else put(out, String(scalar(part.slice(0, c))), flow(part.slice(c + 1)));
    }
    return out;
  }
  return scalar(s);
}

const KEY_RE = /^([^\s#:[{"'-][^:]*?|"[^"]*"|'[^']*')\s*:(?:\s+(.*))?$/;
const ITEM_RE = /^-( |$)/;

export function parseYaml(src) {
  const rows = String(src).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    if (/^ *\t/.test(line)) throw new SkillError('frontmatter: use spaces, not tabs, for indentation.');
    const m = /^( *)(.*?)\s*$/.exec(line);
    return { indent: m[1].length, text: m[2] };
  });
  let i = 0;
  const skip = () => {
    while (i < rows.length && (rows[i].text === '' || rows[i].text.startsWith('#'))) i++;
  };

  function blockScalar(parentIndent, style) {
    const lines = [];
    let blockIndent = null;
    while (i < rows.length) {
      const r = rows[i];
      if (r.text === '') { lines.push(''); i++; continue; }
      if (r.indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = r.indent;
      lines.push(' '.repeat(Math.max(0, r.indent - blockIndent)) + r.text);
      i++;
    }
    while (lines.length && lines[0] === '') lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const text = lines.join('\n');
    return style === '|' ? text : text.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
  }

  function value(rest, parentIndent) {
    const text = stripComment(rest ?? '').trim();
    if (/^[|>][+-]?$/.test(text)) return blockScalar(parentIndent, text[0]);
    if (text !== '') return flow(text);
    skip();
    if (i < rows.length) {
      const next = rows[i];
      if (next.indent > parentIndent) return block(next.indent);
      if (next.indent === parentIndent && ITEM_RE.test(next.text)) return block(next.indent);
    }
    return null;
  }

  function block(indent) {
    skip();
    if (i >= rows.length || rows[i].indent !== indent) throw new SkillError('frontmatter: inconsistent indentation.');
    return ITEM_RE.test(rows[i].text) ? list(indent) : map(indent);
  }

  function map(indent) {
    const out = {};
    for (;;) {
      skip();
      if (i >= rows.length) break;
      const r = rows[i];
      if (r.indent < indent) break;
      if (r.indent > indent) throw new SkillError(`frontmatter: unexpected indentation at "${r.text.slice(0, 40)}".`);
      if (ITEM_RE.test(r.text)) break;
      const m = KEY_RE.exec(r.text);
      if (!m) throw new SkillError(`frontmatter: cannot read the line "${r.text.slice(0, 60)}"; write key: value.`);
      i++;
      put(out, String(scalar(m[1])), value(m[2], indent));
    }
    return out;
  }

  function list(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= rows.length) break;
      const r = rows[i];
      if (r.indent > indent) throw new SkillError(`frontmatter: unexpected indentation at "${r.text.slice(0, 40)}".`);
      if (r.indent < indent || !ITEM_RE.test(r.text)) break;
      const after = r.text.slice(1);
      const item = after.trimStart();
      const bare = stripComment(item).trim();
      if (bare === '') { i++; out.push(value('', indent)); continue; }
      if (!/^["'[{]/.test(bare) && KEY_RE.test(bare)) {
        // "- key: value" opens a map whose later keys line up under the first one.
        const mapIndent = indent + 1 + (after.length - item.length);
        rows[i] = { indent: mapIndent, text: item };
        out.push(map(mapIndent));
        continue;
      }
      i++;
      out.push(flow(bare));
    }
    return out;
  }

  skip();
  if (i >= rows.length) return {};
  const result = block(rows[i].indent);
  skip();
  if (i < rows.length) throw new SkillError(`frontmatter: could not read from "${rows[i].text.slice(0, 40)}".`);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SkillError('frontmatter must be key: value lines.');
  return result;
}

export function parseSkillFile(text) {
  const t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) throw new SkillError('SKILL.md must start with a --- frontmatter block holding at least name and description.');
  return { data: parseYaml(m[1]), body: t.slice(m[0].length).replace(/^\n+/, '') };
}

// ---- Reading a skill folder ----

function textList(value, label) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  for (const x of items) {
    if (typeof x !== 'string' && typeof x !== 'number') throw new SkillError(`${label} must be a list of words.`);
  }
  return items.map(String);
}

function normalizeMeta(data, dirName) {
  const name = data.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new SkillError('name must be 1 to 64 characters: lowercase English letters, digits and hyphens, starting with a letter or digit.');
  if (name !== dirName) throw new SkillError(`name "${name}" must equal the folder name "${dirName}".`);
  const description = data.description;
  if (typeof description !== 'string' || !description.trim()) throw new SkillError('description is required: say what the skill does and when to use it.');
  if (description.length > SKILL_LIMITS.description) throw new SkillError(`description is longer than ${SKILL_LIMITS.description} characters.`);
  const designed = data.designed_for ?? {};
  if (typeof designed !== 'object' || Array.isArray(designed)) throw new SkillError('designed_for must hold computers and os.');
  const os = textList(designed.os, 'designed_for.os').map((x) => x.toLowerCase());
  for (const x of os) if (!OS_NAMES.includes(x)) throw new SkillError(`designed_for.os "${x}" must be one of ${OS_NAMES.join(', ')}.`);
  const requires = data.requires ?? null;
  if (requires !== null && (typeof requires !== 'object' || Array.isArray(requires))) throw new SkillError('requires must be a map such as commands: [python>=3.10].');
  const hasRequirements = Boolean((requires && Object.values(requires).some((v) => (Array.isArray(v) ? v.length : v))) || data.setup || data.check);
  return {
    name,
    description: description.trim(),
    designedFor: { computers: textList(designed.computers, 'designed_for.computers'), os },
    requires,
    hints: typeof data.hints === 'string' ? data.hints : '',
    check: typeof data.check === 'string' ? data.check : null,
    setup: data.setup ?? null,
    hasRequirements,
  };
}

// Every regular file under a skill, except per-computer config (which must not change the skill's
// identity) and dot entries. Links are skipped: a skill cannot point outside itself.
function walkFiles(root) {
  const files = [];
  let total = 0;
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && entry.name === 'config') continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(abs, childRel); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(abs).size;
      total += size;
      if (files.length >= SKILL_LIMITS.files) throw new SkillError(`more than ${SKILL_LIMITS.files} files.`);
      if (total > SKILL_LIMITS.totalBytes) throw new SkillError(`larger than ${SKILL_LIMITS.totalBytes} bytes in total.`);
      files.push({ rel: childRel, abs, size });
    }
  };
  visit(root, '');
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f.rel}\0${f.size}\0`);
    h.update(fs.readFileSync(f.abs));
  }
  return h.digest('hex');
}

function decodeText(buf) {
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    try { return new TextDecoder('gbk', { fatal: true }).decode(buf); } catch { return null; }
  }
}

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

// Where a path really is, resolved through links, must stay inside the root.
function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const STATUS_NOTES = {
  ready: 'ready: nothing more to install here.',
  needs_setup: 'needs_setup: this skill lists requirements that have not been verified on this computer. Automatic setup is not available yet: check each requirement on the target with the bash tool before running anything from this skill, and tell the owner what you install.',
  stale: 'stale: this skill changed since it was last verified on this computer; check its requirements again before running it.',
  incompatible: 'incompatible: this skill is not designed for this computer\'s operating system. Do not apply it here unless the owner says so.',
  offline: 'offline: the target computer is not reachable right now.',
};

export class SkillStore {
  constructor({ dir = skillsDir(), stateFile = skillsStatePath(), computers = () => [] } = {}) {
    this.dir = dir;
    this.stateFile = stateFile;
    this.computers = computers;
  }

  // Reads every skill folder. A broken skill is reported in problems and left out, never half-loaded.
  scan() {
    const skills = [];
    const problems = [];
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const root = path.join(this.dir, entry.name);
      try {
        const md = path.join(root, 'SKILL.md');
        const stat = fs.lstatSync(md, { throwIfNoEntry: false });
        if (!stat) throw new SkillError('there is no SKILL.md in this folder.');
        if (!stat.isFile()) throw new SkillError('SKILL.md must be a regular file, not a link.');
        if (stat.size > SKILL_LIMITS.skillMd) throw new SkillError(`SKILL.md is larger than ${SKILL_LIMITS.skillMd} bytes.`);
        const { data, body } = parseSkillFile(fs.readFileSync(md, 'utf8'));
        const meta = normalizeMeta(data, entry.name);
        const files = walkFiles(root);
        const hash = hashFiles(files);
        skills.push({ ...meta, hash, short: hash.slice(0, 8), ref: `${meta.name}@${hash.slice(0, 8)}`, root, files, body });
      } catch (err) {
        if (!(err instanceof SkillError) && err.code !== 'ENOENT' && err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
        problems.push({ folder: entry.name, problem: err.message });
      }
    }
    skills.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { skills, problems };
  }

  readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return state && typeof state === 'object' && state.adaptations && typeof state.adaptations === 'object' ? state : { adaptations: {} };
    } catch {
      return { adaptations: {} };
    }
  }

  status(skill, computer, state) {
    if (!computer.online) return 'offline';
    if (skill.designedFor.computers.length && !skill.designedFor.computers.includes(computer.name)) return 'incompatible';
    const os = osOf(computer.os);
    if (skill.designedFor.os.length && os && !skill.designedFor.os.includes(os)) return 'incompatible';
    if (!skill.hasRequirements) return 'ready';
    const record = state.adaptations?.[computer.name]?.[skill.name];
    if (!record) return 'needs_setup';
    return record.hash === skill.hash ? 'ready' : 'stale';
  }

  // computer may be one name, a list of names, or "all".
  targets(arg) {
    if (arg === undefined || arg === null) return [];
    const all = this.computers();
    const names = arg === 'all' ? all.map((c) => c.name) : Array.isArray(arg) ? arg : [arg];
    const out = [];
    for (const name of names) {
      if (typeof name !== 'string' || !name) throw new SkillError('computer must be a computer name, a list of names, or "all".');
      const found = all.find((c) => c.name === name);
      if (!found) throw new SkillError(`There is no computer named "${name}". Available: ${all.map((c) => c.name).join(', ') || 'none'}.`);
      out.push(found);
    }
    return out;
  }

  find(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new SkillError('name must be the name of a skill, as skill_list shows it.');
    const { skills } = this.scan();
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new SkillError(`There is no skill named "${name}". Call skill_list to see them.`);
    return skill;
  }

  list(args = {}) {
    const targets = this.targets(args.computer);
    const { skills, problems } = this.scan();
    const state = this.readState();
    const terms = typeof args.query === 'string' ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const shown = skills.filter((s) => {
      const hay = `${s.name} ${s.description} ${s.hints}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const result = {
      count: shown.length,
      ...(terms.length ? { matched_of: skills.length } : {}),
      skills: shown.map((s) => ({
        name: s.name,
        description: s.description,
        ref: s.ref,
        designed_for: s.designedFor,
        ...(targets.length ? { status: Object.fromEntries(targets.map((c) => [c.name, this.status(s, c, state)])) } : {}),
      })),
      ...(problems.length ? { problems } : {}),
      next: skills.length
        ? (targets.length ? 'skill_load(name, computer) opens a skill for that computer.' : 'Pass computer to see whether each skill is ready there.')
        : `There are no skills yet. A skill is a folder with a SKILL.md in ${this.dir}.`,
    };
    return { text: JSON.stringify(result, null, 2) };
  }

  load(args = {}) {
    if (args.computer === undefined) throw new SkillError('computer is required: name the computer this skill will be used on.');
    const [computer] = this.targets(args.computer);
    if (!computer || Array.isArray(args.computer)) throw new SkillError('Load a skill for one computer at a time.');
    const skill = this.find(args.name);
    const status = this.status(skill, computer, this.readState());
    const os = osOf(computer.os);
    const lines = [
      `[skill_ref: ${skill.ref}]`,
      `[target: ${computer.name} | os: ${computer.os ?? 'unknown'} | status: ${status}]`,
      '[The skill\'s files are on the host, not on the target: read them with skill_read. Relative paths below are inside the skill folder. Run commands on the target with the computer parameter of the other tools.]',
      `[${STATUS_NOTES[status]}]`,
    ];
    const { computers: designedComputers, os: designedOs } = skill.designedFor;
    if (designedComputers.length || designedOs.length) {
      lines.push(`[designed for: ${[designedComputers.length ? `computers ${designedComputers.join(', ')}` : '', designedOs.length ? `os ${designedOs.join(', ')}` : ''].filter(Boolean).join('; ')}${os && designedOs.length && !designedOs.includes(os) ? '' : ''}]`);
    }
    if (skill.requires) lines.push(`[requires: ${JSON.stringify(skill.requires)}]`);
    if (skill.hints) lines.push(`[hints: ${skill.hints.replace(/\s+/g, ' ').trim()}]`);
    const config = this.computerConfig(skill, computer.name);
    if (config) lines.push('', `[settings for ${computer.name} (${config.file}):`, config.text.trimEnd(), ']');
    lines.push('', '--- SKILL.md ---', skill.body.trimEnd(), '', '--- files ---');
    const rest = skill.files.filter((f) => f.rel !== 'SKILL.md');
    for (const f of rest.slice(0, SKILL_LIMITS.listedFiles)) lines.push(`${f.rel} (${kb(f.size)})`);
    if (rest.length > SKILL_LIMITS.listedFiles) lines.push(`... and ${rest.length - SKILL_LIMITS.listedFiles} more`);
    if (!rest.length) lines.push('(only SKILL.md)');
    return { text: lines.join('\n'), meta: { skill: skill.ref, target: computer.name } };
  }

  computerConfig(skill, computerName) {
    if (/[\\/]|^\.+$/.test(computerName)) return null;
    for (const ext of CONFIG_EXTENSIONS) {
      const file = path.join(skill.root, 'config', `${computerName}.${ext}`);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > SKILL_LIMITS.config) continue;
        // Reject a config directory that resolves through a link outside this skill.
        if (!insideRoot(fs.realpathSync(skill.root), fs.realpathSync(file))) continue;
        const text = decodeText(fs.readFileSync(file));
        if (text !== null) return { file: `config/${computerName}.${ext}`, text };
      } catch { /* not there */ }
    }
    return null;
  }

  read(args = {}) {
    const skill = this.find(args.name);
    const rel = args.path;
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new SkillError('path must be a file path inside the skill, such as scripts/check.py.');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) throw new SkillError('path must stay inside the skill folder.');
    const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
    const root = real(skill.root);
    const target = real(path.join(skill.root, rel));
    if (!root || !target) throw new SkillError(`There is no file "${rel}" in the skill ${skill.name}.`);
    if (!insideRoot(root, target)) throw new SkillError('path must stay inside the skill folder.');
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new SkillError(`"${rel}" is a folder; give the path of a file.`);
    if (stat.size > SKILL_LIMITS.file) throw new SkillError(`"${rel}" is ${kb(stat.size)}, larger than the ${kb(SKILL_LIMITS.file)} limit.`);
    const text = decodeText(fs.readFileSync(target));
    const head = `[skill_ref: ${skill.ref}] ${rel.replace(/\\/g, '/')} (${kb(stat.size)})`;
    if (text === null) return { text: `${head}\nThis is a binary file; it is not shown.`, meta: { skill: skill.ref } };
    return { text: `${head}\n${text}`, meta: { skill: skill.ref } };
  }

  risk(args = {}) {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 4096 || args.command.includes('\0')) {
      throw new SkillError('command must be nonempty plain text of at most 4096 characters.');
    }
    if (typeof args.computer !== 'string') throw new SkillError('computer is required: use a name from list_computers.');
    const [target] = this.targets(args.computer);
    const ctx = { os: osOf(target.os), homeDir: target.home || '', cwd: target.home || '', vars: {}, skillDirs: [] };
    const findings = classifyStep(args.command, ctx);
    const highest = findings.reduce((n, f) => Math.max(n, RISK_TAGS.indexOf(f.tag)), 0);
    return { text: JSON.stringify({ computer: target.name, os: ctx.os, command: args.command,
      risk: RISK_TAGS[highest], findings,
      warning: 'Static heuristic only: no command was run. This does not grant permission or guarantee safety. Review the exact command and obtain any required human approval before executing.' }, null, 2) };
  }

  tool(name, args = {}) {
    try {
      if (name === 'skill_list') return this.list(args);
      if (name === 'skill_load') return this.load(args);
      if (name === 'skill_read') return this.read(args);
      if (name === 'skill_risk') return this.risk(args);
      return { text: `unknown skill tool: ${name}`, isError: true };
    } catch (err) {
      if (err instanceof SkillError) return { text: err.message, isError: true };
      throw err;
    }
  }
}

const computerParam = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description: 'Name of a computer from list_computers, a list of names, or "all".',
};

export const SKILL_TOOLS = [
  {
    name: 'skill_list',
    description: 'List the skills kept on the host: reusable procedures with their name, what they do and when to use them. Before you start a task on a computer, call this with that computer (or a list of computers): each skill then shows whether it is ready, needs_setup, stale or incompatible there. When one matches the task, open it with skill_load. query narrows the list to skills whose name or description contain all its words.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerParam,
        query: { type: 'string', description: 'Words that must all appear in the skill\'s name or description.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List skills', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'skill_load',
    description: 'Open a skill for one computer: its instructions, the settings that differ on that computer, whether it is ready there, and the list of its other files. The skill\'s files are on the host. Act on the target computer with the computer parameter of the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from skill_list.' },
        computer: { type: 'string', description: 'The computer the skill will be used on, from list_computers.' },
      },
      required: ['name', 'computer'],
      additionalProperties: false,
    },
    annotations: { title: 'Open a skill', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'skill_risk',
    description: 'READ ONLY: statically annotate risks of an exact proposed skill setup command on a named computer; does not execute or approve it. Unrecognised commands are treated conservatively. The owner must still approve risky changes before they are run.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: { type: 'string', description: 'Target computer name from list_computers.' },
        command: { type: 'string', description: 'Exact command to review, maximum 4096 characters. Nothing is executed.' },
      },
      required: ['computer', 'command'],
      additionalProperties: false,
    },
    annotations: { title: 'Review skill command risk', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'skill_read',
    description: 'Read one file inside a skill (a script, a reference, a template) from the host, as listed by skill_load. Only files inside the skill folder can be read.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from skill_list.' },
        path: { type: 'string', description: 'File path inside the skill, such as references/api.md.' },
        computer: { type: 'string', description: 'Optional: the computer you are using the skill on.' },
      },
      required: ['name', 'path'],
      additionalProperties: false,
    },
    annotations: { title: 'Read a skill file', readOnlyHint: true, openWorldHint: false },
  },
];
