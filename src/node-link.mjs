import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { machineInfo } from './hub.mjs';
import { discover, firstReachable, keyHash, lanJson, nodePsk } from './lan.mjs';

const POLL_TIMEOUT_MS = 40000;
const RESULT_TIMEOUT_MS = 120000;
const MAX_SEEN = 2000;
const LAN_RETRY_MS = 60000;
const LAN_PROBE_MS = 2500;

// Unref'd: a stopped link must not hold the process open; the service's servers keep it alive.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

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
//
// route decides the path: 'public' always uses origin; 'lan' only the main computer's LAN
// port, and never sends work over the internet (it only asks there whether the route
// changed); 'auto' prefers the LAN and falls back to the internet. The hub sends the route
// and its LAN address with every poll reply; onSettings keeps them for the next start.
export function startNodeLink({
  origin, key, id, proxy, execute, log = () => {},
  route: firstRoute = 'auto', hubLan: firstHubLan = null, onSettings = () => {}, lanSelf = () => null,
  findHub = (nodeId) => discover({ id: nodeId }), lanRetryMs = LAN_RETRY_MS,
}) {
  const publicSend = hubClient(origin, proxy);
  const identity = id ? `n:${id}` : null;
  const psk = id ? nodePsk(keyHash(key)) : null;
  const boot = randomBytes(8).toString('hex');
  const running = new Set();
  const seen = new Set();
  let stopped = false;
  let route = firstRoute;
  let hubLan = firstHubLan;
  let lanTarget = null;
  let lanProblem = null;
  let nextLanTry = 0;

  const lanSend = (target) => async (pathname, { body, timeoutMs }) => lanJson({
    host: target.host, port: target.port, identity, psk, path: pathname, body, timeoutMs,
    headers: { Authorization: `Bearer ${key}` },
  });

  async function findLan() {
    if (!identity) throw new Error('this computer joined before LAN support; join again to use the LAN');
    const ping = (host, port) => lanSend({ host, port })('/hub/node/ping', { body: {}, timeoutMs: LAN_PROBE_MS }).then((answer) => {
      if (answer.status === 401) throw new Error(`${host}:${port} no longer knows this computer`);
      if (answer.status !== 200) throw new Error(`${host}:${port} answered ${answer.status}`);
    });
    const reasons = [];
    if (hubLan?.addrs?.length) {
      try {
        return { host: await firstReachable(hubLan.addrs, hubLan.port, ping), port: hubLan.port };
      } catch (err) {
        reasons.push(err.message);
      }
    }
    // The main computer may have a new address since it restarted: ask the network.
    const found = await findHub(id).catch(() => []);
    for (const answer of found) {
      try {
        await ping(answer.address, answer.port);
        hubLan = { addrs: [answer.address, ...(hubLan?.addrs || []).filter((a) => a !== answer.address)], port: answer.port };
        onSettings({ hubLan });
        return { host: answer.address, port: answer.port };
      } catch (err) {
        reasons.push(err.message);
      }
    }
    if (!hubLan && !found.length) throw new Error('the main computer has no LAN address on record and did not answer on this network (it may be a cloud relay, or on another network)');
    if (!found.length) reasons.push('no answer to a search of this network');
    throw new Error(`the main computer cannot be reached over the LAN: ${reasons.join('; ')}`);
  }

  // The path for the next request: { send, via }, or an error when only the LAN is allowed and it is not there.
  async function path() {
    if (route === 'public' || !identity) {
      lanTarget = null;
      return { send: publicSend, via: 'public' };
    }
    if (!lanTarget && (route === 'lan' || Date.now() >= nextLanTry)) {
      try {
        lanTarget = await findLan();
        if (lanProblem || route === 'auto') log(`using the LAN: ${lanTarget.host}:${lanTarget.port}`);
        lanProblem = null;
      } catch (err) {
        lanProblem = err.message;
        nextLanTry = Date.now() + lanRetryMs;
        if (route === 'lan') throw Object.assign(new Error(err.message), { lanOnly: true });
      }
    }
    return lanTarget ? { send: lanSend(lanTarget), via: 'lan' } : { send: publicSend, via: 'public' };
  }

  function lanFailed(via, err) {
    if (via !== 'lan') return;
    lanProblem = `the LAN connection broke: ${err.message}`;
    lanTarget = null;
    // Auto falls back to the internet at once and tries the LAN again later.
    if (route === 'auto') nextLanTry = Date.now() + lanRetryMs;
  }

  function applySettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const changed = {};
    if (['auto', 'lan', 'public'].includes(settings.route) && settings.route !== route) {
      log(`route changed to ${settings.route}`);
      route = settings.route;
      changed.route = route;
      nextLanTry = 0;
      if (route === 'public') lanTarget = null;
    }
    if (settings.lan !== undefined && JSON.stringify(settings.lan) !== JSON.stringify(hubLan)) {
      hubLan = settings.lan;
      changed.hubLan = hubLan;
      // A new address is worth trying now rather than at the next retry.
      if (!lanTarget) nextLanTry = 0;
    }
    if (Object.keys(changed).length) onSettings(changed);
  }

  // Only the route is asked over the internet, so a computer set to LAN-only that cannot find
  // the main computer can still be switched back from the phone.
  async function checkIn() {
    try {
      const answer = await publicSend('/hub/node/settings', { key, body: { lanProblem }, timeoutMs: 20000 });
      if (answer.status === 200) applySettings(answer.body);
    } catch {
      // The internet is down as well; try again later.
    }
  }

  async function deliver(id, outcome) {
    for (let delay = 1000; !stopped; delay = Math.min(delay * 2, 30000)) {
      let via;
      try {
        const chosen = await path();
        via = chosen.via;
        const answer = await chosen.send('/hub/node/result', { key, body: { id, outcome }, timeoutMs: RESULT_TIMEOUT_MS });
        if (answer.status === 200 || answer.status === 401) break;
      } catch (err) {
        // Kept until the hub is back: the result of real work must not be dropped.
        if (!err.lanOnly) lanFailed(via, err);
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
    let connected = null;
    let lastCheckIn = 0;
    while (!stopped) {
      let via;
      try {
        const chosen = await path();
        via = chosen.via;
        const answer = await chosen.send('/hub/node/poll', {
          key,
          // knows lets the main computer answer at once when this computer's settings are out of date.
          body: { boot, running: [...running], info: machineInfo(), lan: lanSelf(), lanProblem, knows: JSON.stringify({ route, lan: hubLan }) },
          timeoutMs: POLL_TIMEOUT_MS,
        });
        if (answer.status === 401) {
          if (connected) log('the main computer removed this computer');
          connected = null;
          await sleep(60000);
          continue;
        }
        if (answer.status !== 200) throw new Error(`main computer answered ${answer.status}`);
        if (connected !== via) log(`connected to the main computer over ${via === 'lan' ? `the LAN (${lanTarget.host})` : origin}`);
        connected = via;
        delay = 1000;
        applySettings(answer.body.settings);
        for (const call of answer.body.calls || []) {
          if (seen.has(call.id)) continue;
          seen.add(call.id);
          if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
          running.add(call.id);
          runCall(call);
        }
      } catch (err) {
        if (stopped) return;
        if (err.lanOnly) {
          if (connected !== 'lan-missing') log(`LAN only, and ${err.message}`);
          connected = 'lan-missing';
          if (Date.now() - lastCheckIn >= lanRetryMs) {
            lastCheckIn = Date.now();
            await checkIn();
            if (route !== 'lan') continue;
          }
          await sleep(5000);
          continue;
        }
        if (connected) log(`connection lost: ${err.message}`);
        connected = null;
        lanFailed(via, err);
        // A broken LAN in auto mode goes straight to the internet.
        if (via === 'lan' && route === 'auto') continue;
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  loop();
  return {
    stop() { stopped = true; },
    state: () => ({ route, via: lanTarget ? 'lan' : 'public', lanProblem }),
  };
}
