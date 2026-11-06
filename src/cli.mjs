import readline from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import qrcode from './vendor/qrcode.mjs';
import {
  DEFAULT_PORT, choosePort, homeDir, hostnameFor, joinFilePath, loadConfig, logDir, memoryPath, newToken, publicLink, readJoinFileAt, requireConfig, saveConfig,
} from './config.mjs';
import { MemoryStore, renderLine } from './memory.mjs';
import {
  autostartState, installAppCopy, installAutostart, removeAutostart, runService, startService, stopService,
  writeLauncher,
} from './service.mjs';
import { desktopInstalled, desktopSupported, installDesktop } from './desktop.mjs';
import { browserInstalled, installBrowser } from './browser.mjs';
import { connectionParts, copyToClipboard, getQuickLink } from './link.mjs';
import { defaultShell, findBash, saveShellChoice, shellChoice } from './shell.mjs';
import { installBash } from './bash-install.mjs';
import { hubPath, loadHubState, parsePair } from './hub.mjs';
import { hubClient, joinHub } from './node-link.mjs';
import {
  appLink, createAccount, createSignup, listAccounts, loadRelayConfig, readAccount, relayDir, relayOrigin, removeAccount,
  runRelay, saveRelayConfig, signupLink, validHost,
} from './relay.mjs';
import { runQuick } from './quick.mjs';
import {
  checkPublic, deleteTunnel, ensureCloudflared, ensureCloudflareLogin, ensureTunnel, tunnelLogPath,
} from './tunnel.mjs';

