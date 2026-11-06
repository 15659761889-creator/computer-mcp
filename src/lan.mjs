import { createHash, createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import os from 'node:os';

// Computers on the same network talk directly over TLS-PSK: the key both sides already hold
// from pairing does the authentication and encryption, so there is no certificate and nothing
// for the person to set up. Only TLS 1.2 has PSK in Node.js; ECDHE adds forward secrecy.
export const LAN_PORT = 8766;
export const DISCOVERY_PORT = 8767;
const CIPHERS = 'ECDHE-PSK-CHACHA20-POLY1305';
const TLS = { ciphers: CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
const FIREWALL_RULE = '万机 LAN';

export const ROUTES = ['auto', 'lan', 'public'];

// The hub keeps only sha256(key), so the LAN key is derived from that. This means
// anyone who learns a computer's key hash can also derive its LAN key (but not the
// admin key itself, which the hash does not reveal). A separate per-computer LAN
// secret would need a pairing-protocol change, so this trade-off is accepted.
export function nodePsk(keyHashHex) {
  return createHmac('sha256', Buffer.from(keyHashHex, 'hex')).update('computer-mcp lan v1').digest();
}

export const keyHash = (key) => createHash('sha256').update(String(key)).digest('hex');

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

// Private IPv4 addresses of this machine, the ones another computer at home can reach.
export function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && PRIVATE.some((re) => re.test(item.address))) found.push(item.address);
    }
  }
  // Link-local addresses come last: they mean DHCP failed on that adapter.
  return [...new Set(found)].sort((a, b) => Number(a.startsWith('169.254.')) - Number(b.startsWith('169.254.')));
}

function broadcastAddresses() {
  const found = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal || !item.netmask) continue;
      const ip = item.address.split('.').map(Number);
      const mask = item.netmask.split('.').map(Number);
      found.add(ip.map((part, i) => (part | (~mask[i] & 255))).join('.'));
    }
  }
  return [...found];
}

// handle(req, res, identity) serves a request from an authenticated peer; pskFor(identity)
// returns that peer's key, or null to refuse the connection.
export function startLanServer({ port = LAN_PORT, host = '0.0.0.0', pskFor, handle, log = () => {} }) {
  const server = https.createServer({
    ...TLS,
    pskCallback: (socket, identity) => {
      const psk = pskFor(identity);
      if (psk) socket.lanIdentity = identity;
      return psk || null;
    },
  }, (req, res) => {
    const identity = req.socket.lanIdentity;
    if (!identity) {
      res.writeHead(401).end();
      return;
    }
    Promise.resolve(handle(req, res, identity)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      else res.destroy();
    });
  });
  // A failed handshake is someone without the key; nothing to report.
  server.on('tlsClientError', () => {});
  server.keepAliveTimeout = 65000;
  return new Promise((resolve) => {
    const tryPort = (wanted, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0 && wanted !== 0) {
          tryPort(wanted + 2, left - 1);
          return;
        }
        log(`LAN port not opened: ${err.message}`);
        resolve(null);
      });
      server.listen(wanted, host, () => resolve(server));
    };
    tryPort(port, 5);
  });
}

const agents = new Map();

// No TLS session cache: resuming a PSK session on a second connection hangs the handshake.
function agentFor(identity, psk) {
  const key = `${identity}|${psk.toString('hex')}`;
  if (!agents.has(key)) {
    if (agents.size > 64) agents.clear();
    agents.set(key, new https.Agent({ ...TLS, keepAlive: true, maxSockets: 8, maxCachedSessions: 0, pskCallback: () => ({ psk, identity }), checkServerIdentity: () => undefined }));
  }
  return agents.get(key);
}

// One request to a peer. Resolves with the raw response for streaming, or rejects with a
// reason a person can act on.
export function lanRequest({ host, port, identity, psk, path, method = 'GET', headers = {}, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path, method, headers, agent: agentFor(identity, psk) }, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(new Error(lanReason(err, host, port))));
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body);
  });
}

