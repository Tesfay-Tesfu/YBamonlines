// Whiteboards: board list, live updates (Server-Sent Events) and shared editing.
//
// How live editing works
//   - Each open board lives in memory in a "room" (this app runs as one server process).
//   - Browsers listen on GET /api/boards/:id/events (Server-Sent Events). The first
//     message is a snapshot of the board; after that they receive every change.
//   - Edits are sent as small operations to POST /api/boards/:id/ops. The server applies
//     them in order, gives the board a new version number and passes them to everyone.
//   - Pointers, strokes being drawn, the laser and "follow me" go through
//     POST /api/boards/:id/live and are never stored.
//   - Rooms are saved to the database a moment after each change and when everyone leaves.
const crypto = require('crypto');
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');

const r = new Router();
r.use(A.requireLogin);

const SLUG = 'whiteboard';
const MAX_BOARD_BYTES = 24 * 1024 * 1024;   // whole board (images included)
const MAX_ELEMENT_BYTES = 3 * 1024 * 1024;  // one element (an image)
const MAX_PAGES = 60;
const COLORS = ['#2563eb', '#e66414', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#dc2626'];

const newId = () => crypto.randomBytes(6).toString('hex');
const blankPage = (bg = 'grid') => ({ id: newId(), bg, els: [] });

// ---------------------------------------------------------------- access
async function whiteboardTool() {
  return db.one('SELECT id, active FROM tools WHERE slug=$1', [SLUG]);
}
// Returns { canView, canEdit } for a student's boards.
async function studentAccess(user, studentId) {
  studentId = Number(studentId);
  if (!studentId) return { canView: false, canEdit: false };
  if (user.role === 'admin') return { canView: true, canEdit: true };
  const tool = await whiteboardTool();
  if (!tool || !tool.active) return { canView: false, canEdit: false };
  const given = await db.one(`SELECT 1 FROM allocations WHERE student_id=$1 AND tool_id=$2 AND status='active' AND (expires_at IS NULL OR expires_at > now())`, [studentId, tool.id]);
  if (!given) return { canView: false, canEdit: false };
  if (user.role === 'student') return { canView: user.id === studentId, canEdit: user.id === studentId };
  if (!(await A.canViewStudent(user, studentId))) return { canView: false, canEdit: false };
  return { canView: true, canEdit: await A.canManageStudent(user, studentId) };
}
async function boardAccess(user, board) {
  if (!board) A.fail(404, 'Board not found.');
  if (board.student_id) return studentAccess(user, board.student_id);
  const own = board.owner_id === user.id || user.role === 'admin';
  return { canView: own, canEdit: own };
}
async function loadBoardRow(id) {
  return db.one('SELECT id, student_id, owner_id, title, version, updated_at, created_at FROM boards WHERE id=$1', [Number(id)]);
}

// ---------------------------------------------------------------- rooms
const rooms = new Map(); // boardId -> room

async function openRoom(id) {
  let room = rooms.get(id);
  if (room) return room.ready;
  room = { id, clients: new Map(), data: null, version: 0, title: '', dirty: false, saveTimer: null, closeTimer: null, bytes: 0 };
  room.ready = (async () => {
    const row = await db.one('SELECT title, data, version FROM boards WHERE id=$1', [id]);
    if (!row) { rooms.delete(id); A.fail(404, 'Board not found.'); }
    room.data = row.data && Array.isArray(row.data.pages) ? row.data : { pages: [] };
    if (!room.data.pages.length) room.data.pages.push(blankPage());
    room.version = row.version; room.title = row.title;
    room.bytes = Buffer.byteLength(JSON.stringify(room.data));
    return room;
  })();
  rooms.set(id, room);
  try { return await room.ready; } catch (e) { rooms.delete(id); throw e; }
}
function scheduleSave(room, delay = 1500) {
  room.dirty = true;
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => saveRoom(room).catch(e => console.error('board save failed', room.id, e.message)), delay);
}
async function saveRoom(room) {
  clearTimeout(room.saveTimer); room.saveTimer = null;
  if (!room.dirty) return;
  room.dirty = false;
  await db.q('UPDATE boards SET data=$2::jsonb, version=$3, updated_at=now() WHERE id=$1', [room.id, JSON.stringify(room.data), room.version]);
}
function maybeClose(room) {
  clearTimeout(room.closeTimer);
  if (room.clients.size) return;
  room.closeTimer = setTimeout(async () => {
    if (room.clients.size) return;
    try { await saveRoom(room); } catch (e) { console.error('board save failed', room.id, e.message); return; }
    rooms.delete(room.id);
  }, 30e3);
}
function send(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}
function broadcast(room, event, data, exceptCid = null) {
  for (const c of room.clients.values()) if (c.cid !== exceptCid) send(c, event, data);
}
const presence = room => [...room.clients.values()].map(c => ({ cid: c.cid, uid: c.user.id, name: c.user.name, role: c.user.role, color: c.color, edit: c.canEdit }));

