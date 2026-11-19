// Clerk authentication without an SDK: verify Clerk session tokens (RS256 JWTs) against the
// instance's published signing keys, and fetch the signed-in person's profile with the secret key.
//
// Browser: ClerkJS signs the person in (Google), then sends `Authorization: Bearer <session token>`.
// Server:  verify signature, expiry, issuer and authorized party; map `sub` to a Crosstalk user.
import crypto from 'node:crypto';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

/** pk_test_<base64("example.clerk.accounts.dev$")> -> "example.clerk.accounts.dev" */
export function frontendApiFromPublishableKey(publishableKey) {
  const m = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(String(publishableKey ?? '').trim());
  if (!m) throw new Error('CLERK_PUBLISHABLE_KEY must look like pk_test_… or pk_live_…');
  const host = Buffer.from(m[2], 'base64').toString('utf8').replace(/\$$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error('CLERK_PUBLISHABLE_KEY does not contain a valid Clerk domain');
  return host;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export function createClerkAuth({
  publishableKey,
  secretKey,
  authorizedParties = [],
  apiUrl = 'https://api.clerk.com',
  issuer,
  jwksUrl,
  fetchImpl = (...a) => fetch(...a),
  clockSkewSec = 10,
  now = () => Date.now(),
}) {
  const frontendApi = frontendApiFromPublishableKey(publishableKey);
  issuer ??= `https://${frontendApi}`;
  jwksUrl ??= `${issuer}/.well-known/jwks.json`;

  let keys = new Map();
  let fetchedAt = 0;
  let inflight = null;

  function refreshKeys() {
    inflight ??= (async () => {
      const res = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Could not fetch Clerk signing keys: HTTP ${res.status}`);
      const body = await res.json();
      const next = new Map();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty === 'RSA' && jwk.kid) next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      }
      keys = next;
      fetchedAt = now();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function keyFor(kid) {
    const stale = now() - fetchedAt > 6 * 3600_000;
    // Unknown key id: refetch (keys rotate), but at most every 30s so bad tokens can't hammer Clerk.
    if (stale || (!keys.has(kid) && now() - fetchedAt > 30_000)) await refreshKeys();
    const key = keys.get(kid);
    if (!key) throw new AuthError('Session token signed with an unknown key');
    return key;
  }

  async function verifySessionToken(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) throw new AuthError('Malformed session token');
    let header;
    let payload;
    try {
      header = b64json(parts[0]);
      payload = b64json(parts[1]);
    } catch {
      throw new AuthError('Malformed session token');
    }
    if (header.alg !== 'RS256') throw new AuthError('Unsupported session token algorithm');
    const key = await keyFor(header.kid);
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!valid) throw new AuthError('Invalid session token signature');
    const t = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + clockSkewSec < t) throw new AuthError('Session token expired');
    if (typeof payload.nbf === 'number' && payload.nbf - clockSkewSec > t) throw new AuthError('Session token not valid yet');
    if (payload.iss !== issuer) throw new AuthError('Session token from a different Clerk instance');
    if (authorizedParties.length && payload.azp && !authorizedParties.includes(payload.azp)) throw new AuthError('Session token issued for a different site');
    if (payload.sts === 'pending') throw new AuthError('Session is not active yet');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError('Session token has no user');
    return payload;
  }

  /** The person's profile from Clerk's Backend API (needs the secret key). */
  async function fetchUser(userId) {
    const res = await fetchImpl(`${apiUrl}/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secretKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Clerk user lookup failed: HTTP ${res.status}`);
    const u = await res.json();
    const emails = u.email_addresses ?? [];
    const primary = emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0];
    const email = primary?.email_address ?? null;
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || (email ? email.split('@')[0] : '') || 'New user';
    return { clerkId: u.id, name, username: u.username ?? null, email, imageUrl: u.image_url ?? null, synced: true };
  }

  return { frontendApi, issuer, publishableKey, verifySessionToken, fetchUser };
}
