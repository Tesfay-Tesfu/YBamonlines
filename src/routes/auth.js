// Sign in / sign up / email verification / password reset
const { Router } = require('../http');
const db = require('../db');
const config = require('../config');
const A = require('../auth');
const { sendMail, mailEnabled } = require('../mailer');

const r = new Router();
const loginLimit = A.rateLimit({ windowMs: 15 * 60e3, max: 30, key: 'login' });
const LOCK_AFTER = 8;

async function guardLock(user) {
  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    A.fail(429, 'This account is locked for a few minutes after too many wrong tries.');
  }
}
async function recordFail(user) {
  if (!user) return;
  const n = user.failed_logins + 1;
  await db.q(`UPDATE users SET failed_logins=$2::int, locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE NULL END WHERE id=$1`,
    [user.id, n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER]);
}

async function issueEmailToken(user, purpose) {
  const t = A.token(24);
  const hours = purpose === 'verify' ? 72 : 2;
  await db.q('DELETE FROM email_tokens WHERE user_id=$1 AND purpose=$2', [user.id, purpose]);
  await db.q(`INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval)`,
    [A.sha(t), user.id, purpose, String(hours)]);
  const link = `${config.appUrl}/#/${purpose === 'verify' ? 'verify' : 'reset'}/${t}`;
  const subject = purpose === 'verify' ? 'Confirm your AMtutorTools email' : 'Reset your AMtutorTools password';
  const text = purpose === 'verify'
    ? `Hello ${user.name},\n\nPlease confirm your email address by opening this link:\n${link}\n\nThe link works for 3 days.\n\nAfro-Merica Tutor`
    : `Hello ${user.name},\n\nSomeone asked to reset your AMtutorTools password. If it was you, open this link within 2 hours:\n${link}\n\nIf it wasn't you, you can ignore this email.\n\nAfro-Merica Tutor`;
  await sendMail({ to: user.email, subject, text });
}
async function useEmailToken(t, purpose) {
  const row = await db.one(`DELETE FROM email_tokens WHERE token_hash=$1 AND purpose=$2 RETURNING user_id, expires_at`, [A.sha(String(t || '')), purpose]);
  if (!row || new Date(row.expires_at) < new Date()) A.fail(400, 'This link is invalid or has expired.');
  return row.user_id;
}

// ----- who am I -----
r.get('/me', (req, res) => res.json({ user: req.user, mailEnabled: mailEnabled() }));

// ----- adult sign in -----
r.post('/login', loginLimit, async (req, res) => {
  const email = A.normEmail(req.body.email);
  const user = await db.one(`SELECT * FROM users WHERE email=$1 AND role <> 'student'`, [email]);
  await guardLock(user);
  if (!user || !user.active || !(await A.checkSecret(req.body.password || '', user.password_hash))) {
    await recordFail(user);
    A.fail(401, 'Email or password is not correct.');
  }
  await A.createSession(res, user);
  req.user = user; A.audit(req, 'login');
  res.json({ ok: true, role: user.role });
});

// ----- student sign in (username + PIN) -----
r.post('/student-login', loginLimit, async (req, res) => {
  const username = A.normUsername(req.body.username);
  const user = await db.one(`SELECT * FROM users WHERE username=$1 AND role='student'`, [username]);
  await guardLock(user);
  if (!user || !user.active || !(await A.checkSecret(req.body.pin || '', user.pin_hash))) {
    await recordFail(user);
    A.fail(401, 'Username or PIN is not correct. Ask your tutor or parent for help.');
  }
  await A.createSession(res, user);
  req.user = user; A.audit(req, 'login', user.id);
  res.json({ ok: true, role: 'student' });
});

r.post('/logout', async (req, res) => { await A.destroySession(req, res); res.json({ ok: true }); });

// ----- invite preview (shown on the sign-up page) -----
r.get('/invite/:code', async (req, res) => {
  const inv = await db.one(
    `SELECT i.role, i.email, i.expires_at, i.used_at, s.name AS student_name
       FROM invites i LEFT JOIN users s ON s.id = i.student_id WHERE i.code=$1`, [String(req.params.code).trim().toUpperCase()]);
  if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) A.fail(404, 'This invite code is invalid, used or expired.');
  res.json({ role: inv.role, email: inv.email, studentFirstName: inv.student_name ? inv.student_name.split(' ')[0] : null });
});