// Save everything on shutdown (Render sends SIGTERM before a deploy)
async function saveAll() { await Promise.all([...rooms.values()].map(r2 => saveRoom(r2).catch(() => {}))); }
process.once('SIGTERM', () => { saveAll().finally(() => process.exit(0)); });
process.once('SIGINT', () => { saveAll().finally(() => process.exit(0)); });

// ---------------------------------------------------------------- operations
const isId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
function checkElement(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !isId(e.id) || typeof e.t !== 'string') A.fail(400, 'Bad element.');
  if (e.t === 'img' && !(typeof e.src === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(e.src))) A.fail(400, 'Images must be PNG, JPEG, WebP or GIF.');
  const size = Buffer.byteLength(JSON.stringify(e));
  if (size > MAX_ELEMENT_BYTES) A.fail(413, 'That item is too large.');
  return size;
}
const pageOf = (room, pid) => room.data.pages.find(p => p.id === pid);

// Applies one operation. Returns false when it no longer applies (e.g. element already deleted).
function applyOp(room, op) {
  const P = room.data.pages;
  switch (op && op.o) {
    case 'add': { const p = pageOf(room, op.p); checkElement(op.e); if (!p) return false; const i = p.els.findIndex(x => x.id === op.e.id); if (i >= 0) p.els[i] = op.e; else if (Number.isInteger(op.at) && op.at >= 0 && op.at <= p.els.length) p.els.splice(op.at, 0, op.e); else p.els.push(op.e); return true; }
    case 'upd': { const p = pageOf(room, op.p); checkElement(op.e); if (!p) return false; const i = p.els.findIndex(x => x.id === op.e.id); if (i < 0) return false; p.els[i] = op.e; return true; }
    case 'del': { const p = pageOf(room, op.p); if (!p || !Array.isArray(op.ids)) return false; const s = new Set(op.ids); const n = p.els.length; p.els = p.els.filter(x => !s.has(x.id)); return p.els.length !== n; }
    case 'order': { const p = pageOf(room, op.p); if (!p || !Array.isArray(op.ids)) return false; const s = new Set(op.ids); const moved = p.els.filter(x => s.has(x.id)), rest = p.els.filter(x => !s.has(x.id)); p.els = op.dir === 'back' ? [...moved, ...rest] : [...rest, ...moved]; return true; }
    case 'addPage': {
      if (P.length >= MAX_PAGES) A.fail(400, `A board can have up to ${MAX_PAGES} pages.`);
      const pg = op.page; if (!pg || !isId(pg.id) || !Array.isArray(pg.els) || P.some(p => p.id === pg.id)) A.fail(400, 'Bad page.');
      pg.els.forEach(checkElement);
      const at = Number.isInteger(op.at) ? Math.max(0, Math.min(P.length, op.at)) : P.length;
      P.splice(at, 0, { id: pg.id, bg: String(pg.bg || 'grid').slice(0, 20), els: pg.els }); return true;
    }
    case 'delPage': { if (P.length <= 1) return false; const i = P.findIndex(p => p.id === op.p); if (i < 0) return false; P.splice(i, 1); return true; }
    case 'pageBg': { const p = pageOf(room, op.p); if (!p) return false; p.bg = String(op.bg || 'grid').slice(0, 20); return true; }
    case 'clear': { const p = pageOf(room, op.p); if (!p) return false; p.els = []; return true; }
    default: A.fail(400, 'Unknown change.');
  }
}

