// A small, dependency-free HTTP framework: routing with :params, JSON bodies,
// async handlers, static files. Keeps the project to one npm dependency (pg).
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
};
const mimeOf = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function compile(pattern) {
  if (pattern === '*') return { re: /^.*$/, keys: [] };
  const keys = [];
  let src = pattern.replace(/\/$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  if (src.endsWith('/\\*') || src.endsWith('\\*')) { src = src.replace(/\/?\\\*$/, '(?:/(.*))?'); keys.push('rest'); }
  return { re: new RegExp(`^${src || ''}/?$`), keys };
}

class Router {
  constructor() { this.stack = []; }
  use(prefix, ...fns) {
    if (typeof prefix !== 'string') { fns.unshift(prefix); prefix = ''; }
    for (const fn of fns) {
      if (fn instanceof Router) {
        for (const l of fn.stack) this.stack.push({ ...l, pattern: prefix + l.pattern, ...compileLayer(prefix + l.pattern, l.mw) });
      } else {
        this.stack.push({ method: null, pattern: prefix, mw: true, fns: [fn], ...compileLayer(prefix, true) });
      }
    }
    return this;
  }
  route(method, pattern, fns) { this.stack.push({ method, pattern, mw: false, fns, ...compileLayer(pattern, false) }); return this; }
  get(p, ...f) { return this.route('GET', p, f); }
  post(p, ...f) { return this.route('POST', p, f); }
  put(p, ...f) { return this.route('PUT', p, f); }
  patch(p, ...f) { return this.route('PATCH', p, f); }
  delete(p, ...f) { return this.route('DELETE', p, f); }
}
function compileLayer(pattern, mw) {
  if (mw) return { prefixRe: pattern ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}(/|$)`) : null };
  return compile(pattern);
}

function enhance(req, res) {
  const url = new URL(req.url, 'http://x');
  req.path = decodeURIComponent(url.pathname);
  req.query = Object.fromEntries(url.searchParams);
  req.get = h => req.headers[h.toLowerCase()];
  // Client address. Render sits behind Cloudflare, which sets CF-Connecting-IP / True-Client-IP itself (a visitor
  // can't fake them). The first X-Forwarded-For entry can be typed in by anyone, so it is only the last resort.
  const fwd = req.headers['x-forwarded-for'];
  req.ip = String(req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || (fwd ? String(fwd).split(',')[0] : '') || req.socket.remoteAddress || '').trim();
  res.status = c => { res.statusCode = c; return res; };
  res.json = obj => {
    if (res.headersSent) return;
    const body = JSON.stringify(obj);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  };
  res.send = (body, type) => {
    if (res.headersSent) return;
    if (type) res.setHeader('Content-Type', type);
    res.end(body);
  };
  res.redirect = (loc, code = 302) => { res.statusCode = code; res.setHeader('Location', loc); res.end(); };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createApp({ bodyLimit = 1e6, onError } = {}) {
  const app = new Router();
  app.handle = async (req, res) => {
    enhance(req, res);
    req.body = {};
    try {
      if (!['GET', 'HEAD'].includes(req.method) && /json/.test(req.headers['content-type'] || '')) {
        const raw = await readBody(req, bodyLimit);
        try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
        catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
        if (!req.body || typeof req.body !== 'object') req.body = {};
      }
      const layers = app.stack;
      let i = 0;
      const next = async err => {
        if (err) throw err;
        while (i < layers.length) {
          const l = layers[i++];
          if (l.mw) {
            if (l.prefixRe && !l.prefixRe.test(req.path)) continue;
            return run(l.fns, next);
          }
          if (l.method !== req.method && !(l.method === 'GET' && req.method === 'HEAD')) continue;
          const m = l.re.exec(req.path);
          if (!m) continue;
          req.params = {};
          l.keys.forEach((k, j) => { req.params[k] = m[j + 1] !== undefined ? decodeURIComponent(m[j + 1]) : undefined; });
          return run(l.fns, next);
        }
        res.status(404).json({ error: 'Not found' });
      };
      const run = async (fns, done) => {
        let j = 0;
        const step = async err => {
          if (err) throw err;
          if (res.writableEnded) return;
          if (j >= fns.length) return done();
          const fn = fns[j++];
          // `pending` keeps errors from a next() call even if the middleware forgot to return it
          let pending = null;
          await fn(req, res, e => (pending = step(e)));
          if (pending) await pending;
        };
        return step();
      };
      await next();
    } catch (err) {
      if (onError) onError(err, req, res);
      else { res.statusCode = err.status || 500; res.end(err.message); }
    }
  };
  app.listen = (port, cb) => http.createServer(app.handle).listen(port, cb);
  return app;
}

// Static file middleware: serves files under `dir` for paths starting with `prefix`.
function serveStatic(prefix, dir, { maxAge = 0, index = 'index.html' } = {}) {
  const root = path.resolve(dir);
  return async (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !req.path.startsWith(prefix)) return next();
    let rel = req.path.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += index;
    const file = path.resolve(root, '.' + path.sep + rel);
    if (!file.startsWith(root + path.sep)) return next();
    let st;
    try { st = await fs.promises.stat(file); } catch { return next(); }
    if (!st.isFile()) return next();
    res.setHeader('Content-Type', mimeOf(file));
    res.setHeader('Content-Length', st.size);
    res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-cache');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };
}

module.exports = { createApp, Router, serveStatic, mimeOf };
