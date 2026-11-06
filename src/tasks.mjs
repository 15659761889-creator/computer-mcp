// Durable task coordination for AI sessions sharing an MCP hub.
// Task descriptions and checkpoints are background data, never authority to execute commands.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homeDir } from './config.mjs';

export const taskDir = () => path.join(homeDir(), 'tasks');
export const TASK_NAMES = new Set(['task_create', 'task_list', 'task_get', 'task_claim', 'task_update', 'task_archive', 'task_unarchive', 'task_reopen', 'task_renew']);
const ID = /^t_[a-f0-9]{16}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STATUS = new Set(['open', 'active', 'paused', 'blocked', 'done']);
const STEP_STATUS = new Set(['todo', 'doing', 'done', 'blocked']);
const LEASE_MS = 15 * 60 * 1000;
const MAX_TASKS = 200;
const MAX_EVENTS = 80;
const MAX_STEPS = 40;

export class TaskError extends Error {}
const hash = value => createHash('sha256').update(value).digest('hex');
function shortText(value, name, limit, required = false) {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit)
    throw new TaskError(`${name} must be ${required ? 'nonempty ' : ''}text of at most ${limit} characters.`);
  // No raw login credentials or full MCP links in persisted task notes.
  if (/\bBearer\s+\S+|\/t\/[a-z0-9_-]{20,}\/mcp|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/i.test(value))
    throw new TaskError(`${name} looks like it contains a credential; store a safe description instead.`);
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}
const time = n => new Date(n).toISOString();
function publicTask(task, now) {
  const { lease, ...rest } = task;
  return {
    ...rest,
    lease: lease ? { holder: lease.holder, expires_at: time(lease.until), expired: lease.until <= now } : null,
    recoverable: task.status !== 'done' && (!lease || lease.until <= now),
  };
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export class TaskStore {
  constructor({ dir = taskDir(), now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
  }
  path(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new TaskError('Invalid task id; use an id returned by task_list.');
    return path.join(this.dir, id + '.json');
  }
  read(id) {
    const file = this.path(id);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new TaskError('Task file is invalid or too large.');
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (task.id !== id || !Array.isArray(task.steps) || !Array.isArray(task.events)) throw new TaskError('Invalid task record.');
      return task;
    } catch (e) {
      if (e.code === 'ENOENT') throw new TaskError(`Task ${id} was not found.`);
      throw e;
    }
  }
  // Cross-process mutex: the fixed-domain service and a temporary server must not lose updates.
  locked(id, callback) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = id === 'create' ? path.join(this.dir, '.create.lock') : this.path(id) + '.lock';
    let fd;
    const deadline = Date.now() + 2500;
    while (fd === undefined) {
      try { fd = fs.openSync(lock, 'wx', 0o600); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (Date.now() > deadline) throw new TaskError('Task is busy. Retry this operation.');
        sleep(25);
      }
    }
    try { return callback(); }
    finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
  }
  save(task) {
    const target = this.path(task.id);
    const temp = target + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, target);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  all() {
    let names;
    try { names = fs.readdirSync(this.dir); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (names.length > MAX_TASKS * 3) throw new TaskError('Task storage has too many entries; investigate before continuing.');
    return names.filter(name => /^t_[a-f0-9]{16}\.json$/.test(name)).map(name => {
      try { return this.read(name.slice(0, -5)); } catch { return null; }
    }).filter(Boolean);
  }
  // The most recently changed task, for recent_calls: an AI that finishes its work
  // marks the task done, and that update may be newer than the last audit-logged call
  // (another server, or the update itself), so the reader should not conclude the
  // session was cut off just because it left no handoff note.
  latestActivity() {
    let best = null;
    for (const t of this.all()) {
      const at = Date.parse(t.updated_at);
      if (Number.isFinite(at) && (!best || at > best.at)) best = { at, id: t.id, status: t.status };
    }
    return best;
  }
  create(args = {}) {
    const goal = shortText(args.goal, 'goal', 2000, true);
    const project = args.project === undefined ? null : shortText(args.project, 'project', 64, true);
    if (project && !PROJECT.test(project)) throw new TaskError('project must use lowercase letters, digits, dots, dashes or underscores.');
    const computer = args.computer === undefined ? null : shortText(args.computer, 'computer', 100, true);
    if (args.steps !== undefined && (!Array.isArray(args.steps) || args.steps.length > MAX_STEPS))
      throw new TaskError(`steps must be an array of at most ${MAX_STEPS} titles.`);
    const steps = (args.steps || []).map((title, i) => ({
      index: i, title: shortText(title, `steps[${i}]`, 240, true),
      status: 'todo', evidence: '', updated_at: null,
    }));
    const next = args.next === undefined ? (steps[0]?.title || 'Inspect the project and record a concrete next step.') : shortText(args.next, 'next', 1000, true);
    return this.locked('create', () => {
      const existing = this.all().filter((t) => !t.archived);
      if (existing.length >= MAX_TASKS) throw new TaskError(`Task limit of ${MAX_TASKS} reached. Archive tasks before creating more.`);
      const dup = existing.find((t) => t.goal === goal && ['open', 'active', 'paused', 'blocked'].includes(t.status));
      if (dup) throw new TaskError(`A task with the same goal already exists: ${dup.id} (${dup.status}). Resume it with task_get and task_claim instead of creating a duplicate.`);
      const n = this.now();
      for (let attempt = 0; attempt < 4; attempt++) {
        const id = 't_' + randomBytes(8).toString('hex');
        if (fs.existsSync(this.path(id))) continue;
        const task = {
          id, project, computer, goal, status: 'open', rev: 1, created_at: time(n),
          updated_at: time(n), last_actor: null, summary: '', next,
          steps, files: [], events: [], lease: null, archived: false,
        };
        this.save(task);
        return { task: publicTask(task, n), next_action: 'Call task_claim(id, actor) before work, then task_update after each meaningful step.' };
      }
      throw new TaskError('Could not generate a unique task id.');
    });
  }
  list(args = {}) {
    const limit = args.limit === undefined ? 30 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TaskError('limit must be between 1 and 100.');
    const tasks = this.all().filter(t =>
      (args.include_archived === true || !t.archived) &&
      (args.project === undefined || t.project === args.project) &&
      (args.status === undefined || t.status === args.status)
    ).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const n = this.now();
    return { count: tasks.length, tasks: tasks.slice(0, limit).map(t => ({
      id: t.id, project: t.project, computer: t.computer, goal: t.goal, status: t.status,
      archived: t.archived === true,
      rev: t.rev, updated_at: t.updated_at, next: t.next, summary: t.summary,
      completed_steps: t.steps.filter(s => s.status === 'done').length, total_steps: t.steps.length,
      lease: publicTask(t, n).lease, recoverable: publicTask(t, n).recoverable,
    })), next_action: 'Call task_get(id) before resuming. If recoverable, call task_claim(id, actor).' };
  }
  get(args = {}) {
    const task = this.read(args.id);
    return { task: publicTask(task, this.now()), next_action: 'Check the actual computer, files and tests before trusting older checkpoints. Claim only if the lease is expired or free.' };
  }
  claim(args = {}) {
    const actor = shortText(args.actor, 'actor', 100, true);
    return this.locked(args.id, () => {
      const task = this.read(args.id);
      if (task.archived) throw new TaskError('This task is archived; restore it with task_unarchive first.');
      if (task.status === 'done') throw new TaskError('This task is completed; reopen it with task_reopen or create a new task for new work.');
      const n = this.now();
      if (task.lease?.until > n && !(typeof args.lease_token === 'string' && hash(args.lease_token) === task.lease.hash))
        throw new TaskError(`Task is held by ${task.lease.holder} until ${time(task.lease.until)}. Do not duplicate their work; retry when the lease expires.`);
      const previous = task.lease ? { holder: task.lease.holder, expired: task.lease.until <= n } : null;
      const token = randomBytes(24).toString('base64url');
      task.lease = { hash: hash(token), holder: actor, until: n + LEASE_MS };
      task.last_actor = actor;
      task.status = 'active';
      task.rev++;
      task.updated_at = time(n);
      task.events.push({ at: time(n), kind: 'claim', actor, previous });
      task.events = task.events.slice(-MAX_EVENTS);
      this.save(task);
      return { task: publicTask(task, n), lease_token: token, note: 'Keep lease_token private. Supply it to task_update and with task_id/task_lease on other tools. The lease is renewed by linked calls, and can be reclaimed 15 minutes after the last activity.' };
    });
  }
  verify(id, token) {
    const task = this.read(id);
    if (typeof token !== 'string' || !token || !task.lease || hash(token) !== task.lease.hash || task.lease.until <= this.now())
      throw new TaskError('Task lease is missing, expired or held by another AI. Call task_get and task_claim; do not run conflicting actions.');
    return task;
  }
  update(args = {}) {
    return this.locked(args.id, () => {
      const task = this.verify(args.id, args.lease_token);
      if (args.if_rev !== undefined && args.if_rev !== task.rev)
        throw new TaskError(`Task changed since revision ${args.if_rev}; current revision is ${task.rev}. Re-read before modifying.`);
      const n = this.now();
      const summary = shortText(args.summary, 'summary', 1500);
      const next = shortText(args.next, 'next', 1000);
      const evidence = shortText(args.evidence, 'evidence', 1000);
      if (summary !== undefined) task.summary = summary;
      if (next !== undefined) task.next = next;
      if (args.status !== undefined) {
        if (!STATUS.has(args.status) || args.status === 'open') throw new TaskError('status must be active, paused, blocked or done.');
        task.status = args.status;
      }
      if (args.step_index !== undefined) {
        if (!Number.isInteger(args.step_index) || !task.steps[args.step_index])
          throw new TaskError('step_index must name an existing step, starting at 0.');
        if (!STEP_STATUS.has(args.step_status)) throw new TaskError('step_status must be todo, doing, done or blocked.');
        task.steps[args.step_index].status = args.step_status;
        task.steps[args.step_index].updated_at = time(n);
        if (evidence !== undefined) task.steps[args.step_index].evidence = evidence;
      }
      if (args.add_step !== undefined) {
        const title = shortText(args.add_step, 'add_step', 240, true);
        if (task.steps.length >= MAX_STEPS) throw new TaskError(`steps must contain at most ${MAX_STEPS} titles.`);
        task.steps.push({ index: task.steps.length, title, status: 'todo', evidence: '', updated_at: null });
      }
      if (args.files !== undefined) {
        if (!Array.isArray(args.files) || args.files.length > 20) throw new TaskError('files must contain at most 20 paths.');
        task.files = args.files.map((file, i) => shortText(file, `files[${i}]`, 350, true));
      }
      task.updated_at = time(n);
      task.rev++;
      task.events.push({ at: time(n), kind: 'checkpoint', actor: task.lease.holder,
        step_index: args.step_index ?? null, step_status: args.step_status ?? null,
        status: task.status, summary: summary || null, evidence: evidence || null, next: next || null });
      task.events = task.events.slice(-MAX_EVENTS);
      if (['done', 'paused', 'blocked'].includes(task.status)) task.lease = null;
      else task.lease.until = n + LEASE_MS;
      this.save(task);
      return { task: publicTask(task, n), next_action: task.status === 'done' ? 'The task is complete.' : task.status === 'active' ? 'Continue and checkpoint at the next meaningful step.' : 'Another AI can now claim this task.' };
    });
  }
  archive(args = {}) {
    return this.locked(args.id, () => {
      const task = this.read(args.id);
      const n = this.now();
      if (task.lease?.until > n) {
        if (typeof args.lease_token !== 'string' || !args.lease_token || hash(args.lease_token) !== task.lease.hash)
          throw new TaskError(`Task is held by ${task.lease.holder} until ${time(task.lease.until)}; archive it with the lease token or wait for the lease to expire.`);
      }
      if (task.archived) throw new TaskError('Task is already archived.');
      task.archived = true;
      task.lease = null;
      task.rev++;
      task.updated_at = time(n);
      task.events.push({ at: time(n), kind: 'archive', actor: task.last_actor });
      task.events = task.events.slice(-MAX_EVENTS);
      this.save(task);
      return { task: publicTask(task, n), next_action: 'Archived tasks do not count toward the task limit. Use task_unarchive to restore it.' };
    });
  }
  unarchive(args = {}) {
    return this.locked(args.id, () => {
      const task = this.read(args.id);
      if (!task.archived) throw new TaskError('Task is not archived.');
      if (this.all().filter((t) => !t.archived).length >= MAX_TASKS)
        throw new TaskError(`Task limit of ${MAX_TASKS} reached. Archive another task before restoring this one.`);
      const n = this.now();
      task.archived = false;
      task.rev++;
      task.updated_at = time(n);
      task.events.push({ at: time(n), kind: 'unarchive', actor: task.last_actor });
      task.events = task.events.slice(-MAX_EVENTS);
      this.save(task);
      return { task: publicTask(task, n), next_action: 'Call task_get and task_claim before resuming.' };
    });
  }
  reopen(args = {}) {
    return this.locked(args.id, () => {
      const task = this.read(args.id);
      if (task.archived) throw new TaskError('Task is archived; restore it with task_unarchive first.');
      if (task.status !== 'done') throw new TaskError('Only a done task can be reopened.');
      const n = this.now();
      task.status = 'active';
      task.rev++;
      task.updated_at = time(n);
      task.events.push({ at: time(n), kind: 'reopen', actor: task.last_actor });
      task.events = task.events.slice(-MAX_EVENTS);
      this.save(task);
      return { task: publicTask(task, n), next_action: 'Call task_claim(id, actor) before work.' };
    });
  }
  renew(args = {}) {
    return this.locked(args.id, () => {
      const task = this.verify(args.id, args.lease_token);
      const minutes = args.minutes === undefined ? 15 : args.minutes;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)
        throw new TaskError('minutes must be between 1 and 60.');
      const n = this.now();
      task.lease.until = n + minutes * 60 * 1000;
      task.updated_at = time(n);
      this.save(task);
      return { task: publicTask(task, n), next_action: 'Lease extended. Renew again before it expires if the work runs long.' };
    });
  }
  // Called by the MCP router after an explicitly task-linked action. No command content is stored.
  recordAction(id, token, action) {
    return this.locked(id, () => {
      const task = this.verify(id, token);
      const n = this.now();
      task.lease.until = n + LEASE_MS;
      task.updated_at = time(n);
      task.events.push({ at: time(n), kind: 'tool', actor: task.lease.holder,
        tool: String(action.tool).slice(0, 60),
        computer: typeof action.computer === 'string' ? action.computer.slice(0, 100) : null,
        status: action.status,
        duration_ms: action.duration_ms });
      task.events = task.events.slice(-MAX_EVENTS);
      this.save(task);
      return true;
    });
  }
  tool(name, args = {}) {
    try {
      const value = name === 'task_create' ? this.create(args)
        : name === 'task_list' ? this.list(args)
        : name === 'task_get' ? this.get(args)
        : name === 'task_claim' ? this.claim(args)
        : name === 'task_update' ? this.update(args)
        : name === 'task_archive' ? this.archive(args)
        : name === 'task_unarchive' ? this.unarchive(args)
        : name === 'task_reopen' ? this.reopen(args)
        : name === 'task_renew' ? this.renew(args) : null;
      return value ? { text: JSON.stringify(value, null, 2) } : { text: 'Unknown task tool', isError: true };
    } catch (err) {
      if (err instanceof TaskError) return { text: err.message, isError: true };
      throw err;
    }
  }
}

