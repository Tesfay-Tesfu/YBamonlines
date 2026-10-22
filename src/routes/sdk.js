// Endpoints the in-tool SDK (public/sdk/amtutor.js) calls while a student uses a tool.
// Only the student themself can write; parents/tutors/admins view in read-only mode.
const { Router } = require('../http');
const db = require('../db');
const config = require('../config');
const A = require('../auth');
const { toolBySlug, activeAllocation } = require('../tools');

const r = new Router();

async function studentTool(req) {
  if (!req.user) A.fail(401, 'Please sign in.');
  if (req.user.role !== 'student') A.fail(403, 'Only the student’s own sessions are saved.');
  const tool = await toolBySlug(req.params.slug);
  if (!tool) A.fail(404, 'Tool not found.');
  if (!(await activeAllocation(req.user.id, tool.id))) A.fail(403, 'This tool is not assigned to you.');
  return tool;
}
const str = (v, n = 200) => (v === undefined || v === null ? null : String(v).slice(0, n));

// Save key/value changes: { set: {key: "string"}, remove: [keys], clear: true }
r.post('/:slug/state', async (req, res) => {
  const tool = await studentTool(req);
  const set = req.body.set && typeof req.body.set === 'object' ? req.body.set : {};
  const remove = Array.isArray(req.body.remove) ? req.body.remove.map(String) : [];
  for (const k of Object.keys(set)) set[k] = String(set[k]);
  const size = Buffer.byteLength(JSON.stringify(set));
  if (size > config.maxStateBytes) A.fail(413, 'Saved data is too large.');
  const row = await db.one(
    `INSERT INTO tool_state(student_id, tool_id, data) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (student_id, tool_id) DO UPDATE
       SET data = (CASE WHEN $5 THEN '{}'::jsonb ELSE tool_state.data END) - $4::text[] || $3::jsonb, updated_at = now()
     RETURNING pg_column_size(data) AS bytes`,
    [req.user.id, tool.id, JSON.stringify(set), remove, !!req.body.clear]);
  if (row.bytes > config.maxStateBytes * 2) console.warn(`tool_state large: student ${req.user.id} tool ${tool.slug} ${row.bytes} bytes`);
  res.json({ ok: true });
});

// Record answers: { items: [{question, response, answer, correct, ms, topic, mode, session, meta}] }
r.post('/:slug/attempts', async (req, res) => {
  const tool = await studentTool(req);
  const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 300);
  if (!items.length) return res.json({ ok: true, saved: 0 });
  const cols = [], vals = [];
  items.forEach((it, i) => {
    const b = i * 12;
    cols.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11}::jsonb,$${b + 12})`);
    const ts = Number(it.ts) && Math.abs(Date.now() - Number(it.ts)) < 7 * 86400e3 ? new Date(Number(it.ts)) : new Date();
    vals.push(req.user.id, tool.id, str(it.session, 80), str(it.mode, 40), str(it.topic, 80),
      str(it.question, 300) || '?', str(it.response, 200), str(it.answer, 200), !!it.correct,
      Number.isFinite(+it.ms) ? Math.max(0, Math.min(2147483647, Math.round(+it.ms))) : null,
      it.meta && typeof it.meta === 'object' ? JSON.stringify(it.meta).slice(0, 2000) : null, ts);
  });
  await db.q(`INSERT INTO attempts(student_id,tool_id,session_key,mode,topic,question,response,answer,correct,ms,meta,created_at) VALUES ${cols.join(',')}`, vals);
  res.json({ ok: true, saved: items.length });
});

// Time on task: { seconds, day: "YYYY-MM-DD" (student's local day) }
r.post('/:slug/activity', async (req, res) => {
  const tool = await studentTool(req);
  const secs = Math.max(0, Math.min(120, Math.round(Number(req.body.seconds) || 0)));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body.day || '') ? req.body.day : new Date().toISOString().slice(0, 10);
  if (secs) {
    await db.q(`INSERT INTO activity(student_id,tool_id,day,seconds) VALUES ($1,$2,$3,$4)
                ON CONFLICT (student_id,tool_id,day) DO UPDATE SET seconds = activity.seconds + EXCLUDED.seconds`,
      [req.user.id, tool.id, day, secs]);
  }
  res.json({ ok: true });
});

// Badges: { code, title, icon }
r.post('/:slug/achievement', async (req, res) => {
  const tool = await studentTool(req);
  const code = str(req.body.code, 60), title = str(req.body.title, 120);
  if (!code || !title) A.fail(400, 'code and title are required.');
  const row = await db.one(`INSERT INTO achievements(student_id,tool_id,code,title,icon) VALUES ($1,$2,$3,$4,$5)
                            ON CONFLICT (student_id,tool_id,code) DO NOTHING RETURNING id`,
    [req.user.id, tool.id, code, title, str(req.body.icon, 8) || '🏅']);
  res.json({ ok: true, isNew: !!row });
});

module.exports = r;
