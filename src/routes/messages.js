// Messages: one conversation per student, shared by the student, their parents, their tutors and admins.
// Anyone in the conversation can write and attach files (homework sheets, slides, PDFs, photos).
// Tutors and admins can post homework with a due date; adults can post notes the student can't see.
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');
const config = require('../config');
const { sendMail, mailEnabled } = require('../mailer');

const r = new Router();
r.use(A.requireLogin);

const MAX_FILE = Number(process.env.MESSAGE_FILE_MB || 15) * 1024 * 1024;
const MAX_TOTAL = Number(process.env.MESSAGE_STORAGE_MB || 500) * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;

// Allowed attachments: extension -> media type. Web pages, scripts and SVG are not allowed.
const TYPES = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text', odp: 'application/vnd.oasis.opendocument.presentation', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
  csv: 'text/csv', txt: 'text/plain', rtf: 'application/rtf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
  zip: 'application/zip', ggb: 'application/vnd.geogebra.file',
};
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'video/mp4']);

const isAdult = u => u.role !== 'student';
async function assertInThread(user, sid) {
  if (!(await A.canViewStudent(user, sid))) A.fail(403, 'You are not part of this conversation.');
}
// Students the user can talk about (admins: everyone)
function scope(user, alias = 's', param = '$1') {
  if (user.role === 'admin') return `${alias}.role='student'`;
  if (user.role === 'student') return `${alias}.role='student' AND ${alias}.id=${param}`;
  return `${alias}.role='student' AND EXISTS (SELECT 1 FROM student_links l WHERE l.student_id=${alias}.id AND l.adult_id=${param})`;
}

// ---------------------------------------------------------------- conversations
// A student has a general conversation (key 0: student, parents, all their tutors, admins) and one
// private conversation per tutor (key = tutor's id: student, parents, that tutor, admins).
// A tutor sees only the general conversation and their own — never another tutor's.
const keyCond = (u, alias, p) => (u.role === 'tutor' ? ` AND ${alias}.tutor_key IN (0, $${p})` : '');
const canSeeKey = (u, key) => u.role !== 'tutor' || key === 0 || key === u.id;

// The conversations of one student that this user can open, with names, unread counts and last activity.
async function threadKeys(u, sid) {
  const tutors = await db.many(`SELECT a.id, a.name, a.subject FROM student_links l JOIN users a ON a.id=l.adult_id
                                 WHERE l.student_id=$1 AND l.relation='tutor' ORDER BY a.name`, [sid]);
  const used = await db.many(`SELECT DISTINCT m.tutor_key AS k, u.name, u.subject FROM messages m LEFT JOIN users u ON u.id=m.tutor_key
                               WHERE m.student_id=$1 AND m.tutor_key<>0`, [sid]);
  let list = [{ key: 0, name: 'General', subject: null, linked: true }];
  for (const t of tutors) list.push({ key: t.id, name: t.name, subject: t.subject, linked: true });
  for (const x of used) if (!list.some(l => l.key === x.k)) list.push({ key: x.k, name: x.name || 'Former tutor', subject: x.subject, linked: false });
  list = list.filter(l => canSeeKey(u, l.key));
  if (u.role === 'tutor') list.sort((a, b) => (b.key === u.id) - (a.key === u.id)); // their own first
  const stats = await db.many(`SELECT m.tutor_key AS k, max(m.created_at) AS last_at,
        count(*) FILTER (WHERE m.id > COALESCE(r.last_read_id,0) AND m.sender_id IS DISTINCT FROM $2)::int AS unread
      FROM messages m LEFT JOIN thread_reads r ON r.student_id=m.student_id AND r.tutor_key=m.tutor_key AND r.user_id=$2
     WHERE m.student_id=$1 AND m.deleted_at IS NULL AND (NOT m.adults_only OR $3) GROUP BY m.tutor_key`, [sid, u.id, isAdult(u)]);
  for (const l of list) { const st = stats.find(x => x.k === l.key); l.unread = st ? st.unread : 0; l.last_at = st ? st.last_at : null; }
  return list;
}

