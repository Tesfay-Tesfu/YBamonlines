// Students: list, profile, progress reports, tools/plan, PIN, invites.
// Visibility: admin = all; tutor/parent = linked students; student = self.
const crypto = require('crypto');
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');
const { toolBySlug } = require('../tools');
const { csv } = require('../util');

const r = new Router();
r.use(A.requireLogin);

const randomPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const inviteCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 8; i++) s += abc[crypto.randomInt(abc.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
};

async function uniqueUsername(c, name) {
  const parts = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, '').trim().split(/\s+/);
  const base = ((parts[0] || 'student') + (parts[1] ? '.' + parts[1][0] : '')).slice(0, 20);
  for (let i = 0; i < 50; i++) {
    const u = i === 0 ? base : `${base}${crypto.randomInt(10, 1000)}`;
    if (!(await c.query('SELECT 1 FROM users WHERE username=$1', [u])).rows.length) return u;
  }
  return `${base}${Date.now() % 100000}`;
}

// Shared by admin bulk import too
async function createStudent(c, actor, { name, grade, username, pin }) {
  name = String(name || '').trim();
  if (!name) A.fail(400, 'Student name is required.');
  grade = grade === '' || grade === null || grade === undefined ? null : Number(grade);
  if (grade !== null && !(grade >= 1 && grade <= 12)) A.fail(400, 'Grade must be 1 to 12.');
  username = username ? A.normUsername(username) : await uniqueUsername(c, name);
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) A.fail(400, 'Username: 3–30 letters, numbers, dots or dashes.');
  if ((await c.query('SELECT 1 FROM users WHERE username=$1', [username])).rows.length) A.fail(409, `Username "${username}" is taken.`);
  pin = pin ? String(pin) : randomPin();
  const p = A.pinProblem(pin); if (p) A.fail(400, p);
  const s = (await c.query(`INSERT INTO users(role,name,username,pin_hash,grade,created_by) VALUES ('student',$1,$2,$3,$4,$5) RETURNING id, name, username, grade`,
    [name, username, await A.hashSecret(pin), grade, actor.id])).rows[0];
  if (actor.role === 'tutor') {
    await c.query(`INSERT INTO student_links(student_id, adult_id, relation, created_by) VALUES ($1,$2,'tutor',$2)`, [s.id, actor.id]);
  }
  return { ...s, pin };
}

