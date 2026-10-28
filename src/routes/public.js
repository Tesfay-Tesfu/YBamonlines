// Public interest form (no sign-in): /interest shows the page, POST /api/public/interest saves an answer.
// Admins see the answers on the Leads page and contact parents (WhatsApp, phone, email).
const fs = require('fs');
const path = require('path');
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');
const config = require('../config');
const spam = require('../spam');

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
    .replace('{{OFFER}}', clean(process.env.INTEREST_OFFER, 80).replace(/[<>&"]/g, ''))
    .replace('{{FORM_TOKEN}}', spam.formToken()).replace('{{TURNSTILE_SITE_KEY}}', spam.turnstileOn() ? spam.turnstile.site.replace(/[^\w-]/g, '') : '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
});
r.get('/interest/options', (req, res) => res.json(OPT));

const limit = A.rateLimit({ windowMs: 60 * 60e3, max: 8, key: 'interest' });
const ok = res => res.json({ ok: true });     // bots get the same answer as people, so they learn nothing
r.post('/api/public/interest', limit, async (req, res) => {
  const b = req.body || {};
  if (b.website) return ok(res);                                        // hidden field: only bots fill it in
  const name = clean(b.parent_name, 80), phone = clean(b.phone, 40), email = clean(b.email, 120).toLowerCase();
  if (!name) A.fail(400, 'Please enter your name.');
  const digits = phoneDigits(phone);
  if (digits.length < 8 || digits.length > 15) A.fail(400, 'Please enter a WhatsApp or phone number we can reach.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) A.fail(400, 'That email address doesn’t look right.');
  if (!b.consent) A.fail(400, 'Please tick the box so we may contact you.');
  const subjects = pickList(b.subjects, OPT.subjects);
  if (!subjects.length) A.fail(400, 'Please choose at least one subject.');
  if (!(await spam.checkTurnstile(b.cf, req.ip))) A.fail(400, 'Please complete the “I’m human” check, then press Send again.');
  const lead = { parent_name: name, phone, phone_digits: digits, email: email || null, city: clean(b.city, 80) || null, message: clean(b.message, 1000) || null };

  if (await spam.blocked(lead, req.ip)) return ok(res);                 // on the admin's block list: drop quietly
  let reason = spam.checkToken(b.ft) || spam.contentReason(lead);
  if (!reason && await spam.flooding()) reason = 'too many answers in one hour';
  if (reason && await spam.spamFull()) return ok(res);                 // under attack: don't fill the database

  // Same number again within a day: update that answer instead of adding a copy
  if (!reason) {
    const prev = await db.one(`SELECT id FROM leads WHERE phone_digits=$1 AND status <> 'spam' AND created_at > now() - interval '1 day' ORDER BY id DESC LIMIT 1`, [digits]);
    if (prev) {
      await db.q(`UPDATE leads SET repeats=repeats+1, subjects=(SELECT array_agg(DISTINCT x) FROM unnest(subjects || $2::text[]) x),
          message=CASE WHEN $3::text IS NULL OR message IS NOT DISTINCT FROM $3 THEN message ELSE concat_ws(E'\n---\n', message, $3) END, updated_at=now() WHERE id=$1`,
        [prev.id, subjects, lead.message]);
      return res.json({ ok: true, id: prev.id });
    }
  }
  const row = await db.one(`INSERT INTO leads(parent_name, phone, phone_digits, email, city, grades, subjects, goals, formats, times, start_when, heard, source, message, consent_at, status, spam_reason, ip_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15, $16, $17) RETURNING id`,
    [name, phone, digits, lead.email, lead.city, pickList(b.grades, OPT.grades), subjects, pickList(b.goals, OPT.goals),
      pickList(b.formats, OPT.formats), pickList(b.times, OPT.times), OPT.start.includes(b.start_when) ? b.start_when : null,
      OPT.heard.includes(b.heard) ? b.heard : null, clean(b.source, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '') || null, lead.message,
      reason ? 'spam' : 'new', reason, spam.ipHash(req.ip)]);
  res.json({ ok: true, id: reason ? undefined : row.id });
});

module.exports = r;
module.exports.OPT = OPT;
