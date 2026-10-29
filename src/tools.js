// Tool catalog: folder tools (tools/<slug>/manifest.json), uploaded tools (stored in DB),
// access checks, and the tool page server that injects the student's data + SDK.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const A = require('./auth');
const { Router, mimeOf } = require('./http');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const SUBJECTS = ['math', 'physics', 'chemistry', 'science', 'english', 'other'];

function cleanMeta(m, slug) {
  const num = (v, d) => (Number.isFinite(+v) && +v >= 1 && +v <= 12 ? Math.round(+v) : d);
  const gmin = num(m.grade_min ?? m.gradeMin, 5), gmax = num(m.grade_max ?? m.gradeMax, 12);
  return {
    slug,
    name: String(m.name || slug).slice(0, 80),
    subject: SUBJECTS.includes(m.subject) ? m.subject : 'other',
    grade_min: Math.min(gmin, gmax), grade_max: Math.max(gmin, gmax),
    description: String(m.description || '').slice(0, 500),
    icon: String(m.icon || '🧮').slice(0, 8),
    version: String(m.version || '1.0.0').slice(0, 20),
    settings_schema: JSON.stringify(Array.isArray(m.settings) ? m.settings : Array.isArray(m.settings_schema) ? m.settings_schema : []),
  };
}

// Registers every tools/<slug>/ folder. Manifest metadata is re-applied only when its
// version changes, so edits made in the admin screen survive restarts.
async function scanFolderTools() {
  const found = [];
  if (!fs.existsSync(config.toolsDir)) return found;
  for (const dir of fs.readdirSync(config.toolsDir, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('_') || dir.name.startsWith('.')) continue;
    const slug = dir.name;
    const base = path.join(config.toolsDir, slug);
    if (!SLUG_RE.test(slug)) { console.warn(`tools/${slug}: folder name must be lowercase letters, numbers and dashes — skipped`); continue; }
    if (!fs.existsSync(path.join(base, 'index.html'))) { console.warn(`tools/${slug}: no index.html — skipped`); continue; }
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')); }
    catch (e) { console.warn(`tools/${slug}: manifest.json missing or invalid (${e.message}) — using defaults`); }
    const m = cleanMeta(manifest, slug);
    const existing = await db.one('SELECT id, version, source FROM tools WHERE slug=$1', [slug]);
    if (existing && existing.source === 'upload') { console.warn(`tools/${slug}: an uploaded tool already uses this name — folder skipped`); continue; }
    if (!existing) {
      await db.q(`INSERT INTO tools(slug,name,subject,grade_min,grade_max,description,icon,version,settings_schema,source)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'folder')`,
        [m.slug, m.name, m.subject, m.grade_min, m.grade_max, m.description, m.icon, m.version, m.settings_schema]);
    } else if (existing.version !== m.version) {
      await db.q(`UPDATE tools SET name=$2,subject=$3,grade_min=$4,grade_max=$5,description=$6,icon=$7,version=$8,settings_schema=$9,updated_at=now() WHERE id=$1`,
        [existing.id, m.name, m.subject, m.grade_min, m.grade_max, m.description, m.icon, m.version, m.settings_schema]);
    }
    found.push(slug);
  }
  return found;
}

const toolBySlug = slug => db.one('SELECT * FROM tools WHERE slug=$1', [slug]);

const activeAllocation = (studentId, toolId) => db.one(
  `SELECT a.* FROM allocations a JOIN tools t ON t.id = a.tool_id
    WHERE a.student_id=$1 AND a.tool_id=$2 AND a.status='active' AND t.active
      AND (a.expires_at IS NULL OR a.expires_at > now())`, [studentId, toolId]);

