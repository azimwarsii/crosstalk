// Server configuration from the environment (and an optional .env file next to package.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontendApiFromPublishableKey } from './auth.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  // Real environment variables win over .env values.
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const publicUrl = String(env.CROSSTALK_PUBLIC_URL ?? '').trim().replace(/\/+$/, '') || null;
  const cfg = {
    production,
    port: Number(env.PORT ?? 4545),
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    dbFile: env.CROSSTALK_DB ?? path.join(ROOT, 'data', 'crosstalk.db'),
    maxDepth: Number(env.CROSSTALK_MAX_DEPTH) || 6,
    trustProxy: truthy(env.CROSSTALK_TRUST_PROXY),
    devAuth: truthy(env.CROSSTALK_DEV_AUTH),
    clerk: null,
  };
  const errors = [];
  const warnings = [];

  // Also accept the Next.js-style name people often copy from Clerk's dashboard.
  const publishableKey = env.CLERK_PUBLISHABLE_KEY || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '';
  if (publishableKey || env.CLERK_SECRET_KEY) {
    const parties = String(env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
    if (!parties.length && publicUrl) parties.push(new URL(publicUrl).origin);
    cfg.clerk = { publishableKey: String(publishableKey).trim(), secretKey: String(env.CLERK_SECRET_KEY ?? '').trim(), authorizedParties: parties };
    if (!cfg.clerk.publishableKey) errors.push('CLERK_PUBLISHABLE_KEY is missing (it starts with pk_).');
    if (!cfg.clerk.secretKey) errors.push('CLERK_SECRET_KEY is missing (it starts with sk_).');
    else if (!/^sk_(test|live)_/.test(cfg.clerk.secretKey)) errors.push('CLERK_SECRET_KEY should start with sk_test_ or sk_live_.');
    if (cfg.clerk.publishableKey) {
      try {
        cfg.clerk.frontendApi = frontendApiFromPublishableKey(cfg.clerk.publishableKey);
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (production && cfg.clerk.publishableKey.startsWith('pk_test_')) warnings.push('Using a Clerk development instance (pk_test_) in production. Switch to your production instance keys (pk_live_/sk_live_) before launch.');
  }

  if (cfg.devAuth && production) errors.push('CROSSTALK_DEV_AUTH must not be enabled when NODE_ENV=production.');
  if (cfg.devAuth && cfg.clerk) warnings.push('Both Clerk and dev sign-in are enabled; dev sign-in is ignored while Clerk is configured.');
  if (cfg.clerk) cfg.devAuth = false;
  if (!cfg.clerk && !cfg.devAuth) errors.push('No sign-in method. Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (see .env.example), or CROSSTALK_DEV_AUTH=1 for local development only.');
  if (production && !publicUrl) errors.push('Set CROSSTALK_PUBLIC_URL to the public https address, e.g. https://crosstalk.example.com');
  if (production && publicUrl && !publicUrl.startsWith('https://')) errors.push('CROSSTALK_PUBLIC_URL must use https in production.');
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) errors.push('PORT must be a positive integer.');

  return { config: cfg, errors, warnings };
}