const HELP = `wanji: give this computer its own fixed MCP link

  wanji setup <name>   set up once: tunnel, DNS, automatic start, link
      --domain <domain>       Your own Cloudflare domain (required on first setup)
      --port <port>           local port (default ${DEFAULT_PORT} or the next free one)
      --proxy <url>           proxy for downloads and Cloudflare API calls
      --cloudflared <path>    use this cloudflared instead of finding or downloading one
  wanji quick          temporary account-free tunnel, no setup or DNS
      --name <name>           optional computer label
      --port <port>           local port (default: first free port starting at ${DEFAULT_PORT})
      --proxy <url>           optional HTTP/HTTPS proxy
      --cloudflared <path>    local cloudflared executable (otherwise finds/downloads it)
      --copy                  copy the complete temporary link on start
  wanji link           choose which connection details to copy (interactive menu)
      --copy                  copy the complete MCP URL (no menu)
      --address --copy        copy the MCP address for Bearer-token clients
      --key --copy            copy only the secret key / Bearer token
      --quick | --fixed       select temporary or fixed tunnel
      --menu                  force the interactive copy menu
      --show                  print the complete MCP URL (for scripts)
  wanji app            connect the phone app: shows a QR code, and makes this the main computer
      --rows                  print the connection text and QR rows (for the Windows manager)
  wanji invite         make a one-time pairing code for adding another computer
      --file [path]           instead, pre-register a computer and write a join file (default: Desktop\join.json)
      --name <name>           name the new computer (default: computer, or computer-2 ...)
  wanji join <code>    add this computer to a main computer; it then starts by itself
      --file [path]           join from a join file instead of a pairing code
                              (no path: join.json in this computer's config folder)
      --name <name>           name the AI sees (default: this computer's name)
      --proxy <url>           proxy for reaching the main computer
  wanji computers      list the computers on this main computer
  wanji remove <name>  remove a computer from this main computer
  wanji route [name] [auto|lan|public]
                              how a computer reaches the main one and copies files: auto
                              prefers the LAN, lan never uses the internet for work, public
                              never uses the LAN. On a joined computer, leave out the name.
  wanji relay setup    make this rented server the relay all computers connect to
      --host <ip|domain>      this server's public IP or domain (required)
      --shared                serve several people, each signing up with an invite
      --tls acme|files|none   acme (default) gets a free certificate itself on port 80
      --staging               use Let's Encrypt's test service
      --port <n>              HTTPS port (default 443); with --tls none, the local HTTP port
      --origin <url>          public address, when another proxy or tunnel is in front
      --cert <file> --key <file>   certificate files for --tls files
  wanji relay run      run the relay in the foreground (what the system service calls)
  wanji relay app      show the QR code that connects the phone app (one-person relay)
  wanji relay invite   make an invite for one more person (shared relay)
  wanji relay users    list the people on this relay
  wanji relay remove-user <id>
  wanji memory         the notes AIs leave each other; yours are locked, so no AI can change them
      list [--kind fact|handoff] [--query words]    show the notes (this is the default)
      add "text" --key <key>  save a note of yours (a fact needs --key; --kind handoff has none)
      --computer <name> --tags a,b --open           optional; --open leaves the note unlocked
      lock <id|key> | unlock <id|key>               lock a note, which also makes it yours
      forget <id|key>         delete a note and wipe its text from the file
      authors                 who has written, newest first, and where their calls came from
      revoke <author> [--since <date>]              undo everything one AI wrote (and wipe it)
      revoke --all --since <date>                   undo every AI write since then, whatever names they gave
      purge                   keep only live notes; also ends the history, so nothing before can be undone
  wanji status         show whether the service and the link work
  wanji rotate         replace the secret; the old link stops working at once
  wanji desktop        install desktop control (ui_look, ui_act); setup does this too
  wanji browser        install the AI's own browser (Chromium + Playwright, about 300 MB)
      --proxy <url>           proxy for the download
  wanji shell [powershell|bash|auto]   choose the AI's default shell; bash downloads
                              Git Bash first when it is missing (Windows, about 60 MB)
      --proxy <url>           proxy for the download
  wanji update         make the service run this installed version
  wanji autostart [off]  start automatically with the computer (Windows: logon task;
                              Linux: systemd user service, plus a keeper in Windows under WSL)
  wanji start | stop   start or stop the service
  wanji run            run in the foreground (what the startup task calls)
  wanji uninstall      remove automatic start, keep the link for a later setup
      --delete-tunnel         also delete the Cloudflare tunnel
      --purge                 also delete local settings, logs and the secret
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
      continue;
    }
    const key = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[key] = argv[i + 1];
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

async function localHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(check, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(3000);
  }
  return false;
}

async function setup({ flags, positional }) {
  const existing = loadConfig();
  const name = (positional[0] || existing?.name || '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(name)) {
    throw new Error('usage: wanji setup <name>; the name may use a-z, 0-9 and hyphens');
  }
  if (existing && existing.name !== name) {
    throw new Error(`this computer is already set up as "${existing.name}"; run wanji uninstall --delete-tunnel --purge first`);
  }
  const domain = flags.domain ?? existing?.domain;
  if (typeof domain !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    throw new Error('fixed tunnel requires --domain <your-domain> (for example: --domain example.com)');
  }
  const hostname = hostnameFor(name, domain);
  const proxy = flags.proxy === true ? undefined : flags.proxy || existing?.proxy;

  await stopService();
  const port = flags.port ? Number(flags.port) : existing?.port || await choosePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a port number');

  const cloudflared = ensureCloudflared({ explicit: flags.cloudflared || existing?.cloudflared, proxy });
  ensureCloudflareLogin(cloudflared, proxy);
  console.log(`Connecting ${hostname} through Cloudflare...`);
  const tunnelId = ensureTunnel({ cloudflared, name, hostname, port, proxy });

  // Existing secret stays: running setup again must not break a link already in use.
  saveConfig({
    name, domain, hostname, port, tunnelId, cloudflared, proxy, token: existing?.token || newToken(),
  });
  installAppCopy();
  if (desktopSupported && !flags['no-desktop'] && !desktopInstalled()) {
    try {
      installDesktop({ proxy });
    } catch (err) {
      console.log(`Warning: desktop control was not installed: ${err.message}`);
    }
  }
  const autostart = installAutostart({ limited: flags.limited === true });
  if (!autostart.installed) {
    console.log(autostart.note);
  } else {
    startService();
    if (autostart.level !== 'Highest') {
      if (!flags.limited) console.log('Note: administrator rights were not granted, so windows running as administrator cannot be controlled. Run setup again and allow the prompt to change that.');
    }
    if (!findBash()) console.log('Note: Git Bash was not found, so the AI uses PowerShell. To give it Bash, run: wanji shell bash');
    if (!await waitFor(() => localHealthy(port), 30)) {
      throw new Error(`the service did not start on port ${port}; try wanji run to see why`);
    }
    console.log('Checking the public address...');
    if (!await waitFor(() => checkPublic(hostname, proxy), 120)) {
      console.log(`Warning: ${hostname} is not reachable yet. New DNS can take a few minutes; check with wanji status.`);
      console.log(`If it stays down, this network may block Cloudflare tunnels (TCP 7844). Log: ${tunnelLogPath()}`);
    }
  }
  console.log(`\nDone. Your fixed link (treat it like a password):\n\n  ${publicLink(requireConfig())}\n`);
  console.log('To copy the full link, address or key separately, run: wanji link');
}


async function linkCommand(flags) {
  if (flags.quick && flags.fixed) throw new Error('choose either --quick or --fixed');
  if (flags.address && flags.key) throw new Error('choose either --address or --key');
  const fixedConfig = loadConfig();
  const fixed = fixedConfig?.hostname ? connectionParts(`https://${fixedConfig.hostname}`, fixedConfig.token) : null;
  const quick = flags.fixed ? null : await getQuickLink();
  const interactive = flags.menu || (!flags.copy && !flags.show && !flags.address && !flags.key
    && process.stdin.isTTY && process.stdout.isTTY);
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('the interactive menu needs a terminal; use --copy, --address or --key instead');
  }

  let source = flags.quick ? 'quick' : flags.fixed ? 'fixed'
    : fixed ? 'fixed' : 'quick';
  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (fixed && quick && !flags.quick && !flags.fixed) {
        console.log('\nSelect a connection:\n  1. Fixed domain\n  2. Temporary tunnel');
        const answer = (await rl.question('Connection [1/2]: ')).trim();
        if (answer === '2') source = 'quick';
        else if (answer !== '1') return;
      }
      const parts = source === 'fixed' ? fixed : quick;
      if (!parts) throw new Error(source === 'quick'
        ? 'no live temporary tunnel found; start wanji quick and try again'
        : 'no fixed tunnel configured; run wanji setup <name> --domain example.com');
      console.log(`\n${source === 'quick' ? 'Temporary' : 'Fixed'} connection: ${parts.address}`);
      while (true) {
        console.log('\n  1. Copy complete MCP link (address + key)');
        console.log('  2. Copy MCP address only (Bearer-token mode)');
        console.log('  3. Copy secret key only');
        console.log('  4. Show all connection details (reveals key)');
        console.log('  0. Exit');
        const answer = (await rl.question('Choose [0-4]: ')).trim();
        if (answer === '0' || !answer) return;
        if (answer === '4') {
          console.log(`\nComplete link: ${parts.full}\nMCP address:   ${parts.address}\nSecret key:    ${parts.key}`);
          continue;
        }
        const part = { '1': 'full', '2': 'address', '3': 'key' }[answer];
        if (!part) { console.log('Choose 0, 1, 2, 3 or 4.'); continue; }
        copyToClipboard(parts[part]);
        console.log(`${part === 'full' ? 'Complete link' : part === 'address' ? 'MCP address' : 'Secret key'} copied. Paste it into your MCP client.`);
      }
    } finally {
      rl.close();
    }
  }

  const parts = source === 'fixed' ? fixed : quick;
  if (!parts) throw new Error(source === 'quick'
    ? 'no live temporary tunnel found; start wanji quick and try again'
    : 'no fixed tunnel configured; run wanji setup <name> --domain example.com');
  const part = flags.address ? 'address' : flags.key ? 'key' : 'full';
  if (flags.copy) {
    copyToClipboard(parts[part]);
    console.log(`${part === 'full' ? 'Complete link' : part === 'address' ? 'MCP address' : 'Secret key'} copied to clipboard.`);
  } else {
    console.log(parts[part]);
  }
}