// Decides who is looking at a tool page and in which mode:
//  student  — the student using their own tool; everything is saved
//  review   — a parent/tutor/admin looking at a student's tool; nothing is saved
//  preview  — a tutor/admin trying a tool with no student; nothing is saved
async function resolveToolAccess(user, tool, studentParam) {
  if (!user) A.fail(401, 'Please sign in.');
  if (!tool) A.fail(404, 'Tool not found.');
  if (user.role === 'student') {
    if (!tool.active) A.fail(403, 'This tool is turned off.');
    const alloc = await activeAllocation(user.id, tool.id);
    if (!alloc) A.fail(403, 'This tool is not assigned to you.');
    return { mode: 'student', studentId: user.id, alloc };
  }
  if (studentParam) {
    await A.assertView(user, studentParam);
    const alloc = await db.one('SELECT * FROM allocations WHERE student_id=$1 AND tool_id=$2', [Number(studentParam), tool.id]);
    if (user.role !== 'admin' && (!alloc || alloc.status !== 'active')) A.fail(403, 'This tool has not been given to this student.');
    if (!A.tutorOwnsAlloc(user, alloc)) A.fail(403, 'This tool belongs to another of this student’s tutors.');
    return { mode: 'review', studentId: Number(studentParam), alloc };
  }
  if (!['admin', 'tutor'].includes(user.role)) A.fail(403, 'Choose a student to view this tool.');
  if (user.role === 'tutor') {
    const given = await db.one(`SELECT 1 FROM allocations a JOIN student_links l ON l.student_id=a.student_id
                                 WHERE a.tool_id=$1 AND a.status='active' AND l.adult_id=$2 AND l.relation='tutor' AND (a.tutor_id IS NULL OR a.tutor_id=$2) LIMIT 1`, [tool.id, user.id]);
    if (!given || !tool.active) A.fail(403, 'You can only open tools that an admin has given to your students.');
  }
  return { mode: 'preview', studentId: null, alloc: null };
}

async function readToolFile(tool, rel) {
  if (tool.source === 'upload') {
    const f = await db.one('SELECT mime, content FROM tool_files WHERE tool_id=$1 AND path=$2', [tool.id, rel]);
    return f ? { mime: f.mime, body: f.content } : null;
  }
  const root = path.resolve(config.toolsDir, tool.slug);
  const file = path.resolve(root, '.' + path.sep + rel);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return null;
    return { mime: mimeOf(file), body: await fs.promises.readFile(file) };
  } catch { return null; }
}

const safeJson = obj => JSON.stringify(obj).replace(/[<\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function injectBoot(html, tool, boot) {
  const tag = `<base href="/tools/${tool.slug}/">\n<script>window.__AMT_BOOT=${safeJson(boot)};</script>\n<script src="/sdk/amtutor.js?v=${encodeURIComponent(tool.version)}"></script>\n`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + '\n' + tag + html.slice(m.index + m[0].length);
  const h = html.match(/<html[^>]*>/i);
  if (h) return html.slice(0, h.index + h[0].length) + '<head>' + tag + '</head>' + html.slice(h.index + h[0].length);
  return tag + html;
}

const router = new Router();

// Tool pages: /tools/<slug>/  (index gets the boot data) and /tools/<slug>/<asset>
router.get('/tools/:slug/*', async (req, res) => {
  if (!req.user) return res.redirect('/#/login');
  const tool = await toolBySlug(req.params.slug);
  if (!tool) A.fail(404, 'Tool not found.');
  const rel = req.params.rest || 'index.html';
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (rel !== 'index.html') {
    if (rel === 'manifest.json') A.fail(404, 'Not found');
    const f = await readToolFile(tool, rel);
    if (!f) A.fail(404, 'File not found.');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(f.body, f.mime);
  }

  const access = await resolveToolAccess(req.user, tool, req.query.student);
  let student = null, state = {};
  if (access.studentId) {
    const s = await db.one('SELECT id, name, grade FROM users WHERE id=$1 AND role=$2', [access.studentId, 'student']);
    if (!s) A.fail(404, 'Student not found.');
    student = { id: s.id, name: s.name, firstName: s.name.split(' ')[0], grade: s.grade };
    const st = await db.one('SELECT data FROM tool_state WHERE student_id=$1 AND tool_id=$2', [s.id, tool.id]);
    state = st ? st.data : {};
    if (access.mode === 'review') A.audit(req, 'view_tool', s.id, { tool: tool.slug });
  }
  const f = await readToolFile(tool, 'index.html');
  if (!f) A.fail(404, 'This tool has no index.html.');
  const boot = {
    mode: access.mode,
    tool: { slug: tool.slug, name: tool.name, version: tool.version, subject: tool.subject },
    student,
    viewer: { id: req.user.id, role: req.user.role, name: req.user.name },
    settings: access.alloc ? access.alloc.settings : {},
    state,
  };
  res.setHeader('Cache-Control', 'no-store');
  res.send(injectBoot(f.body.toString('utf8'), tool, boot), 'text/html; charset=utf-8');
});
router.get('/tools/:slug', (req, res) => res.redirect(`/tools/${encodeURIComponent(req.params.slug)}/${req.query.student ? `?student=${encodeURIComponent(req.query.student)}` : ''}`));

module.exports = { router, scanFolderTools, toolBySlug, activeAllocation, cleanMeta, SLUG_RE, SUBJECTS };