// ---------------------------------------------------------------- list and counts
r.get('/threads', async (req, res) => {
  const u = req.user, adult = isAdult(u);
  const kc = keyCond(u, 'm', 1);
  const rows = await db.many(`
    SELECT s.id, s.name, s.grade,
      lm.id AS last_id, lm.body AS last_body, lm.kind AS last_kind, lm.sender_name AS last_sender, lm.created_at AS last_at, lm.files AS last_files,
      EXISTS (SELECT 1 FROM thread_reads r WHERE r.student_id=s.id AND r.user_id=$1) AS following,
      (SELECT count(*) FROM messages m LEFT JOIN thread_reads r ON r.student_id=m.student_id AND r.tutor_key=m.tutor_key AND r.user_id=$1
        WHERE m.student_id=s.id AND m.deleted_at IS NULL AND m.id > COALESCE(r.last_read_id,0) AND m.sender_id IS DISTINCT FROM $1
          AND (NOT m.adults_only OR $2)${kc}${u.role === 'admin' ? ' AND r.user_id IS NOT NULL' : ''})::int AS unread,
      (SELECT count(*) FROM messages m WHERE m.student_id=s.id AND m.kind='homework' AND m.done_at IS NULL AND m.deleted_at IS NULL${kc})::int AS open_homework
    FROM users s
    LEFT JOIN LATERAL (SELECT m.id, left(m.body, 140) AS body, m.kind, m.sender_name, m.created_at,
                              (SELECT count(*) FROM message_files f WHERE f.message_id=m.id)::int AS files
                         FROM messages m WHERE m.student_id=s.id AND m.deleted_at IS NULL AND (NOT m.adults_only OR $2)${kc}
                        ORDER BY m.id DESC LIMIT 1) lm ON true
    WHERE ${scope(u)}
    ORDER BY lm.created_at DESC NULLS LAST, s.name LIMIT 2000`, [u.id, adult]);
  res.json({ threads: rows, mailEnabled: mailEnabled() });
});

// Unread total for the menu badge. Admins only count conversations they have opened before.
r.get('/unread', async (req, res) => {
  const u = req.user;
  const row = await db.one(`
    SELECT count(*)::int AS n FROM messages m
      ${u.role === 'admin' ? 'JOIN' : 'LEFT JOIN'} thread_reads r ON r.student_id=m.student_id AND r.tutor_key=m.tutor_key AND r.user_id=$1
      JOIN users s ON s.id=m.student_id
     WHERE m.deleted_at IS NULL AND m.id > COALESCE(r.last_read_id,0) AND m.sender_id IS DISTINCT FROM $1
       AND (NOT m.adults_only OR $2)${keyCond(u, 'm', 1)} AND ${scope(u)}`, [u.id, isAdult(u)]);
  const hw = u.role === 'student' ? await db.one(`SELECT count(*)::int AS n FROM messages WHERE student_id=$1 AND kind='homework' AND done_at IS NULL AND deleted_at IS NULL`, [u.id]) : null;
  res.json({ unread: row.n, homework: hw ? hw.n : 0 });
});

// ---------------------------------------------------------------- one conversation
const MSG_COLS = `m.id, m.student_id, m.tutor_key, m.sender_id, m.sender_name, m.sender_role, m.body, m.kind, to_char(m.due_date,'YYYY-MM-DD') AS due_date,
  m.adults_only, m.done_at, m.created_at, m.deleted_at,
  COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size) ORDER BY f.id)
              FROM message_files mf JOIN files f ON f.id=mf.file_id WHERE mf.message_id=m.id), '[]') AS files`;

