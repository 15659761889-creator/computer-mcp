import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { machineInfo } from './hub.mjs';

const POLL_TIMEOUT_MS = 40000;
const RESULT_TIMEOUT_MS = 120000;
const MAX_SEEN = 2000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// fetch ignores proxies, and this computer may only reach the hub through one.
export function hubClient(origin, proxy) {
  const secure = new URL(origin).protocol === 'https:';
  const agent = new (secure ? https : http).Agent({
    keepAlive: true,
    ...(proxy ? { proxyEnv: secure ? { HTTPS_PROXY: proxy } : { HTTP_PROXY: proxy } } : {}),
  });
  return (pathname, { key, body, timeoutMs }) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const req = (secure ? https : http).request(new URL(pathname, origin), {
      agent,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // A proxy or tunnel error page: the status code below says enough.
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function joinHub({ origin, code, name, proxy }) {
  const send = hubClient(origin, proxy);
  let answer;
  // TLS through a local proxy or VPN sometimes resets for a moment, and a code is too precious to fail on that.
  for (let attempt = 1; !answer; attempt += 1) {
    try {
      answer = await send('/hub/join', { body: { code, name, info: machineInfo() }, timeoutMs: 30000 });
    } catch (err) {
      if (attempt >= 4) throw new Error(`could not reach ${origin}: ${err.message}. Check the network; if it needs a proxy, add --proxy http://host:port`);
      await sleep(attempt * 2000);
    }
  }
  if (answer.status !== 200) throw new Error(answer.body?.error || `the main computer answered ${answer.status}`);
  return answer.body;
}

// Keeps this computer connected to the hub by long polling, which passes any tunnel or proxy
// and needs no open port here. execute(tool, args) resolves to the tool's outcome.
export function startNodeLink({ origin, key, proxy, execute, log = () => {} }) {
  const send = hubClient(origin, proxy);
  const boot = randomBytes(8).toString('hex');
  const running = new Set();
  const seen = new Set();
  let stopped = false;

  async function deliver(id, outcome) {
    for (let delay = 1000; !stopped; delay = Math.min(delay * 2, 30000)) {
      try {
        const answer = await send('/hub/node/result', { key, body: { id, outcome }, timeoutMs: RESULT_TIMEOUT_MS });
        if (answer.status === 200 || answer.status === 401) break;
      } catch {
        // Kept until the hub is back: the result of real work must not be dropped.
      }
      await sleep(delay);
    }
    running.delete(id);
  }

  async function runCall(call) {
    let outcome;
    try {
      outcome = await execute(call.tool, call.args);
    } catch (err) {
      outcome = { text: `tool failed: ${err.message}`, isError: true };
    }
    await deliver(call.id, outcome);
  }

  async function loop() {
    let delay = 1000;
    let connected = false;
    while (!stopped) {
      try {
        const answer = await send('/hub/node/poll', {
          key,
          body: { boot, running: [...running], info: machineInfo() },
          timeoutMs: POLL_TIMEOUT_MS,
        });
        if (answer.status === 401) {
          if (connected) log('the main computer removed this computer');
          connected = false;
          await sleep(60000);
          continue;
        }
        if (answer.status !== 200) throw new Error(`main computer answered ${answer.status}`);
        if (!connected) log(`connected to ${origin}`);
        connected = true;
        delay = 1000;
        for (const call of answer.body.calls || []) {
          if (seen.has(call.id)) continue;
          seen.add(call.id);
          if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
          running.add(call.id);
          runCall(call);
        }
      } catch (err) {
        if (stopped) return;
        if (connected) log(`connection lost: ${err.message}`);
        connected = false;
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  loop();
  return { stop() { stopped = true; } };
}
