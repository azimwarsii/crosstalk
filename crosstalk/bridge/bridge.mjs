#!/usr/bin/env node
// Crosstalk bridge: keeps one local agent (Claude Code, Codex, or any CLI) connected to a hub.
// When someone @mentions the agent, the bridge runs it with the conversation and posts the reply.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CrosstalkClient } from '../lib/client.mjs';
import { createAdapter } from './adapters.mjs';
import { buildPrompt, buildSystemPrompt } from './prompt.mjs';
import { readSecret } from '../lib/secret.mjs';
import { VERSION } from '../lib/version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.resolve(HERE, '../mcp/mcp-server.mjs');

const USAGE = `Usage: node bridge/bridge.mjs (--config <file> | --token-stdin | --token <t>) [options]

Connects one agent to a Crosstalk hub and answers when it is @mentioned.
Usually you don't run this directly: "crosstalk agent install" sets it up as a background service.

Options:
  --config <file>                Settings saved by "crosstalk agent install" (url, token, adapter, cwd, ...)
  --url <url>                    Hub URL (default $CROSSTALK_URL or http://127.0.0.1:4545)
  --token-stdin                  Read the agent's token from stdin (hidden prompt in a terminal)
  --token <token>                The agent's token (avoid: visible in your shell history and process list)
  --adapter <name>               claude | codex | command | echo   (default: claude)
  --bin <path>                   Path to the claude/codex executable (default: found on PATH)
  --cwd <dir>                    Folder the agent works in (default: current folder)
  --cmd "<shell command>"        For --adapter command: prompt on stdin, reply on stdout
  --model <name>                 Model to pass to the CLI
  --guest-mode <mode>            How to treat people who are not your owner:
                                   chat     answer, but no local tools (default)
                                   readonly answer, may read files in --cwd
                                   off      politely decline
  --owner-permission-mode <m>    Claude Code permission mode for YOUR requests
                                   (e.g. acceptEdits, auto, bypassPermissions)
  --codex-sandbox <mode>         Codex sandbox for YOUR requests (default workspace-write)
  --concurrency <n>              Conversations handled at once (default 3)
  --timeout <seconds>            Give up on one reply after this long (default 600)
  --state-dir <dir>              Where session ids are kept
  --no-mcp                       Don't give the agent Crosstalk tools (ask_agent, read_room, ...)
`;

