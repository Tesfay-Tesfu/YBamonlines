// Meetings: scheduled online classes (Google Meet, Zoom, …) with the joining link.
// Admins create, change and delete them. Everyone else only sees the classes that concern them:
//   students – classes they are in; parents – their children's classes;
//   tutors   – classes they teach (tutor_id), or, for classes without a tutor, classes with their students.
const { Router } = require('../http');
const db = require('../db');
const A = require('../auth');
const config = require('../config');

const r = new Router();
r.use(A.requireLogin);

// ---------------------------------------------------------------- time zones
// Offset (ms) of a time zone at a UTC instant, using the built-in time zone data.
function tzOffset(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - utcMs;
}
// Wall-clock date + time in a time zone -> UTC milliseconds (handles daylight saving time)
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz);
  return utc;
}
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const ymd = dt => dt.toISOString().slice(0, 10);
const toDateStr = v => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v ? String(v).slice(0, 10) : null);

// All occurrences of a meeting between two UTC instants
function occurrences(m, fromMs, toMs) {
  const out = [], start = toDateStr(m.start_date), until = toDateStr(m.until_date), dur = m.duration_min * 60e3;
  const add = d => { const s = zonedToUtc(d, m.start_time, m.tz); if (s + dur > fromMs && s < toMs) out.push({ meeting_id: m.id, date: d, start: new Date(s).toISOString(), end: new Date(s + dur).toISOString() }); };
  if (m.repeat !== 'weekly') { add(start); return out; }
  // walk the calendar days from the later of (start, from - 1 day) to the earlier of (until, to + 1 day)
  let day = new Date(Math.max(Date.parse(start + 'T00:00:00Z'), fromMs - 86400e3));
  day = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const last = Math.min(until ? Date.parse(until + 'T00:00:00Z') : Infinity, toMs + 86400e3);
  for (let n = 0; day.getTime() <= last && n < 800; n++, day = new Date(day.getTime() + 86400e3)) {
    if (m.days.includes(day.getUTCDay()) && ymd(day) >= start) add(ymd(day));
  }
  return out;
}

// ---------------------------------------------------------------- who sees what
async function visibleMeetings(u, id = null) {
  const params = [], cond = [];
  if (id) { params.push(id); cond.push(`m.id=$${params.length}`); }
  if (u.role === 'student') { params.push(u.id); cond.push(`EXISTS (SELECT 1 FROM meeting_students ms WHERE ms.meeting_id=m.id AND ms.student_id=$${params.length})`); }
  else if (u.role === 'parent') { params.push(u.id); cond.push(`EXISTS (SELECT 1 FROM meeting_students ms JOIN student_links l ON l.student_id=ms.student_id WHERE ms.meeting_id=m.id AND l.adult_id=$${params.length} AND l.relation='parent')`); }
  else if (u.role === 'tutor') { params.push(u.id); cond.push(`(m.tutor_id=$${params.length} OR (m.tutor_id IS NULL AND EXISTS (SELECT 1 FROM meeting_students ms JOIN student_links l ON l.student_id=ms.student_id WHERE ms.meeting_id=m.id AND l.adult_id=$${params.length} AND l.relation='tutor')))`); }
  // students in each class: adults see the ones they are linked to (admins: all); students see only themselves
  const who = u.role === 'admin' ? 'true' : u.role === 'student' ? `s.id=${Number(u.id)}` : `EXISTS (SELECT 1 FROM student_links l WHERE l.student_id=s.id AND l.adult_id=${Number(u.id)})`;
  return db.many(`SELECT m.id, m.title, m.meet_url, m.dial, m.pin, m.more_url, m.notes, m.tz, to_char(m.start_date,'YYYY-MM-DD') AS start_date, m.start_time, m.duration_min,
      m.repeat, m.days, to_char(m.until_date,'YYYY-MM-DD') AS until_date, m.tutor_id, t.name AS tutor_name, t.subject AS tutor_subject,
      COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'grade', s.grade) ORDER BY s.name) FROM meeting_students ms JOIN users s ON s.id=ms.student_id WHERE ms.meeting_id=m.id AND ${who}), '[]') AS students,
      (SELECT count(*)::int FROM meeting_students ms WHERE ms.meeting_id=m.id) AS student_count
    FROM meetings m LEFT JOIN users t ON t.id=m.tutor_id ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY m.start_date, m.start_time`, params);
}

