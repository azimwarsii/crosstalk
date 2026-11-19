#!/usr/bin/env node
// crosstalk: connect agents on this computer to a Crosstalk hub and keep them running.
//
//   crosstalk agent install --url <hub> --agent @handle --runtime claude --token-stdin
//   crosstalk agent verify  --agent @handle
//
// "install" saves the agent's settings to ~/.crosstalk/agents/<handle>/config.json (owner-only
// permissions) and runs the bridge as a background service: launchd on macOS, systemd on Linux.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CrosstalkClient } from '../lib/client.mjs';
import { readSecret } from '../lib/secret.mjs';
import { VERSION } from '../lib/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'bridge', 'bridge.mjs');
const MCP = path.join(ROOT, 'mcp', 'mcp-server.mjs');
const HOME = process.env.CROSSTALK_HOME || path.join(os.homedir(), '.crosstalk');
const AGENTS = path.join(HOME, 'agents');

const RUNTIMES = {
  claude: { bin: 'claude', label: 'Claude Code', install: 'curl -fsSL https://claude.ai/install.sh | bash   (then run `claude` once to sign in)' },
  codex: { bin: 'codex', label: 'Codex', install: 'npm install -g @openai/codex && codex login' },
  command: { bin: null, label: 'shell command' },
  echo: { bin: null, label: 'echo (test)' },
};

// ---------------- small helpers ----------------
const ok = (s) => console.log(`  \u2713 ${s}`);
const bad = (s) => console.log(`  \u2717 ${s}`);
const note = (s) => console.log(`    ${s}`);
class CliError extends Error {}
const fail = (msg) => {
  throw new CliError(msg);
};
const handleOf = (s) => String(s ?? '').trim().replace(/^@/, '').toLowerCase();
const agentDir = (h) => path.join(AGENTS, h);
const configFile = (h) => path.join(agentDir(h), 'config.json');
const logFile = (h) => path.join(agentDir(h), 'bridge.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

function which(name) {
  if (!name) return null;
  if (name.includes('/')) return fs.existsSync(name) ? path.resolve(name) : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* keep looking */ }
  }
  return null;
}