r.get('/threads/:sid', async (req, res) => {
  const sid = Number(req.params.sid), u = req.user;
  await assertInThread(u, sid);
  const s = await db.one(`SELECT id, name, grade FROM users WHERE id=$1 AND role='student'`, [sid]);
  if (!s) A.fail(404, 'Student not found.');
  const keys = await threadKeys(u, sid);
  let key = req.query.key !== undefined && req.query.key !== '' ? Number(req.query.key) : null;
  if (key !== null && !keys.some(k => k.key === key)) A.fail(403, 'You are not part of this conversation.');
  if (key === null) key = u.role === 'tutor' ? u.id : (keys.filter(k => k.last_at).sort((a, b) => new Date(b.last_at) - new Date(a.last_at))[0] || keys[0]).key;
  const after = Number(req.query.after) || 0;
  const msgs = await db.many(`SELECT * FROM (SELECT ${MSG_COLS} FROM messages m
      WHERE m.student_id=$1 AND m.tutor_key=$4 AND m.id > $2 AND (NOT m.adults_only OR $3) ORDER BY m.id DESC LIMIT 300) x ORDER BY id`, [sid, after, isAdult(u), key]);
  msgs.forEach(m => { if (m.deleted_at) { m.body = ''; m.files = []; } });
  const maxId = msgs.length ? msgs[msgs.length - 1].id : 0;
  await db.q(`INSERT INTO thread_reads(student_id, tutor_key, user_id, last_read_id) VALUES ($1,$2,$3,$4)
              ON CONFLICT (student_id, tutor_key, user_id) DO UPDATE SET last_read_id=GREATEST(thread_reads.last_read_id, EXCLUDED.last_read_id)`, [sid, key, u.id, maxId]);
  const th = keys.find(k => k.key === key); if (th) th.unread = 0;
  // who is in this conversation: parents always; all tutors in General, only that tutor in a tutor's conversation
  const people = (await db.many(`SELECT a.id, a.name, a.subject, a.role, l.relation FROM student_links l JOIN users a ON a.id=l.adult_id WHERE l.student_id=$1 AND a.active ORDER BY l.relation DESC, a.name`, [sid]))
    .filter(p => p.relation === 'parent' || key === 0 || p.id === key);
  if (!after && u.role !== 'student') A.audit(req, 'view_messages', sid, { key });
  const canWrite = !!th && (key === 0 || th.linked);
  const canHomework = canWrite && (u.role === 'admin' || (u.role === 'tutor' && await A.canManageStudent(u, sid)));
  res.json({ student: s, key, threads: keys, messages: msgs, people, canWrite, canHomework, canAdultsOnly: isAdult(u) });
});

