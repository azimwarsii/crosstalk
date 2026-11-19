// Clerk sign-in, against a fake Clerk instance: our own RSA keys, JWKS endpoint and users API.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { createClerkAuth, frontendApiFromPublishableKey } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

const FAPI = 'happy-otter-12.clerk.accounts.dev';
const PK = `pk_test_${Buffer.from(`${FAPI}$`).toString('base64')}`;
const ISSUER = `https://${FAPI}`;
const SITE = 'https://crosstalk.example.com';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'ins_key_1', use: 'sig', alg: 'RS256' };

function sign(claims, { key = privateKey, kid = 'ins_key_1' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT', kid });
  const body = enc(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const session = (over = {}) => ({ iss: ISSUER, sub: 'user_2abcGoogle', sid: 'sess_1', azp: SITE, iat: nowS(), nbf: nowS() - 5, exp: nowS() + 60, ...over });

test('publishable keys decode to the Clerk frontend API host', () => {
  assert.equal(frontendApiFromPublishableKey(PK), FAPI);
  assert.throws(() => frontendApiFromPublishableKey('sk_test_abc'), /pk_test_/);
});

test('config refuses unsafe production setups', () => {
  const bad = loadConfig({ NODE_ENV: 'production', CROSSTALK_DEV_AUTH: '1' });
  assert.ok(bad.errors.some((e) => /DEV_AUTH/.test(e)));
  assert.ok(bad.errors.some((e) => /CROSSTALK_PUBLIC_URL/.test(e)));
  const noAuth = loadConfig({});
  assert.ok(noAuth.errors.some((e) => /No sign-in method/.test(e)));
  const good = loadConfig({ NODE_ENV: 'production', CROSSTALK_PUBLIC_URL: SITE, CLERK_PUBLISHABLE_KEY: PK, CLERK_SECRET_KEY: 'sk_test_x' });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.config.clerk.authorizedParties, [SITE]);
  assert.ok(good.warnings.some((w) => /development instance/.test(w)));
});

test('Clerk session tokens sign people in; bad tokens are refused', async (t) => {
  // Fake Clerk: JWKS + Backend API users endpoint.
  let userLookups = 0;
  const fake = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/v1/users/user_2abcGoogle') {
      userLookups++;
      assert.equal(req.headers.authorization, 'Bearer sk_test_secret');
      return res.end(JSON.stringify({
        id: 'user_2abcGoogle', first_name: 'Ada', last_name: 'Lovelace', username: null, image_url: 'https://img.clerk.com/ada.png',
        primary_email_address_id: 'idn_1', email_addresses: [{ id: 'idn_1', email_address: 'ada@example.com' }],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosstalk-auth-'));
  const dbFile = path.join(dir, 'crosstalk.db');
  const clerk = createClerkAuth({ publishableKey: PK, secretKey: 'sk_test_secret', authorizedParties: [SITE], issuer: ISSUER, jwksUrl: `${fakeUrl}/.well-known/jwks.json`, apiUrl: fakeUrl });
  const config = { dbFile, maxDepth: 6, publicUrl: SITE };
  let app = createServer({ config, clerk, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.shutdown();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = (p, token) => fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  // Public config tells the browser how to load Clerk; no dev sign-up route exists.
  const cfg = await (await get('/api/config')).json();
  assert.equal(cfg.auth, 'clerk');
  assert.equal(cfg.clerk.frontendApi, FAPI);
  assert.equal((await fetch(`${base}/api/dev/signup`, { method: 'POST', body: '{"name":"x"}' })).status, 404);
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy'), new RegExp(`script-src 'self' https://${FAPI.replace(/\./g, '\\.')}`));
  assert.match(page.headers.get('strict-transport-security'), /max-age/);

  // First sign-in creates the person from their Google profile, once.
  const token = sign(session());
  const [a, b] = await Promise.all([get('/api/me', token), get('/api/me', token)]);
  const me = await a.json();
  assert.equal(a.status, 200, JSON.stringify(me));
  assert.equal((await b.json()).id, me.id, 'concurrent first requests make one account');
  assert.equal(me.name, 'Ada Lovelace');
  assert.equal(me.handle, 'ada-lovelace');
  assert.equal(me.email, 'ada@example.com');
  assert.equal(me.imageUrl, 'https://img.clerk.com/ada.png');
  assert.equal(userLookups, 1);
  const rooms = await (await get('/api/rooms', token)).json();
  assert.deepEqual(rooms.rooms, [], 'new people start with no team, so no rooms');
  assert.deepEqual(me.teams, []);

  // Refused: expired, wrong instance, wrong site, forged signature, unknown key, garbage.
  const refused = {
    expired: sign(session({ exp: nowS() - 120 })),
    'wrong issuer': sign(session({ iss: 'https://evil.clerk.accounts.dev' })),
    'wrong site': sign(session({ azp: 'https://evil.example.com' })),
    forged: sign(session(), { key: other.privateKey }),
    'unknown key': sign(session(), { kid: 'nope' }),
    garbage: 'a.b.c',
  };
  for (const [why, bad] of Object.entries(refused)) {
    const r = await get('/api/me', bad);
    assert.equal(r.status, 401, `${why} should be refused`);
  }

  // People persist across a restart (SQLite file), and agent tokens still work alongside Clerk.
  const created = await (await fetch(`${base}/api/agents`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'ada-bot', runtime: 'claude-code' }) })).json();
  await app.shutdown();
  app = createServer({ config, clerk, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const again = await (await get('/api/me', sign(session()))).json();
  assert.equal(again.id, me.id);
  assert.equal(again.agents[0].handle, 'ada-bot');
  const asAgent = await (await get('/api/me', created.token)).json();
  assert.equal(asAgent.handle, 'ada-bot');
  assert.equal(userLookups, 1, 'no profile refetch for a recent sign-in');
  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600, 'database file is private');
});
