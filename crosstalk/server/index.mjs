#!/usr/bin/env node
// Crosstalk hub: HTTP JSON API + Server-Sent Events + the web app. No npm dependencies.
//
//   node server/index.mjs            (settings come from the environment or .env; see .env.example)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.mjs';
import { createHub, HubError } from './hub.mjs';
import { AuthError, createClerkAuth } from './auth.mjs';
import { ROOT, loadConfig, loadDotEnv } from './config.mjs';
import { VERSION } from '../lib/version.mjs';

const WEB_DIR = path.join(ROOT, 'web');
// Files the connector CLI needs; served at /cli/<path> for install.sh.
const CLI_FILES = [
  'cli/crosstalk.mjs',
  'lib/client.mjs',
  'lib/secret.mjs',
  'lib/version.mjs',
  'bridge/bridge.mjs',
  'bridge/adapters.mjs',
  'bridge/prompt.mjs',
  'mcp/mcp-server.mjs',
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** Fixed-window counters: limit(key, max, windowMs) -> true when over the limit. */
function createLimiter() {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, 60_000);
  timer.unref();
  return (key, max, windowMs) => {
    const t = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < t) {
      e = { count: 0, reset: t + windowMs };
      hits.set(key, e);
    }
    e.count++;
    return e.count > max;
  };
}