// Talks to the running service, which owns the hub's state.
async function hubApi(pathname, { method = 'GET', body } = {}) {
  const config = requireConfig();
  if (config.joined) throw new Error(`this computer is joined to ${config.joined.origin}; manage computers on the main computer or in the phone app`);
  if (!config.hubEnabled) throw new Error('this is not a main computer yet; run: wanji app');
  const { adminKey } = loadHubState(hubPath(homeDir()));
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${config.port}/hub/api/${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('the service is not running; run: wanji start');
  }
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || `the service answered ${res.status}`);
  return answer;
}

function qrRows(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, y) => Array.from({ length: size }, (__, x) => (qr.isDark(y, x) ? '1' : '0')).join(''));
}

function printQr(rows) {
  // Two modules per character cell, with the white border scanners need.
  const blank = '0'.repeat(rows[0].length);
  const framed = [blank, ...rows, blank].map((row) => `0${row}0`);
  for (let y = 0; y < framed.length; y += 2) {
    let line = '';
    for (let x = 0; x < framed[y].length; x += 1) {
      const top = framed[y][x] === '0';
      const bottom = (framed[y + 1]?.[x] ?? '0') === '0';
      line += top && bottom ? '\u2588' : top ? '\u2580' : bottom ? '\u2584' : ' ';
    }
    console.log(line);
  }
}