export const TASK_TOOLS = [
  {
    name: 'task_create',
    description: 'Create a persistent task with its full goal, steps and next action BEFORE starting substantial work. First call task_list to avoid duplicates. A task survives model context loss or quota exhaustion. Claim it before executing.',
    inputSchema: { type: 'object', properties: {
      goal: { type: 'string', description: 'Complete original user goal and acceptance criteria (max 2000 chars).' },
      project: { type: 'string', description: 'Stable lowercase project id, e.g. wanji or campus.' },
      computer: { type: 'string', description: 'Primary computer name, if known.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Up to 40 actionable milestones.' },
      next: { type: 'string', description: 'Exact immediate next action.' },
    }, required: ['goal'], additionalProperties: false },
    annotations: { title: 'Create durable task', openWorldHint: false },
  },
  {
    name: 'task_list',
    description: 'FIRST call when starting, resuming or checking multi-step work. Shows durable goals, progress and which AI holds each lease, even if the last AI vanished without a handoff.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, status: { type: 'string', enum: ['open', 'active', 'paused', 'blocked', 'done'] },
      include_archived: { type: 'boolean', description: 'Archived tasks are hidden unless this is true.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, additionalProperties: false },
    annotations: { title: 'List durable tasks', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'task_get',
    description: 'Read one complete durable task: original goal, all steps, last checkpoint, artifacts, recent tool actions, lease, and next action. Verify actual files/processes before acting.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Read task for takeover', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'task_claim',
    description: 'Claim a free or expired task for one AI session; refuses an unexpired lease to prevent conflicts. Returns a private lease_token for task_update and tagged computer calls. Do not put the token in task notes.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, actor: { type: 'string', description: 'Specific AI and session label, e.g. gpt-6:chat-a.' },
      lease_token: { type: 'string', description: 'Only for renewing your OWN lease, otherwise omit.' },
    }, required: ['id', 'actor'], additionalProperties: false },
    annotations: { title: 'Claim task for AI session', openWorldHint: false },
  },
  {
    name: 'task_update',
    description: 'Persist progress immediately after EACH meaningful step and before context runs out: summary, what was verified, files, current step, exact next action. status paused/blocked/done releases lease so another AI can continue. Never store secrets.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, lease_token: { type: 'string', description: 'Private token from task_claim.' },
      if_rev: { type: 'integer', description: 'Optional revision from task_get; rejects stale updates.' },
      summary: { type: 'string', description: 'Current durable progress summary; what is done, what remains.' },
      next: { type: 'string', description: 'Specific next command, file or verification action.' },
      step_index: { type: 'integer', minimum: 0 },
      step_status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
      add_step: { type: 'string', description: 'Append one step title (up to 40 steps in total).' },
      evidence: { type: 'string', description: 'Short verification for the updated step.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Up to 20 exact artifact/repository paths.' },
      status: { type: 'string', enum: ['active', 'paused', 'blocked', 'done'] },
    }, required: ['id', 'lease_token'], additionalProperties: false },
    annotations: { title: 'Save task checkpoint or handoff', openWorldHint: false },
  },
  {
    name: 'task_archive',
    description: 'Archive a task so it stops counting toward the 200-task limit. The task file stays on disk and can be restored with task_unarchive. A live lease held by another AI can only be archived with its lease token.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, lease_token: { type: 'string', description: 'Private token from task_claim, only needed while the task is leased.' },
    }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Archive task', openWorldHint: false },
  },
  {
    name: 'task_unarchive',
    description: 'Restore an archived task so it shows in task_list again and counts toward the task limit.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Restore archived task', openWorldHint: false },
  },
  {
    name: 'task_reopen',
    description: 'Reopen a done task as active so it can be claimed and worked on again, instead of creating a duplicate task.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Reopen done task', openWorldHint: false },
  },
  {
    name: 'task_renew',
    description: 'Extend the lease on a task you hold, before a long action that would outrun the 15-minute lease. The router also renews automatically while a task-linked action runs. minutes defaults to 15, maximum 60.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, lease_token: { type: 'string', description: 'Private token from task_claim.' },
      minutes: { type: 'integer', minimum: 1, maximum: 60 },
    }, required: ['id', 'lease_token'], additionalProperties: false },
    annotations: { title: 'Extend task lease', openWorldHint: false },
  },
];
