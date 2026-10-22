// Sends email through an HTTP email service (no SMTP library needed).
// Set ONE of: RESEND_API_KEY (resend.com) or BREVO_API_KEY (brevo.com), plus MAIL_FROM.
// Without a key, emails are printed to the server log, and admins can verify accounts by hand.
const config = require('./config');

const provider = process.env.RESEND_API_KEY ? 'resend' : process.env.BREVO_API_KEY ? 'brevo' : null;
const mailEnabled = () => !!provider;

function parseFrom(from) {
  const m = String(from).match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: 'AMtutorTools', email: String(from).trim() };
}

async function sendMail({ to, subject, text }) {
  if (!provider) {
    console.log(`\n[mail not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return false;
  }
  try {
    let resp;
    if (provider === 'resend') {
      resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
      });
    } else {
      resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: parseFrom(config.mailFrom), to: [{ email: to }], subject, textContent: text }),
      });
    }
    if (!resp.ok) { console.error('sendMail failed:', resp.status, await resp.text()); return false; }
    return true;
  } catch (e) {
    console.error('sendMail failed:', e.message);
    return false;
  }
}

module.exports = { sendMail, mailEnabled };
