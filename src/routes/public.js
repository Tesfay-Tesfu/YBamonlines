// Public interest form (no sign-in): /interest shows the page, POST /api/public/interest saves an answer.
// Admins see the answers on the Leads page and contact parents (WhatsApp, phone, email).
const fs = require('fs');
const path = require('path');
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');
const config = require('../config');

const r = new Router();
const OPT = {
  grades: ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  subjects: ['Math', 'Physics', 'Science', 'Python for Kids'],
  goals: ['Catch up', 'Build confidence', 'Get ahead', 'Test prep', 'Projects & competitions'],
  formats: ['Online 1-on-1', 'Online small group', 'In person'],
  times: ['Weekday afternoons', 'Weekday evenings', 'Weekends'],
  start: ['Right away', 'In a few weeks', 'Just exploring'],
  heard: ['WhatsApp', 'Telegram', 'Facebook', 'Instagram', 'TikTok', 'A friend or family', 'School or community', 'Other'],
};
const pickList = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map(String))].filter(x => allowed.includes(x));
const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);
const DEFAULT_CC = String(process.env.CONTACT_DEFAULT_COUNTRY || '1').replace(/\D/g, '') || '1';
function phoneDigits(p) {
  const raw = String(p || '').trim(), d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || raw.startsWith('00')) return d.replace(/^00/, '');
  if (d.length === 10 && DEFAULT_CC === '1') return '1' + d;          // US/Canada number without +1
  if (d.length === 11 && d.startsWith('1') && DEFAULT_CC === '1') return d;
  return d.startsWith(DEFAULT_CC) ? d : DEFAULT_CC + d.replace(/^0+/, '');
}

// The page itself, with the site address filled in for link previews (WhatsApp, Telegram, Facebook)
const DEFAULT_LOGO = 'https://res.cloudinary.com/dnxsqsccu/image/upload/v1785330959/afromerica/logo.png';
const PAGE = path.join(config.publicDir, 'app', 'interest.html');
r.get('/interest', (req, res) => {
  let html = fs.readFileSync(PAGE, 'utf8');
  const wa = String(process.env.CONTACT_WHATSAPP || '').replace(/\D/g, '');
  const logo = /^https:\/\/[^\s"'<>]+$/.test(process.env.LOGO_URL || '') ? process.env.LOGO_URL : DEFAULT_LOGO;
  html = html.replace(/\{\{APP_URL\}\}/g, config.appUrl).replace(/\{\{LOGO_URL\}\}/g, logo)
    .replace('{{CONTACT_WHATSAPP}}', wa)
    .replace('{{OFFER}}', clean(process.env.INTEREST_OFFER, 80).replace(/[<>&"]/g, ''));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
});
r.get('/interest/options', (req, res) => res.json(OPT));

const limit = A.rateLimit({ windowMs: 60 * 60e3, max: 8, key: 'interest' });
r.post('/api/public/interest', limit, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });                         // hidden field: bots fill it in
  if (Number(b.t) && Date.now() - Number(b.t) < 2500) return res.json({ ok: true }); // filled in impossibly fast
  const name = clean(b.parent_name, 80), phone = clean(b.phone, 40), email = clean(b.email, 120).toLowerCase();
  if (!name) A.fail(400, 'Please enter your name.');
  const digits = phoneDigits(phone);
  if (digits.length < 8 || digits.length > 15) A.fail(400, 'Please enter a WhatsApp or phone number we can reach.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) A.fail(400, 'That email address doesn’t look right.');
  if (!b.consent) A.fail(400, 'Please tick the box so we may contact you.');
  const subjects = pickList(b.subjects, OPT.subjects);
  if (!subjects.length) A.fail(400, 'Please choose at least one subject.');
  const row = await db.one(`INSERT INTO leads(parent_name, phone, phone_digits, email, city, grades, subjects, goals, formats, times, start_when, heard, source, message, consent_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now()) RETURNING id`,
    [name, phone, digits, email || null, clean(b.city, 80) || null, pickList(b.grades, OPT.grades), subjects, pickList(b.goals, OPT.goals),
      pickList(b.formats, OPT.formats), pickList(b.times, OPT.times), OPT.start.includes(b.start_when) ? b.start_when : null,
      OPT.heard.includes(b.heard) ? b.heard : null, clean(b.source, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '') || null, clean(b.message, 1000) || null]);
  res.json({ ok: true, id: row.id });
});

module.exports = r;
module.exports.OPT = OPT;