const { values: flags } = parseArgs({
  options: {
    config: { type: 'string' },
    url: { type: 'string' },
    token: { type: 'string' },
    'token-stdin': { type: 'boolean', default: false },
    adapter: { type: 'string' },
    bin: { type: 'string' },
    cwd: { type: 'string' },
    cmd: { type: 'string' },
    model: { type: 'string' },
    'guest-mode': { type: 'string' },
    'owner-permission-mode': { type: 'string' },
    'codex-sandbox': { type: 'string' },
    concurrency: { type: 'string' },
    timeout: { type: 'string' },
    'state-dir': { type: 'string' },
    'no-mcp': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Under launchd/systemd, exit 0 on problems a restart can't fix (bad token, bad config),
// so the service manager doesn't restart-loop against the hub. Interactive runs exit 1.
const MANAGED = process.env.CROSSTALK_MANAGED || '';
function die(msg) {
  console.error(`crosstalk-bridge: ${msg}`);
  process.exit(MANAGED ? 0 : 1);
}

let cfg = {};
if (flags.config) {
  try {
    cfg = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
  } catch (e) {
    die(`cannot read --config ${flags.config}: ${e.message}`);
  }
  // A service starts with a bare PATH; use the one captured at install time.
  if (cfg.path) process.env.PATH = [cfg.path, process.env.PATH].filter(Boolean).join(path.delimiter);
}
const pick = (flag, key, fallback) => flags[flag] ?? cfg[key] ?? fallback;
const opt = {
  url: pick('url', 'url', process.env.CROSSTALK_URL || 'http://127.0.0.1:4545'),
  token: flags.token ?? cfg.token ?? process.env.CROSSTALK_TOKEN,
  adapter: pick('adapter', 'adapter', 'claude'),
  bin: pick('bin', 'bin', undefined),
  cwd: pick('cwd', 'cwd', process.cwd()),
  cmd: pick('cmd', 'cmd', undefined),
  model: pick('model', 'model', undefined),
  'guest-mode': pick('guest-mode', 'guestMode', 'chat'),
  'owner-permission-mode': pick('owner-permission-mode', 'ownerPermissionMode', undefined),
  'codex-sandbox': pick('codex-sandbox', 'codexSandbox', 'workspace-write'),
  concurrency: pick('concurrency', 'concurrency', '3'),
  timeout: pick('timeout', 'timeout', '600'),
  'state-dir': flags['state-dir'] ?? (flags.config ? path.dirname(path.resolve(flags.config)) : undefined),
  'no-mcp': flags['no-mcp'] || cfg.noMcp === true,
};

async function main() {
  if (flags.help) return console.log(USAGE);
  if (flags['token-stdin']) opt.token = await readSecret('Paste the agent token (nothing shows as you paste): ');
  if (!opt.token) die(`no token. Use --config, --token-stdin or $CROSSTALK_TOKEN.\n\n${USAGE}`);
  if (!['chat', 'readonly', 'off'].includes(opt['guest-mode'])) die('--guest-mode must be chat, readonly or off');
  const cwd = path.resolve(opt.cwd);
  if (!fs.existsSync(cwd)) die(`--cwd ${cwd} does not exist`);

  const client = new CrosstalkClient(opt.url, opt.token);
  let me;
  for (;;) {
    try {
      me = await client.me();
      break;
    } catch (e) {
      if (e.status === 401) die('the hub rejected the token. Get a new one in the agent’s settings, then run "crosstalk agent install" again.');
      if (!MANAGED) die(`cannot reach ${opt.url}: ${e.message}`);
      // As a service, wait for the network / hub instead of exiting.
      log(`cannot reach ${opt.url} (${e.message}); retrying in 10s`);
      await sleep(10_000);
    }
  }
  if (me.kind !== 'agent') die('that token belongs to a person. Create an agent in the web app and use its token.');
  if (cfg.handle && cfg.handle !== me.handle) die(`this config is for @${cfg.handle} but the token is for @${me.handle}`);

  const stateDir = path.resolve(opt['state-dir'] || path.join(os.homedir(), '.crosstalk', 'agents', me.handle));
  fs.mkdirSync(path.join(stateDir, 'runs'), { recursive: true, mode: 0o700 });
  const sessionsFile = path.join(stateDir, 'sessions.json');
  let sessions = {};
  try {
    sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  } catch { /* first run */ }
  const saveSessions = () => fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), { mode: 0o600 });

  const timeoutMs = Number(opt.timeout) * 1000;
  const adapter = createAdapter(opt.adapter, {
    me,
    cwd,
    bin: opt.bin,
    cmd: opt.cmd,
    model: opt.model,
    guestMode: opt['guest-mode'],
    ownerPermissionMode: opt['owner-permission-mode'],
    codexSandbox: opt['codex-sandbox'],
    timeoutMs,
    mcpServerPath: MCP_SERVER,
  });
  const useMcp = adapter.supportsMcp && !opt['no-mcp'];
  const info = { adapter: opt.adapter, version: VERSION, host: os.hostname(), platform: process.platform, cwd, managed: MANAGED || 'manual' };

  log(`crosstalk bridge ${VERSION} · @${me.handle} (${me.name}) → ${opt.url}`);
  log(`adapter: ${adapter.label}${opt.bin ? ` (${opt.bin})` : ''} · cwd: ${cwd} · guests: ${opt['guest-mode']} · tools: ${useMcp ? 'crosstalk MCP' : 'none'}`);

  // ---- one conversation lane per (room, tier): same-room messages run in order ----
  const queue = [];
  const busy = new Set();
  const seen = new Set();
  let active = 0;
  const limit = Math.max(1, Number(opt.concurrency) || 3);

  function pump() {
    while (active < limit) {
      const i = queue.findIndex((j) => !busy.has(j.lane));
      if (i < 0) return;
      const job = queue.splice(i, 1)[0];
      active++;
      busy.add(job.lane);
      handle(job.env, job.lane)
        .catch((e) => log('handler error:', e.message))
        .finally(() => {
          active--;
          busy.delete(job.lane);
          pump();
        });
    }
  }

  function enqueue(env) {
    if (seen.has(env.message.id)) return;
    seen.add(env.message.id);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    queue.push({ env, lane: `${env.room.id}:${env.accessTier}` });
    pump();
  }

  function writeMcpConfig(mcpEnv) {
    const file = path.join(stateDir, 'runs', `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const config = { mcpServers: { crosstalk: { type: 'stdio', command: process.execPath, args: [MCP_SERVER], env: mcpEnv } } };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    return file;
  }

  async function handle(env, lane) {
    const tier = env.accessTier;
    const from = `@${env.sender.handle}${env.sender.kind === 'agent' ? ' (agent)' : ''}`;
    log(`← ${from} [${tier}] in ${env.room.kind === 'dm' ? 'DM' : `#${env.room.name}`}: ${env.message.text.slice(0, 100).replace(/\n/g, ' ')}`);

    if (tier !== 'owner' && opt['guest-mode'] === 'off') {
      await client.post(env.room.id, `Sorry — I only take requests from @${me.owner?.handle ?? 'my owner'} right now.`, env.message.id);
      return;
    }

    const mcpEnv = { CROSSTALK_URL: opt.url, CROSSTALK_TOKEN: opt.token, CROSSTALK_ROOM: env.room.id, CROSSTALK_TRIGGER: env.message.id };
    const mcpConfigPath = useMcp && opt.adapter !== 'codex' ? writeMcpConfig(mcpEnv) : null;
    const ownerMode = opt.adapter === 'codex' ? opt['codex-sandbox'] : opt['owner-permission-mode'] ?? null;
    const system = buildSystemPrompt(me, {
      hasTools: useMcp,
      guestMode: tier === 'owner' ? null : opt['guest-mode'],
      ...(tier === 'owner' && (opt.adapter === 'claude' || opt.adapter === 'claude-code' || opt.adapter === 'codex') ? { ownerMode, cwd, adapter: opt.adapter === 'codex' ? 'codex' : 'claude' } : {}),
    });
    await client.status(env.room.id, 'thinking').catch(() => {});
    const started = Date.now();

    const attempt = (session) =>
      adapter.run({
        prompt: buildPrompt(env, me, { sinceMessageId: session?.lastMessageId }),
        system,
        tier,
        env,
        sessionId: session?.sessionId,
        mcpConfigPath,
        mcpEnv: useMcp ? mcpEnv : null,
      });

    try {
      let result;
      try {
        result = await attempt(sessions[lane]);
      } catch (e) {
        if (!sessions[lane] || /took longer/.test(e.message)) throw e;
        log(`resume failed (${e.message.slice(0, 120)}); starting a fresh session`);
        delete sessions[lane];
        result = await attempt(null);
      }
      if (result.sessionId) {
        sessions[lane] = { sessionId: result.sessionId, lastMessageId: env.message.id, updatedAt: new Date().toISOString() };
        saveSessions();
      }
      const text = String(result.text ?? '').trim();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!text || /^NO_REPLY\b/i.test(text)) {
        log(`→ (no reply needed, ${secs}s)`);
        return;
      }
      await client.post(env.room.id, text, env.message.id);
      log(`→ replied in ${secs}s: ${text.slice(0, 100).replace(/\n/g, ' ')}`);
    } catch (e) {
      log(`✗ ${e.message}`);
      // Owners see the real error; guests get a generic one (errors can contain local paths).
      const detail = tier === 'owner' ? `: ${e.message.slice(0, 400)}` : '. My owner can check the bridge log.';
      await client.post(env.room.id, `⚠️ I couldn't finish that${detail}`, env.message.id).catch(() => {});
    } finally {
      if (mcpConfigPath) fs.rmSync(mcpConfigPath, { force: true });
      await client.status(env.room.id, 'idle').catch(() => {});
    }
  }

  // ---- listen forever, reconnecting with backoff ----
  let backoff = 1000;
  for (;;) {
    try {
      for await (const evt of client.events({ info })) {
        backoff = 1000;
        if (evt.type === 'hello') log('online — waiting for mentions');
        else if (evt.type === 'trigger') enqueue(evt);
      }
      log('hub closed the stream');
    } catch (e) {
      if (e.status === 401) die('the hub rejected the token (a new token was made?). Run "crosstalk agent install --replace" with the new one.');
      log(`connection lost (${e.message}); retrying in ${backoff / 1000}s`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main();
