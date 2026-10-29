// Writing Studio: English writing practice shared by a student and their tutor.
//
//   The student plans and writes. The text is sent while they type and passed live to anyone
//   who has the piece open (Server-Sent Events), so the tutor watches the writing appear.
//   The tutor comments on selected words (optionally suggesting new words), scores a rubric and
//   writes a "Glow" (what went well) and a "Grow" (next step). Only the student changes the text,
//   so two people never type over each other; tutors change it through suggestions the student accepts.
//
//   Status: draft -> submitted (turned in, text locked) -> revise (sent back) or reviewed -> done.
//   A copy of the text is kept each time it is turned in or reviewed, to show what changed.
//
//   Tutor separation (same as the whiteboard): a piece has a tutor_key. Tutors see pieces with
//   their own id or 0; a piece a student starts goes to the tutor the tool was given by.
const crypto = require('crypto');
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');

const r = new Router();
r.use(A.requireLogin);

const SLUG = 'writing-studio';
const MAX_BODY = 60000, MAX_COMMENTS = 300, MAX_PIECES = 400;
const GENRES = ['narrative', 'descriptive', 'opinion', 'informative', 'letter', 'poem', 'response', 'free'];
const TRAITS = ['ideas', 'organization', 'voice', 'word_choice', 'fluency', 'conventions'];
const STATUSES = ['draft', 'submitted', 'revise', 'reviewed', 'done'];
const EDITABLE = ['draft', 'revise', 'reviewed'];        // the student may change the text in these
const newId = () => crypto.randomBytes(5).toString('hex');
const countWords = s => (String(s).match(/[A-Za-z0-9À-ɏሀ-፿]+(?:['’-][A-Za-z0-9À-ɏሀ-፿]+)*/g) || []).length;
const clean = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);

// ---------------------------------------------------------------- access
async function toolRow() { return db.one('SELECT id, active FROM tools WHERE slug=$1', [SLUG]); }
// { canView, canWrite (student's own text), canReview (tutor/admin feedback), alloc }
async function studentAccess(user, studentId) {
  studentId = Number(studentId);
  const none = { canView: false, canWrite: false, canReview: false };
  if (!studentId) return none;
  const tool = await toolRow();
  const alloc = tool ? await db.one(`SELECT tutor_id FROM allocations WHERE student_id=$1 AND tool_id=$2 AND status='active' AND (expires_at IS NULL OR expires_at > now())`, [studentId, tool.id]) : null;
  if (user.role === 'admin') return { canView: true, canWrite: false, canReview: true, alloc };
  if (!tool || !tool.active || !alloc || !A.tutorOwnsAlloc(user, alloc)) return none;
  if (user.role === 'student') return user.id === studentId ? { canView: true, canWrite: true, canReview: false, alloc } : none;
  if (!(await A.canViewStudent(user, studentId))) return none;
  const manage = user.role === 'tutor' && await A.canManageStudent(user, studentId);
  return { canView: true, canWrite: false, canReview: manage, alloc };
}
async function pieceAccess(user, w) {
  if (!w) A.fail(404, 'Writing not found.');
  if (user.role === 'tutor' && w.tutor_key && w.tutor_key !== user.id) return { canView: false, canWrite: false, canReview: false };
  return studentAccess(user, w.student_id);
}
async function loadPiece(id) {
  return db.one(`SELECT w.*, to_char(w.due_date, 'YYYY-MM-DD') AS due_date, u.name AS tutor_name, u.subject AS tutor_subject
    FROM writings w LEFT JOIN users u ON u.id = w.tutor_key WHERE w.id=$1`, [Number(id)]);
}
async function mustSee(req, id) {
  const w = await loadPiece(id), a = await pieceAccess(req.user, w);
  if (!a.canView) A.fail(403, 'You do not have access to this writing.');
  return { w, a };
}

// ---------------------------------------------------------------- live (Server-Sent Events)
const rooms = new Map();   // writing id -> Map(cid -> { res, user })
function send(c, event, data) { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } }
function broadcast(id, event, data, exceptCid = null) { const room = rooms.get(id); if (room) for (const [cid, c] of room) if (cid !== exceptCid) send(c, event, data); }
const presence = id => [...(rooms.get(id) || new Map()).entries()].map(([cid, c]) => ({ cid, id: c.user.id, name: c.user.name, role: c.user.role }));
const publicPiece = w => ({ ...w, words: w.words });
async function pushUpdate(id, exceptCid) { const w = await loadPiece(id); if (w) broadcast(id, 'update', publicPiece(w), exceptCid); return w; }

// ---------------------------------------------------------------- list / create
r.get('/', async (req, res) => {
  const sid = Number(req.query.student) || (req.user.role === 'student' ? req.user.id : 0);
  if (!sid) A.fail(400, 'Choose a student.');
  const a = await studentAccess(req.user, sid);
  if (!a.canView) A.fail(403, 'You do not have access to this student’s writing.');
  const mine = req.user.role === 'tutor';
  const rows = await db.many(`SELECT w.id, w.title, w.genre, w.status, w.words, w.target_words, to_char(w.due_date,'YYYY-MM-DD') AS due_date, w.updated_at, w.created_at, w.submitted_at,
      w.tutor_key, u.name AS tutor_name, (w.prompt IS NOT NULL AND w.created_by <> w.student_id) AS assigned,
      (SELECT count(*)::int FROM jsonb_array_elements(w.comments) c WHERE NOT COALESCE((c->>'resolved')::boolean, false)) AS open_comments
    FROM writings w LEFT JOIN users u ON u.id = w.tutor_key WHERE w.student_id=$1${mine ? ' AND w.tutor_key IN (0, $2)' : ''} ORDER BY w.updated_at DESC`, mine ? [sid, req.user.id] : [sid]);
  rows.forEach(w => { w.live = presence(w.id).length; });
  res.json({ pieces: rows, canWrite: a.canWrite, canReview: a.canReview });
});

r.post('/', async (req, res) => {
  const sid = Number(req.body.student) || (req.user.role === 'student' ? req.user.id : 0);
  const a = await studentAccess(req.user, sid);
  if (!a.canWrite && !a.canReview) A.fail(403, 'You cannot start writing for this student.');
  if ((await db.one('SELECT count(*)::int AS n FROM writings WHERE student_id=$1', [sid])).n >= MAX_PIECES) A.fail(400, 'Too many pieces. Delete some first.');
  const genre = GENRES.includes(req.body.genre) ? req.body.genre : 'narrative';
  const title = clean(req.body.title, 120).trim() || 'Untitled';
  const target = Math.round(Number(req.body.target_words)) || null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null;
  const tutorKey = req.user.role === 'tutor' ? req.user.id : (a.alloc && a.alloc.tutor_id) || 0;
  const row = await db.one(`INSERT INTO writings(student_id, tutor_key, title, genre, prompt, target_words, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [sid, tutorKey, title, genre, clean(req.body.prompt, 2000).trim() || null, target && target > 0 && target <= 10000 ? target : null, due, req.user.id]);
  if (req.user.role !== 'student') A.audit(req, 'assign_writing', sid, { writing: row.id, title });
  res.json({ ok: true, id: row.id });
});

// ---------------------------------------------------------------- one piece
r.get('/:id', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  const versions = await db.many(`SELECT id, label, words, created_at FROM writing_versions WHERE writing_id=$1 ORDER BY id`, [w.id]);
  res.json({ piece: publicPiece(w), versions, canWrite: a.canWrite && EDITABLE.includes(w.status), isOwner: a.canWrite, canReview: a.canReview, live: presence(w.id) });
});
r.get('/:id/versions/:vid', async (req, res) => {
  const { w } = await mustSee(req, req.params.id);
  const v = await db.one('SELECT id, label, body, words, created_at FROM writing_versions WHERE id=$1 AND writing_id=$2', [Number(req.params.vid), w.id]);
  if (!v) A.fail(404, 'Version not found.');
  res.json({ version: v });
});

// Text and plan, sent while the student types
r.post('/:id/text', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  if (!a.canWrite) A.fail(403, 'Only the student writes the text. Use comments to suggest changes.');
  if (!EDITABLE.includes(w.status)) A.fail(423, w.status === 'submitted' ? 'This piece is turned in. Tap “Take back” to keep writing.' : 'This piece is finished.');
  if (Number(req.body.v) !== w.version) return res.status(409).json({ error: 'This writing changed on another screen.', piece: publicPiece(w) });
  const body = req.body.body !== undefined ? clean(req.body.body, MAX_BODY + 1) : w.body;
  if (body.length > MAX_BODY) A.fail(413, 'That is longer than 60,000 characters.');
  let plan = w.plan;
  if (req.body.plan !== undefined) {
    if (!req.body.plan || typeof req.body.plan !== 'object' || Array.isArray(req.body.plan)) A.fail(400, 'Bad plan.');
    plan = {}; for (const [k, v] of Object.entries(req.body.plan).slice(0, 40)) if (/^[a-z_]{1,30}$/.test(k)) plan[k] = clean(v, 1500);
  }
  const title = req.body.title !== undefined ? (clean(req.body.title, 120).trim() || 'Untitled') : w.title;
  const words = countWords(body);
  const row = await db.one(`UPDATE writings SET body=$2, plan=$3::jsonb, title=$4, words=$5, version=version+1, updated_at=now() WHERE id=$1 AND version=$6 RETURNING version`,
    [w.id, body, JSON.stringify(plan), title, words, w.version]);
  if (!row) return res.status(409).json({ error: 'This writing changed on another screen.', piece: publicPiece(await loadPiece(w.id)) });
  broadcast(w.id, 'text', { body, plan, title, words, v: row.version }, req.body.cid);
  res.json({ ok: true, v: row.version, words });
});

// Status, assignment details, rubric and feedback
r.patch('/:id', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  const b = req.body, set = {}, me = req.user;
  let snapshot = null;
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) A.fail(400, 'Unknown status.');
    if (a.canWrite) {
      // the student turns it in, or takes it back before the tutor has looked
      if (b.status === 'submitted' && EDITABLE.includes(w.status)) { if (!w.body.trim()) A.fail(400, 'Write something before you turn it in.'); set.status = 'submitted'; set.submitted_at = new Date(); snapshot = 'Turned in'; }
      else if (b.status === 'draft' && w.status === 'submitted') set.status = 'draft';
      else if (b.status !== w.status) A.fail(403, 'Your tutor decides when it is reviewed or done.');
    } else if (a.canReview) {
      set.status = b.status;
      if (['revise', 'reviewed', 'done'].includes(b.status) && b.status !== w.status) { set.reviewed_at = new Date(); snapshot = b.status === 'revise' ? 'Sent back to revise' : b.status === 'done' ? 'Finished' : 'Reviewed'; }
    } else A.fail(403, 'You can read this writing but not change it.');
  }
  const reviewerKeys = ['prompt', 'glow', 'grow', 'rubric', 'genre', 'target_words', 'due_date'];
  if (!a.canReview && reviewerKeys.some(k => b[k] !== undefined)) A.fail(403, 'Only the tutor gives feedback.');
  if (b.title !== undefined) {
    if (!a.canReview && !a.canWrite) A.fail(403, 'You can read this writing but not change it.');
    if (!a.canReview && !EDITABLE.includes(w.status)) A.fail(423, 'This piece is locked.');
    set.title = clean(b.title, 120).trim() || 'Untitled';
  }
  if (a.canReview) {
    if (b.prompt !== undefined) set.prompt = clean(b.prompt, 2000).trim() || null;
    if (b.genre !== undefined && GENRES.includes(b.genre)) set.genre = b.genre;
    if (b.target_words !== undefined) { const t = Math.round(Number(b.target_words)); set.target_words = t > 0 && t <= 10000 ? t : null; }
    if (b.due_date !== undefined) set.due_date = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null;
    if (b.glow !== undefined) set.glow = clean(b.glow, 3000).trim() || null;
    if (b.grow !== undefined) set.grow = clean(b.grow, 3000).trim() || null;
    if (b.rubric !== undefined) {
      const ru = {}; for (const t of TRAITS) { const n = Number((b.rubric || {})[t]); if (n >= 1 && n <= 4) ru[t] = Math.round(n); }
      set.rubric = JSON.stringify(ru);
    }
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.json({ ok: true });
  await db.q(`UPDATE writings SET ${keys.map((k, i) => `${k}=$${i + 2}${k === 'rubric' ? '::jsonb' : ''}`).join(', ')}, updated_at=now() WHERE id=$1`, [w.id, ...keys.map(k => set[k])]);
  if (snapshot) {
    const last = await db.one('SELECT body FROM writing_versions WHERE writing_id=$1 ORDER BY id DESC LIMIT 1', [w.id]);
    if (!last || last.body !== w.body || snapshot !== 'Turned in') await db.q('INSERT INTO writing_versions(writing_id, label, body, words, by_id) VALUES ($1,$2,$3,$4,$5)', [w.id, snapshot, w.body, w.words, me.id]);
    A.audit(req, set.status === 'submitted' ? 'submit_writing' : 'review_writing', w.student_id, { writing: w.id, status: set.status });
  }
  await pushUpdate(w.id);
  res.json({ ok: true });
});

r.delete('/:id', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  const studentDraft = a.canWrite && w.status === 'draft' && !w.comments.length && !w.prompt;
  if (!a.canReview && !studentDraft) A.fail(403, a.canWrite ? 'Ask your tutor to delete a piece that has feedback or was assigned.' : 'You cannot delete this writing.');
  await db.q('DELETE FROM writings WHERE id=$1', [w.id]);
  broadcast(w.id, 'deleted', {});
  A.audit(req, 'delete_writing', w.student_id, { writing: w.id, title: w.title });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- comments
// { id, by, name, role, quote, start, text, suggest, parent, resolved, at }
r.post('/:id/comments', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  if (!a.canWrite && !a.canReview) A.fail(403, 'You can read the comments but not add one.');
  if (w.comments.length >= MAX_COMMENTS) A.fail(400, 'Too many comments on this piece.');
  const text = clean(req.body.text, 2000).trim(), suggest = req.body.suggest !== undefined && req.body.suggest !== null ? clean(req.body.suggest, 2000) : null;
  const parent = req.body.parent && w.comments.some(c => c.id === req.body.parent && !c.parent) ? req.body.parent : null;
  const quote = parent ? '' : clean(req.body.quote, 600);
  if (!text && suggest === null) A.fail(400, 'Write a comment.');
  if (suggest !== null && !a.canReview) A.fail(403, 'Only the tutor suggests changes.');
  if (suggest !== null && !quote) A.fail(400, 'Select the words you want to change.');
  const c = { id: newId(), by: req.user.id, name: req.user.name, role: req.user.role, quote, start: Math.max(0, Math.round(Number(req.body.start)) || 0), text, suggest, parent, resolved: false, at: new Date().toISOString() };
  await db.q(`UPDATE writings SET comments = comments || $2::jsonb, updated_at=now() WHERE id=$1`, [w.id, JSON.stringify([c])]);
  await pushUpdate(w.id);
  res.json({ ok: true, comment: c });
});
// Find the quoted words in the text, nearest to where the comment was made
function locate(body, quote, start) {
  if (!quote) return -1;
  let best = -1, bestD = Infinity, i = body.indexOf(quote);
  while (i >= 0) { const d = Math.abs(i - start); if (d < bestD) { best = i; bestD = d; } i = body.indexOf(quote, i + 1); }
  return best;
}
r.patch('/:id/comments/:cid', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  if (!a.canWrite && !a.canReview) A.fail(403, 'You cannot change comments here.');
  const list = w.comments, c = list.find(x => x.id === req.params.cid);
  if (!c) A.fail(404, 'Comment not found.');
  let body = null;
  if (req.body.accept) {
    if (!a.canWrite) A.fail(403, 'The student accepts suggestions.');
    if (!EDITABLE.includes(w.status)) A.fail(423, 'Take the piece back (or wait for your tutor) before changing the text.');
    if (c.suggest === null || c.suggest === undefined) A.fail(400, 'This comment has no suggestion.');
    const at = locate(w.body, c.quote, c.start);
    if (at < 0) A.fail(409, 'Those words have changed, so the suggestion can’t be applied. Change them yourself.');
    body = w.body.slice(0, at) + c.suggest + w.body.slice(at + c.quote.length);
    c.accepted = true; c.resolved = true;
  }
  if (req.body.resolved !== undefined) c.resolved = !!req.body.resolved;
  if (body !== null) {
    const row = await db.one(`UPDATE writings SET body=$2, words=$3, comments=$4::jsonb, version=version+1, updated_at=now() WHERE id=$1 AND version=$5 RETURNING version`, [w.id, body, countWords(body), JSON.stringify(list), w.version]);
    if (!row) A.fail(409, 'The text just changed. Try again.');
  } else await db.q(`UPDATE writings SET comments=$2::jsonb, updated_at=now() WHERE id=$1`, [w.id, JSON.stringify(list)]);
  const p = await pushUpdate(w.id);
  res.json({ ok: true, piece: p });
});
r.delete('/:id/comments/:cid', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  const c = w.comments.find(x => x.id === req.params.cid);
  if (!c) A.fail(404, 'Comment not found.');
  if (c.by !== req.user.id && req.user.role !== 'admin') A.fail(403, 'You can delete only your own comments.');
  void a;
  const list = w.comments.filter(x => x.id !== c.id && x.parent !== c.id);
  await db.q(`UPDATE writings SET comments=$2::jsonb, updated_at=now() WHERE id=$1`, [w.id, JSON.stringify(list)]);
  await pushUpdate(w.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- live connection
r.get('/:id/events', async (req, res) => {
  const { w, a } = await mustSee(req, req.params.id);
  const cid = /^[A-Za-z0-9_-]{4,40}$/.test(req.query.cid || '') ? req.query.cid : newId();
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.socket.setTimeout(0); req.socket.setNoDelay(true);
  if (!rooms.has(w.id)) rooms.set(w.id, new Map());
  const room = rooms.get(w.id), old = room.get(cid);
  if (old) try { old.res.end(); } catch {}
  const client = { res, user: req.user };
  room.set(cid, client);
  res.write('retry: 2000\n\n');
  send(client, 'snapshot', { piece: publicPiece(w), canWrite: a.canWrite && EDITABLE.includes(w.status), isOwner: a.canWrite, canReview: a.canReview, me: cid });
  broadcast(w.id, 'presence', presence(w.id));
  if (req.user.role !== 'student') A.audit(req, 'view_writing', w.student_id, { writing: w.id });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20e3);
  req.on('close', () => {
    clearInterval(ping);
    if (room.get(cid) === client) room.delete(cid);
    if (!room.size) rooms.delete(w.id); else broadcast(w.id, 'presence', presence(w.id));
  });
});
// "is typing…" and where the writer is (never stored)
r.post('/:id/live', async (req, res) => {
  const id = Number(req.params.id), room = rooms.get(id), c = room && room.get(req.body.cid);
  if (!c || c.user.id !== req.user.id) return res.json({ ok: false });
  const k = req.body.k;
  if (!['typing', 'caret', 'look'].includes(k)) A.fail(400, 'Bad message.');
  broadcast(id, 'live', { cid: req.body.cid, name: req.user.name, role: req.user.role, k, pos: Math.max(0, Math.round(Number(req.body.pos)) || 0), field: /^[a-z_]{1,30}$/.test(req.body.field || '') ? req.body.field : 'body' }, req.body.cid);
  res.json({ ok: true });
});

module.exports = r;
module.exports._test = { countWords, locate };