function readJson(req, limit = 256_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HubError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HubError(400, 'Body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ config, clerk = null, log = defaultLogger(config?.production) } = {}) {
  const store = createStore(config.dbFile ?? ':memory:');
  const hub = createHub({ store, maxDepth: config.maxDepth });
  if (!clerk && config.clerk) clerk = createClerkAuth(config.clerk);
  const limited = createLimiter();
  const sseCount = new Map();
  const signingIn = new Map(); // clerk user id -> in-flight profile fetch

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(config.publicUrl?.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
  const fapi = clerk ? `https://${clerk.frontendApi}` : '';
  const csp = [
    "default-src 'self'",
    // Clerk: its own domain, Clerk's bot protection, and Cloudflare Turnstile for sign-up challenges.
    `script-src 'self'${clerk ? ` ${fapi} https://*.protect.clerk.com https://challenges.cloudflare.com` : ''}`,
    `connect-src 'self'${clerk ? ` ${fapi} https://*.protect.clerk.com:*` : ''}`, // bot-protection probes use several ports
    `img-src 'self' data:${clerk ? ' https://img.clerk.com' : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `frame-src ${clerk ? 'https://challenges.cloudflare.com' : "'none'"}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  function json(res, status, body, extra = {}) {
    const data = JSON.stringify(body ?? {});
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...securityHeaders, ...extra });
    res.end(data);
  }

  const clientIp = (req) =>
    (config.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  function origin(req) {
    if (config.publicUrl) return config.publicUrl;
    const fwdProto = config.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
    const fwdHost = config.trustProxy ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
    return `${fwdProto || (req.socket.encrypted ? 'https' : 'http')}://${fwdHost || req.headers.host || 'localhost'}`;
  }

  // ---------- authentication ----------
  async function principalFromClerk(token) {
    const payload = await clerk.verifySessionToken(token);
    const existing = hub.userByClerkId(payload.sub);
    const syncProfile = () => {
      if (!signingIn.has(payload.sub)) {
        signingIn.set(payload.sub, clerk.fetchUser(payload.sub).finally(() => signingIn.delete(payload.sub)));
      }
      return signingIn.get(payload.sub);
    };
    if (!existing) return hub.upsertClerkUser(await syncProfile());
    if (!existing.profileSyncedAt || Date.now() - existing.profileSyncedAt > 12 * 3600_000) {
      syncProfile().then((profile) => hub.upsertClerkUser(profile)).catch((e) => log('warn', 'profile refresh failed', { error: e.message }));
    }
    return { kind: 'user', id: existing.id, user: existing };
  }

  async function authenticate(req) {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    if (token.startsWith('ct_')) return hub.authenticate(token);
    if (clerk && token.split('.').length === 3) return principalFromClerk(token);
    return null;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, auth });
  };

  route('GET', '/api/config', () => ({
    name: 'Crosstalk',
    version: VERSION,
    auth: clerk ? 'clerk' : 'dev',
    clerk: clerk ? { publishableKey: clerk.publishableKey, frontendApi: clerk.frontendApi } : null,
    maxDepth: hub.maxDepth,
  }), { auth: false });
  if (config.devAuth && !clerk) {
    route('POST', '/api/dev/signup', ({ body, req }) => {
      if (limited(`signup:${clientIp(req)}`, 20, 3600_000)) throw new HubError(429, 'Too many sign-ups from this address. Try again later.');
      return hub.signup(body.name);
    }, { auth: false });
  }
  route('GET', '/api/me', ({ p }) => hub.me(p));
  route('PATCH', '/api/me', ({ p, body }) => hub.updateMe(p, body));

  route('GET', '/api/teams', ({ p }) => ({ teams: hub.listTeams(p) }));
  route('GET', '/api/teams/discover', ({ p }) => ({ teams: hub.discoverTeams(p) }));
  route('POST', '/api/teams', ({ p, body }) => ({ team: hub.createTeam(p, body) }));
  route('PATCH', '/api/teams/:id', ({ p, params, body }) => ({ team: hub.updateTeam(p, params.id, body) }));
  route('DELETE', '/api/teams/:id', ({ p, params }) => (hub.deleteTeam(p, params.id), { ok: true }));
  route('POST', '/api/teams/:id/join', ({ p, params }) => ({ team: hub.joinTeam(p, params.id) }));
  route('POST', '/api/teams/:id/leave', ({ p, params }) => (hub.leaveTeam(p, params.id), { ok: true }));
  route('POST', '/api/teams/:id/invite', ({ p, params }) => ({ team: hub.resetTeamInvite(p, params.id) }));
  route('GET', '/api/teams/:id/people', ({ p, params }) => ({ people: hub.listPeople(p, params.id) }));
  route('DELETE', '/api/teams/:id/members/:uid', ({ p, params }) => (hub.removeFromTeam(p, params.id, params.uid), { ok: true }));
  // Invite links (/join/<code>). Codes are long and random, but guesses are still limited.
  const inviteLimit = (req) => {
    if (limited(`invite:${clientIp(req)}`, 30, 10 * 60_000)) throw new HubError(429, 'Too many invite links tried. Wait a few minutes and try again.');
  };
  route('GET', '/api/invites/:code', ({ p, params, req }) => (inviteLimit(req), { team: hub.previewInvite(p, params.code) }));
  route('POST', '/api/invites/:code', ({ p, params, req }) => (inviteLimit(req), { team: hub.joinByCode(p, params.code) }));

  route('GET', '/api/agents', ({ p, query }) => ({ agents: hub.listAgents(p, { teamId: query.get('team') || undefined }) }));
  route('POST', '/api/agents', ({ p, body }) => hub.createAgent(p, body));
  route('GET', '/api/agents/:id', ({ p, params }) => ({ agent: hub.getAgent(p, params.id) }));
  route('PATCH', '/api/agents/:id', ({ p, params, body }) => ({ agent: hub.updateAgent(p, params.id, body) }));
  route('DELETE', '/api/agents/:id', ({ p, params }) => (hub.deleteAgent(p, params.id), { ok: true }));
  route('POST', '/api/agents/:id/token', ({ p, params }) => hub.rotateAgentToken(p, params.id));
  route('POST', '/api/agents/:id/pair-code', ({ p, params }) => hub.createPairCode(p, params.id));
  route('POST', '/api/pair', ({ body, req }) => {
    // Codes are short, so attempts are tightly limited (per address, and hub-wide).
    if (limited(`pair:${clientIp(req)}`, 20, 10 * 60_000) || limited('pair:all', 300, 60_000)) {
      throw new HubError(429, 'Too many pairing attempts. Wait a few minutes and try again.');
    }
    return hub.redeemPairCode(body.code, body.handle);
  }, { auth: false });
  route('POST', '/api/agent/status', ({ p, body }) => (hub.setStatus(p, body), { ok: true }));
  route('GET', '/api/mentions', ({ p, query }) => ({ mentions: hub.mentions(p, { after: query.get('after'), limit: num(query.get('limit')) }) }));

  route('GET', '/api/rooms', ({ p }) => ({ rooms: hub.listRooms(p) }));
  route('POST', '/api/rooms', ({ p, body }) => ({ room: hub.createRoom(p, body) }));
  route('GET', '/api/rooms/:id', ({ p, params }) => ({ room: hub.getRoom(p, params.id) }));
  route('PATCH', '/api/rooms/:id', ({ p, params, body }) => ({ room: hub.updateRoom(p, params.id, body) }));
  route('POST', '/api/rooms/:id/join', ({ p, params }) => ({ room: hub.joinRoom(p, params.id) }));
  route('POST', '/api/rooms/:id/leave', ({ p, params }) => ({ room: hub.leaveRoom(p, params.id) }));
  route('POST', '/api/rooms/:id/members', ({ p, params, body }) => ({ room: hub.addMember(p, params.id, body.handle) }));
  route('DELETE', '/api/rooms/:id/members/:mid', ({ p, params }) => ({ room: hub.removeMember(p, params.id, params.mid) }));
  route('GET', '/api/rooms/:id/messages', ({ p, params, query }) => ({
    messages: hub.getMessages(p, params.id, { after: query.get('after'), before: query.get('before'), limit: num(query.get('limit')) }),
  }));
  route('GET', '/api/rooms/:id/search', ({ p, params, query }) => ({ messages: hub.searchMessages(p, params.id, query.get('q'), { limit: num(query.get('limit')) }) }));
  route('POST', '/api/rooms/:id/messages', ({ p, params, body }) => {
    if (limited(`post:${p.kind}:${p.id}`, p.kind === 'agent' ? 120 : 60, 60_000)) throw new HubError(429, 'You are sending messages too fast. Wait a moment.');
    return hub.postMessage(p, params.id, body);
  });
  route('DELETE', '/api/messages/:id', ({ p, params }) => (hub.deleteMessage(p, params.id), { ok: true }));
  route('POST', '/api/dm', ({ p, body }) => ({ room: hub.openDM(p, body.handle, body.teamId) }));
  route('GET', '/api/messages/:id/reply', async ({ p, params, query, signal }) => ({
    reply: await hub.waitForReply(p, params.id, { from: query.get('from'), timeoutMs: clamp(num(query.get('wait')) ?? 30, 0, 120) * 1000, signal }),
  }));

  // ---------- realtime ----------
  function bridgeInfo(req) {
    const raw = req.headers['x-crosstalk-bridge'];
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(String(raw)));
    } catch {
      return null;
    }
  }

  function sse(req, res, p) {
    const key = `${p.kind}:${p.id}`;
    if ((sseCount.get(key) ?? 0) >= 20) return json(res, 429, { error: 'Too many open connections' });
    sseCount.set(key, (sseCount.get(key) ?? 0) + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...securityHeaders });
    res.socket?.setTimeout(0);
    const send = (evt) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    send({ type: 'hello', me: hub.me(p) });
    const unsubscribe = hub.subscribe(p, { send, close: () => res.end() }, p.kind === 'agent' ? bridgeInfo(req) : null);
    const ping = setInterval(() => res.writableEnded || res.write(': ping\n\n'), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      const n = (sseCount.get(key) ?? 1) - 1;
      if (n > 0) sseCount.set(key, n);
      else sseCount.delete(key);
    });
  }

  // ---------- static + installer ----------
  function installScript(req, res) {
    const hubUrl = origin(req);
    if (!/^https?:\/\/[\w.:[\]-]+$/.test(hubUrl)) return json(res, 400, { error: 'Bad Host header' });
    const script = [
      '#!/bin/sh',
      `# Crosstalk connector installer (from ${hubUrl})`,
      'set -eu',
      `HUB="${hubUrl}"`,
      'DEST="${CROSSTALK_HOME:-$HOME/.crosstalk}/cli"',
      'BIN_DIR="${CROSSTALK_BIN_DIR:-$HOME/.local/bin}"',
      'NODE="$(command -v node || true)"',
      'if [ -z "$NODE" ]; then echo "Crosstalk needs Node.js 20 or later: https://nodejs.org" >&2; exit 1; fi',
      `if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then`,
      '  echo "Crosstalk needs Node.js 20 or later (found $("$NODE" --version))." >&2; exit 1',
      'fi',
      'mkdir -p "$DEST" "$BIN_DIR"',
      `for f in ${CLI_FILES.join(' ')}; do`,
      '  mkdir -p "$DEST/$(dirname "$f")"',
      '  curl -fsSL "$HUB/cli/$f" -o "$DEST/$f.tmp"',
      '  mv "$DEST/$f.tmp" "$DEST/$f"',
      'done',
      'printf \'#!/bin/sh\\nexec "%s" "%s" "$@"\\n\' "$NODE" "$DEST/cli/crosstalk.mjs" > "$BIN_DIR/crosstalk"',
      'chmod +x "$BIN_DIR/crosstalk"',
      'echo "Installed crosstalk $("$BIN_DIR/crosstalk" version) at $BIN_DIR/crosstalk"',
      'case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: $BIN_DIR is not on your PATH. Add it, e.g.:  echo \'export PATH=\\"$BIN_DIR:\\$PATH\\"\' >> ~/.zshrc" ;; esac',
      '',
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-cache', ...securityHeaders });
    res.end(script);
  }

  function serveCliFile(rel, res) {
    if (!CLI_FILES.includes(rel)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...securityHeaders });
    fs.createReadStream(path.join(ROOT, rel)).pipe(res);
  }

  function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: 'Bad path' });
    }
    let file = path.resolve(WEB_DIR, `.${rel === '/' ? '/index.html' : rel}`);
    if (!file.startsWith(WEB_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) return json(res, 404, { error: 'Not found' });
      file = path.join(WEB_DIR, 'index.html'); // client-side routes
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...securityHeaders, ...(type.startsWith('text/html') ? { 'Content-Security-Policy': csp } : {}) });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- dispatch ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      const ok = store.ping();
      return json(res, ok ? 200 : 503, { ok, version: VERSION, ...hub.stats() });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      if (url.pathname === '/install.sh') return installScript(req, res);
      if (url.pathname.startsWith('/cli/')) return serveCliFile(url.pathname.slice(5), res);
      return serveStatic(url.pathname, res);
    }

    const ip = clientIp(req);
    let p = null;
    try {
      p = await authenticate(req);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      if (limited(`authfail:${ip}`, 120, 60_000)) return json(res, 429, { error: 'Too many failed sign-ins' });
      return json(res, 401, { error: e.message });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (!p) return json(res, 401, { error: 'Sign in first' });
      return sse(req, res, p);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.auth && !p) {
        if (limited(`authfail:${ip}`, 120, 60_000)) return json(res, 429, { error: 'Too many failed sign-ins' });
        return json(res, 401, { error: 'Sign in first' });
      }
      if (req.method !== 'GET' && limited(`write:${p ? `${p.kind}:${p.id}` : ip}`, 300, 60_000)) return json(res, 429, { error: 'Too many requests. Slow down a little.' });
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        return json(res, 400, { error: 'Bad path' });
      }
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const out = await r.handler({ p, params, body, query: url.searchParams, signal: ac.signal, req });
      if (!res.writableEnded) json(res, 200, out);
      return;
    }
    json(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.url === '/healthz') return;
      const pathOnly = req.url.split('?')[0];
      if (pathOnly.startsWith('/api/') || res.statusCode >= 400) log(res.statusCode >= 500 ? 'error' : 'info', 'request', { method: req.method, path: pathOnly, status: res.statusCode, ms: Date.now() - started });
    });
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HubError || err instanceof AuthError) return json(res, err.status, { error: err.message });
      log('error', 'unhandled', { method: req.method, path: req.url.split('?')[0], error: err.stack || String(err) });
      json(res, 500, { error: 'Something went wrong on our side.' });
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  function shutdown() {
    return new Promise((resolve) => {
      server.close(() => resolve());
      hub.closeAll();
      server.closeIdleConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 5000).unref();
    }).finally(() => store.close());
  }

  return { server, hub, store, shutdown };
}

function defaultLogger(production) {
  return (level, msg, fields = {}) => {
    if (production) {
      process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
    } else if (level !== 'info' || fields.status >= 400) {
      console.log(`${new Date().toISOString().slice(11, 19)} ${level} ${msg}`, Object.keys(fields).length ? fields : '');
    }
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  loadDotEnv();
  const { config, errors, warnings } = loadConfig();
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    console.error(`Crosstalk cannot start:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  const { server, shutdown } = createServer({ config });
  server.listen(config.port, config.host, () => {
    const shown = config.publicUrl || `http://${config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host}:${config.port}`;
    console.log(`Crosstalk ${VERSION} on ${shown}  ·  sign-in: ${config.clerk ? 'Clerk' : 'DEV (no passwords, local only)'}  ·  db: ${config.dbFile}`);
  });
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: shutting down`);
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