// Turning the hub on is safe for clients already connected: until a second computer joins, they keep working unchanged.
async function appCommand(flags) {
  const config = requireConfig();
  if (config.joined) throw new Error('this computer is already joined to a main computer; connect the phone app on that one');
  if (!config.hostname) throw new Error('the main computer needs a fixed address first; run: wanji setup <name> --domain <your-domain>');
  if (!config.hubEnabled) {
    saveConfig({ ...config, hubEnabled: true });
    loadHubState(hubPath(homeDir()));
    await stopService();
    installAppCopy();
    startService();
    await waitFor(() => localHealthy(config.port), 30);
  }
  const { adminKey } = loadHubState(hubPath(homeDir()));
  const text = `wanji://${config.hostname}/${adminKey}`;
  const rows = qrRows(text);
  if (flags.rows) {
    console.log(text);
    console.log(rows.join('\n'));
    return;
  }
  console.log('\nOpen the 万机 app on your phone and scan this. It is the key to all your computers, so show it to no one.\n');
  printQr(rows);
  console.log(`\nOr copy this into the app:\n${text}\n`);
}

// Pre-register a computer on the host and write its credentials to a join file:
// the new computer joins from the file, with no pairing code to type.
async function inviteFileCommand(flags) {
  const created = await hubApi('computers', { method: 'POST', body: { name: typeof flags.name === 'string' ? flags.name : undefined } });
  // No path given: drop it on the Desktop, where it is easy to find and copy.
  const target = typeof flags.file === 'string' && flags.file
    ? path.resolve(flags.file)
    : path.join(os.homedir(), 'Desktop', 'join.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ origin: created.origin, id: created.id, key: created.key, name: created.name }, null, 2)}\n`, { mode: 0o600 });
  console.log(`加入文件已保存到：${target}\n\n把这个文件复制到新电脑的 %APPDATA%\\computer-mcp\\join.json，\n再在新电脑上打开 万机 管理器，确认后就会加入，不用输配对码\n（或者在新电脑上运行：wanji join --file <文件路径>）。\n\n注意：这个文件就是凭证，别泄露；加入成功后会自动删除。`);
}

// The config a joined computer saves; kept separate so it can be tested
// without stopping services or installing anything.
export function joinedConfig(existing, joined, { port, proxy, token }) {
  return {
    name: joined.name, port, proxy, token: existing?.token || token, joined: { origin: joined.origin, id: joined.id, key: joined.key },
  };
}

// The shared tail of joining: save the credentials, install the app copy and
// desktop control, set up autostart, and start the service. A join file is
// deleted only once its credentials are saved, so a failure cannot lose them.
async function finishJoin(existing, joined, flags, joinFile) {
  const proxy = flags.proxy === true ? undefined : flags.proxy || existing?.proxy;
  await stopService();
  const port = existing?.port || await choosePort();
  saveConfig(joinedConfig(existing, joined, { port, proxy, token: newToken() }));
  if (joinFile) fs.rmSync(joinFile, { force: true });
  installAppCopy();
  if (desktopSupported && !flags['no-desktop'] && !desktopInstalled()) {
    try {
      installDesktop({ proxy });
    } catch (err) {
      console.log(`Warning: desktop control was not installed: ${err.message}`);
    }
  }
  const autostart = installAutostart({ limited: flags.limited === true });
  if (autostart.installed) startService();
  if (autostart.note) console.log(autostart.note);
  console.log(`\nDone. This computer is now "${joined.name}". It starts by itself and appears in the phone app.`);
}

async function joinCommand({ flags, positional }) {
  const existing = loadConfig();
  if (existing?.hostname) throw new Error(`this computer already has its own link as "${existing.name}"; run wanji uninstall --delete-tunnel --purge first`);
  if (flags.file) {
    // --file alone means the join.json in this computer's config folder.
    const file = typeof flags.file === 'string' ? path.resolve(flags.file) : joinFilePath();
    const joined = readJoinFileAt(file);
    if (!joined) throw new Error(`no join file at ${file}; ask the main computer for one (wanji invite --file <path>)`);
    const name = joined.name || (typeof flags.name === 'string' ? flags.name : os.hostname().toLowerCase());
    return finishJoin(existing, { ...joined, name }, flags, file);
  }
  const { origin, code } = parsePair(positional.join(' '));
  const proxy = flags.proxy === true ? undefined : flags.proxy || existing?.proxy;
  const joined = await joinHub({
    origin, code, proxy, name: typeof flags.name === 'string' ? flags.name : os.hostname().toLowerCase(),
  });
  return finishJoin(existing, { ...joined, origin }, flags);
}

const VIA = { lan: 'over the LAN', public: 'over the internet' };

async function computersCommand() {
  const { computers } = await hubApi('status');
  for (const c of computers) {
    const path = c.main ? '' : `  [${c.route}${c.via ? `, ${VIA[c.via]}` : ''}]`;
    console.log(`${c.online ? 'online ' : 'offline'}  ${c.name}${c.main ? '  (main)' : ''}${path}${c.note ? `  - ${c.note}` : ''}`);
    if (!c.main && c.lanProblem && c.route !== 'public') console.log(`         LAN: ${c.lanProblem}`);
  }
}

async function routeCommand(positional) {
  const config = requireConfig();
  const ROUTES = ['auto', 'lan', 'public'];
  if (config.joined) {
    const wanted = positional[0];
    if (!wanted) {
      console.log(`route: ${config.joined.route || 'auto'} (as last heard from the main computer)`);
      return;
    }
    if (!ROUTES.includes(wanted)) throw new Error('choose auto, lan or public');
    const send = hubClient(config.joined.origin, config.proxy);
    const answer = await send('/hub/node/settings', { key: config.joined.key, body: { route: wanted }, timeoutMs: 20000 })
      .catch((err) => { throw new Error(`could not reach the main computer: ${err.message}`); });
    if (answer.status !== 200) throw new Error(answer.body?.error || `the main computer answered ${answer.status}`);
    saveConfig({ ...config, joined: { ...config.joined, route: answer.body.route, hubLan: answer.body.lan } });
    console.log(`Route set to ${answer.body.route}. The running service follows within a minute.`);
    return;
  }
  const [name, wanted] = positional;
  if (!name) return computersCommand();
  if (!ROUTES.includes(wanted)) throw new Error('usage: wanji route <name> auto|lan|public');
  const { computers } = await hubApi('status');
  const computer = computers.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!computer) throw new Error(`no computer named "${name}"`);
  if (computer.main) throw new Error('the main computer has no route; set it on the other computers');
  await hubApi(`computers/${computer.id}`, { method: 'PATCH', body: { route: wanted } });
  console.log(`${computer.name} now uses route ${wanted}.${computer.online ? ' It switches on its next check-in.' : ''}`);
}