// ----- redeem an invite: new account, or link an existing signed-in parent/tutor -----
r.post('/redeem', loginLimit, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const out = await db.tx(async c => {
    const inv = (await c.query('SELECT * FROM invites WHERE code=$1 FOR UPDATE', [code])).rows[0];
    if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) A.fail(400, 'This invite code is invalid, used or expired.');
    if (inv.role === 'parent' && !req.body.consent) A.fail(400, 'Please confirm parental consent to continue.');

    let user = req.user && req.user.role !== 'student' ? req.user : null;
    let created = false;
    if (user) {
      if (inv.role !== user.role && !(inv.role === 'parent' && user.role === 'tutor')) A.fail(400, `This code is for a ${inv.role} account.`);
      if (inv.email && A.normEmail(inv.email) !== A.normEmail(user.email)) A.fail(400, 'This invite was sent to a different email address.');
    } else {
      const email = A.normEmail(req.body.email);
      const name = String(req.body.name || '').trim();
      if (!name) A.fail(400, 'Please enter your name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) A.fail(400, 'Please enter a valid email.');
      if (inv.email && A.normEmail(inv.email) !== email) A.fail(400, 'Please use the email address the invite was sent to.');
      const p = A.passwordProblem(req.body.password); if (p) A.fail(400, p);
      if ((await c.query('SELECT 1 FROM users WHERE email=$1', [email])).rows.length) A.fail(409, 'An account with this email already exists. Sign in first, then enter the code.');
      user = (await c.query(
        `INSERT INTO users(role,name,email,password_hash,email_verified) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [inv.role, name, email, await A.hashSecret(req.body.password), !!inv.email && !mailEnabled()])).rows[0];
      created = true;
    }
    if (inv.student_id) {
      await c.query(`INSERT INTO student_links(student_id, adult_id, relation, consent_at, created_by)
                     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (student_id, adult_id) DO UPDATE SET consent_at = COALESCE(student_links.consent_at, EXCLUDED.consent_at)`,
        [inv.student_id, user.id, inv.role === 'tutor' ? 'tutor' : 'parent', inv.role === 'parent' ? new Date() : null, inv.created_by]);
    }
    await c.query('UPDATE invites SET used_by=$2, used_at=now() WHERE id=$1', [inv.id, user.id]);
    return { user, created, studentId: inv.student_id };
  });
  if (out.created) {
    await A.createSession(res, out.user);
    if (!out.user.email_verified) await issueEmailToken(out.user, 'verify');
  }
  req.user = out.user; A.audit(req, out.created ? 'signup_invite' : 'link_invite', out.studentId);
  res.json({ ok: true, created: out.created });
});

// ----- email verification -----
r.post('/verify', async (req, res) => {
  const uid = await useEmailToken(req.body.token, 'verify');
  await db.q('UPDATE users SET email_verified=true WHERE id=$1', [uid]);
  res.json({ ok: true });
});
r.post('/resend-verify', A.requireLogin, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true });
  await issueEmailToken(req.user, 'verify');
  res.json({ ok: true, mailEnabled: mailEnabled() });
});

// ----- password reset -----
r.post('/forgot', A.rateLimit({ windowMs: 60 * 60e3, max: 10, key: 'forgot' }), async (req, res) => {
  const user = await db.one(`SELECT * FROM users WHERE email=$1 AND role <> 'student' AND active`, [A.normEmail(req.body.email)]);
  if (user) await issueEmailToken(user, 'reset');
  res.json({ ok: true }); // same answer either way, so emails can't be discovered
});
r.post('/reset', async (req, res) => {
  const p = A.passwordProblem(req.body.password); if (p) A.fail(400, p);
  const uid = await useEmailToken(req.body.token, 'reset');
  await db.q('UPDATE users SET password_hash=$2, email_verified=true, failed_logins=0, locked_until=NULL WHERE id=$1', [uid, await A.hashSecret(req.body.password)]);
  await db.q('DELETE FROM sessions WHERE user_id=$1', [uid]);
  res.json({ ok: true });
});

r.post('/change-password', A.requireLogin, async (req, res) => {
  if (req.user.role === 'student') A.fail(403, 'Students change PINs with their tutor or parent.');
  const u = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await A.checkSecret(req.body.current || '', u.password_hash))) A.fail(400, 'Current password is not correct.');
  const p = A.passwordProblem(req.body.password); if (p) A.fail(400, p);
  await db.q('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await A.hashSecret(req.body.password)]);
  A.audit(req, 'change_password');
  res.json({ ok: true });
});

module.exports = r;
