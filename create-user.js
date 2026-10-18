#!/usr/bin/env node
// Create or reset a user from the command line (e.g. in the Render Shell):
//   npm run create-user -- <username> <password> [--admin] [--name "Display Name"]
'use strict';
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const [username, password] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--name');
const isAdmin = args.includes('--admin');
const nameIdx = args.indexOf('--name');
const displayName = nameIdx >= 0 ? args[nameIdx + 1] : username;

if (!username || !password || password.length < 8) {
  console.log('Usage: npm run create-user -- <username> <password (8+ chars)> [--admin] [--name "Display Name"]');
  process.exit(1);
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       is_admin = users.is_admin OR EXCLUDED.is_admin`,
    [username.toLowerCase(), displayName, hash, isAdmin]
  );
  console.log(`Saved user "${username}"${isAdmin ? ' (admin)' : ''}.`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
