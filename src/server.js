// AMtutorTools — Afro-Merica Tutor tool platform
const config = require('./config');
const db = require('./db');
const migrate = require('./migrate');
const A = require('./auth');
const { createApp, serveStatic } = require('./http');
const tools = require('./tools');

const app = createApp({
  bodyLimit: config.maxUploadBytes + 1024 * 1024,
  onError(err, req, res) {
    const status = err.status || (err.code === '22P02' ? 400 : 500);
    if (status >= 500) console.error(`${req.method} ${req.path}`, err);
    if (res.headersSent) return res.end();
    res.statusCode = status;
    if (!req.path.startsWith('/tools/')) {
      res.json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>AMtutorTools</title><body style="font-family:system-ui;padding:40px;color:#1f2a37">
        <h2 style="color:#005596">${status === 401 ? 'Please sign in' : 'Not available'}</h2><p>${escapeHtml(err.message)}</p><p><a href="/" target="_top">Back to AMtutorTools</a></p>`);
    }
  },
});
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Security headers for every response
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  return next();
});

app.get('/healthz', async (req, res) => {
  await db.q('SELECT 1');
  res.json({ ok: true });
});

app.use(A.loadUser);
app.use('/api', A.csrfGuard);
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/catalog'));
app.use('/api/sdk', require('./routes/sdk'));
app.use('/api/students', require('./routes/students').router);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/boards', require('./routes/boards'));
app.use('/api/messages', require('./routes/messages'));
app.use(tools.router);

// Front-end (single page app) and the tool SDK
app.use(serveStatic('/sdk/', `${config.publicDir}/sdk`, { maxAge: 300 }));
app.use(serveStatic('/', `${config.publicDir}/app`, { maxAge: 0 }));

async function bootstrapAdmin() {
  const has = await db.one(`SELECT 1 FROM users WHERE role='admin' LIMIT 1`);
  if (has) return;
  if (!config.adminEmail || !config.adminPassword) {
    console.warn('No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, then restart.');
    return;
  }
  const p = A.passwordProblem(config.adminPassword);
  if (p) { console.warn(`ADMIN_PASSWORD rejected: ${p}`); return; }
  await db.q(`INSERT INTO users(role,name,email,password_hash,email_verified) VALUES ('admin','Administrator',$1,$2,true)`,
    [A.normEmail(config.adminEmail), await A.hashSecret(config.adminPassword)]);
  console.log(`Admin account created for ${config.adminEmail}`);
}

async function cleanup() {
  await db.q(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.q(`DELETE FROM email_tokens WHERE expires_at < now()`);
  await require('./routes/messages').cleanupFiles();
}

async function start() {
  await migrate();
  await bootstrapAdmin();
  const found = await tools.scanFolderTools();
  console.log(`Tools from folder: ${found.join(', ') || '(none)'}`);
  await cleanup();
  setInterval(() => cleanup().catch(e => console.error('cleanup', e.message)), 6 * 3600e3).unref();
  app.listen(config.port, () => console.log(`AMtutorTools running on ${config.appUrl} (port ${config.port})`));
}

process.on('unhandledRejection', e => console.error('Unhandled promise rejection:', e));

start().catch(e => { console.error('Startup failed:', e); process.exit(1); });
