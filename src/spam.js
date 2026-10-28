// Spam protection for the public interest form.
// Layers (cheapest first): rate limit per connection -> hidden "website" field -> signed one-time form token
// (proves the page was really opened, and not too fast) -> optional Cloudflare Turnstile check -> admin block list
// -> content checks. Real-looking answers that fail a soft check go to the Spam folder instead of being lost,
// so an admin can rescue a real parent with one click.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const KEY = crypto.createHash('sha256').update('interest-form:' + config.sessionSecret).digest();
const MIN_MS = 4000, MAX_MS = 24 * 3600e3;            // the form must be open at least 4 s, at most a day
const used = new Map();                                // token nonce -> expiry (one instance; tokens are single use)
setInterval(() => { const now = Date.now(); for (const [k, t] of used) if (t < now) used.delete(k); }, 10 * 60e3).unref();

const b64 = buf => buf.toString('base64url');
const sign = s => b64(crypto.createHmac('sha256', KEY).update(s).digest()).slice(0, 32);
function formToken() { const s = `${Date.now().toString(36)}.${b64(crypto.randomBytes(9))}`; return `${s}.${sign(s)}`; }
// -> null when fine, or a reason
function checkToken(tok) {
  const p = String(tok || '').split('.');
  if (p.length !== 3) return 'no form token (sent without opening the form)';
  const s = `${p[0]}.${p[1]}`, mac = sign(s);
  if (p[2].length !== mac.length || !crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(mac))) return 'forged form token';
  const age = Date.now() - parseInt(p[0], 36);
  if (!(age >= MIN_MS)) return 'filled in too fast';
  if (age > MAX_MS) return 'form open for more than a day';
  if (used.has(p[1])) return 'form token used twice';
  used.set(p[1], Date.now() + MAX_MS);
  return null;
}
const ipHash = ip => crypto.createHmac('sha256', KEY).update(String(ip || '')).digest('hex').slice(0, 16);

// Optional Cloudflare Turnstile (free, privacy-friendly "I'm human" check). Off unless both keys are set.
const turnstile = { site: process.env.TURNSTILE_SITE_KEY || '', secret: process.env.TURNSTILE_SECRET_KEY || '' };
const turnstileOn = () => !!(turnstile.site && turnstile.secret);
async function checkTurnstile(token, ip) {
  if (!turnstileOn()) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: turnstile.secret, response: String(token).slice(0, 2048), remoteip: ip || '' }), signal: AbortSignal.timeout(8000) });
    return !!(await r.json()).success;
  } catch (e) { console.error('Turnstile check failed', e.message); return true; } // Cloudflare unreachable: don't lose real parents
}

// Words that real parents asking about tutoring don't write. Admins add their own on the Leads page.
const SPAM_WORDS = ['bitcoin', 'crypto', 'forex', 'binary option', 'casino', 'betting', 'viagra', 'cialis', 'porn', 'xxx', 'sex', 'escort', 'dating',
  'payday loan', 'seo', 'backlink', 'rank your', 'web design', 'website design', 'traffic to your', 'marketing services', 'guest post',
  'investment opportunity', 'earn $', 'make money', 'work from home', 'gift card', 'wallet', 'airdrop', 'giveaway', 'click here', 'unsubscribe', 'whatsapp me at', 'telegram me'];
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ru|cn|xyz|top|info|biz|io|co|me|ly|link|click|site|online|shop)\b|t\.me\/|bit\.ly)/i;
function contentReason(l) {
  const text = `${l.parent_name} ${l.city || ''} ${l.message || ''}`.toLowerCase();
  if (/<[a-z!/][^>]*>/i.test(text)) return 'contains HTML';
  if (LINK.test(text)) return 'contains a web link';
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(`${l.parent_name} ${l.message || ''}`)) return 'email address in name or message';
  const w = SPAM_WORDS.find(x => new RegExp(`(^|[^a-z])${x.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}($|[^a-z])`, 'i').test(text));
  if (w) return `spam word “${w}”`;
  if (/\d{3,}/.test(l.parent_name)) return 'numbers in the name';
  if (l.parent_name.split(/\s+/).length > 6) return 'name is too long';
  if (/(.)\1{5,}/.test(text)) return 'repeated characters';
  const d = l.phone_digits.slice(-9);
  if (new Set(d).size <= 2 || '0123456789012345678'.includes(d) || '9876543210987654321'.includes(d)) return 'fake-looking phone number';
  return null;
}

async function blocked(l, ip) {
  const rows = await db.many('SELECT kind, value FROM lead_blocks');
  const text = `${l.parent_name} ${l.city || ''} ${l.message || ''}`.toLowerCase();
  for (const b of rows) {
    if (b.kind === 'phone' && l.phone_digits.endsWith(b.value.replace(/\D/g, '').slice(-9))) return `blocked number ${b.value}`;
    if (b.kind === 'email' && l.email && (l.email === b.value || (b.value.startsWith('@') && l.email.endsWith(b.value)))) return `blocked email ${b.value}`;
    if (b.kind === 'word' && text.includes(b.value.toLowerCase())) return `blocked word “${b.value}”`;
    if (b.kind === 'ip' && b.value === ipHash(ip)) return 'blocked connection';
  }
  return null;
}

// Too many answers in a short time (a flood): the extra ones go to Spam for a person to look at.
const FLOOD_PER_HOUR = Number(process.env.INTEREST_MAX_PER_HOUR || 40);
async function flooding() {
  const r = await db.one(`SELECT count(*)::int AS n FROM leads WHERE created_at > now() - interval '1 hour' AND status <> 'spam'`);
  return r.n >= FLOOD_PER_HOUR;
}
async function spamFull() {
  const r = await db.one(`SELECT count(*)::int AS n FROM leads WHERE created_at > now() - interval '1 hour' AND status = 'spam'`);
  return r.n >= 300;   // during an attack, stop storing spam at all
}
async function cleanupSpam() { await db.q(`DELETE FROM leads WHERE status='spam' AND created_at < now() - interval '30 days'`); }

module.exports = { formToken, checkToken, ipHash, turnstile, turnstileOn, checkTurnstile, contentReason, blocked, flooding, spamFull, cleanupSpam };
