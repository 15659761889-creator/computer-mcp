// Static risk annotation for skill setup commands.
//
// Rules of the road:
//   1. Static only. The model never grades its own commands.
//   2. Fail closed: a command we cannot recognise is system-wide. "isolated" needs proof that every
//      target is inside a skill directory.
//   3. This is not a sandbox. It decides whether a person must look at the exact command. The real
//      protection is the exact-command approval, the hash binding, snapshots and undo steps.
import path from 'node:path';

// Tags, from harmless to dangerous.
export const RISK_TAGS = ['isolated', 'user-level', 'system-wide', 'elevated', 'destructive', 'remote-exec'];

// ctx = { os: 'windows'|'linux'|'macos', homeDir, cwd, vars: {SKILL_ENV: ..., SKILL_CACHE: ...}, skillDirs: [...] }
// vars keys must be upper case.

const F = (tag, rule, reason, hint) => (hint ? { tag, rule, reason, hint } : { tag, rule, reason });

// ---------------------------------------------------------------- parsing

function tokenize(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

function makeSegment(raw, piped) {
  const tokens = tokenize(raw);
  const base = (tokens[0] ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
  return { raw, tokens, cmd: base, args: tokens.slice(1), pipedFromPrev: piped };
}

// Split on && || ; | and newlines, respecting quotes. $() nesting is not parsed; the opaque rule
// escalates such commands instead.
export function splitSegments(cmd) {
  const segs = [];
  let buf = '';
  let quote = null;
  let piped = false;
  const flush = (nextPiped) => {
    const raw = buf.trim();
    buf = '';
    if (raw) segs.push(makeSegment(raw, piped));
    piped = nextPiped;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { buf += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { flush(false); i++; continue; }
    if (c === '|') { flush(true); continue; }
    if (c === ';' || c === '\n') { flush(false); continue; }
    buf += c;
  }
  flush(false);
  return segs;
}

// ---------------------------------------------------------------- paths

export function expandVars(s, ctx) {
  return String(s).replace(/%(\w+)%|\$\{(\w+)\}|\$env:(\w+)|\$(\w+)/gi, (m, a, b, c, d) => {
    const key = String(a ?? b ?? c ?? d).toUpperCase();
    return ctx.vars?.[key] ?? m;
  });
}

function norm(p, ctx) {
  let s = String(p).replace(/\\/g, '/');
  if (s.startsWith('~')) s = String(ctx.homeDir).replace(/\\/g, '/') + s.slice(1);
  if (!/^([a-z]:)?\//i.test(s)) s = String(ctx.cwd).replace(/\\/g, '/') + '/' + s;
  s = path.posix.normalize(s);
  return ctx.os === 'windows' ? s.toLowerCase() : s;
}

function within(p, dirs, ctx) {
  const e = expandVars(p, ctx);
  if (/[$%`]/.test(e)) return false; // an unresolved variable cannot be proven to be inside
  const n = norm(e, ctx);
  return dirs.some((d) => {
    const dn = norm(d, ctx).replace(/\/$/, '');
    return n === dn || n.startsWith(dn + '/');
  });
}
const inSkill = (p, ctx) => within(p, ctx.skillDirs ?? [], ctx);
const inHome = (p, ctx) => within(p, [ctx.homeDir], ctx);

function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(n + '=')) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}
const hasFlag = (args, names) => args.some((a) => names.some((n) => a.toLowerCase() === n || a.toLowerCase().startsWith(n + '=')));
// POSIX absolute paths start with '/'; never discard them as command flags.
// On Windows, slash-prefixed switches (for example /S) remain excluded.
const nonFlags = (args, ctx) => args.filter((a) => !a.startsWith('-') && !(ctx?.os === 'windows' && a.startsWith('/')));

function placeOf(paths, ctx) {
  if (!paths.length) return 'outside';
  if (paths.every((p) => inSkill(p, ctx))) return 'isolated';
  if (paths.every((p) => inSkill(p, ctx) || inHome(p, ctx))) return 'user-level';
  return 'outside';
}

// ---------------------------------------------------------------- rules

const ELEVATORS = new Set(['sudo', 'doas', 'gsudo', 'su', 'runas', 'pkexec']);
const DESTROY = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'shred', 'truncate']);
const DISK_KILL = new Set(['mkfs', 'format', 'diskpart', 'fdisk', 'parted']);
const ALL_ARGS_OPS = new Set(['mkdir', 'md', 'touch', 'new-item', 'ni', 'set-content', 'add-content', 'out-file', 'tee']);
const DEST_OPS = new Set(['cp', 'copy', 'copy-item', 'mv', 'move', 'move-item', 'expand-archive', 'unzip', 'tar', 'ln', 'install']);
const READONLY = new Set([
  'echo', 'cd', 'pwd', 'ls', 'dir', 'cat', 'type', 'where', 'which', 'test', 'true', 'false',
  'get-command', 'get-childitem', 'write-host', 'write-output', 'set-location',
]);
const PY = new Set(['python', 'python3', 'py']);
const FETCHERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'python', 'python3', 'py', 'perl', 'ruby', 'node', 'powershell', 'pwsh', 'iex', 'invoke-expression']);

const elevatedRule = (s) => {
  const out = [];
  if (/-verb\s+runas/i.test(s.raw)) out.push(F('elevated', 'elevated.runas', 'Start-Process -Verb RunAs asks for administrator rights'));
  if (s.cmd === 'choco' || s.cmd === 'chocolatey') {
    if (s.args.some((a) => ['install', 'upgrade', 'uninstall'].includes(a))) out.push(F('elevated', 'elevated.choco', 'Chocolatey installs need administrator rights'));
  }
  return out;
};

const destructiveRule = (s, ctx) => {
  if (DISK_KILL.has(s.cmd) || /^mkfs(?:\.[a-z0-9_-]+)?$/.test(s.cmd) || ['mke2fs', 'mkswap', 'wipefs', 'sgdisk'].includes(s.cmd)) return [F('destructive', 'destructive.disk', `${s.cmd} rewrites disks or partitions`)];
  if (s.cmd === 'dd') {
    const of = s.args.find((a) => a.startsWith('of='))?.slice(3);
    return of && inSkill(of, ctx)
      ? [F('isolated', 'destructive.dd-in-skill', 'dd writes inside the skill area')]
      : [F('destructive', 'destructive.dd', 'dd writes outside the skill area')];
  }
  if (!DESTROY.has(s.cmd)) return [];
  return placeOf(nonFlags(s.args, ctx), ctx) === 'isolated'
    ? [F('isolated', 'destructive.rm-in-skill', 'every delete target is inside the skill area')]
    : [F('destructive', 'destructive.rm', 'deletes or overwrites paths outside the skill area')];
};

const fileOpRule = (s, ctx) => {
  let targets;
  if (ALL_ARGS_OPS.has(s.cmd)) targets = nonFlags(s.args, ctx);
  else if (DEST_OPS.has(s.cmd)) {
    const d = flagValue(s.args, ['-C', '-d', '-DestinationPath', '-Destination', '-t']);
    const nf = nonFlags(s.args, ctx);
    targets = d ? [d] : nf.length ? [nf[nf.length - 1]] : [];
  } else return [];
  const where = placeOf(targets, ctx);
  if (where === 'isolated') return [F('isolated', 'fileop.skill', 'writes only inside the skill area')];
  if (where === 'user-level') return [F('user-level', 'fileop.home', 'writes inside the user home')];
  return [F('system-wide', 'fileop.outside', 'writes outside the user home')];
};

const redirectRule = (s, ctx) => {
  const out = [];
  for (const m of s.raw.matchAll(/(?<![0-9&])(>>?)\s*("[^"]+"|'[^']+'|\S+)/g)) {
    const target = m[2].replace(/^["']|["']$/g, '');
    if (/^(\/dev\/null|nul|\$null|&\d)$/i.test(target)) continue;
    if (/\.(bashrc|zshrc|profile|bash_profile|zprofile)$/.test(target) || /profile\.ps1$/i.test(target)) {
      out.push(F('system-wide', 'redirect.profile', 'writes a shell profile, which changes every later session'));
    } else if (inSkill(target, ctx)) {
      out.push(F('isolated', 'redirect.skill', 'redirects into the skill area'));
    } else if (m[1] === '>') {
      out.push(F('destructive', 'redirect.overwrite', `overwrites ${target}, outside the skill area`));
    } else {
      out.push(F(inHome(target, ctx) ? 'user-level' : 'system-wide', 'redirect.append', `appends to ${target}`));
    }
  }
  return out;
};

const pipRule = (s, ctx) => {
  let args = s.args;
  let viaPython = false;
  if (PY.has(s.cmd)) {
    const mi = args.indexOf('-m');
    if (mi >= 0 && args[mi + 1] === 'pip') { args = args.slice(mi + 2); viaPython = true; } else return [];
  } else if (s.cmd !== 'pip' && s.cmd !== 'pip3') return [];
  if (!args.some((a) => ['install', 'uninstall', 'download'].includes(a))) return [F('isolated', 'pip.readonly', 'read-only pip command')];
  if (inSkill(s.tokens[0], ctx)) return [F('isolated', 'pip.venv', 'uses an interpreter inside the skill environment')];
  const target = flagValue(args, ['--target', '-t', '--prefix']);
  if (target && inSkill(target, ctx)) return [F('isolated', 'pip.target', 'installs into the skill area with --target/--prefix')];
  if (hasFlag(args, ['--user'])) return [F('user-level', 'pip.user', 'pip --user install')];
  const hint = ctx.vars?.SKILL_ENV
    ? `use ${viaPython ? 'the python inside $SKILL_ENV' : 'the pip inside $SKILL_ENV'} to avoid a global install`
    : undefined;
  return [F('system-wide', 'pip.global', 'pip installs into the global or current interpreter', hint)];
};

const venvRule = (s, ctx) => {
  if (!PY.has(s.cmd)) return [];
  const i = s.args.indexOf('-m');
  if (i < 0 || !['venv', 'virtualenv'].includes(s.args[i + 1])) return [];
  const dest = nonFlags(s.args.slice(i + 2), ctx)[0];
  if (dest && inSkill(dest, ctx)) return [F('isolated', 'venv.skill', 'creates a venv inside the skill area')];
  return [F(dest && inHome(dest, ctx) ? 'user-level' : 'system-wide', 'venv.other', 'creates a venv outside the skill area')];
};

const npmRule = (s, ctx) => {
  if (!['npm', 'pnpm', 'yarn', 'npx'].includes(s.cmd)) return [];
  if (!s.args.some((a) => ['install', 'i', 'add', 'ci'].includes(a))) return [F('isolated', 'npm.readonly', 'not an install command')];
  if (hasFlag(s.args, ['-g', '--global']) || s.args[0] === 'global') {
    return [F('system-wide', 'npm.global', 'global npm install', ctx.vars?.SKILL_DIR ? 'use --prefix $SKILL_DIR for a local install' : undefined)];
  }
  const prefix = flagValue(s.args, ['--prefix']);
  if (prefix) {
    return [inSkill(prefix, ctx) ? F('isolated', 'npm.prefix', '--prefix points into the skill area') : F('user-level', 'npm.prefix-other', '--prefix points outside the skill area')];
  }
  return inSkill(ctx.cwd, ctx)
    ? [F('isolated', 'npm.local', 'local install inside the skill directory')]
    : [F('user-level', 'npm.local-other', 'local install outside the skill directory')];
};

const pkgMgrRule = (s) => {
  const isInstall = s.args.some((a) => ['install', 'upgrade', 'uninstall', 'remove', 'add', 'update', '-S', '-R'].includes(a));
  switch (s.cmd) {
    case 'winget':
      if (!isInstall) return [F('isolated', 'winget.readonly', 'read-only winget command')];
      return flagValue(s.args, ['--scope']) === 'user'
        ? [F('user-level', 'winget.user', 'winget --scope user')]
        : [F('system-wide', 'winget.default', 'winget may raise a UAC prompt or install machine-wide', 'try --scope user')];
    case 'scoop': case 'brew': case 'pipx': case 'cargo': case 'go': case 'rustup':
      if (!isInstall && s.args[0] !== 'install') return [F('isolated', `${s.cmd}.readonly`, `${s.cmd} command that installs nothing`)];
      return [F('user-level', `${s.cmd}.user`, `${s.cmd} installs into the user directory`)];
    case 'apt': case 'apt-get': case 'dnf': case 'yum': case 'zypper': case 'pacman': case 'apk': case 'dpkg': case 'rpm': case 'snap':
      return isInstall ? [F('system-wide', 'os-pkg', `${s.cmd} is a system package manager (usually needs root)`)] : [F('isolated', 'os-pkg.readonly', 'read-only')];
    case 'msiexec': case 'installer':
      return [F('system-wide', 'installer', 'runs an installer')];
    default:
      return [];
  }
};

const envRegRule = (s) => {
  const out = [];
  const raw = s.raw;
  if (s.cmd === 'setx') out.push(F(/\/m\b/i.test(raw) ? 'elevated' : 'system-wide', 'env.setx', 'setx changes environment variables permanently'));
  if (s.cmd === 'reg' && /\b(add|delete|import|load)\b/i.test(raw)) {
    out.push(F(/HKLM|HKEY_LOCAL_MACHINE/i.test(raw) ? 'elevated' : 'system-wide', 'reg.write', 'changes the registry'));
  }
  if (/\[Environment\]::SetEnvironmentVariable/i.test(raw)) {
    out.push(F(/Machine/i.test(raw) ? 'elevated' : 'system-wide', 'env.dotnet', 'changes environment variables permanently'));
  }
  if (/\bSet-ItemProperty\b.*\bHK(LM|CU)/i.test(raw)) {
    out.push(F(/HKLM/i.test(raw) ? 'elevated' : 'system-wide', 'reg.psprop', 'PowerShell registry change'));
  }
  if (['systemctl', 'launchctl', 'sc', 'schtasks', 'crontab', 'netsh', 'ufw', 'iptables'].includes(s.cmd)) {
    out.push(F('system-wide', 'svc', `${s.cmd} changes services, scheduled tasks or the network`));
  }
  return out;
};

// Forms that cannot be analysed statically are escalated so a person reads the exact command.
const opaqueRule = (s) => {
  const out = [];
  if (/-(enc|encodedcommand)\b/i.test(s.raw)) out.push(F('remote-exec', 'opaque.encoded', 'base64 encoded command cannot be reviewed'));
  if (s.cmd === 'eval') out.push(F('remote-exec', 'opaque.eval', 'eval runs text built at run time'));
  if (/(\$\(|`|<\()/.test(s.raw) && !/^\s*echo\b/.test(s.raw)) out.push(F('system-wide', 'opaque.subst', 'command substitution hides what will really run'));
  return out;
};

const RULES = [elevatedRule, destructiveRule, fileOpRule, redirectRule, pipRule, venvRule, npmRule, pkgMgrRule, envRegRule, opaqueRule];

// ---------------------------------------------------------------- entry points

function classifySegments(segs, ctx) {
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];

    if (s.pipedFromPrev && i > 0 && FETCHERS.has(segs[i - 1].cmd) && INTERPRETERS.has(s.cmd)) {
      out.push(F('remote-exec', 'remote.pipe', `output of ${segs[i - 1].cmd} is piped straight into ${s.cmd}`));
    }
    if (/\b(iex|invoke-expression)\b/i.test(s.raw) && /\b(irm|iwr|invoke-restmethod|invoke-webrequest|curl|wget|downloadstring)\b/i.test(s.raw)) {
      out.push(F('remote-exec', 'remote.iex', 'downloaded text goes straight into Invoke-Expression'));
    }
    if (/(\$\(|`|<\()\s*(curl|wget)\b/i.test(s.raw)) {
      out.push(F('remote-exec', 'remote.subst', 'downloads and runs inside a command substitution'));
    }

    // Elevation: tag it, then classify the inner command too (sudo rm -rf / is both).
    if (ELEVATORS.has(s.cmd)) {
      out.push(F('elevated', 'elevated.cmd', `uses ${s.cmd} to elevate`));
      const rest = s.tokens.slice(1);
      let k = 0;
      while (k < rest.length && rest[k].startsWith('-')) k++;
      if (rest[k]) out.push(...classifySegments([makeSegment(rest.slice(k).join(' '), false)], ctx));
      continue;
    }

    const found = RULES.flatMap((r) => r(s, ctx));
    if (found.length) out.push(...found);
    else if (READONLY.has(s.cmd) || hasFlag(s.args, ['--version', '-version', '--help'])) out.push(F('isolated', 'readonly', 'read-only or version probe'));
    else out.push(F('system-wide', 'unclassified', `unrecognised command ${s.cmd}; treated as system-wide (fail closed)`));
  }
  return out;
}

export function classifyStep(cmd, ctx) {
  const segs = splitSegments(String(cmd));
  if (!segs.length) return [F('system-wide', 'empty', 'empty command')];
  const seen = new Set();
  return classifySegments(segs, ctx).filter((f) => {
    const k = `${f.tag}|${f.rule}|${f.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
