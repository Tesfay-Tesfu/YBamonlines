// Space Lab, public page: /space lets a family play the six missions once, free and without an account.
// At the end the parent leaves a WhatsApp number (it lands in Leads, marked "space-lab") to get the certificate.
// Students who have the Space Lab tool use it as a normal tool, as often as they like.
//
// "Once" means: once per browser (a cookie that lasts a year) and at most 3 plays per internet connection
// in 30 days (a family or a classroom on one Wi-Fi). Signed-in admins and tutors can always play, to try it out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');
const config = require('../config');
const spam = require('../spam');

const r = new Router();
const PAGE = path.join(__dirname, '..', '..', 'tools', 'space-lab', 'index.html');
const COOKIE = 'amt_space';
const PLAY_HOURS = 3;          // a started mission can be continued (e.g. after a reload) for 3 hours
const IP_LIMIT = 3, IP_DAYS = 30;
const KEY = crypto.createHash('sha256').update('space-lab:' + config.sessionSecret).digest();
const sign = s => crypto.createHmac('sha256', KEY).update(s).digest('base64url').slice(0, 24);
const DEFAULT_LOGO = 'https://res.cloudinary.com/dnxsqsccu/image/upload/v1785330959/afromerica/logo.png';

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) { const [id, mac] = decodeURIComponent(v.join('=')).split('.'); if (id && mac && sign(id) === mac) return id; }
  }
  return null;
}
function setCookie(res, id) {
  res.setHeader('Set-Cookie', `${COOKIE}=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${config.isProd ? '; Secure' : ''}`);
}
const staff = req => req.user && ['admin', 'tutor'].includes(req.user.role);
const needHeader = req => { if (req.get('x-amt') !== '1') A.fail(403, 'Bad request.'); };

// state of this browser: 'new' (may play), 'active' (playing now), 'played' (used up)
async function state(req) {
  if (staff(req)) return { status: 'new', staff: true };
  const cid = readCookie(req);
  if (cid) {
    const p = await db.one(`SELECT id, finished_at, started_at > now() - interval '${PLAY_HOURS} hours' AS fresh FROM space_plays WHERE cookie_id=$1 ORDER BY id DESC LIMIT 1`, [cid]);
    if (p && !p.finished_at && p.fresh) return { status: 'active', play: p.id };
    if (p) return { status: 'played' };
  }
  const n = await db.one(`SELECT count(*)::int AS n FROM space_plays WHERE ip_hash=$1 AND started_at > now() - interval '${IP_DAYS} days'`, [spam.ipHash(req.ip)]);
  if (n.n >= IP_LIMIT) return { status: 'played', network: true };
  return { status: 'new' };
}

// The page: the same file as the tool, with the public settings added
r.get('/space', async (req, res) => {
  let html = fs.readFileSync(PAGE, 'utf8');
  const logo = /^https:\/\/[^\s"'<>]+$/.test(process.env.LOGO_URL || '') ? process.env.LOGO_URL : DEFAULT_LOGO;
  const boot = { public: true, appUrl: config.appUrl, logo, whatsapp: String(process.env.CONTACT_WHATSAPP || '').replace(/\D/g, ''), ft: spam.formToken(),
    staff: staff(req) ? req.user.name : null };
  const tag = `<script>window.SPACE = ${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`;
  html = html.replace('<!--SPACE-BOOT-->', tag)
    .replace(/\{\{APP_URL\}\}/g, config.appUrl).replace(/\{\{LOGO_URL\}\}/g, logo);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
});

r.get('/api/public/space/status', async (req, res) => res.json(await state(req)));

const limit = A.rateLimit({ windowMs: 60 * 60e3, max: 30, key: 'space' });
r.post('/api/public/space/start', limit, async (req, res) => {
  needHeader(req);
  const st = await state(req);
  if (st.staff) return res.json({ ok: true, staff: true });
  if (st.status === 'played') return res.status(403).json({ played: true, error: 'You have used your free mission.' });
  if (st.status === 'active') return res.json({ ok: true, resumed: true });
  const grade = Math.round(Number(req.body.grade)); const cid = crypto.randomBytes(12).toString('base64url');
  await db.q(`INSERT INTO space_plays(cookie_id, ip_hash, grade, mission, source) VALUES ($1,$2,$3,1,$4)`,
    [cid, spam.ipHash(req.ip), grade >= 1 && grade <= 12 ? grade : null, String(req.body.source || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || null]);
  setCookie(res, cid);
  res.json({ ok: true });
});
r.post('/api/public/space/progress', limit, async (req, res) => {
  needHeader(req);
  const cid = readCookie(req); const m = Math.round(Number(req.body.mission));
  if (cid && m >= 1 && m <= 6) await db.q(`UPDATE space_plays SET mission=GREATEST(mission, $2) WHERE id=(SELECT id FROM space_plays WHERE cookie_id=$1 ORDER BY id DESC LIMIT 1) AND finished_at IS NULL`, [cid, m]);
  res.json({ ok: true });
});
r.post('/api/public/space/finish', limit, async (req, res) => {
  needHeader(req);
  const cid = readCookie(req);
  const score = Math.round(Number(req.body.score)), total = Math.round(Number(req.body.total));
  if (cid) await db.q(`UPDATE space_plays SET finished_at=now(), mission=6, score=$2, total=$3 WHERE id=(SELECT id FROM space_plays WHERE cookie_id=$1 ORDER BY id DESC LIMIT 1) AND finished_at IS NULL`,
    [cid, score >= 0 && score <= 100 ? score : null, total > 0 && total <= 100 ? total : null]);
  res.json({ ok: true });
});

// For the Leads page
async function stats() {
  return db.one(`SELECT count(*)::int AS plays, count(*) FILTER (WHERE finished_at IS NOT NULL)::int AS finished,
      (SELECT count(*)::int FROM leads WHERE source='space-lab' AND status <> 'spam') AS contacts,
      count(*) FILTER (WHERE started_at > now() - interval '7 days')::int AS week
    FROM space_plays`);
}

module.exports = r;
module.exports.stats = stats;