async function removeCommand(name) {
  if (!name) throw new Error('usage: wanji remove <name>');
  const { computers } = await hubApi('status');
  const computer = computers.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!computer) throw new Error(`no computer named "${name}"`);
  if (computer.main) throw new Error('the main computer cannot be removed');
  await hubApi(`computers/${computer.id}`, { method: 'DELETE' });
  console.log(`Removed "${computer.name}". It can no longer be reached through this address.`);
}

async function relayCommand({ flags, positional }) {
  const sub = positional.shift();
  const dir = relayDir();
  const config = loadRelayConfig(dir);
  const need = () => {
    if (!config) throw new Error('the relay is not set up; run: wanji relay setup --host <this server\'s IP or domain>');
    return config;
  };
  const showLink = (text, intro) => {
    console.log(`\n${intro}\n`);
    printQr(qrRows(text));
    console.log(`\nOr copy this into the app:\n${text}\n`);
  };
  switch (sub) {
    case 'setup': {
      const host = String(flags.host || config?.host || '').toLowerCase();
      if (!validHost(host)) throw new Error('pass --host with this server\'s public IPv4 address or domain');
      const tls = flags.tls || config?.tls || 'acme';
      if (!['acme', 'files', 'none'].includes(tls)) throw new Error('--tls must be acme, files or none');
      const next = {
        ...config,
        host,
        tls,
        shared: flags.shared === true ? true : config?.shared === true,
        staging: flags.staging === true ? true : config?.staging,
        httpsPort: tls !== 'none' && flags.port ? Number(flags.port) : config?.httpsPort,
        port: tls === 'none' && flags.port ? Number(flags.port) : config?.port,
        origin: typeof flags.origin === 'string' ? flags.origin : config?.origin,
        certFile: typeof flags.cert === 'string' ? path.resolve(flags.cert) : config?.certFile,
        keyFile: typeof flags.key === 'string' ? path.resolve(flags.key) : config?.keyFile,
      };
      if (tls === 'files' && (!next.certFile || !next.keyFile)) throw new Error('--tls files needs --cert and --key');
      if (tls === 'none' && !next.origin) throw new Error('--tls none needs --origin https://... (the address of the proxy in front)');
      saveRelayConfig(next, dir);
      if (!next.shared && listAccounts(dir).length === 0) createAccount(dir, 'owner');
      console.log(`Relay set up for ${relayOrigin(next)}${next.shared ? ' (shared)' : ''}.`);
      console.log(next.shared ? 'Make an invite for each person with: wanji relay invite' : 'Once it runs, connect the phone app with: wanji relay app');
      return undefined;
    }
    case 'run':
      need();
      await runRelay({ dir });
      return undefined;
    case 'app': {
      const ids = listAccounts(dir);
      const id = positional[0] || (ids.length === 1 ? ids[0] : null);
      if (!id) throw new Error('this relay has several people; each connects with their own invite (wanji relay invite)');
      const text = appLink(need(), readAccount(dir, id).adminKey);
      if (flags.rows) {
        console.log(text);
        console.log(qrRows(text).join('\n'));
        return undefined;
      }
      showLink(text, 'Open the 万机 app on your phone and scan this. It is the key to all your computers, so show it to no one.');
      return undefined;
    }
    case 'invite': {
      if (!need().shared) throw new Error('this relay serves one person; connect the phone app with: wanji relay app');
      const { code, days } = createSignup(dir);
      showLink(signupLink(config, code), `Invite for one person, valid for ${days} days, one use. They scan it with the 万机 app.`);
      return undefined;
    }
    case 'users':
      for (const id of listAccounts(dir)) {
        const account = readAccount(dir, id);
        const computers = Object.values(account.computers || {}).map((c) => c.name);
        console.log(`${id}  since ${account.createdAt?.slice(0, 10) || '?'}  ${computers.length} computer(s)${computers.length ? `: ${computers.join(', ')}` : ''}`);
      }
      return undefined;
    case 'remove-user': {
      const id = positional[0];
      if (!id || !listAccounts(dir).includes(id)) throw new Error('usage: wanji relay remove-user <id from relay users>');
      removeAccount(dir, id);
      console.log(`Removed ${id}. Their MCP address and computers stop working within a few seconds.`);
      return undefined;
    }
    default:
      throw new Error('usage: wanji relay setup|run|app|invite|users|remove-user');
  }
}

