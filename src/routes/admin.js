// Admin-only endpoints: overview, users, bulk students, links, tools catalog & uploads,
// bulk tool assignment, invites, audit log, exports.
const { Router } = require('../http');
const db = require('../db');
const config = require('../config');
const A = require('../auth');
const { scanFolderTools, cleanMeta, SLUG_RE } = require('../tools');
const { createStudent, createInvite } = require('./students');
const { csv } = require('../util');

const r = new Router();
r.use(A.requireRole('admin'));

// ---------- overview ----------
r.get('/overview', async (req, res) => {
  const counts = await db.many(`SELECT role, count(*)::int AS n, count(*) FILTER (WHERE active)::int AS active FROM users GROUP BY role`);
  const week = await db.one(`SELECT
      (SELECT count(*) FROM (SELECT student_id FROM activity WHERE day > current_date - 7
                              UNION SELECT student_id FROM attempts WHERE created_at > now() - interval '7 days') s)::int AS active_students,
      (SELECT COALESCE(sum(seconds),0) FROM activity WHERE day > current_date - 7)::int AS seconds,
      (SELECT count(*) FROM attempts WHERE created_at > now() - interval '7 days')::int AS attempts,
      (SELECT round(100.0*avg(correct::int)) FROM attempts WHERE created_at > now() - interval '7 days')::int AS accuracy,
      (SELECT count(*) FROM users s WHERE s.role='student' AND s.active AND NOT EXISTS
          (SELECT 1 FROM activity v WHERE v.student_id=s.id AND v.day > current_date - 7)
          AND NOT EXISTS (SELECT 1 FROM attempts t WHERE t.student_id=s.id AND t.created_at > now() - interval '7 days'))::int AS inactive_students,
      (SELECT count(*) FROM users s WHERE s.role='student' AND NOT EXISTS
          (SELECT 1 FROM student_links l WHERE l.student_id=s.id AND l.relation='tutor'))::int AS students_without_tutor,
      (SELECT count(*) FROM users s WHERE s.role='student' AND NOT EXISTS
          (SELECT 1 FROM student_links l WHERE l.student_id=s.id AND l.relation='parent'))::int AS students_without_parent,
      (SELECT count(*) FROM tools WHERE active)::int AS active_tools,
      (SELECT count(*) FROM (SELECT 1 FROM users GROUP BY role = 'student', lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) HAVING count(*) > 1) d)::int AS duplicate_names`);
  const topTools = await db.many(`SELECT t.name, t.icon, COALESCE(sum(v.seconds),0)::int AS seconds, count(DISTINCT v.student_id)::int AS students
      FROM tools t LEFT JOIN activity v ON v.tool_id=t.id AND v.day > current_date - 7
     GROUP BY t.id ORDER BY seconds DESC, t.name LIMIT 8`);
  const daily = await db.many(`SELECT to_char(d,'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM (SELECT student_id FROM activity WHERE day=d::date
                              UNION SELECT student_id FROM attempts WHERE created_at::date=d::date) s)::int AS students,
      (SELECT COALESCE(sum(seconds),0) FROM activity WHERE day=d::date)::int AS seconds
     FROM generate_series(current_date - 13, current_date, interval '1 day') d ORDER BY d`);
  res.json({ counts, week, topTools, daily });
});

// ---------- users (adults) ----------
r.get('/users', async (req, res) => {
  const params = []; let where = `role <> 'student'`;
  if (req.query.role) { params.push(req.query.role); where += ` AND role=$${params.length}`; }
  if (req.query.q) { params.push(`%${req.query.q}%`); where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
  const users = await db.many(`SELECT u.id, u.role, u.name, u.email, u.email_verified, u.active, u.created_at, u.last_login_at,
      (SELECT count(*)::int FROM student_links l WHERE l.adult_id=u.id) AS students
    FROM users u WHERE ${where} ORDER BY role, name LIMIT 2000`, params);
  res.json({ users });
});

r.post('/users', async (req, res) => {
  const role = ['admin', 'tutor', 'parent'].includes(req.body.role) ? req.body.role : A.fail(400, 'Role must be admin, tutor or parent.');
  const name = String(req.body.name || '').trim(); if (!name) A.fail(400, 'Name is required.');
  const email = A.normEmail(req.body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) A.fail(400, 'A valid email is required.');
  if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) A.fail(409, 'An account with this email already exists.');
  const temp = req.body.password || `Am${A.token(6)}9`;
  const p = A.passwordProblem(temp); if (p) A.fail(400, p);
  const u = await db.one(`INSERT INTO users(role,name,email,password_hash,email_verified,created_by) VALUES ($1,$2,$3,$4,true,$5) RETURNING id, role, name, email`,
    [role, name, email, await A.hashSecret(temp), req.user.id]);
  A.audit(req, 'create_user', null, { id: u.id, role, email });
  res.json({ user: u, password: temp });
});