export function lanReason(err, host, port) {
  const where = `${host}:${port}`;
  switch (err.code) {
    case 'ECONNREFUSED': return `${where} refused the connection (万机 is not running there, or uses another port)`;
    case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': return `${where} did not answer (not on this network, or a firewall blocks port ${port})`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `${where} cannot be reached from this network`;
    case 'ECONNRESET': return `${where} closed the connection`;
    case 'EPROTO': case 'ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY': return `${where} did not accept this computer's key (a different 万机, or this computer was removed)`;
    default: return `${where}: ${err.message}`;
  }
}

export async function readBody(res, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) throw new Error('reply too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function lanJson(options) {
  const res = await lanRequest({
    ...options,
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)),
  });
  const text = (await readBody(res)).toString('utf8');
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Status alone says enough.
  }
  return { status: res.statusCode, body: parsed };
}

// The first address that answers wins; every failure is kept so a forced LAN route can say why.
export async function firstReachable(addrs, port, attempt) {
  if (!addrs?.length || !port) throw new Error('its LAN address is not known yet (it has not connected since starting)');
  const reasons = [];
  return new Promise((resolve, reject) => {
    let left = addrs.length;
    for (const host of addrs) {
      attempt(host, port).then(() => resolve(host), (err) => {
        reasons.push(err.message);
        left -= 1;
        if (!left) reject(new Error(reasons.join('; ')));
      });
    }
  });
}

// Answers "where are you" broadcasts, so a computer finds the main one after its address changed.
export function startDiscovery({ port = DISCOVERY_PORT, answer, log = () => {} }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (data, rinfo) => {
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (message?.cmcp !== 'find') return;
    const reply = answer(message);
    if (reply) socket.send(Buffer.from(JSON.stringify({ cmcp: 'here', ...reply })), rinfo.port, rinfo.address);
  });
  socket.on('error', (err) => {
    log(`LAN discovery off: ${err.message}`);
    socket.close();
  });
  socket.bind(port);
  return socket;
}

// Broadcasts once and collects answers for timeoutMs.
export function discover(message, { port = DISCOVERY_PORT, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = [];
    socket.on('message', (data, rinfo) => {
      try {
        const reply = JSON.parse(data.toString('utf8'));
        if (reply?.cmcp === 'here') found.push({ ...reply, address: rinfo.address });
      } catch {
        // Not ours.
      }
    });
    socket.on('error', () => {});
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const payload = Buffer.from(JSON.stringify({ cmcp: 'find', ...message }));
      for (const address of broadcastAddresses()) socket.send(payload, port, address, () => {});
    });
    setTimeout(() => {
      socket.close();
      // One answer per address, home-network addresses first: VPN and proxy adapters answer too.
      const unique = [...new Map(found.map((f) => [f.address, f])).values()];
      const rank = (f) => (PRIVATE.slice(0, 3).some((re) => re.test(f.address)) ? 0 : PRIVATE.some((re) => re.test(f.address)) ? 1 : 2);
      resolve(unique.sort((x, y) => rank(x) - rank(y)));
    }, timeoutMs);
  });
}

// Lets other computers reach the LAN port without Windows asking the person. Needs the
// elevated service; a limited one leaves it to Windows' own prompt.
export function allowThroughFirewall(tcpPort) {
  if (process.platform !== 'win32') return 'not needed';
  const program = process.execPath;
  const show = spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`, 'verbose'], { encoding: 'utf8', windowsHide: true });
  const current = show.stdout || '';
  if (show.status === 0 && current.includes(String(tcpPort)) && current.toLowerCase().includes(program.toLowerCase())) return 'already allowed';
  spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`], { windowsHide: true });
  const rules = [['TCP', String(tcpPort)], ['UDP', String(DISCOVERY_PORT)]].map(([protocol, port]) => spawnSync('netsh', [
    'advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow',
    `program=${program}`, `protocol=${protocol}`, `localport=${port}`, 'profile=any',
  ], { encoding: 'utf8', windowsHide: true }));
  return rules.every((r) => r.status === 0) ? 'allowed' : `not allowed: ${(rules.find((r) => r.status !== 0).stdout || '').trim()}`;
}