// The owner's side of the shared memory. It works on the same file as the running service, which
// reads whatever is appended; the rewrites (forget, revoke, purge) are rare and brief.
function memoryCommand({ positional, flags }) {
  const store = new MemoryStore({ file: memoryPath() });
  const [action = 'list', ...rest] = positional;
  const flag = (name) => (typeof flags[name] === 'string' ? flags[name] : undefined);
  const ref = () => {
    if (!rest[0]) throw new Error(`memory ${action} needs the id or the key of a note (see: wanji memory list)`);
    return /^m_[0-9a-f]{8}$/.test(rest[0]) ? { id: rest[0] } : { key: rest[0] };
  };
  switch (action) {
    case 'list': {
      const { total, items } = store.list({ kind: flag('kind') || 'all', query: flag('query'), limit: 50 });
      const s = store.stats();
      console.log(`${s.facts} facts, ${s.handoffs} handoffs, ${s.chars} characters. File: ${memoryPath()}`);
      for (const note of items) console.log(renderLine(note, 200));
      if (total > items.length) console.log(`(${total - items.length} more; narrow with --query or --kind)`);
      return;
    }
    case 'add': {
      const kind = flag('kind') || 'fact';
      const key = flag('key');
      const found = kind === 'fact' && key ? store.byKey(key) : null;
      const { entry, created } = store.write({
        kind,
        text: rest[0],
        key,
        computer: flag('computer'),
        tags: flag('tags') ? flag('tags').split(',') : undefined,
        if_rev: found?.rev,
        by: 'owner',
        locked: flags.open ? false : undefined,
      });
      console.log(`${created ? 'Saved' : 'Replaced'} ${entry.kind} ${entry.id}${entry.locked ? ' (locked)' : ''}.`);
      return;
    }
    case 'lock':
    case 'unlock': {
      const note = store.setLock(ref(), action === 'lock');
      console.log(`${note.id} is ${note.locked ? 'locked and now yours' : 'unlocked'}.`);
      return;
    }
    case 'forget': {
      const gone = store.forget({ ...ref(), by: 'owner' });
      console.log(`Deleted ${gone.kind} ${gone.id}; its text is gone from the file.`);
      return;
    }
    case 'authors': {
      const rows = store.authors();
      if (!rows.length) console.log('Nobody has written yet.');
      for (const row of rows) console.log(`${row.author}: ${row.events} writes, last ${row.last}${row.via.length ? `, from ${row.via.join('; ')}` : ''}`);
      return;
    }
    case 'revoke': {
      const all = Boolean(flags.all);
      if (all && !flag('since')) throw new Error('memory revoke --all needs --since <date>, the time from which every AI write is undone');
      if (!all && !rest[0]) throw new Error('memory revoke needs the name of an AI (see: wanji memory authors), or --all --since <date>');
      const { events } = store.revoke({ author: all ? '*' : rest[0], since: flag('since') });
      console.log(`Undid ${events} writes by ${all ? 'every AI' : `"${rest[0]}"`} and wiped them from the file.`);
      return;
    }
    case 'purge': {
      const s = store.purge();
      console.log(`The file now holds only live notes: ${s.facts} facts, ${s.handoffs} handoffs. Earlier writes can no longer be undone.`);
      return;
    }
    default:
      throw new Error('memory: use list, add, lock, unlock, forget, authors, revoke or purge');
  }
}

