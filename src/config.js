// Loads .env (if present) without extra dependencies, then exposes settings.
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production');
  process.exit(1);
}

module.exports = {
  isProd,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/amtutortools',
  databaseSsl: process.env.DATABASE_SSL === '1',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret',
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  mailFrom: process.env.MAIL_FROM || 'AMtutorTools <no-reply@amtutortools.local>',
  sessionDays: 14,
  studentSessionHours: 12,
  toolsDir: path.join(__dirname, '..', 'tools'),
  publicDir: path.join(__dirname, '..', 'public'),
  maxStateBytes: 2 * 1024 * 1024,
  maxUploadBytes: 8 * 1024 * 1024,
};
