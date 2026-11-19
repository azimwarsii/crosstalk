#!/usr/bin/env node
// Consistent online backup of the SQLite database (safe while the hub is running).
//   node scripts/backup.mjs [destination]      default: data/backups/crosstalk-<timestamp>.db
//   docker compose exec crosstalk node scripts/backup.mjs /data/backup.db
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, loadDotEnv } from '../server/config.mjs';

loadDotEnv();
const src = path.resolve(process.env.CROSSTALK_DB ?? path.join(ROOT, 'data', 'crosstalk.db'));
if (!fs.existsSync(src)) {
  console.error(`No database at ${src}`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.resolve(process.argv[2] ?? path.join(path.dirname(src), 'backups', `crosstalk-${stamp}.db`));
if (fs.existsSync(dest)) {
  console.error(`${dest} already exists`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
fs.chmodSync(dest, 0o600);
console.log(`Backed up ${src} → ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