async function status() {
  const config = requireConfig();
  if (config.joined) {
    console.log(`name:        ${config.name}`);
    console.log(`joined to:   ${config.joined.origin}`);
    console.log(`local:       ${await localHealthy(config.port) ? 'running' : 'NOT running'}`);
    console.log(`autostart:   ${autostartState()}`);
    console.log(`browser:     ${browserInstalled() ? 'installed' : 'not installed; run wanji browser'}`);
    console.log(`audit log:   ${path.join(logDir(), 'audit.jsonl')}`);
    return;
  }
  const local = await localHealthy(config.port);
  const remote = await checkPublic(config.hostname, config.proxy);
  console.log(`name:        ${config.name}`);
  console.log(`address:     https://${config.hostname} (the secret is shown by wanji link)`);
  console.log(`local:       ${local ? 'running' : 'NOT running'} on 127.0.0.1:${config.port}`);
  console.log(`public:      ${remote ? 'reachable' : 'NOT reachable'}`);
  console.log(`autostart:   ${autostartState()}`);
  console.log(`shell:       ${shellLine()}`);
  if (desktopSupported) console.log(`desktop:     ${desktopInstalled() ? 'installed' : 'not installed; run wanji desktop'}`);
  console.log(`browser:     ${browserInstalled() ? 'installed' : 'not installed; run wanji browser'}`);
  console.log(`audit log:   ${path.join(logDir(), 'audit.jsonl')}`);
  console.log(`tunnel log:  ${tunnelLogPath()}`);
  if (!local || !remote) process.exitCode = 1;
}

function shellLine() {
  const bash = findBash();
  if (process.platform !== 'win32') return bash || 'sh';
  const choice = shellChoice() === 'auto' ? 'automatic' : 'chosen';
  return `${defaultShell() === 'bash' ? 'Git Bash' : 'PowerShell'} (${choice})${bash ? `, Git Bash at ${bash}` : ', Git Bash not installed'}`;
}