// ---------------------------------------------------------------- send
const lastMailed = new Map(); // "userId:studentId:key" -> time, so people get at most one email per conversation per 30 min
r.post('/threads/:sid', async (req, res) => {
  const sid = Number(req.params.sid), u = req.user, b = req.body;
  await assertInThread(u, sid);
  const key = Number(b.key) || 0;
  const isLinkedTutor = async (st, k) => !!(await db.one(`SELECT 1 FROM student_links WHERE student_id=$1 AND adult_id=$2 AND relation='tutor'`, [st, k]));
  if (!canSeeKey(u, key)) A.fail(403, 'You are not part of this conversation.');
  if (key && !(await isLinkedTutor(sid, key))) A.fail(400, 'That tutor is no longer linked to this student.');
  const body = String(b.body || '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
  const fileIds = [...new Set((Array.isArray(b.files) ? b.files : []).map(Number).filter(Number.isInteger))].slice(0, MAX_FILES_PER_MESSAGE);
  if (!body && !fileIds.length) A.fail(400, 'Write a message or attach a file.');
  const kind = b.kind === 'homework' ? 'homework' : 'message';
  if (kind === 'homework' && !['admin', 'tutor'].includes(u.role)) A.fail(403, 'Only tutors and admins can set homework.');
  const due = kind === 'homework' && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null;
  const adultsOnly = !!b.adults_only && isAdult(u);
  if (adultsOnly && kind === 'homework') A.fail(400, 'Homework has to be visible to the student.');
  if (fileIds.length) {
    const own = await db.many(`SELECT id FROM files WHERE id = ANY($1::int[]) AND owner_id=$2`, [fileIds, u.id]);
    if (own.length !== fileIds.length) A.fail(403, 'You can only attach files you uploaded.');
  }
  // the same message can go to several students (e.g. one homework sheet for a whole group), in the same kind of conversation
  const targets = [sid];
  for (const x of (Array.isArray(b.also) ? b.also : []).map(Number)) {
    if (targets.includes(x) || targets.length >= 200) continue;
    await assertInThread(u, x);
    if (key && !(await isLinkedTutor(x, key))) { const st = await db.one('SELECT name FROM users WHERE id=$1', [x]); A.fail(400, `${st ? st.name : 'A student'} doesn’t have this tutor.`); }
    targets.push(x);
  }
  if (targets.length > 1 && !['admin', 'tutor'].includes(u.role)) A.fail(403, 'Only tutors and admins can send to several students.');
  if (kind === 'homework') for (const t of targets) if (u.role !== 'admin' && !(await A.canManageStudent(u, t))) A.fail(403, 'You can only set homework for your own students.');
  const created = await db.tx(async c => {
    const out = [];
    for (const t of targets) {
      const m = (await c.query(`INSERT INTO messages(student_id, tutor_key, sender_id, sender_name, sender_role, body, kind, due_date, adults_only)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [t, key, u.id, u.name, u.role, body, kind, due, adultsOnly])).rows[0];
      for (const f of fileIds) await c.query('INSERT INTO message_files(message_id, file_id) VALUES ($1,$2)', [m.id, f]);
      await c.query(`INSERT INTO thread_reads(student_id, tutor_key, user_id, last_read_id) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (student_id, tutor_key, user_id) DO UPDATE SET last_read_id=GREATEST(thread_reads.last_read_id, EXCLUDED.last_read_id)`, [t, key, u.id, m.id]);
      out.push({ student: t, id: m.id });
    }
    return out;
  });
  A.audit(req, kind === 'homework' ? 'send_homework' : 'send_message', sid, { key, students: targets.length, files: fileIds.length, adults_only: adultsOnly });
  res.json({ ok: true, sent: created.length });
  notify(u, targets, key, { body, kind, due, files: fileIds.length }).catch(e => console.error('message email failed', e.message));
});

// Email the adults in the conversation (students have no email): parents, plus all tutors in General or only
// that tutor in a tutor's conversation. At most one email per person per conversation per 30 minutes.
async function notify(sender, targets, key, m) {
  if (!mailEnabled()) return;
  for (const sid of targets) {
    const s = await db.one(`SELECT name FROM users WHERE id=$1`, [sid]);
    const adults = (await db.many(`SELECT a.id, a.email, a.name, l.relation FROM student_links l JOIN users a ON a.id=l.adult_id
                                   WHERE l.student_id=$1 AND a.active AND a.email IS NOT NULL AND a.id <> $2`, [sid, sender.id]))
      .filter(a => a.relation === 'parent' || key === 0 || a.id === key);
    for (const a of adults) {
      const mk = `${a.id}:${sid}:${key}`, now = Date.now();
      if (lastMailed.get(mk) > now - 30 * 60e3) continue;
      lastMailed.set(mk, now);
      const what = m.kind === 'homework' ? `New homework for ${s.name}${m.due ? ` (due ${m.due})` : ''}` : `New message about ${s.name}`;
      const snippet = m.body ? `\n\n"${m.body.slice(0, 300)}${m.body.length > 300 ? '…' : ''}"` : '';
      await sendMail({ to: a.email, subject: `${what} — AMtutorTools`,
        text: `Hello ${a.name.split(' ')[0]},\n\n${sender.name} (${sender.role}) wrote in ${s.name}'s messages${m.files ? ` and attached ${m.files} file${m.files === 1 ? '' : 's'}` : ''}.${snippet}\n\nOpen the conversation: ${config.appUrl}/#/messages/${sid}?t=${key}\n\nAMtutorTools` });
    }
  }
}

// ---------------------------------------------------------------- homework done / delete
r.post('/:id/done', async (req, res) => {
  const m = await db.one('SELECT id, student_id, kind, tutor_key FROM messages WHERE id=$1 AND deleted_at IS NULL', [Number(req.params.id)]);
  if (!m || m.kind !== 'homework') A.fail(404, 'Homework not found.');
  await assertInThread(req.user, m.student_id);
  if (!canSeeKey(req.user, m.tutor_key)) A.fail(404, 'Homework not found.');
  if (req.user.role === 'parent') A.fail(403, 'The student or tutor marks homework as done.');
  await db.q('UPDATE messages SET done_at=$2 WHERE id=$1', [m.id, req.body.done === false ? null : new Date()]);
  A.audit(req, req.body.done === false ? 'homework_reopened' : 'homework_done', m.student_id, { message: m.id });
  res.json({ ok: true });
});

r.delete('/:id', async (req, res) => {
  const m = await db.one('SELECT id, student_id, sender_id FROM messages WHERE id=$1 AND deleted_at IS NULL', [Number(req.params.id)]);
  if (!m) A.fail(404, 'Message not found.');
  if (m.sender_id !== req.user.id && req.user.role !== 'admin') A.fail(403, 'You can only delete your own messages.');
  await db.tx(async c => {
    await c.query(`UPDATE messages SET deleted_at=now(), body='' WHERE id=$1`, [m.id]);
    await c.query('DELETE FROM message_files WHERE message_id=$1', [m.id]); // unused files are removed by the daily clean-up
  });
  A.audit(req, 'delete_message', m.student_id, { message: m.id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- files
// Upload: send the raw file as the request body, with its name in the X-Filename header.
r.post('/files', async (req, res) => {
  const name = (() => { try { return decodeURIComponent(String(req.get('X-Filename') || '')); } catch { return ''; } })()
    .replace(/[\\/\u0000-\u001f<>:"|?*]+/g, '_').trim().slice(0, 140) || 'file';
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  const mime = ext && TYPES[ext.toLowerCase()];
  if (!mime) A.fail(415, 'This kind of file can’t be attached. Use PDF, PowerPoint, Word, Excel, pictures, audio, video or ZIP.');
  const declared = Number(req.get('content-length') || 0);
  if (declared > MAX_FILE) A.fail(413, `Files can be up to ${Math.round(MAX_FILE / 1048576)} MB.`);
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', c => { size += c.length; if (size > MAX_FILE) { reject(Object.assign(new Error(`Files can be up to ${Math.round(MAX_FILE / 1048576)} MB.`), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', resolve); req.on('error', reject);
  });
  if (!size) A.fail(400, 'The file is empty.');
  const used = await db.one('SELECT COALESCE(sum(size),0)::bigint AS n FROM files');
  if (Number(used.n) + size > MAX_TOTAL) A.fail(507, 'File storage is full. An admin needs to delete old messages with attachments.');
  const f = await db.one('INSERT INTO files(owner_id, name, mime, size, content) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, mime, size',
    [req.user.id, name, mime, size, Buffer.concat(chunks)]);
  res.json({ file: f });
});

r.get('/files/:id', async (req, res) => {
  const id = Number(req.params.id), u = req.user;
  const f = await db.one('SELECT id, owner_id, name, mime, size FROM files WHERE id=$1', [id]);
  if (!f) A.fail(404, 'File not found.');
  let ok = f.owner_id === u.id || u.role === 'admin';
  if (!ok) {
    const ms = await db.many(`SELECT m.student_id, m.adults_only, m.tutor_key FROM message_files mf JOIN messages m ON m.id=mf.message_id
                               WHERE mf.file_id=$1 AND m.deleted_at IS NULL`, [id]);
    for (const m of ms) if ((!m.adults_only || isAdult(u)) && canSeeKey(u, m.tutor_key) && await A.canViewStudent(u, m.student_id)) { ok = true; break; }
  }
  if (!ok) A.fail(403, 'You do not have access to this file.');
  const row = await db.one('SELECT content FROM files WHERE id=$1', [id]);
  const inline = INLINE.has(f.mime) && req.query.download !== '1';
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', row.content.length);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(row.content);
});

// Storage used by attachments (admins)
r.get('/storage', A.requireRole('admin'), async (req, res) => {
  const s = await db.one('SELECT COALESCE(sum(size),0)::bigint AS used, count(*)::int AS files FROM files');
  res.json({ used: Number(s.used), files: s.files, limit: MAX_TOTAL, maxFile: MAX_FILE });
});

module.exports = r;
module.exports.cleanupFiles = () => db.q(`DELETE FROM files f WHERE f.created_at < now() - interval '1 day'
  AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id=f.id)`);