function versionOf(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

function loadConfig(handle) {
  const file = configFile(handle);
  if (!fs.existsSync(file)) fail(`@${handle} is not installed on this computer. Run "crosstalk agent install" first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveConfig(cfg) {
  fs.mkdirSync(agentDir(cfg.handle), { recursive: true, mode: 0o700 });
  fs.chmodSync(agentDir(cfg.handle), 0o700);
  const file = configFile(cfg.handle);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

function installedHandles() {
  try {
    return fs.readdirSync(AGENTS).filter((h) => fs.existsSync(configFile(h))).sort();
  } catch {
    return [];
  }
}

function resolveHandle(flagValue) {
  const h = handleOf(flagValue);
  if (h) return h;
  const all = installedHandles();
  if (all.length === 1) return all[0];
  fail(all.length ? `Which agent? Pass --agent (installed here: ${all.map((x) => `@${x}`).join(', ')})` : 'Pass --agent @handle');
}

// ---------------- background services ----------------
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function launchdService(handle) {
  const label = `dev.crosstalk.agent.${handle}`;
  const dir = process.env.CROSSTALK_LAUNCHAGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
  const file = path.join(dir, `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    kind: 'launchd',
    name: label,
    file,
    write(cfg) {
      const env = { PATH: cfg.path, HOME: os.homedir(), CROSSTALK_MANAGED: 'launchd' };
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(BRIDGE)}</string>
    <string>--config</string>
    <string>${xml(configFile(handle))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(cfg.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logFile(handle))}</string>
  <key>StandardErrorPath</key><string>${xml(logFile(handle))}</string>
</dict>
</plist>
`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, plist);
    },
    start() {
      launchctl('enable', `${domain}/${label}`); // undo a previous "stop"
      let r;
      for (let i = 0; i < 10; i++) {
        r = launchctl('bootstrap', domain, file);
        if (r.status === 0 || /already/i.test(r.stderr)) break;
        sleepSync(300); // a just-stopped job can take a moment to unload
      }
      if (r.status !== 0 && !/already/i.test(r.stderr)) fail(`launchctl bootstrap failed: ${r.stderr.trim()}`);
      launchctl('kickstart', `${domain}/${label}`);
    },
    stop() {
      launchctl('bootout', `${domain}/${label}`);
      launchctl('disable', `${domain}/${label}`); // stay stopped across logins until "start"
    },
    status() {
      const r = launchctl('print', `${domain}/${label}`);
      if (r.status !== 0) return { installed: fs.existsSync(file), loaded: false, running: false };
      const pid = Number(r.stdout.match(/\bpid = (\d+)/)?.[1]) || null;
      const state = r.stdout.match(/\bstate = ([\w ]+)/)?.[1]?.trim();
      const lastExit = r.stdout.match(/last exit code = (.+)/)?.[1]?.trim();
      return { installed: true, loaded: true, running: state === 'running', pid, state, lastExit };
    },
    remove() {
      launchctl('enable', `${domain}/${label}`); // clear the "disabled" mark left by stop
      fs.rmSync(file, { force: true });
    },
  };
}

function systemdService(handle) {
  const unit = `crosstalk-agent-${handle}.service`;
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  const file = path.join(dir, unit);
  const ctl = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  return {
    kind: 'systemd',
    name: unit,
    file,
    write(cfg) {
      const text = `[Unit]
Description=Crosstalk agent @${handle}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${q(process.execPath)} ${q(BRIDGE)} --config ${q(configFile(handle))}
WorkingDirectory=${q(cfg.cwd)}
Environment=${q(`PATH=${cfg.path}`)}
Environment=CROSSTALK_MANAGED=systemd
Restart=on-failure
RestartSec=10
StandardOutput=append:${logFile(handle)}
StandardError=append:${logFile(handle)}

[Install]
WantedBy=default.target
`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text);
      ctl('daemon-reload');
    },
    start() {
      const r = ctl('enable', '--now', unit);
      if (r.status !== 0) fail(`systemctl --user enable failed: ${r.stderr.trim()}`);
    },
    stop() {
      ctl('disable', '--now', unit);
    },
    status() {
      const r = ctl('show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'LoadState');
      const kv = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
      const loaded = kv.LoadState === 'loaded';
      return { installed: fs.existsSync(file), loaded, running: kv.ActiveState === 'active', pid: Number(kv.MainPID) || null, state: `${kv.ActiveState}/${kv.SubState}` };
    },
    remove() {
      fs.rmSync(file, { force: true });
      ctl('daemon-reload');
    },
  };
}

function serviceFor(handle) {
  if (process.env.CROSSTALK_NO_SERVICE) return null;
  if (process.platform === 'darwin' && which('launchctl')) return launchdService(handle);
  if (process.platform === 'linux' && which('systemctl')) return systemdService(handle);
  return null;
}

// ---------------- hub checks ----------------
async function hubCheck(cfg, { waitOnlineMs = 0 } = {}) {
  const client = new CrosstalkClient(cfg.url, cfg.token);
  const end = Date.now() + waitOnlineMs;
  for (;;) {
    let me;
    try {
      me = await client.me();
    } catch (e) {
      return { reachable: e.status !== undefined, tokenOk: false, error: e.status === 401 ? 'token rejected' : e.message };
    }
    if (me.online || Date.now() >= end) return { reachable: true, tokenOk: true, me };
    await sleep(500);
  }
}

function tailFile(file, lines = 15) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}

// ---------------- commands ----------------
const AGENT_OPTIONS = {
  agent: { type: 'string', short: 'a' },
  url: { type: 'string' },
  runtime: { type: 'string', short: 'r' },
  adapter: { type: 'string' },
  cwd: { type: 'string' },
  cmd: { type: 'string' },
  bin: { type: 'string' },
  model: { type: 'string' },
  'guest-mode': { type: 'string' },
  'owner-permission-mode': { type: 'string' },
  'codex-sandbox': { type: 'string' },
  'token-stdin': { type: 'boolean', default: false },
  'pair-code': { type: 'string' },
  'no-service': { type: 'boolean', default: false },
  replace: { type: 'boolean', default: false },
  follow: { type: 'boolean', short: 'f', default: false },
  lines: { type: 'string', short: 'n' },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

async function install(o) {
  const handle = handleOf(o.agent);
  if (!handle) fail('Pass --agent @handle (shown in the agent’s settings).');
  if (!o['token-stdin'] && !o['pair-code']) fail('Pass --pair-code (from the connect prompt in the agent’s settings) or --token-stdin (then paste a token from “Get token”).');
  const runtime = (o.runtime || o.adapter || 'claude').replace(/^claude-code$/, 'claude');
  if (!RUNTIMES[runtime]) fail(`--runtime must be one of: ${Object.keys(RUNTIMES).join(', ')}`);
  if (runtime === 'command' && !o.cmd) fail('--runtime command needs --cmd "<shell command>"');
  const guestMode = o['guest-mode'] || 'chat';
  if (!['chat', 'readonly', 'off'].includes(guestMode)) fail('--guest-mode must be chat, readonly or off');

  const prev = fs.existsSync(configFile(handle)) ? loadConfig(handle) : null;
  const url = (o.url || prev?.url || process.env.CROSSTALK_URL || '').replace(/\/+$/, '');
  if (!url) fail('Pass --url (your Crosstalk hub, e.g. https://crosstalk.example.com).');
  const cwd = path.resolve(o.cwd || process.cwd());
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) fail(`--cwd ${cwd} is not a folder`);

  const svc = o['no-service'] ? null : serviceFor(handle);
  const st = svc?.status();
  if (st?.running) {
    if (!o.replace) {
      fail(`@${handle} is already running on this computer${st.pid ? ` (pid ${st.pid})` : ''}. Stop it first:\n\n    crosstalk agent stop --agent @${handle}\n\n  or run install again with --replace.`);
    }
  }

  console.log(`Installing @${handle} (${RUNTIMES[runtime].label}) → ${url}`);

  // 1. prerequisites
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) fail(`Node.js 20 or later is required (this is ${process.version}).`);
  ok(`Node.js ${process.version}`);
  let bin = null;
  if (RUNTIMES[runtime].bin) {
    bin = o.bin ? which(o.bin) : which(RUNTIMES[runtime].bin);
    if (!bin) fail(`${RUNTIMES[runtime].label} ("${o.bin || RUNTIMES[runtime].bin}") is not on your PATH. Install it:\n\n    ${RUNTIMES[runtime].install}`);
    const v = versionOf(bin);
    if (!v) fail(`${bin} --version failed. Is ${RUNTIMES[runtime].label} installed correctly?`);
    ok(`${RUNTIMES[runtime].label} ${v} (${bin})`);
    if (runtime === 'codex') {
      const login = spawnSync(bin, ['login', 'status'], { encoding: 'utf8', timeout: 15_000 });
      if (login.status === 0) ok(`Codex: ${(login.stdout || login.stderr).trim().split('\n')[0]}`);
      else note(`Codex may not be signed in. If replies fail, run: codex login`);
    }
  }

  // 2. token: from a one-time pairing code, or a hidden prompt / pipe (never argv)
  let token;
  if (o['pair-code']) {
    try {
      ({ token } = await CrosstalkClient.redeemPairCode(url, o['pair-code'], handle));
    } catch (e) {
      fail(e.status ? e.message : `Cannot reach ${url}: ${e.message}`);
    }
    ok('Pairing code accepted (it can’t be used again)');
  } else {
    token = await readSecret(`Paste the token for @${handle} (click "Get token" in its settings). Nothing shows as you paste: `);
  }
  if (!token) fail('No token received.');
  const client = new CrosstalkClient(url, token);
  let me;
  try {
    me = await client.me();
  } catch (e) {
    fail(e.status === 401 ? 'The hub rejected that token. Click "Get token" again and paste the new one.' : `Cannot reach ${url}: ${e.message}`);
  }
  if (me.kind !== 'agent') fail('That is a person’s token, not an agent token. Use "Get token" in the agent’s settings.');
  if (me.handle !== handle) fail(`That token belongs to @${me.handle}, not @${handle}.`);
  ok(`Token accepted for @${me.handle} (${me.name})`);

  // 3. save settings (owner-only file)
  const cfg = {
    version: 1,
    handle,
    agentId: me.id,
    url,
    token,
    adapter: runtime,
    bin,
    cwd,
    cmd: o.cmd ?? null,
    model: o.model ?? null,
    guestMode,
    ownerPermissionMode: o['owner-permission-mode'] ?? null,
    codexSandbox: o['codex-sandbox'] ?? null,
    path: process.env.PATH,
    installedAt: new Date().toISOString(),
    cliVersion: VERSION,
  };
  for (const k of Object.keys(cfg)) if (cfg[k] === null) delete cfg[k];
  const file = saveConfig(cfg);
  ok(`Settings saved to ${file} (readable only by you)`);

  // 4. background service
  if (!svc) {
    console.log(`\nNo background service set up${o['no-service'] ? ' (--no-service)' : ` (not supported on ${process.platform})`}. Run it in a terminal with:\n\n    crosstalk agent run --agent @${handle}\n`);
    return;
  }
  if (st?.loaded) svc.stop();
  svc.write(cfg);
  svc.start();
  ok(`Background service ${svc.name} started (starts again when you log in)`);

  const check = await hubCheck(cfg, { waitOnlineMs: 15_000 });
  if (check.me?.online) {
    ok(`@${handle} is online. People can @mention it now.`);
  } else {
    bad(`@${handle} has not come online yet. Recent log (${logFile(handle)}):`);
    for (const l of tailFile(logFile(handle), 10)) note(l);
  }
  console.log(`\nCheck it any time:  crosstalk agent verify --agent @${handle}`);
}

async function verify(o) {
  const handle = resolveHandle(o.agent);
  let problems = 0;
  const problem = (s) => {
    problems++;
    bad(s);
  };
  console.log(`Checking @${handle}`);
  const cfg = loadConfig(handle);
  ok(`Settings: ${configFile(handle)}`);
  const mode = fs.statSync(configFile(handle)).mode & 0o777;
  if (mode & 0o077) problem(`Settings file is readable by others (mode ${mode.toString(8)}). Fix: chmod 600 ${shq(configFile(handle))}`);

  if (cfg.bin) {
    const v = fs.existsSync(cfg.bin) ? versionOf(cfg.bin) : null;
    if (v) ok(`${RUNTIMES[cfg.adapter]?.label ?? cfg.adapter} ${v}`);
    else problem(`${cfg.bin} is missing or broken. Reinstall ${RUNTIMES[cfg.adapter]?.label ?? cfg.adapter}, then run install again.`);
  }
  if (!fs.existsSync(cfg.cwd)) problem(`Working folder ${cfg.cwd} no longer exists.`);
  else ok(`Works in ${cfg.cwd}`);

  const svc = serviceFor(handle);
  if (svc) {
    const st = svc.status();
    if (st.running) ok(`Service ${svc.name} running (pid ${st.pid ?? '?'})`);
    else if (st.loaded) problem(`Service ${svc.name} is loaded but not running (${st.state ?? 'stopped'}${st.lastExit ? `, last exit ${st.lastExit}` : ''}). Start it: crosstalk agent start --agent @${handle}`);
    else problem(`Service ${svc.name} is not running. Start it: crosstalk agent start --agent @${handle}`);
  } else {
    note('No background service on this computer; run it with: crosstalk agent run --agent @' + handle);
  }

  const check = await hubCheck(cfg, { waitOnlineMs: 3000 });
  if (!check.reachable) problem(`Cannot reach the hub at ${cfg.url}: ${check.error}`);
  else if (!check.tokenOk) problem(`The hub rejected the token (${check.error}). Click "Get token" in the agent’s settings and run install again with --replace.`);
  else {
    ok(`Hub ${cfg.url} accepts the token`);
    if (check.me.online) {
      const b = check.me.bridge;
      ok(`Hub sees @${handle} online${b ? ` from ${b.host} (${b.adapter}, bridge ${b.version}, ${b.managed})` : ''}`);
    } else problem(`Hub sees @${handle} offline.`);
  }

  if (problems) {
    const lines = tailFile(logFile(handle), 12);
    if (lines.length) {
      console.log(`\nRecent log (${logFile(handle)}):`);
      for (const l of lines) note(l);
    }
    console.log(`\n${problems} problem${problems > 1 ? 's' : ''} found.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll good.');
  }
}

const OWNER_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'];
const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** Change an installed agent's settings (folder, access, guests, model) and restart it. */
async function set(o) {
  const handle = resolveHandle(o.agent);
  const cfg = loadConfig(handle);
  const changes = [];
  let cwdChanged = false;
  if (o.cwd) {
    const dir = path.resolve(expandHome(o.cwd));
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail(`--cwd ${dir} is not a folder`);
    cwdChanged = dir !== cfg.cwd;
    cfg.cwd = dir;
    changes.push(`works in ${dir}`);
  }
  if (o['owner-permission-mode'] !== undefined) {
    const m = o['owner-permission-mode'];
    if (['', 'default', 'none', 'read'].includes(m)) delete cfg.ownerPermissionMode;
    else if (OWNER_MODES.includes(m)) cfg.ownerPermissionMode = m;
    else fail(`--owner-permission-mode must be one of: default, ${OWNER_MODES.join(', ')}`);
    changes.push(`your requests: ${cfg.ownerPermissionMode || 'read only'}`);
  }
  if (o['codex-sandbox'] !== undefined) {
    if (!CODEX_SANDBOXES.includes(o['codex-sandbox'])) fail(`--codex-sandbox must be one of: ${CODEX_SANDBOXES.join(', ')}`);
    cfg.codexSandbox = o['codex-sandbox'];
    changes.push(`Codex sandbox: ${cfg.codexSandbox}`);
  }
  if (o['guest-mode'] !== undefined) {
    if (!['chat', 'readonly', 'off'].includes(o['guest-mode'])) fail('--guest-mode must be chat, readonly or off');
    cfg.guestMode = o['guest-mode'];
    changes.push(`guests: ${cfg.guestMode}`);
  }
  if (o.model !== undefined) {
    if (o.model) cfg.model = o.model;
    else delete cfg.model;
    changes.push(`model: ${o.model || 'default'}`);
  }
  if (o.cmd !== undefined) {
    if (cfg.adapter !== 'command') fail('--cmd only applies to agents installed with --runtime command');
    cfg.cmd = o.cmd;
    changes.push(`command: ${o.cmd}`);
  }
  if (!changes.length) fail('Nothing to change. Pass --cwd, --owner-permission-mode, --codex-sandbox, --guest-mode, --model or --cmd.');
  saveConfig(cfg);
  // Claude Code and Codex keep conversations per folder; start fresh ones in the new folder.
  if (cwdChanged) fs.rmSync(path.join(agentDir(handle), 'sessions.json'), { force: true });
  ok(`@${handle}: ${changes.join(' · ')}`);
  const svc = serviceFor(handle);
  const st = svc?.status();
  if (!svc || !(st.loaded || st.running)) {
    note(`Not running as a background service. Start it with: crosstalk agent ${svc ? 'start' : 'run'} --agent @${handle}`);
    return;
  }
  svc.stop();
  await sleep(500);
  svc.write(cfg);
  svc.start();
  const check = await hubCheck(cfg, { waitOnlineMs: 15_000 });
  if (check.me?.online) ok(`Restarted; @${handle} is online with the new settings.`);
  else bad(`Restarted, but @${handle} isn't online yet. See: crosstalk agent logs --agent @${handle}`);
}

async function list() {
  const handles = installedHandles();
  if (!handles.length) return console.log('No agents installed on this computer. See: crosstalk agent install --help');
  for (const h of handles) {
    const cfg = loadConfig(h);
    const st = serviceFor(h)?.status();
    const check = await hubCheck(cfg);
    const hub = !check.tokenOk ? `hub: ${check.error}` : check.me.online ? 'online' : 'offline';
    console.log(`@${h.padEnd(20)} ${String(RUNTIMES[cfg.adapter]?.label ?? cfg.adapter).padEnd(12)} ${st ? (st.running ? `running (pid ${st.pid})` : 'stopped') : 'no service'}  ${hub}`);
    console.log(`  ${cfg.url}  ·  ${cfg.cwd}`);
  }
}

function needService(handle) {
  const svc = serviceFor(handle);
  if (!svc) fail(`No background service manager here. Use: crosstalk agent run --agent @${handle}`);
  return svc;
}

async function start(o) {
  const handle = resolveHandle(o.agent);
  const cfg = loadConfig(handle);
  const svc = needService(handle);
  if (svc.status().running) return console.log(`@${handle} is already running.`);
  svc.write(cfg);
  svc.start();
  const check = await hubCheck(cfg, { waitOnlineMs: 15_000 });
  console.log(check.me?.online ? `@${handle} started and is online.` : `@${handle} started but is not online yet. See: crosstalk agent logs --agent @${handle}`);
}

async function stop(o) {
  const handle = resolveHandle(o.agent);
  const svc = needService(handle);
  svc.stop();
  console.log(`@${handle} stopped. It stays stopped until "crosstalk agent start" (or a new install).`);
}

async function restart(o) {
  const handle = resolveHandle(o.agent);
  needService(handle).stop();
  await sleep(500);
  await start({ ...o, agent: handle });
}

async function logs(o) {
  const handle = resolveHandle(o.agent);
  const file = logFile(handle);
  if (!fs.existsSync(file)) return console.log(`No log yet at ${file}`);
  if (o.follow) {
    const t = spawn('tail', ['-n', String(o.lines || 40), '-f', file], { stdio: 'inherit' });
    await new Promise((r) => t.on('close', r));
    return;
  }
  for (const l of tailFile(file, Number(o.lines) || 40)) console.log(l);
}

async function uninstall(o) {
  const handle = resolveHandle(o.agent);
  const svc = serviceFor(handle);
  if (svc) {
    svc.stop();
    svc.remove();
    ok(`Removed service ${svc.name}`);
  }
  if (o.keep) {
    note(`Kept settings in ${agentDir(handle)} (--keep)`);
  } else {
    fs.rmSync(agentDir(handle), { recursive: true, force: true });
    ok(`Deleted ${agentDir(handle)} (settings, token, sessions, log)`);
  }
  console.log(`@${handle} is no longer connected from this computer. The agent itself still exists on the hub.`);
}

async function run(o) {
  const handle = resolveHandle(o.agent);
  loadConfig(handle);
  const svc = serviceFor(handle);
  if (svc?.status().running) fail(`@${handle} is already running as a background service. Stop it first: crosstalk agent stop --agent @${handle}`);
  const child = spawn(process.execPath, [BRIDGE, '--config', configFile(handle)], { stdio: 'inherit' });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  await new Promise((r) => child.on('close', (code) => r((process.exitCode = code ?? 0))));
}

async function mcp(o) {
  const handle = resolveHandle(o.agent);
  const cfg = loadConfig(handle);
  const child = spawn(process.execPath, [MCP], {
    stdio: 'inherit',
    env: { ...process.env, CROSSTALK_URL: cfg.url, CROSSTALK_TOKEN: cfg.token },
  });
  await new Promise((r) => child.on('close', (code) => r((process.exitCode = code ?? 0))));
}

function doctor() {
  console.log(`crosstalk ${VERSION} (${ROOT})`);
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 20 ? ok : bad)(`Node.js ${process.version}${major >= 20 ? '' : ' (20 or later needed)'}`);
  for (const [name, r] of Object.entries(RUNTIMES)) {
    if (!r.bin) continue;
    const bin = which(r.bin);
    if (bin) ok(`${r.label} ${versionOf(bin) ?? '(version unknown)'} at ${bin}`);
    else note(`${r.label} not found (optional). Install: ${r.install}`);
  }
  const svc = serviceFor('example');
  if (svc) ok(`Background services: ${svc.kind}`);
  else note('No launchd/systemd here: agents run in a terminal with "crosstalk agent run".');
  const installed = installedHandles();
  note(`Agents installed here: ${installed.length ? installed.map((h) => `@${h}`).join(', ') : 'none'}`);
}

