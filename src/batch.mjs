// batch: several tool calls in one round trip. Most of an AI's wait is its own turn between
// calls, not the link, so one call that does five things saves four turns. Every item goes
// through the normal call path (permissions, routing to its computer, audit, phone feed).
import { MAX_WAIT_SECS } from './shell.mjs';

export const MAX_BATCH_ITEMS = 20;
const BUDGET_SECS = MAX_WAIT_SECS - 5;
const MAX_TOTAL_CHARS = 100000;
const MIN_ITEM_CHARS = 2000;
const MAX_IMAGES = 4;

export const BATCH_TOOL = {
  name: 'batch',
  description: `Run up to ${MAX_BATCH_ITEMS} tool calls in one request, to save round trips: e.g. read several files, run a few commands, or a ui_act then ui_look. Each item names its tool and that tool's arguments (with computer when there are several computers). mode parallel (default) runs all at once; sequence runs in order and stops at the first error unless continue_on_error. Use sequence for steps that depend on each other or touch the same window. One reply lists each result with its duration; long outputs are cut. The whole batch replies within ${BUDGET_SECS} s: a bash still running returns its job id.`,
  inputSchema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_BATCH_ITEMS,
        description: 'The calls to make.',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name, e.g. bash, read_file, grep, ui_act.' },
            args: { type: 'object', description: 'Arguments for that tool, as in a direct call.' },
          },
          required: ['tool'],
          additionalProperties: false,
        },
      },
      computer: { type: 'string', description: 'Computer for items whose args name none.' },
      mode: { type: 'string', enum: ['parallel', 'sequence'], description: 'Default parallel.' },
      continue_on_error: { type: 'boolean', description: 'sequence only: keep going after a failed item.' },
    },
    required: ['calls'],
    additionalProperties: false,
  },
  annotations: { title: 'Run several tool calls', destructiveHint: true, openWorldHint: true },
};

// Shortens an item's own wait so the batch as a whole still answers in time.
function fitToBudget(tool, args, leftSecs) {
  const left = Math.max(0, Math.floor(leftSecs));
  if (tool === 'bash' && args.background !== true) return { ...args, wait: Math.min(args.wait ?? 60, left) };
  if (tool === 'job' && args.wait !== undefined) return { ...args, wait: Math.min(args.wait, left) };
  if (tool === 'wait_for') return { ...args, timeout: Math.min(args.timeout ?? 60, left) };
  return args;
}

function fromRpc(reply) {
  if (reply?.error) return { text: reply.error.message, isError: true, images: [] };
  const content = reply?.result?.content ?? [];
  return {
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    isError: reply?.result?.isError === true,
    images: content.filter((c) => c.type === 'image'),
  };
}

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[... cut: ${text.length} chars in total; run this call alone for all of it]` : text;
}

// callOne(tool, args) returns the JSON-RPC reply of a normal tools/call.
export async function runBatch(args, callOne) {
  const { calls, mode = 'parallel', continue_on_error: keepGoing = false, computer } = args ?? {};
  if (!Array.isArray(calls) || !calls.length) return { text: 'calls must be a non-empty list of {tool, args}', isError: true };
  if (calls.length > MAX_BATCH_ITEMS) return { text: `at most ${MAX_BATCH_ITEMS} calls per batch; split it`, isError: true };
  if (mode !== 'parallel' && mode !== 'sequence') return { text: 'mode must be parallel or sequence', isError: true };
  for (const [i, call] of calls.entries()) {
    if (!call || typeof call !== 'object' || typeof call.tool !== 'string') return { text: `call ${i + 1} needs a tool name`, isError: true };
    if (call.tool === 'batch') return { text: `call ${i + 1}: a batch cannot contain another batch`, isError: true };
    if (call.args !== undefined && (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args))) return { text: `call ${i + 1}: args must be an object`, isError: true };
  }

  const started = Date.now();
  const deadline = started + BUDGET_SECS * 1000;
  const results = new Array(calls.length).fill(null);
  const runOne = async (i) => {
    const { tool } = calls[i];
    const callArgs = { ...(computer !== undefined ? { computer } : {}), ...(calls[i].args ?? {}) };
    const t0 = Date.now();
    let timer;
    const late = new Promise((resolve) => {
      // A little past the deadline, so a bash whose wait was shortened can still answer with its job id.
      timer = setTimeout(() => resolve({ text: `no reply within the batch's ${BUDGET_SECS} s; it may still be running on the computer`, isError: true, late: true }), Math.max(0, deadline - Date.now()) + 3000);
    });
    const reply = callOne(tool, fitToBudget(tool, callArgs, (deadline - Date.now()) / 1000)).then(fromRpc, (err) => ({ text: `tool failed: ${err.message}`, isError: true, images: [] }));
    const outcome = await Promise.race([reply, late]);
    clearTimeout(timer);
    results[i] = { ...outcome, ms: Date.now() - t0 };
    return outcome;
  };

  if (mode === 'parallel') {
    await Promise.all(calls.map((_, i) => runOne(i)));
  } else {
    for (let i = 0; i < calls.length; i += 1) {
      if (Date.now() >= deadline) break;
      const outcome = await runOne(i);
      if (outcome.isError && !keepGoing) break;
    }
  }

  const perItem = Math.max(MIN_ITEM_CHARS, Math.floor(MAX_TOTAL_CHARS / calls.length));
  const images = [];
  let failed = 0;
  let skipped = 0;
  const parts = calls.map((call, i) => {
    const r = results[i];
    const where = call.args?.computer ?? computer;
    const label = `=== [${i + 1}] ${call.tool}${where ? ` @${where}` : ''}`;
    if (!r) {
      skipped += 1;
      return `${label} skipped (an earlier call failed${Date.now() >= deadline ? ' or time ran out' : ''})`;
    }
    if (r.isError) failed += 1;
    for (const image of r.images ?? []) {
      if (images.length < MAX_IMAGES) images.push(image);
    }
    const imageNote = r.images?.length ? `\n[${r.images.length} image(s) attached${images.length >= MAX_IMAGES ? `; at most ${MAX_IMAGES} per batch` : ''}]` : '';
    return `${label} ${r.isError ? 'ERROR' : 'ok'} ${r.ms} ms\n${cut(r.text, perItem)}${imageNote}`;
  });
  const summary = `batch: ${calls.length - failed - skipped} ok, ${failed} failed, ${skipped} skipped, ${Date.now() - started} ms (${mode})`;
  return {
    text: `${summary}\n${parts.join('\n')}`,
    isError: failed + skipped === calls.length,
    images,
    meta: { batch: calls.length, failed, skipped },
  };
}