// ---------------------------------------------------------------- routes
// List boards: ?student=ID for a student's boards; without it, the adult's own prep boards.
r.get('/', async (req, res) => {
  const sid = Number(req.query.student) || (req.user.role === 'student' ? req.user.id : 0);
  let rows, canEdit;
  if (sid) {
    const a = await studentAccess(req.user, sid);
    if (!a.canView) A.fail(403, 'You do not have access to these boards.');
    canEdit = a.canEdit;
    rows = await db.many(`SELECT id, title, updated_at, created_at, jsonb_array_length(data->'pages') AS pages FROM boards WHERE student_id=$1 ORDER BY updated_at DESC`, [sid]);
  } else {
    if (req.user.role === 'student' || req.user.role === 'parent') A.fail(400, 'Choose a student.');
    canEdit = true;
    rows = await db.many(`SELECT id, title, updated_at, created_at, jsonb_array_length(data->'pages') AS pages FROM boards WHERE owner_id=$1 AND student_id IS NULL ORDER BY updated_at DESC`, [req.user.id]);
  }
  // show live state for rooms that are open
  rows.forEach(b => { const room = rooms.get(b.id); if (room && room.data) { b.live = room.clients.size; b.pages = room.data.pages.length; } });
  res.json({ boards: rows, canEdit });
});