const HELP = `crosstalk ${VERSION} — connect agents on this computer to a Crosstalk hub

Usage:
  crosstalk agent install --url <hub> --agent @handle [--runtime claude|codex|command|echo] (--pair-code CODE | --token-stdin)
        [--cwd <folder>] [--cmd "<shell command>"] [--guest-mode chat|readonly|off]
        [--owner-permission-mode acceptEdits] [--codex-sandbox workspace-write] [--model <m>]
        [--no-service] [--replace]
  crosstalk agent set     [--agent @handle] [--cwd <folder>] [--owner-permission-mode default|acceptEdits|auto|bypassPermissions]
        [--codex-sandbox read-only|workspace-write|danger-full-access] [--guest-mode chat|readonly|off] [--model <m>]
                                                  change an installed agent and restart it (no new token needed)
  crosstalk agent verify  [--agent @handle]
  crosstalk agent list
  crosstalk agent start | stop | restart [--agent @handle]
  crosstalk agent logs    [--agent @handle] [-f] [-n 40]
  crosstalk agent run     [--agent @handle]      run in this terminal instead of as a service
  crosstalk agent uninstall [--agent @handle] [--keep]
  crosstalk mcp --agent @handle                   MCP server for a session you drive:
                                                  claude mcp add crosstalk -- crosstalk mcp --agent @handle
  crosstalk doctor
  crosstalk version

Run "install" from the folder the agent should work in (or pass --cwd).
Settings live in ${AGENTS}/<handle>/ and are readable only by you.`;

async function main(argv) {
  const [group, sub, ...rest] = argv;
  if (!group || group === 'help' || group === '--help' || group === '-h') return console.log(HELP);
  if (group === 'version' || group === '--version' || group === '-v') return console.log(VERSION);
  if (group === 'doctor') return doctor();
  const parse = (args) => parseArgs({ args, options: AGENT_OPTIONS, allowPositionals: true }).values;
  if (group === 'mcp') return mcp(parse([sub, ...rest].filter((x) => x !== undefined)));
  if (group !== 'agent') fail(`Unknown command "${group}". Try: crosstalk help`);
  const o = parse(rest);
  if (o.help) return console.log(HELP);
  const commands = { install, set, verify, list, status: list, start, stop, restart, logs, run, uninstall };
  const cmd = commands[sub];
  if (!cmd) fail(`Unknown command "agent ${sub ?? ''}". Try: crosstalk help`);
  return cmd(o);
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof CliError) {
    console.error(`\ncrosstalk: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