// List with occurrences between ?from and ?to (ISO dates; default: now to 35 days ahead)
r.get('/', async (req, res) => {
  const from = Date.parse(req.query.from) || Date.now() - 3600e3, to = Math.min(Date.parse(req.query.to) || Date.now() + 35 * 86400e3, from + 400 * 86400e3);
  const meetings = await visibleMeetings(req.user);
  const sessions = meetings.flatMap(m => occurrences(m, from, to)).sort((a, b) => a.start.localeCompare(b.start));
  res.json({ meetings, sessions, canEdit: req.user.role === 'admin' });
});

// ---------------------------------------------------------------- calendar file (.ics)
const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s) > 74) { let n = 74; while (Buffer.byteLength(s.slice(0, n)) > 74) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };
const utcStamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
r.get('/:id/ics', async (req, res) => {
  const [m] = await visibleMeetings(req.user, Number(req.params.id));
  if (!m) A.fail(404, 'Meeting not found.');
  const start = zonedToUtc(m.start_date, m.start_time, m.tz), end = start + m.duration_min * 60e3;
  // Local wall time with the IANA zone name, so weekly classes stay at 3:30 pm through daylight-saving changes
  const local = ms => { const d = new Date(ms + tzOffset(ms, m.tz)); return utcStamp(d.getTime()).replace('Z', ''); };
  const desc = [`Join: ${m.meet_url}`, m.dial ? `Dial: ${m.dial}${m.pin ? ` PIN: ${m.pin}#` : ''}` : '', m.more_url ? `More phone numbers: ${m.more_url}` : '', m.notes || '', `Schedule: ${config.appUrl}/#/meetings`].filter(Boolean).join('\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Afro-Merica Tutor//AMtutorTools//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:meeting-${m.id}@amtutortools`, `DTSTAMP:${utcStamp(Date.now())}`, `DTSTART;TZID=${m.tz}:${local(start)}`, `DTEND;TZID=${m.tz}:${local(end)}`,
    `SUMMARY:${icsEsc(m.title)}`, `LOCATION:${icsEsc(m.meet_url)}`, `URL:${icsEsc(m.meet_url)}`, `DESCRIPTION:${icsEsc(desc)}`];
  if (m.repeat === 'weekly' && m.days.length) {
    const D = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'], byday = m.days.map(d => D[d]).join(',');
    lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${byday}${m.until_date ? `;UNTIL=${utcStamp(zonedToUtc(m.until_date, '23:59', m.tz))}` : ''}`);
  }
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Class starts in 15 minutes', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${m.title.replace(/[^\w-]+/g, '_').slice(0, 60) || 'class'}.ics"`);
  res.end(lines.map(fold).join('\r\n') + '\r\n');
});

