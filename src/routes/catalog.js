// Tool lists for the signed-in user.
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');

const r = new Router();
r.use(A.requireLogin);

// Student: the tools assigned to me, with my progress summary
r.get('/my/tools', A.requireRole('student'), async (req, res) => {
  const tools = await db.many(`
    SELECT t.slug, t.name, t.icon, t.subject, t.description, a.settings,
           COALESCE((SELECT sum(seconds) FROM activity v WHERE v.student_id=a.student_id AND v.tool_id=t.id AND v.day > current_date - 7),0)::int AS seconds_7d,
           (SELECT max(day) FROM activity v WHERE v.student_id=a.student_id AND v.tool_id=t.id) AS last_day
      FROM allocations a JOIN tools t ON t.id=a.tool_id
     WHERE a.student_id=$1 AND a.status='active' AND t.active AND (a.expires_at IS NULL OR a.expires_at > now())
     ORDER BY last_day DESC NULLS LAST, t.name`, [req.user.id]);
  const badges = await db.many(`SELECT ac.title, ac.icon, ac.created_at, t.name AS tool FROM achievements ac LEFT JOIN tools t ON t.id=ac.tool_id
                                 WHERE ac.student_id=$1 ORDER BY ac.created_at DESC LIMIT 12`, [req.user.id]);
  const streak = await db.one(`
    WITH d AS (SELECT DISTINCT day FROM activity WHERE student_id=$1),
    g AS (SELECT day, day - (row_number() OVER (ORDER BY day))::int AS grp FROM d)
    SELECT count(*)::int AS days FROM g WHERE grp = (SELECT grp FROM g WHERE day IN (current_date, current_date - 1) ORDER BY day DESC LIMIT 1)`, [req.user.id]);
  res.json({ tools, badges, streak: streak ? streak.days : 0 });
});

// Adults: the catalog they can assign or preview
r.get('/tools', A.requireRole('admin', 'tutor', 'parent'), async (req, res) => {
  const tools = await db.many(`SELECT id, slug, name, icon, subject, grade_min, grade_max, description, version, source, active, settings_schema
                                 FROM tools ${req.user.role === 'admin' ? '' : 'WHERE active'} ORDER BY subject, grade_min, name`);
  res.json({ tools });
});

module.exports = r;