async function shellCommand({ positional, flags }) {
  const wanted = positional[0];
  if (!wanted) {
    console.log(`The AI's default shell: ${shellLine()}`);
    return;
  }
  if (!['powershell', 'bash', 'auto'].includes(wanted)) throw new Error('choose powershell, bash or auto');
  if (process.platform !== 'win32') throw new Error('only Windows has a shell choice; elsewhere the AI uses bash');
  if (wanted === 'bash' && !findBash()) {
    const bash = await installBash({ proxy: flags.proxy === true ? undefined : flags.proxy || loadConfig()?.proxy });
    console.log(`Git Bash is installed at ${bash}`);
  }
  saveShellChoice(wanted);
  console.log(`The AI's default shell is now ${defaultShell() === 'bash' ? 'Git Bash' : 'PowerShell'}. It applies to the next command; AI chats already open learn it when they reconnect.`);
}

async function uninstall({ flags }) {
  await stopService();
  removeAutostart();
  const config = loadConfig();
  if (flags['delete-tunnel'] && config) {
    deleteTunnel({ cloudflared: config.cloudflared, name: config.name, proxy: config.proxy });
    console.log(`Tunnel deleted. The DNS record ${config.hostname} remains; remove it in the Cloudflare dashboard if you no longer need the name.`);
  }
  if (flags.purge) {
    fs.rmSync(homeDir(), { recursive: true, force: true });
    console.log('Local settings, logs and the secret are deleted.');
  }
  console.log('Automatic start removed and service stopped.');
}

export async function main(argv) {
  const parsed = parseArgs(argv);
  const command = parsed.positional.shift();
  switch (command) {
    case 'setup':
      return setup(parsed);
    case 'quick': {
      const port = parsed.flags.port ? Number(parsed.flags.port) : await choosePort();
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a port number');
      return runQuick({ port, name: parsed.flags.name || undefined, proxy: parsed.flags.proxy === true ? undefined : parsed.flags.proxy, cloudflared: parsed.flags.cloudflared === true ? undefined : parsed.flags.cloudflared, copy: parsed.flags.copy === true });
    }
    case 'app':
      return appCommand(parsed.flags);
    case 'invite': {
      if (parsed.flags.file) return inviteFileCommand(parsed.flags);
      const invite = await hubApi('invites', { method: 'POST' });
      console.log(`Pairing code, valid for 10 minutes, one use:\n\n  ${invite.pair}\n\nOn the new computer run: wanji join ${invite.pair}`);
      return undefined;
    }
    case 'join':
      return joinCommand(parsed);
    case 'computers':
      return computersCommand();
    case 'remove':
      return removeCommand(parsed.positional[0]);
    case 'route':
      return routeCommand(parsed.positional);
    case 'relay':
      return relayCommand(parsed);
    case 'run':
      return runService();
    case 'link':
      return linkCommand(parsed.flags);
    case 'memory':
      return memoryCommand(parsed);
    case 'status':
      return status();
    case 'rotate': {
      const config = requireConfig();
      saveConfig({ ...config, token: newToken() });
      console.log('Secret replaced; the old link no longer works. Get the new one with: wanji link');
      return undefined;
    }
    case 'shell':
      return shellCommand(parsed);
    case 'browser':
      await installBrowser({ proxy: parsed.flags.proxy === true ? undefined : parsed.flags.proxy || loadConfig()?.proxy });
      return undefined;
    case 'desktop':
      installDesktop({ proxy: parsed.flags.proxy === true ? undefined : parsed.flags.proxy || loadConfig()?.proxy });
      return undefined;
    case 'update':
      requireConfig();
      await stopService();
      installAppCopy();
      if (process.platform === 'win32') writeLauncher();
      startService();
      console.log('The service now runs this version.');
      return undefined;
    case 'autostart': {
      requireConfig();
      if (parsed.positional[0] === 'off') {
        await stopService();
        removeAutostart();
        console.log('Automatic start removed and the service stopped. Start it again with: wanji autostart');
        return undefined;
      }
      installAppCopy();
      const autostart = installAutostart({ limited: parsed.flags.limited === true });
      if (!autostart.installed) throw new Error(autostart.note);
      await stopService();
      startService();
      console.log(`Starts automatically (${autostart.level}) and is running now.${autostart.note ? `\nNote: ${autostart.note}` : ''}`);
      return undefined;
    }
    case 'start':
      requireConfig();
      return startService();
    case 'stop':
      return stopService();
    case 'uninstall':
      return uninstall(parsed);
    default:
      console.log(HELP);
      if (command && command !== 'help') process.exitCode = 1;
      return undefined;
  }
}