r.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.one(`SELECT * FROM users WHERE id=$1 AND role <> 'student'`, [id]);
  if (!u) A.fail(404, 'User not found.');
  const b = req.body;
  const role = b.role !== undefined ? b.role : u.role;
  if (!['admin', 'tutor', 'parent'].includes(role)) A.fail(400, 'Invalid role.');
  if (id === req.user.id && (role !== 'admin' || b.active === false)) A.fail(400, 'You cannot remove your own admin access.');
  const email = b.email !== undefined ? A.normEmail(b.email) : u.email;
  if (email !== u.email && await db.one('SELECT 1 FROM users WHERE email=$1', [email])) A.fail(409, 'Email already in use.');
  let hash = u.password_hash;
  if (b.password) { const p = A.passwordProblem(b.password); if (p) A.fail(400, p); hash = await A.hashSecret(b.password); }
  const active = b.active !== undefined ? !!b.active : u.active;
  await db.q(`UPDATE users SET name=$2, email=$3, role=$4, active=$5, email_verified=$6, password_hash=$7, failed_logins=0, locked_until=NULL WHERE id=$1`,
    [id, b.name !== undefined ? String(b.name).trim() || u.name : u.name, email, role, active, b.email_verified !== undefined ? !!b.email_verified : u.email_verified, hash]);
  if (!active || b.password) await db.q('DELETE FROM sessions WHERE user_id=$1', [id]);
  // Someone who stops being a tutor loses their tutor links.
  if (u.role === 'tutor' && role !== 'tutor') await db.q(`DELETE FROM student_links WHERE adult_id=$1 AND relation='tutor'`, [id]);
  A.audit(req, 'update_user', null, { id, role, active, password_changed: !!b.password });
  res.json({ ok: true });
});

r.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) A.fail(400, 'You cannot delete yourself.');
  const u = await db.one(`DELETE FROM users WHERE id=$1 AND role <> 'student' RETURNING email`, [id]);
  if (!u) A.fail(404, 'User not found.');
  A.audit(req, 'delete_user', null, { id, email: u.email });
  res.json({ ok: true });
});

// ---------- duplicate names ----------
// Groups students, and adult accounts, that share the same name (ignoring case and extra spaces).
r.get('/duplicates', async (req, res) => {
  const norm = col => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
  const students = await db.many(`
    SELECT s.id, s.name, s.username, s.grade, s.active, s.created_at, s.last_login_at, ${norm('s.name')} AS key,
      (SELECT count(*)::int FROM allocations a WHERE a.student_id=s.id AND a.status='active') AS tools,
      (SELECT count(*)::int FROM attempts t WHERE t.student_id=s.id) AS attempts,
      (SELECT max(created_at) FROM attempts t WHERE t.student_id=s.id) AS last_answer,
      (SELECT string_agg(a.name, ', ' ORDER BY a.name) FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=s.id AND l.relation='tutor') AS tutors,
      (SELECT string_agg(a.name, ', ' ORDER BY a.name) FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=s.id AND l.relation='parent') AS parents
    FROM users s
    WHERE s.role='student' AND ${norm('s.name')} IN (SELECT ${norm('name')} FROM users WHERE role='student' GROUP BY 1 HAVING count(*) > 1)
    ORDER BY key, s.created_at`);
  const adults = await db.many(`
    SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at, ${norm('u.name')} AS key,
      (SELECT count(*)::int FROM student_links l WHERE l.adult_id=u.id) AS students,
      (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM student_links l JOIN users s ON s.id=l.student_id WHERE l.adult_id=u.id) AS student_names
    FROM users u
    WHERE u.role <> 'student' AND ${norm('u.name')} IN (SELECT ${norm('name')} FROM users WHERE role <> 'student' GROUP BY 1 HAVING count(*) > 1)
    ORDER BY key, u.role, u.created_at`);
  res.json({ students, adults });
});