async function createInvite(c, actor, { role, studentId = null, email = null, days = 14 }) {
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) A.fail(400, 'Invite email is not valid.');
  for (let i = 0; i < 5; i++) {
    const code = inviteCode();
    const row = (await c.query(`INSERT INTO invites(code, role, student_id, email, expires_at, created_by)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, $6) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [code, role, studentId, email ? A.normEmail(email) : null, String(days), actor.id])).rows[0];
    if (row) return row;
  }
  A.fail(500, 'Could not create an invite code. Try again.');
}

// ---------- list ----------
r.get('/', async (req, res) => {
  const u = req.user;
  const params = [];
  let where = `s.role='student'`;
  if (u.role === 'student') { params.push(u.id); where += ` AND s.id=$${params.length}`; }
  else if (u.role !== 'admin') { params.push(u.id); where += ` AND EXISTS (SELECT 1 FROM student_links l WHERE l.student_id=s.id AND l.adult_id=$${params.length})`; }
  if (req.query.q) { params.push(`%${req.query.q}%`); where += ` AND (s.name ILIKE $${params.length} OR s.username ILIKE $${params.length})`; }
  if (req.query.grade) { params.push(Number(req.query.grade)); where += ` AND s.grade=$${params.length}`; }
  const rows = await db.many(`
    SELECT s.id, s.name, s.username, s.grade, s.active, s.last_login_at, s.created_at,
      (SELECT count(*)::int FROM allocations a WHERE a.student_id=s.id AND a.status='active') AS tools,
      (SELECT COALESCE(sum(seconds),0)::int FROM activity v WHERE v.student_id=s.id AND v.day > current_date - 7) AS seconds_7d,
      GREATEST((SELECT max(day) FROM activity v WHERE v.student_id=s.id), (SELECT max(created_at)::date FROM attempts t WHERE t.student_id=s.id)) AS last_active,
      (SELECT count(*)::int FROM attempts t WHERE t.student_id=s.id AND t.created_at > now() - interval '7 days') AS attempts_7d,
      (SELECT round(100.0 * avg(t.correct::int))::int FROM attempts t WHERE t.student_id=s.id AND t.created_at > now() - interval '7 days') AS accuracy_7d,
      (SELECT string_agg(a.name, ', ' ORDER BY a.name) FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=s.id AND l.relation='tutor') AS tutors,
      (SELECT string_agg(a.name, ', ' ORDER BY a.name) FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=s.id AND l.relation='parent') AS parents
    FROM users s WHERE ${where} ORDER BY s.grade NULLS LAST, s.name LIMIT 2000`, params);
  res.json({ students: rows });
});

// ---------- create (admin, tutor) ----------
r.post('/', A.requireRole('admin', 'tutor'), async (req, res) => {
  const s = await db.tx(c => createStudent(c, req.user, req.body));
  A.audit(req, 'create_student', s.id);
  res.json({ student: s });
});

// ---------- profile ----------
async function toolRows(studentId) {
  return db.many(`
    SELECT t.id AS tool_id, t.slug, t.name, t.icon, t.subject, t.grade_min, t.grade_max, t.active AS tool_active, t.settings_schema,
           a.status, a.settings, a.expires_at, a.created_at AS assigned_at,
           (a.status='active' AND t.active AND (a.expires_at IS NULL OR a.expires_at > now())) AS usable,
           COALESCE(v.total,0)::int AS seconds_total, COALESCE(v.week,0)::int AS seconds_7d, v.last_day,
           COALESCE(x.n,0)::int AS attempts, x.acc AS accuracy, x.avg_ms, x.last_at,
           COALESCE(x.n7,0)::int AS attempts_7d, x.acc7 AS accuracy_7d
      FROM allocations a JOIN tools t ON t.id=a.tool_id
      LEFT JOIN LATERAL (SELECT sum(seconds) total, sum(seconds) FILTER (WHERE day > current_date - 7) week, max(day) last_day
                           FROM activity WHERE student_id=a.student_id AND tool_id=a.tool_id) v ON true
      LEFT JOIN LATERAL (SELECT count(*) n, round(100.0*avg(correct::int))::int acc, round(avg(ms))::int avg_ms, max(created_at) last_at,
                                count(*) FILTER (WHERE created_at > now() - interval '7 days') n7,
                                round(100.0*avg(correct::int) FILTER (WHERE created_at > now() - interval '7 days'))::int acc7
                           FROM attempts WHERE student_id=a.student_id AND tool_id=a.tool_id) x ON true
     WHERE a.student_id=$1 ORDER BY a.status, t.subject, t.name`, [studentId]);
}

r.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertView(req.user, id);
  const s = await db.one(`SELECT id, name, username, grade, active, created_at, last_login_at FROM users WHERE id=$1 AND role='student'`, [id]);
  if (!s) A.fail(404, 'Student not found.');
  const manage = await A.canManageStudent(req.user, id);
  const adults = req.user.role === 'student' ? [] : await db.many(`
    SELECT a.id, a.name, ${manage || req.user.role === 'admin' ? 'a.email,' : ''} l.relation, l.consent_at
      FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=$1 ORDER BY l.relation DESC, a.name`, [id]);
  const tools = await toolRows(id);
  const achievements = await db.many(`SELECT ac.code, ac.title, ac.icon, ac.created_at, t.name AS tool FROM achievements ac LEFT JOIN tools t ON t.id=ac.tool_id
                                      WHERE ac.student_id=$1 ORDER BY ac.created_at DESC LIMIT 100`, [id]);
  const days = await db.many(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
        COALESCE((SELECT sum(seconds) FROM activity WHERE student_id=$1 AND day=d::date),0)::int AS seconds,
        (SELECT count(*) FROM attempts WHERE student_id=$1 AND created_at::date = d::date)::int AS attempts
      FROM generate_series(current_date - 27, current_date, interval '1 day') d ORDER BY d`, [id]);
  const invites = manage ? await db.many(`SELECT id, code, role, email, expires_at, used_at FROM invites WHERE student_id=$1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [id]) : [];
  if (req.user.role !== 'student' && req.user.id !== id) A.audit(req, 'view_student', id);
  res.json({ student: s, canManage: manage, canResetPin: manage || adults.some(a => a.id === req.user.id && a.relation === 'parent'), adults, tools, achievements, days, invites });
});

r.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertManage(req.user, id);
  const s = await db.one(`SELECT * FROM users WHERE id=$1 AND role='student'`, [id]);
  if (!s) A.fail(404, 'Student not found.');
  const name = req.body.name !== undefined ? String(req.body.name).trim() : s.name;
  const grade = req.body.grade !== undefined ? (req.body.grade === '' || req.body.grade === null ? null : Number(req.body.grade)) : s.grade;
  if (!name) A.fail(400, 'Name is required.');
  if (grade !== null && !(grade >= 1 && grade <= 12)) A.fail(400, 'Grade must be 1 to 12.');
  let username = s.username;
  if (req.body.username !== undefined && A.normUsername(req.body.username) !== s.username) {
    username = A.normUsername(req.body.username);
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) A.fail(400, 'Username: 3–30 letters, numbers, dots or dashes.');
    if (await db.one('SELECT 1 FROM users WHERE username=$1', [username])) A.fail(409, 'That username is taken.');
  }
  const active = req.body.active !== undefined && req.user.role === 'admin' ? !!req.body.active : s.active;
  await db.q('UPDATE users SET name=$2, grade=$3, username=$4, active=$5 WHERE id=$1', [id, name, grade, username, active]);
  if (!active) await db.q('DELETE FROM sessions WHERE user_id=$1', [id]);
  A.audit(req, 'update_student', id, { name, grade, username, active });
  res.json({ ok: true });
});

r.delete('/:id', A.requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const s = await db.one(`DELETE FROM users WHERE id=$1 AND role='student' RETURNING name`, [id]);
  if (!s) A.fail(404, 'Student not found.');
  A.audit(req, 'delete_student', null, { id, name: s.name });
  res.json({ ok: true });
});

// ---------- PIN (tutor, admin, or the student's parent) ----------
r.post('/:id/pin', async (req, res) => {
  const id = Number(req.params.id);
  const isParent = req.user.role === 'parent' && await db.one(`SELECT 1 FROM student_links WHERE student_id=$1 AND adult_id=$2 AND relation='parent'`, [id, req.user.id]);
  if (!isParent) await A.assertManage(req.user, id);
  const pin = req.body.pin ? String(req.body.pin) : randomPin();
  const p = A.pinProblem(pin); if (p) A.fail(400, p);
  await db.q(`UPDATE users SET pin_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1 AND role='student'`, [id, await A.hashSecret(pin)]);
  await db.q('DELETE FROM sessions WHERE user_id=$1', [id]);
  A.audit(req, 'reset_pin', id);
  res.json({ ok: true, pin });
});

// ---------- tools for a student ----------
r.post('/:id/tools', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertManage(req.user, id);
  const tool = req.body.slug ? await toolBySlug(req.body.slug) : await db.one('SELECT * FROM tools WHERE id=$1', [Number(req.body.tool_id)]);
  if (!tool) A.fail(404, 'Tool not found.');
  await db.q(`INSERT INTO allocations(student_id, tool_id, settings, expires_at, assigned_by) VALUES ($1,$2,$3::jsonb,$4,$5)
              ON CONFLICT (student_id, tool_id) DO UPDATE SET status='active', expires_at=EXCLUDED.expires_at, assigned_by=EXCLUDED.assigned_by, updated_at=now()`,
    [id, tool.id, JSON.stringify(req.body.settings || {}), req.body.expires_at || null, req.user.id]);
  A.audit(req, 'assign_tool', id, { tool: tool.slug });
  res.json({ ok: true });
});

r.patch('/:id/tools/:toolId', async (req, res) => {
  const id = Number(req.params.id), toolId = Number(req.params.toolId);
  await A.assertManage(req.user, id);
  const a = await db.one('SELECT * FROM allocations WHERE student_id=$1 AND tool_id=$2', [id, toolId]);
  if (!a) A.fail(404, 'This tool is not assigned to this student.');
  const status = ['active', 'revoked'].includes(req.body.status) ? req.body.status : a.status;
  const settings = req.body.settings && typeof req.body.settings === 'object'
    ? { ...req.body.settings, _updated: new Date().toISOString(), _by: req.user.name } : a.settings;
  const expires = req.body.expires_at !== undefined ? (req.body.expires_at || null) : a.expires_at;
  await db.q('UPDATE allocations SET status=$3, settings=$4::jsonb, expires_at=$5, updated_at=now() WHERE student_id=$1 AND tool_id=$2',
    [id, toolId, status, JSON.stringify(settings), expires]);
  A.audit(req, req.body.settings ? 'update_plan' : 'update_allocation', id, { tool_id: toolId, status });
  res.json({ ok: true });
});

// Wipe a student's saved progress in one tool (keeps attempt history unless asked)
r.delete('/:id/tools/:toolId/progress', async (req, res) => {
  const id = Number(req.params.id), toolId = Number(req.params.toolId);
  await A.assertManage(req.user, id);
  await db.q('DELETE FROM tool_state WHERE student_id=$1 AND tool_id=$2', [id, toolId]);
  if (req.query.history === '1') {
    await db.q('DELETE FROM attempts WHERE student_id=$1 AND tool_id=$2', [id, toolId]);
    await db.q('DELETE FROM activity WHERE student_id=$1 AND tool_id=$2', [id, toolId]);
    await db.q('DELETE FROM achievements WHERE student_id=$1 AND tool_id=$2', [id, toolId]);
  }
  A.audit(req, 'reset_progress', id, { tool_id: toolId, history: req.query.history === '1' });
  res.json({ ok: true });
});

// ---------- reports ----------
r.get('/:id/attempts', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertView(req.user, id);
  const params = [id]; let where = 'a.student_id=$1';
  if (req.query.tool) { params.push(req.query.tool); where += ` AND t.slug=$${params.length}`; }
  if (req.query.days) { params.push(String(Number(req.query.days) || 30)); where += ` AND a.created_at > now() - ($${params.length} || ' days')::interval`; }
  if (req.query.result === 'wrong') where += ' AND NOT a.correct';
  if (req.query.result === 'correct') where += ' AND a.correct';
  const limit = req.query.format === 'csv' ? 50000 : Math.min(Number(req.query.limit) || 300, req.query.tool ? 5000 : 2000);
  const rows = await db.many(`SELECT a.created_at, t.name AS tool, a.mode, a.topic, a.question, a.response, a.answer, a.correct, a.ms, a.session_key, a.meta
    FROM attempts a JOIN tools t ON t.id=a.tool_id WHERE ${where} ORDER BY a.created_at DESC LIMIT ${limit}`, params);
  if (req.query.format === 'csv') {
    const s = await db.one('SELECT name FROM users WHERE id=$1', [id]);
    res.setHeader('Content-Disposition', `attachment; filename="${(s ? s.name : 'student').replace(/[^\w-]+/g, '_')}_attempts.csv"`);
    return res.send(csv([['Date', 'Time', 'Tool', 'Mode', 'Topic', 'Question', 'Answer given', 'Correct answer', 'Result', 'Seconds', 'Session'],
      ...rows.map(x => [x.created_at.toISOString().slice(0, 10), x.created_at.toISOString().slice(11, 19), x.tool, x.mode, x.topic, x.question, x.response, x.answer,
        x.correct ? 'Correct' : 'Wrong', x.ms == null ? '' : (x.ms / 1000).toFixed(1), x.session_key])]), 'text/csv; charset=utf-8');
  }
  res.json({ attempts: rows });
});

// Summary for parents/tutors: per tool, plus questions most often missed
r.get('/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertView(req.user, id);
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  const d = String(days);
  const s = await db.one(`SELECT id, name, grade FROM users WHERE id=$1 AND role='student'`, [id]);
  if (!s) A.fail(404, 'Student not found.');
  const perTool = await db.many(`
    SELECT t.name, t.icon, t.slug,
      COALESCE((SELECT sum(seconds) FROM activity v WHERE v.student_id=$1 AND v.tool_id=t.id AND v.day > current_date - $2::int),0)::int AS seconds,
      count(a.*)::int AS attempts, round(100.0*avg(a.correct::int))::int AS accuracy, round(avg(a.ms))::int AS avg_ms,
      count(DISTINCT a.created_at::date)::int AS days_practiced
    FROM allocations al JOIN tools t ON t.id=al.tool_id
    LEFT JOIN attempts a ON a.student_id=al.student_id AND a.tool_id=al.tool_id AND a.created_at > now() - ($2 || ' days')::interval
    WHERE al.student_id=$1 GROUP BY t.id ORDER BY seconds DESC, t.name`, [id, d]);
  const missed = await db.many(`
    SELECT t.name AS tool, a.question, a.answer, count(*)::int AS wrong
      FROM attempts a JOIN tools t ON t.id=a.tool_id
     WHERE a.student_id=$1 AND NOT a.correct AND a.created_at > now() - ($2 || ' days')::interval
     GROUP BY t.name, a.question, a.answer ORDER BY wrong DESC, a.question LIMIT 12`, [id, d]);
  const totals = await db.one(`SELECT
      (SELECT COALESCE(sum(seconds),0) FROM activity WHERE student_id=$1 AND day > current_date - $2::int)::int AS seconds,
      (SELECT count(*) FROM (SELECT day FROM activity WHERE student_id=$1 AND day > current_date - $2::int
                              UNION SELECT created_at::date FROM attempts WHERE student_id=$1 AND created_at > now() - ($2 || ' days')::interval) d)::int AS active_days,
      (SELECT count(*) FROM attempts WHERE student_id=$1 AND created_at > now() - ($2 || ' days')::interval)::int AS attempts,
      (SELECT round(100.0*avg(correct::int)) FROM attempts WHERE student_id=$1 AND created_at > now() - ($2 || ' days')::interval)::int AS accuracy`, [id, d]);
  const badges = await db.many(`SELECT title, icon, created_at FROM achievements WHERE student_id=$1 AND created_at > now() - ($2 || ' days')::interval ORDER BY created_at DESC`, [id, d]);
  res.json({ student: s, days, totals, perTool, missed, badges });
});

// ---------- invites for this student (parent / tutor) ----------
r.post('/:id/invites', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertManage(req.user, id);
  const role = req.body.role === 'tutor' ? 'tutor' : 'parent';
  if (role === 'tutor' && req.user.role !== 'admin') A.fail(403, 'Only admins can invite tutors.');
  const inv = await db.tx(c => createInvite(c, req.user, { role, studentId: id, email: req.body.email || null, days: 14 }));
  A.audit(req, 'create_invite', id, { role, email: inv.email });
  res.json({ invite: inv });
});

r.delete('/:id/links/:adultId', async (req, res) => {
  const id = Number(req.params.id);
  await A.assertManage(req.user, id);
  const link = await db.one('SELECT relation FROM student_links WHERE student_id=$1 AND adult_id=$2', [id, Number(req.params.adultId)]);
  if (!link) A.fail(404, 'Link not found.');
  if (link.relation === 'tutor' && req.user.role !== 'admin') A.fail(403, 'Only admins can remove a tutor.');
  await db.q('DELETE FROM student_links WHERE student_id=$1 AND adult_id=$2', [id, Number(req.params.adultId)]);
  A.audit(req, 'unlink_adult', id, { adult_id: Number(req.params.adultId) });
  res.json({ ok: true });
});

module.exports = { router: r, createStudent, createInvite };
