// wait_for: one call that sleeps until something happens on this computer, so an AI does not
// burn calls polling a log, a port or a process. Capped like bash wait, so the reply always
// beats the relay's call limit; on "timeout" the AI just calls again.
import fsp from 'node:fs/promises';
import net from 'node:net';
import { findJob } from './jobs.mjs';
import { MAX_WAIT_SECS } from './shell.mjs';
import { decodeFile } from './text.mjs';

const DEFAULT_WAIT = 60;
const POLL_MS = 500;
// A log can grow big; only its last part is read for file_match.
const MAX_MATCH_BYTES = 32 * 1024 * 1024;

class WaitError extends Error {}

async function fileState(file) {
  const stat = await fsp.stat(file).catch(() => null);
  return stat ? { exists: true, size: stat.size, mtime: stat.mtimeMs } : { exists: false, size: 0, mtime: 0 };
}

async function readText(file, size) {
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const start = Math.max(0, size - MAX_MATCH_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return decodeFile(buf.subarray(0, bytesRead)).text;
  } finally {
    await handle.close();
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function needObject(args, key) {
  const value = args[key];
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WaitError(`${key} must be an object`);
  return value;
}

// Each condition: a check that returns a reply line once it holds, or null.
async function buildChecks(args, resolvePath) {
  const checks = [];
  const fm = needObject(args, 'file_match');
  if (fm) {
    if (typeof fm.path !== 'string' || typeof fm.regex !== 'string') throw new WaitError('file_match needs path and regex');
    const file = resolvePath(fm.path);
    let re;
    try { re = new RegExp(fm.regex, fm.ignore_case === true ? 'i' : ''); } catch (err) { throw new WaitError(`bad regex: ${err.message}`); }
    const newOnly = fm.new_only === true;
    const start = await fileState(file);
    const startText = newOnly && start.exists ? await readText(file, start.size) : '';
    let seen = null;
    checks.push(async () => {
      const now = await fileState(file);
      if (!now.exists) return null;
      const key = `${now.size}:${now.mtime}`;
      if (key === seen) return null;
      seen = key;
      let text = await readText(file, now.size);
      // Only text added since the call began; a file that shrank was rewritten, so all of it is new.
      if (newOnly && text.startsWith(startText)) text = text.slice(startText.length);
      const line = text.split(/\r?\n/).find((l) => re.test(l));
      return line === undefined ? null : `file_match: ${file}: ${line.length > 500 ? `${line.slice(0, 500)}...` : line}`;
    });
  }
  const fc = needObject(args, 'file_changed');
  if (fc) {
    if (typeof fc.path !== 'string') throw new WaitError('file_changed needs path');
    const file = resolvePath(fc.path);
    const start = await fileState(file);
    checks.push(async () => {
      const now = await fileState(file);
      if (now.exists === start.exists && now.size === start.size && now.mtime === start.mtime) return null;
      if (!now.exists) return `file_changed: ${file} was deleted`;
      return `file_changed: ${file} ${start.exists ? 'changed' : 'was created'} (size ${now.size} bytes)`;
    });
  }
  const pe = needObject(args, 'process_exit');
  if (pe) {
    if (!Number.isInteger(pe.pid) || pe.pid <= 0) throw new WaitError('process_exit needs pid, a positive whole number');
    checks.push(async () => (processAlive(pe.pid) ? null : `process_exit: pid ${pe.pid} is not running`));
  }
  const po = needObject(args, 'port_open');
  if (po) {
    if (!Number.isInteger(po.port) || po.port < 1 || po.port > 65535) throw new WaitError('port_open needs port, 1-65535');
    const host = typeof po.host === 'string' && po.host ? po.host : '127.0.0.1';
    checks.push(async () => ((await portOpen(host, po.port)) ? `port_open: ${host}:${po.port} accepts connections` : null));
  }
  const jd = needObject(args, 'job_done');
  if (jd) {
    if (typeof jd.id !== 'string') throw new WaitError('job_done needs id');
    if (!findJob(jd.id)) throw new WaitError(`no such job: ${jd.id}`);
    checks.push(async () => {
      const { state } = findJob(jd.id);
      if (state.state === 'running' || state.state === 'starting') return null;
      return `job_done: job ${jd.id} ${state.state}${state.exitCode === undefined || state.exitCode === null ? '' : `, exit ${state.exitCode}`}; fetch output with the job tool`;
    });
  }
  return checks;
}

export async function waitFor(args, resolvePath) {
  const asked = args.timeout === undefined ? DEFAULT_WAIT : Number(args.timeout);
  if (!(asked >= 0)) throw new WaitError('timeout must be a number of seconds');
  const limitMs = Math.min(asked, MAX_WAIT_SECS) * 1000;
  const checks = await buildChecks(args, resolvePath);
  if (!checks.length) throw new WaitError('give at least one condition: file_match, file_changed, process_exit, port_open or job_done');
  const started = Date.now();
  for (;;) {
    const fired = (await Promise.all(checks.map((check) => check()))).filter(Boolean);
    if (fired.length) return { text: `${fired.join('\n')}\nwaited_ms: ${Date.now() - started}`, meta: { fired: fired.map((f) => f.split(':')[0]) } };
    const left = limitMs - (Date.now() - started);
    if (left <= 0) return { text: `timeout: nothing happened in ${Math.round(limitMs / 1000)} s. Call wait_for again to keep waiting.`, meta: { fired: [] } };
    await new Promise((resolve) => { setTimeout(resolve, Math.min(POLL_MS, left)); });
  }
}

export { WaitError };