r.post('/', async (req, res) => {
  const sid = Number(req.body.student) || (req.user.role === 'student' ? req.user.id : 0);
  const title = String(req.body.title || '').trim().slice(0, 80) || `Board ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  let data = { pages: [blankPage(['grid', 'dots', 'graph', 'lined', 'plain'].includes(req.body.bg) ? req.body.bg : 'grid')] };
  // Copy another board (e.g. a tutor's prepared lesson) into this one
  if (req.body.copyFrom) {
    const src = await loadBoardRow(req.body.copyFrom);
    const a = await boardAccess(req.user, src);
    if (!a.canView) A.fail(403, 'You cannot copy that board.');
    const room = rooms.get(src.id);
    const d = room && room.data ? room.data : (await db.one('SELECT data FROM boards WHERE id=$1', [src.id])).data;
    data = JSON.parse(JSON.stringify(d));
  }
  let row;
  if (sid) {
    const a = await studentAccess(req.user, sid);
    if (!a.canEdit) A.fail(403, 'You cannot add boards for this student.');
    if ((await db.one('SELECT count(*)::int AS n FROM boards WHERE student_id=$1', [sid])).n >= 300) A.fail(400, 'This student has too many boards. Delete some first.');
    row = await db.one(`INSERT INTO boards(student_id, title, data, created_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING id, title`, [sid, title, JSON.stringify(data), req.user.id]);
    A.audit(req, 'create_board', sid, { board: row.id });
  } else {
    if (!['admin', 'tutor'].includes(req.user.role)) A.fail(403, 'Choose a student.');
    row = await db.one(`INSERT INTO boards(owner_id, title, data, created_by) VALUES ($1,$2,$3::jsonb,$1) RETURNING id, title`, [req.user.id, title, JSON.stringify(data)]);
  }
  res.json({ board: row });
});

r.get('/:id', async (req, res) => {
  const b = await loadBoardRow(req.params.id);
  const a = await boardAccess(req.user, b);
  if (!a.canView) A.fail(403, 'You do not have access to this board.');
  res.json({ board: b, canEdit: a.canEdit });
});

r.patch('/:id', async (req, res) => {
  const b = await loadBoardRow(req.params.id);
  const a = await boardAccess(req.user, b);
  if (!a.canEdit) A.fail(403, 'You cannot change this board.');
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) A.fail(400, 'Give the board a name.');
  await db.q('UPDATE boards SET title=$2 WHERE id=$1', [b.id, title]);
  const room = rooms.get(b.id); if (room) { room.title = title; broadcast(room, 'title', { title }); }
  res.json({ ok: true });
});

r.delete('/:id', async (req, res) => {
  const b = await loadBoardRow(req.params.id);
  const a = await boardAccess(req.user, b);
  if (!a.canEdit) A.fail(403, 'You cannot delete this board.');
  const room = rooms.get(b.id);
  if (room) { clearTimeout(room.saveTimer); room.dirty = false; broadcast(room, 'deleted', {}); for (const c of room.clients.values()) try { c.res.end(); } catch {} rooms.delete(b.id); }
  await db.q('DELETE FROM boards WHERE id=$1', [b.id]);
  if (b.student_id) A.audit(req, 'delete_board', b.student_id, { board: b.id, title: b.title });
  res.json({ ok: true });
});

// Live connection (Server-Sent Events)
r.get('/:id/events', async (req, res) => {
  const b = await loadBoardRow(req.params.id);
  const a = await boardAccess(req.user, b);
  if (!a.canView) A.fail(403, 'You do not have access to this board.');
  const cid = isId(req.query.cid) ? req.query.cid : newId();
  const room = await openRoom(b.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.socket.setTimeout(0); req.socket.setNoDelay(true);
  const old = room.clients.get(cid); if (old) try { old.res.end(); } catch {}
  const used = new Set([...room.clients.values()].map(c => c.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[room.clients.size % COLORS.length];
  const client = { cid, res, user: req.user, canEdit: a.canEdit, color };
  room.clients.set(cid, client);
  clearTimeout(room.closeTimer);
  res.write(`retry: 2000\n\n`);
  send(client, 'snapshot', { board: { id: b.id, title: room.title, student_id: b.student_id }, data: room.data, version: room.version, canEdit: a.canEdit, me: { cid, color } });
  broadcast(room, 'presence', presence(room));
  if (b.student_id && req.user.role !== 'student') A.audit(req, 'view_board', b.student_id, { board: b.id });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20e3);
  req.on('close', () => {
    clearInterval(ping);
    if (room.clients.get(cid) === client) room.clients.delete(cid);
    broadcast(room, 'presence', presence(room));
    maybeClose(room);
  });
});

// Changes (stored)
r.post('/:id/ops', async (req, res) => {
  const id = Number(req.params.id);
  const room = rooms.get(id);
  const client = room && room.clients.get(req.body.cid);
  if (!room || !client) A.fail(409, 'Not connected to this board. Reconnecting…');
  if (client.user.id !== req.user.id) A.fail(403, 'Not your connection.');
  if (!client.canEdit) A.fail(403, 'You can look at this board but not change it.');
  const ops = Array.isArray(req.body.ops) ? req.body.ops.slice(0, 500) : [];
  if (!ops.length) return res.json({ version: room.version });
  const before = room.bytes, snapshot = JSON.stringify(room.data);
  try {
    const applied = [];
    for (const op of ops) if (applyOp(room, op)) applied.push(op);
    room.bytes = Buffer.byteLength(JSON.stringify(room.data));
    if (room.bytes > MAX_BOARD_BYTES) A.fail(413, 'This board is full. Delete some images or start a new board.');
    if (!applied.length) return res.json({ version: room.version });
    room.version++;
    broadcast(room, 'ops', { v: room.version, cid: client.cid, by: req.user.name, ops: applied });
    scheduleSave(room);
    res.json({ version: room.version });
  } catch (e) {
    room.data = JSON.parse(snapshot); room.bytes = before; // all-or-nothing
    throw e;
  }
});

// Live-only messages: pointers, strokes being drawn, laser, follow-me
r.post('/:id/live', async (req, res) => {
  const room = rooms.get(Number(req.params.id));
  const client = room && room.clients.get(req.body.cid);
  if (!client || client.user.id !== req.user.id) return res.json({ ok: false });
  const m = req.body.m;
  if (!m || typeof m !== 'object' || !['cursor', 'draft', 'draftEnd', 'laser', 'view', 'bring', 'lead'].includes(m.k)) A.fail(400, 'Bad message.');
  if (['draft', 'laser', 'bring', 'lead'].includes(m.k) && !client.canEdit) A.fail(403, 'View only.');
  if (JSON.stringify(m).length > 400000) A.fail(413, 'Too large.');
  broadcast(room, 'live', { cid: client.cid, name: req.user.name, color: client.color, role: req.user.role, m }, client.cid);
  res.json({ ok: true });
});

module.exports = r;
module.exports.rooms = rooms;