// ---------------------------------------------------------------- admins: create / change / delete
function readMeeting(b) {
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) A.fail(400, 'Give the class a name.');
  const url = String(b.meet_url || '').trim();
  if (!/^https:\/\/[^\s<>"']+$/i.test(url)) A.fail(400, 'Paste the meeting link (it starts with https://).');
  const more = String(b.more_url || '').trim();
  if (more && !/^https:\/\/[^\s<>"']+$/i.test(more)) A.fail(400, 'The “more phone numbers” link must start with https://.');
  const tz = String(b.tz || 'America/New_York'); if (!validTz(tz)) A.fail(400, 'Unknown time zone.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) A.fail(400, 'Choose the date.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start_time || '')) A.fail(400, 'Choose the start time.');
  const dur = Math.round(Number(b.duration_min)); if (!(dur >= 5 && dur <= 720)) A.fail(400, 'The class must last between 5 minutes and 12 hours.');
  const repeat = b.repeat === 'weekly' ? 'weekly' : 'none';
  let days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  if (repeat === 'weekly' && !days.length) days = [new Date(b.start_date + 'T12:00:00Z').getUTCDay()];
  const until = repeat === 'weekly' && /^\d{4}-\d{2}-\d{2}$/.test(b.until_date || '') ? b.until_date : null;
  if (until && until < b.start_date) A.fail(400, 'The end date is before the first class.');
  return { title, url, dial: String(b.dial || '').trim().slice(0, 60) || null, pin: String(b.pin || '').replace(/[^\d]/g, '').slice(0, 20) || null, more: more || null,
    notes: String(b.notes || '').trim().slice(0, 1000) || null, tz, start_date: b.start_date, start_time: b.start_time, dur, repeat, days: repeat === 'weekly' ? days : [], until };
}
async function saveStudents(c, meetingId, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  await c.query('DELETE FROM meeting_students WHERE meeting_id=$1', [meetingId]);
  if (list.length) await c.query(`INSERT INTO meeting_students(meeting_id, student_id) SELECT $1, id FROM users WHERE role='student' AND id = ANY($2::int[])`, [meetingId, list]);
}
async function readTutor(v) {
  const id = Number(v) || null;
  if (id && !(await db.one(`SELECT 1 FROM users WHERE id=$1 AND role='tutor'`, [id]))) A.fail(400, 'Tutor not found.');
  return id;
}
r.post('/', A.requireRole('admin'), async (req, res) => {
  const m = readMeeting(req.body), tutor = await readTutor(req.body.tutor_id);
  const id = await db.tx(async c => {
    const row = (await c.query(`INSERT INTO meetings(title, meet_url, dial, pin, more_url, notes, tz, start_date, start_time, duration_min, repeat, days, until_date, tutor_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [m.title, m.url, m.dial, m.pin, m.more, m.notes, m.tz, m.start_date, m.start_time, m.dur, m.repeat, m.days, m.until, tutor, req.user.id])).rows[0];
    await saveStudents(c, row.id, req.body.students);
    return row.id;
  });
  A.audit(req, 'create_meeting', null, { id, title: m.title });
  res.json({ ok: true, id });
});
r.patch('/:id', A.requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!(await db.one('SELECT 1 FROM meetings WHERE id=$1', [id]))) A.fail(404, 'Meeting not found.');
  const m = readMeeting(req.body), tutor = await readTutor(req.body.tutor_id);
  await db.tx(async c => {
    await c.query(`UPDATE meetings SET title=$2, meet_url=$3, dial=$4, pin=$5, more_url=$6, notes=$7, tz=$8, start_date=$9, start_time=$10, duration_min=$11, repeat=$12, days=$13, until_date=$14, tutor_id=$15, updated_at=now() WHERE id=$1`,
      [id, m.title, m.url, m.dial, m.pin, m.more, m.notes, m.tz, m.start_date, m.start_time, m.dur, m.repeat, m.days, m.until, tutor]);
    if (req.body.students !== undefined) await saveStudents(c, id, req.body.students);
  });
  A.audit(req, 'update_meeting', null, { id, title: m.title });
  res.json({ ok: true });
});
r.delete('/:id', A.requireRole('admin'), async (req, res) => {
  const m = await db.one('DELETE FROM meetings WHERE id=$1 RETURNING title', [Number(req.params.id)]);
  if (!m) A.fail(404, 'Meeting not found.');
  A.audit(req, 'delete_meeting', null, { title: m.title });
  res.json({ ok: true });
});

module.exports = r;
module.exports._test = { zonedToUtc, occurrences };
