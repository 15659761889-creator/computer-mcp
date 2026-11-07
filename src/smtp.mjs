import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import readline from 'node:readline';

const validMailbox = (value) => typeof value === 'string'
  && value.length <= 254
  && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)
  && !/[\r\n]/.test(value);

// SMTP is deliberately opt-in: a partial configuration leaves the license in the
// operator's existing pending-delivery queue.
export function smtpConfig(env = process.env) {
  const host = String(env.WANJI_SMTP_HOST || '').trim();
  const user = String(env.WANJI_SMTP_USER || '');
  const password = String(env.WANJI_SMTP_PASSWORD || '');
  const from = String(env.WANJI_SMTP_FROM || user);
  const rawPort = env.WANJI_SMTP_PORT === undefined || env.WANJI_SMTP_PORT === ''
    ? '465' : String(env.WANJI_SMTP_PORT);
  const port = Number(rawPort);
  if (!host || !user || !password || !from) return null;
  if (/[\s\r\n]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535
    || /[\r\n]/.test(user) || /[\r\n]/.test(password) || !validMailbox(from)) return null;
  const secureValue = String(env.WANJI_SMTP_SECURE ?? '').toLowerCase();
  const secure = secureValue ? !['0', 'false', 'no'].includes(secureValue) : port === 465;
  return { host, port, user, password, from, secure };
}

function lineReader(socket) {
  const input = readline.createInterface({ input: socket, crlfDelay: Infinity });
  const queued = [];
  const waiting = [];
  let closed = false;
  let failure = null;
  const onLine = (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  };
  const onError = (error) => {
    failure = error;
    while (waiting.length) waiting.shift().reject(error);
  };
  const onClose = () => {
    closed = true;
    while (waiting.length) waiting.shift().reject(failure || new Error('SMTP connection closed'));
  };
  input.on('line', onLine);
  input.once('close', onClose);
  socket.on('error', onError);
  return {
    async next() {
      if (queued.length) return queued.shift();
      if (failure) throw failure;
      if (closed) throw new Error('SMTP connection closed');
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    close() {
      input.close();
      socket.off('error', onError);
    },
  };
}

async function readReply(reader) {
  const lines = [];
  let line = await reader.next();
  if (!/^\d{3}[ -]/.test(line)) throw new Error('SMTP server sent an invalid response');
  const code = Number(line.slice(0, 3));
  lines.push(line);
  while (line[3] === '-') {
    line = await reader.next();
    if (!/^\d{3}[ -]/.test(line) || Number(line.slice(0, 3)) !== code) throw new Error('SMTP server sent an invalid multiline response');
    lines.push(line);
  }
  return { code, lines };
}

function expect(reply, codes, step) {
  if (!codes.includes(reply.code)) throw new Error(`SMTP ${step} failed (server replied ${reply.code})`);
}

function validHost(host) {
  return typeof host === 'string' && host.length <= 253 && !/[\s\r\n/]/.test(host);
}

export async function sendSmtpMail(config, { to, subject, text }) {
  if (!config || !validHost(config.host) || !validMailbox(config.from) || !validMailbox(to)
    || /[\r\n]/.test(subject || '') || /[\r\n]/.test(config.user || '') || /[\r\n]/.test(config.password || '')) {
    throw new Error('SMTP configuration or message address is invalid');
  }

  let socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.connect({ host: config.host, port: config.port });
  socket.setTimeout(20000, () => socket.destroy(new Error('SMTP connection timed out')));
  if (config.secure) await once(socket, 'secureConnect');
  else await once(socket, 'connect');
  let reader = lineReader(socket);

  try {
    expect(await readReply(reader), [220], 'greeting');
    const ehlo = await (async () => {
      socket.write('EHLO wanji.local\r\n');
      return readReply(reader);
    })();
    expect(ehlo, [250], 'EHLO');

    if (!config.secure) {
      socket.write('STARTTLS\r\n');
      expect(await readReply(reader), [220], 'STARTTLS');
      reader.close();
      socket = tls.connect({ socket, host: config.host, servername: config.host });
      socket.setTimeout(20000, () => socket.destroy(new Error('SMTP connection timed out')));
      await once(socket, 'secureConnect');
      reader = lineReader(socket);
      socket.write('EHLO wanji.local\r\n');
      expect(await readReply(reader), [250], 'EHLO after STARTTLS');
    }

    socket.write(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.password}`).toString('base64')}\r\n`);
    expect(await readReply(reader), [235], 'authentication');
    socket.write(`MAIL FROM:<${config.from}>\r\n`);
    expect(await readReply(reader), [250], 'sender');
    socket.write(`RCPT TO:<${to}>\r\n`);
    expect(await readReply(reader), [250, 251], 'recipient');
    socket.write('DATA\r\n');
    expect(await readReply(reader), [354], 'message start');

    const body = String(text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const message = [
      `From: <${config.from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '.',
      '',
    ].join('\r\n');
    socket.write(message);
    expect(await readReply(reader), [250], 'message delivery');
    socket.write('QUIT\r\n');
    expect(await readReply(reader), [221], 'QUIT');
  } finally {
    reader.close();
    socket.end();
    socket.destroy();
  }
}