r.post('/delete-many', async (req, res) => {
  const sids = [...new Set((req.body.students || []).map(Number).filter(Number.isInteger))];
  const uids = [...new Set((req.body.users || []).map(Number).filter(Number.isInteger))];
  if (uids.includes(req.user.id)) A.fail(400, 'You cannot delete your own account.');
  if (!sids.length && !uids.length) A.fail(400, 'Choose at least one account.');
  const out = await db.tx(async c => {
    const s = (await c.query(`DELETE FROM users WHERE role='student' AND id = ANY($1::int[]) RETURNING id, name`, [sids])).rows;
    const u = (await c.query(`DELETE FROM users WHERE role <> 'student' AND id = ANY($1::int[]) RETURNING id, name, email`, [uids])).rows;
    return { s, u };
  });
  out.s.forEach(x => A.audit(req, 'delete_student', null, { id: x.id, name: x.name, reason: 'duplicate' }));
  out.u.forEach(x => A.audit(req, 'delete_user', null, { id: x.id, email: x.email, reason: 'duplicate' }));
  res.json({ students: out.s.length, users: out.u.length });
});

// ---------- links ----------
r.post('/links', async (req, res) => {
  const studentId = Number(req.body.student_id), adultId = Number(req.body.adult_id);
  const s = await db.one(`SELECT 1 FROM users WHERE id=$1 AND role='student'`, [studentId]);
  const a = await db.one(`SELECT role FROM users WHERE id=$1 AND role IN ('tutor','parent')`, [adultId]);
  if (!s || !a) A.fail(404, 'Student or adult not found.');
  const relation = req.body.relation === 'tutor' || (!req.body.relation && a.role === 'tutor') ? 'tutor' : 'parent';
  if (relation === 'tutor' && a.role !== 'tutor') A.fail(400, 'Only tutor accounts can be linked as tutor.');
  await db.q(`INSERT INTO student_links(student_id, adult_id, relation, consent_at, created_by) VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (student_id, adult_id) DO UPDATE SET relation=EXCLUDED.relation`,
    [studentId, adultId, relation, relation === 'parent' && req.body.consent ? new Date() : null, req.user.id]);
  A.audit(req, 'link_adult', studentId, { adult_id: adultId, relation });
  res.json({ ok: true });
});

