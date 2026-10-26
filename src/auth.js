// Sessions, password/PIN hashing, request guards and access rules.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'amt_sid';
const sha = s => crypto.createHmac('sha256', config.sessionSecret).update(s).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- hashing ----------
// scrypt (built into Node) — format: scrypt$N$r$p$salt$hash
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const scrypt = (s, salt, o) => new Promise((ok, no) =>
  crypto.scrypt(String(s), salt, o.len, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k))));
async function hashSecret(s) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(s, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function checkSecret(s, stored) {
  if (!stored || !stored.startsWith('scrypt$')) {
    await scrypt(s, 'timing-pad', SCRYPT); // keep timing similar when the user doesn't exist
    return false;
  }
  const [, N, r, p, salt, hash] = stored.split('$');
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(s, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, len: want.length });
  return crypto.timingSafeEqual(want, got);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs at least one letter and one number.';
  return null;
}
function pinProblem(pin) {
  return /^\d{4,6}$/.test(String(pin || '')) ? null : 'PIN must be 4 to 6 digits.';
}
const normEmail = e => String(e || '').trim().toLowerCase();
const normUsername = u => String(u || '').trim().toLowerCase();

// ---------- cookies & sessions ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(res, user) {
  const t = token();
  const hours = user.role === 'student' ? config.studentSessionHours : config.sessionDays * 24;
  const expires = new Date(Date.now() + hours * 3600e3);
  await db.q('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [sha(t), user.id, expires]);
  await db.q('UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${config.isProd ? '; Secure' : ''}`);
}

async function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) await db.q('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.isProd ? '; Secure' : ''}`);
}

// Attaches req.user (or null) to every request.
async function loadUser(req, res, next) {
  req.user = null;
  const t = parseCookies(req)[COOKIE];
  if (t) {
    req.user = await db.one(
      `SELECT u.id, u.role, u.name, u.email, u.email_verified, u.username, u.grade
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha(t)]);
  }
  return next();
}

// Blocks cross-site form posts: every state-changing API call must send this header.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-AMT') !== '1') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

const requireLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }));
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this.' });
  next();
};

// ---------- access rules ----------
// Can this user see this student's data?
async function canViewStudent(user, studentId) {
  studentId = Number(studentId);
  if (!user || !studentId) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'student') return user.id === studentId;
  return !!(await db.one('SELECT 1 FROM student_links WHERE student_id=$1 AND adult_id=$2', [studentId, user.id]));
}
// Can this user change this student's tools, plans and progress? (admins, linked tutors)
async function canManageStudent(user, studentId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'tutor') return false;
  return !!(await db.one(`SELECT 1 FROM student_links WHERE student_id=$1 AND adult_id=$2 AND relation='tutor'`, [Number(studentId), user.id]));
}
// When a student has several tutors, each tool can belong to one of them (allocations.tutor_id).
// A tutor only sees tools that are theirs or shared (tutor_id NULL). Everyone else sees all tools.
// Returns an SQL condition for a tool column; `p` is the $ number of the tutor's id in the query.
function tutorToolSql(user, stuCol, toolCol, p) {
  if (!user || user.role !== 'tutor') return '';
  return ` AND ${toolCol} IN (SELECT al.tool_id FROM allocations al WHERE al.student_id=${stuCol} AND (al.tutor_id IS NULL OR al.tutor_id=$${p}))`;
}
const tutorOwnsAlloc = (user, alloc) => !!alloc && (user.role !== 'tutor' || !alloc.tutor_id || alloc.tutor_id === user.id);
async function assertView(user, studentId) {
  if (!(await canViewStudent(user, studentId))) fail(403, 'You do not have access to this student.');
}
async function assertManage(user, studentId) {
  if (!(await canManageStudent(user, studentId))) fail(403, 'Only this student’s tutor or an admin can do that.');
}

// ---------- audit ----------
function audit(req, action, studentId = null, detail = null) {
  return db.q('INSERT INTO audit_log(actor_id, action, student_id, detail, ip) VALUES ($1,$2,$3,$4,$5)',
    [req.user ? req.user.id : null, action, studentId, detail, req.ip]).catch(e => console.error('audit failed', e.message));
}

// ---------- tiny in-memory rate limiter (per process) ----------
const buckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const k = `${key}:${req.ip}`;
    const now = Date.now();
    const b = buckets.get(k) || { n: 0, reset: now + windowMs };
    if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
    b.n++; buckets.set(k, b);
    if (b.n > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60e3).unref();

module.exports = {
  HttpError, fail, sha, token, hashSecret, checkSecret, passwordProblem, pinProblem, normEmail, normUsername,
  createSession, destroySession, loadUser, csrfGuard, requireLogin, requireRole,
  canViewStudent, canManageStudent, assertView, assertManage, audit, rateLimit, tutorToolSql, tutorOwnsAlloc,
};