// ---------- students: bulk import ----------
// rows: [{name, grade, username?, pin?, tutor_email?, parent_email?}]
r.post('/students/bulk', async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 1000) : [];
  if (!rows.length) A.fail(400, 'No rows to import.');
  const results = [];
  for (const [i, row] of rows.entries()) {
    try {
      const out = await db.tx(async c => {
        const s = await createStudent(c, req.user, row);
        if (row.tutor_email) {
          const t = (await c.query(`SELECT id FROM users WHERE email=$1 AND role='tutor'`, [A.normEmail(row.tutor_email)])).rows[0];
          if (!t) A.fail(400, `No tutor with email ${row.tutor_email}`);
          await c.query(`INSERT INTO student_links(student_id, adult_id, relation, created_by) VALUES ($1,$2,'tutor',$3)`, [s.id, t.id, req.user.id]);
        }
        let invite = null;
        if (row.parent_email) invite = (await createInvite(c, req.user, { role: 'parent', studentId: s.id, email: row.parent_email, days: 30 })).code;
        if (Array.isArray(req.body.tool_ids)) {
          for (const tid of req.body.tool_ids) {
            await c.query(`INSERT INTO allocations(student_id, tool_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [s.id, Number(tid), req.user.id]);
          }
        }
        return { ...s, parent_invite: invite };
      });
      results.push({ row: i + 1, ok: true, ...out });
    } catch (e) {
      results.push({ row: i + 1, ok: false, name: row.name, error: e.message });
    }
  }
  A.audit(req, 'bulk_import_students', null, { rows: rows.length, ok: results.filter(x => x.ok).length });
  res.json({ results });
});

// ---------- tools ----------
r.get('/tools', async (req, res) => {
  const tools = await db.many(`SELECT t.*,
      (SELECT count(*)::int FROM allocations a WHERE a.tool_id=t.id AND a.status='active') AS assigned,
      (SELECT COALESCE(sum(seconds),0)::int FROM activity v WHERE v.tool_id=t.id AND v.day > current_date - 30) AS seconds_30d,
      (SELECT COALESCE(sum(length(content)),0)::int FROM tool_files f WHERE f.tool_id=t.id) AS upload_bytes
    FROM tools t ORDER BY t.subject, t.grade_min, t.name`);
  res.json({ tools });
});

r.patch('/tools/:id', async (req, res) => {
  const t = await db.one('SELECT * FROM tools WHERE id=$1', [Number(req.params.id)]);
  if (!t) A.fail(404, 'Tool not found.');
  const m = cleanMeta({ ...t, ...req.body, settings: req.body.settings_schema || t.settings_schema }, t.slug);
  const active = req.body.active !== undefined ? !!req.body.active : t.active;
  await db.q(`UPDATE tools SET name=$2, subject=$3, grade_min=$4, grade_max=$5, description=$6, icon=$7, active=$8, settings_schema=$9, updated_at=now() WHERE id=$1`,
    [t.id, m.name, m.subject, m.grade_min, m.grade_max, m.description, m.icon, active, m.settings_schema]);
  A.audit(req, 'update_tool', null, { slug: t.slug, active });
  res.json({ ok: true });
});

// Upload or replace a single-file HTML tool (stored in the database).
// body: { slug, name, subject, grade_min, grade_max, description, icon, version, html, settings_schema? }
r.post('/tools/upload', async (req, res) => {
  const slug = String(req.body.slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) A.fail(400, 'Short name (slug): 2–49 lowercase letters, numbers or dashes, e.g. "fractions-lab".');
  const html = String(req.body.html || '');
  if (!/<html|<body|<script|<div/i.test(html)) A.fail(400, 'That does not look like an HTML tool.');
  if (Buffer.byteLength(html) > config.maxUploadBytes) A.fail(413, 'The file is larger than 8 MB.');
  let schema = req.body.settings_schema;
  if (typeof schema === 'string' && schema.trim()) { try { schema = JSON.parse(schema); } catch { A.fail(400, 'Plan settings must be valid JSON.'); } }
  const m = cleanMeta({ ...req.body, settings: Array.isArray(schema) ? schema : [] }, slug);
  const existing = await db.one('SELECT * FROM tools WHERE slug=$1', [slug]);
  if (existing && existing.source === 'folder') A.fail(409, 'A built-in tool already uses this short name.');
  const tool = await db.tx(async c => {
    const t = existing
      ? (await c.query(`UPDATE tools SET name=$2, subject=$3, grade_min=$4, grade_max=$5, description=$6, icon=$7, version=$8, settings_schema=$9, updated_at=now() WHERE id=$1 RETURNING *`,
        [existing.id, m.name, m.subject, m.grade_min, m.grade_max, m.description, m.icon, req.body.version ? m.version : bump(existing.version), m.settings_schema])).rows[0]
      : (await c.query(`INSERT INTO tools(slug,name,subject,grade_min,grade_max,description,icon,version,settings_schema,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'upload') RETURNING *`,
        [slug, m.name, m.subject, m.grade_min, m.grade_max, m.description, m.icon, m.version, m.settings_schema])).rows[0];
    await c.query(`INSERT INTO tool_files(tool_id, path, mime, content) VALUES ($1,'index.html','text/html; charset=utf-8',$2)
                   ON CONFLICT (tool_id, path) DO UPDATE SET content=EXCLUDED.content, updated_at=now()`, [t.id, Buffer.from(html, 'utf8')]);
    return t;
  });
  A.audit(req, existing ? 'replace_tool' : 'upload_tool', null, { slug });
  res.json({ tool });
});
function bump(v) { const p = String(v).split('.').map(n => parseInt(n, 10) || 0); while (p.length < 3) p.push(0); p[2]++; return p.join('.'); }

r.get('/tools/:id/download', async (req, res) => {
  const f = await db.one(`SELECT t.slug, f.content FROM tools t JOIN tool_files f ON f.tool_id=t.id AND f.path='index.html' WHERE t.id=$1`, [Number(req.params.id)]);
  if (!f) A.fail(404, 'Only uploaded tools can be downloaded here; built-in tools are in the tools/ folder.');
  res.setHeader('Content-Disposition', `attachment; filename="${f.slug}.html"`);
  res.send(f.content, 'text/html; charset=utf-8');
});

r.delete('/tools/:id', async (req, res) => {
  const t = await db.one('SELECT * FROM tools WHERE id=$1', [Number(req.params.id)]);
  if (!t) A.fail(404, 'Tool not found.');
  if (t.source === 'folder') A.fail(400, 'Built-in tools come from the tools/ folder. Turn it off instead, or delete the folder and redeploy.');
  if (req.query.confirm !== t.slug) A.fail(400, 'Confirm by sending the tool’s short name.');
  await db.q('DELETE FROM tools WHERE id=$1', [t.id]);
  A.audit(req, 'delete_tool', null, { slug: t.slug });
  res.json({ ok: true });
});

r.post('/tools/rescan', async (req, res) => {
  const found = await scanFolderTools();
  res.json({ ok: true, found });
});

// ---------- bulk assignment ----------
// body: { tool_id, student_ids?: [], grade?: n, all?: true, action: 'assign'|'revoke', expires_at? }
r.post('/allocations/bulk', async (req, res) => {
  const tool = await db.one('SELECT * FROM tools WHERE id=$1', [Number(req.body.tool_id)]);
  if (!tool) A.fail(404, 'Tool not found.');
  let ids = Array.isArray(req.body.student_ids) ? req.body.student_ids.map(Number).filter(Boolean) : [];
  if (req.body.grade) ids = (await db.many(`SELECT id FROM users WHERE role='student' AND active AND grade=$1`, [Number(req.body.grade)])).map(r => r.id);
  if (req.body.all) ids = (await db.many(`SELECT id FROM users WHERE role='student' AND active`)).map(r => r.id);
  if (!ids.length) A.fail(400, 'No students selected.');
  let n = 0;
  if (req.body.action === 'revoke') {
    n = (await db.q(`UPDATE allocations SET status='revoked', updated_at=now() WHERE tool_id=$1 AND student_id = ANY($2::int[])`, [tool.id, ids])).rowCount;
  } else {
    n = (await db.q(`INSERT INTO allocations(student_id, tool_id, expires_at, assigned_by)
        SELECT s.id, $1, $3, $4 FROM users s WHERE s.id = ANY($2::int[]) AND s.role='student'
        ON CONFLICT (student_id, tool_id) DO UPDATE SET status='active', expires_at=EXCLUDED.expires_at, updated_at=now()`,
      [tool.id, ids, req.body.expires_at || null, req.user.id])).rowCount;
  }
  A.audit(req, req.body.action === 'revoke' ? 'bulk_revoke' : 'bulk_assign', null, { tool: tool.slug, students: ids.length });
  res.json({ ok: true, changed: n });
});

// ---------- invites ----------
r.get('/invites', async (req, res) => {
  const invites = await db.many(`SELECT i.*, s.name AS student_name, u.name AS used_by_name, c.name AS created_by_name
      FROM invites i LEFT JOIN users s ON s.id=i.student_id LEFT JOIN users u ON u.id=i.used_by LEFT JOIN users c ON c.id=i.created_by
     ORDER BY i.created_at DESC LIMIT 500`);
  res.json({ invites });
});
r.post('/invites', async (req, res) => {
  const role = ['tutor', 'admin', 'parent'].includes(req.body.role) ? req.body.role : 'tutor';
  const inv = await db.tx(c => createInvite(c, req.user, { role, studentId: req.body.student_id ? Number(req.body.student_id) : null, email: req.body.email || null, days: Number(req.body.days) || 14 }));
  A.audit(req, 'create_invite', inv.student_id, { role, email: inv.email });
  res.json({ invite: inv });
});
r.delete('/invites/:id', async (req, res) => {
  await db.q('DELETE FROM invites WHERE id=$1 AND used_at IS NULL', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- audit ----------
r.get('/audit', async (req, res) => {
  const params = []; let where = 'true';
  if (req.query.action) { params.push(req.query.action); where += ` AND l.action=$${params.length}`; }
  if (req.query.student_id) { params.push(Number(req.query.student_id)); where += ` AND l.student_id=$${params.length}`; }
  const rows = await db.many(`SELECT l.id, l.created_at, l.action, l.detail, l.ip, a.name AS actor, a.role AS actor_role, s.name AS student
      FROM audit_log l LEFT JOIN users a ON a.id=l.actor_id LEFT JOIN users s ON s.id=l.student_id
     WHERE ${where} ORDER BY l.created_at DESC LIMIT ${Math.min(Number(req.query.limit) || 300, 2000)}`, params);
  res.json({ log: rows });
});

// ---------- exports ----------
r.get('/export/students.csv', async (req, res) => {
  const rows = await db.many(`SELECT s.id, s.name, s.username, s.grade, s.active, s.created_at, s.last_login_at,
      (SELECT string_agg(a.name || ' <' || a.email || '>', '; ') FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=s.id AND l.relation='tutor') AS tutors,
      (SELECT string_agg(a.name || ' <' || a.email || '>', '; ') FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=s.id AND l.relation='parent') AS parents,
      (SELECT string_agg(t.name, '; ') FROM allocations x JOIN tools t ON t.id=x.tool_id WHERE x.student_id=s.id AND x.status='active') AS tools,
      (SELECT COALESCE(sum(seconds),0) FROM activity v WHERE v.student_id=s.id)::int AS seconds
    FROM users s WHERE s.role='student' ORDER BY s.grade, s.name`);
  res.setHeader('Content-Disposition', 'attachment; filename="amtutortools_students.csv"');
  res.send(csv([['ID', 'Name', 'Username', 'Grade', 'Active', 'Created', 'Last sign-in', 'Tutors', 'Parents', 'Tools', 'Minutes total'],
    ...rows.map(r => [r.id, r.name, r.username, r.grade, r.active ? 'yes' : 'no', r.created_at, r.last_login_at, r.tutors, r.parents, r.tools, Math.round(r.seconds / 60)])]), 'text/csv; charset=utf-8');
});
r.get('/export/attempts.csv', async (req, res) => {
  const days = String(Math.min(Number(req.query.days) || 30, 3650));
  const rows = await db.many(`SELECT a.created_at, s.name AS student, s.grade, t.name AS tool, a.mode, a.topic, a.question, a.response, a.answer, a.correct, a.ms
      FROM attempts a JOIN users s ON s.id=a.student_id JOIN tools t ON t.id=a.tool_id
     WHERE a.created_at > now() - ($1 || ' days')::interval ORDER BY a.created_at DESC LIMIT 500000`, [days]);
  res.setHeader('Content-Disposition', `attachment; filename="amtutortools_attempts_${days}d.csv"`);
  res.send(csv([['Date/time (UTC)', 'Student', 'Grade', 'Tool', 'Mode', 'Topic', 'Question', 'Answer given', 'Correct answer', 'Result', 'Seconds'],
    ...rows.map(r => [r.created_at, r.student, r.grade, r.tool, r.mode, r.topic, r.question, r.response, r.answer, r.correct ? 'Correct' : 'Wrong', r.ms == null ? '' : (r.ms / 1000).toFixed(1)])]), 'text/csv; charset=utf-8');
});

module.exports = r;
