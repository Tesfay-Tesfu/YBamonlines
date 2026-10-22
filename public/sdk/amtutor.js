/*!
 * AMtutorTools SDK — loaded automatically into every tool page.
 *
 * What it gives a tool (window.AMT):
 *   AMT.mode        'student' (saved) | 'review' (adult viewing a student, not saved) | 'preview' | 'standalone'
 *   AMT.student     { id, name, firstName, grade } or null
 *   AMT.viewer      { id, role, name }  role: student | parent | tutor | admin
 *   AMT.settings    the tutor's plan for this tool (fields from manifest.json "settings")
 *   AMT.isStudent   true when the student is using the tool
 *   AMT.isAdult     true for parent / tutor / admin viewers
 *   AMT.storage     localStorage-compatible store saved on the server, per student and tool
 *   AMT.attempt({question, response, answer, correct, ms, topic, mode, session, meta})
 *   AMT.award(code, title, icon)          give a badge once (shown to parents and tutors)
 *   AMT.history({limit, days})            Promise of past attempts (for records screens)
 *   AMT.flush()                           save now
 *
 * Existing tools that use window.localStorage work unchanged: in the platform,
 * localStorage is replaced by AMT.storage, so each student's data is saved on the server.
 */
(function () {
  'use strict';
  var BOOT = window.__AMT_BOOT || null;
  var realLS = null;
  try { realLS = window.localStorage; } catch (e) { /* blocked */ }

  var mode = BOOT ? BOOT.mode : 'standalone';
  var save = mode === 'student';
  var slug = BOOT ? BOOT.tool.slug : 'standalone';
  var student = BOOT ? BOOT.student : null;
  var viewer = BOOT ? BOOT.viewer : { id: 0, role: 'student', name: 'Student' };
  var backupKey = student ? 'amt-pending:' + student.id + ':' + slug : null;
  var HDR = { 'Content-Type': 'application/json', 'X-AMT': '1' };

  function api(path, body, keepalive) {
    return fetch(path, { method: 'POST', headers: HDR, body: JSON.stringify(body), credentials: 'same-origin', keepalive: !!keepalive })
      .then(function (r) {
        if (r.status === 401) { status('signin'); throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  // ------------------------------------------------------------------ storage
  var data = {};
  var pending = { set: {}, remove: {}, clear: false };
  var hasPending = false, timer = null, saving = false, failCount = 0;

  if (BOOT) {
    var st = BOOT.state || {};
    for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) data[k] = String(st[k]);
    // replay changes that didn't reach the server last time (e.g. Wi-Fi dropped)
    if (save && realLS && backupKey) {
      try {
        var b = JSON.parse(realLS.getItem(backupKey) || 'null');
        if (b) {
          if (b.clear) data = {};
          for (var rk in b.remove) delete data[rk];
          for (var sk in b.set) data[sk] = b.set[sk];
          pending = b; hasPending = true;
        }
      } catch (e) { /* ignore */ }
    }
  }

  function backup() {
    if (!save || !realLS || !backupKey) return;
    try { hasPending ? realLS.setItem(backupKey, JSON.stringify(pending)) : realLS.removeItem(backupKey); } catch (e) { /* full */ }
  }
  function schedule(delay) {
    if (!save) return;
    clearTimeout(timer);
    timer = setTimeout(flushState, delay == null ? 1500 : delay);
  }
  function flushState(keepalive) {
    if (!save || !hasPending || (saving && !keepalive)) return Promise.resolve();
    var batch = { set: pending.set, remove: Object.keys(pending.remove), clear: pending.clear };
    pending = { set: {}, remove: {}, clear: false }; hasPending = false;
    var sent = JSON.stringify(batch).length;
    saving = true; status('saving');
    return api('/api/sdk/' + slug + '/state', batch, keepalive && sent < 60000)
      .then(function () { saving = false; failCount = 0; backup(); status(hasPending ? 'saving' : 'saved'); if (hasPending) schedule(); })
      .catch(function () {
        saving = false; failCount++;
        // put the batch back underneath anything newer
        var merged = { set: Object.assign({}, batch.set, pending.set), remove: {}, clear: batch.clear || pending.clear };
        batch.remove.forEach(function (x) { if (!(x in pending.set)) merged.remove[x] = 1; });
        for (var x in pending.remove) { merged.remove[x] = 1; delete merged.set[x]; }
        pending = merged; hasPending = true; backup();
        status('offline');
        schedule(Math.min(30000, 2000 * Math.pow(2, failCount)));
      });
  }

  var storage = {
    getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem: function (key, value) {
      key = String(key); value = String(value);
      if (data[key] === value) return;
      data[key] = value;
      if (!save) return;
      pending.set[key] = value; delete pending.remove[key]; hasPending = true; backup(); schedule();
    },
    removeItem: function (key) {
      key = String(key);
      if (!(key in data)) return;
      delete data[key];
      if (!save) return;
      delete pending.set[key]; pending.remove[key] = 1; hasPending = true; backup(); schedule();
    },
    clear: function () {
      data = {};
      if (!save) return;
      pending = { set: {}, remove: {}, clear: true }; hasPending = true; backup(); schedule();
    },
    key: function (i) { return Object.keys(data)[i] || null; },
    get length() { return Object.keys(data).length; },
  };

  if (BOOT) {
    try { Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return storage; } }); }
    catch (e) { console.warn('AMT: could not replace localStorage; use AMT.storage instead.'); }
  }

  // ------------------------------------------------------------------ attempts
  var aQueue = [], aTimer = null;
  var sessionKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function attempt(rec) {
    if (!save || !rec) return;
    aQueue.push({
      question: rec.question, response: rec.response, answer: rec.answer, correct: !!rec.correct,
      ms: rec.ms, topic: rec.topic, mode: rec.mode, session: rec.session || sessionKey, meta: rec.meta, ts: rec.ts || Date.now(),
    });
    if (aQueue.length >= 25) flushAttempts(); else { clearTimeout(aTimer); aTimer = setTimeout(flushAttempts, 4000); }
  }
  function flushAttempts(keepalive) {
    if (!save || !aQueue.length) return Promise.resolve();
    var items = aQueue.splice(0, 300);
    return api('/api/sdk/' + slug + '/attempts', { items: items }, keepalive)
      .catch(function () { aQueue = items.concat(aQueue).slice(-2000); clearTimeout(aTimer); aTimer = setTimeout(flushAttempts, 15000); });
  }

  // ------------------------------------------------------------------ time on task
  var lastInput = Date.now(), activeSecs = 0, TICK = 15;
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastInput = Date.now(); }, { passive: true, capture: true });
  });
  function localDay() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function flushActivity(keepalive) {
    if (!save || activeSecs < 1) return;
    var s = activeSecs; activeSecs = 0;
    api('/api/sdk/' + slug + '/activity', { seconds: s, day: localDay() }, keepalive).catch(function () { activeSecs += s; });
  }
  if (save) {
    setInterval(function () {
      if (document.visibilityState === 'visible' && Date.now() - lastInput < 60000) activeSecs += TICK;
      if (activeSecs >= 30) flushActivity();
    }, TICK * 1000);
  }

  // ------------------------------------------------------------------ badges
  var awarded = {};
  function award(code, title, icon) {
    if (!save || !code || awarded[code]) return Promise.resolve(false);
    awarded[code] = 1;
    return api('/api/sdk/' + slug + '/achievement', { code: code, title: title || code, icon: icon || '🏅' })
      .then(function (r) { if (r.isNew) toast((icon || '🏅') + ' New badge: ' + (title || code)); return r.isNew; })
      .catch(function () { delete awarded[code]; return false; });
  }

  function history(opts) {
    opts = opts || {};
    if (!student) return Promise.resolve([]);
    var q = '?tool=' + encodeURIComponent(slug) + '&limit=' + (opts.limit || 2000) + (opts.days ? '&days=' + opts.days : '');
    return fetch('/api/students/' + student.id + '/attempts' + q, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { attempts: [] }; })
      .then(function (j) { return j.attempts || []; });
  }

  function flushAll(keepalive) { flushActivity(keepalive); flushAttempts(keepalive); return flushState(keepalive); }
  window.addEventListener('pagehide', function () { flushAll(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushAll(true); });

  // ------------------------------------------------------------------ small UI: save status, review banner, toasts
  var pill = null, pillTimer = null;
  function ui(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  function css() {
    if (document.getElementById('amt-css')) return;
    var s = document.createElement('style'); s.id = 'amt-css';
    s.textContent = '.amt-pill{position:fixed;right:10px;bottom:10px;z-index:2147483000;font:600 12px/1 system-ui,sans-serif;padding:6px 10px;border-radius:999px;background:rgba(0,45,95,.85);color:#fff;opacity:0;transition:opacity .3s;pointer-events:none}' +
      '.amt-pill.on{opacity:1}.amt-pill.bad{background:#b42318}' +
      '.amt-banner{position:fixed;left:50%;transform:translateX(-50%);bottom:10px;z-index:2147483000;font:600 13px/1.3 system-ui,sans-serif;padding:8px 14px;border-radius:12px;background:#fff8ee;color:#7a3a07;border:1px solid #f6d4a8;box-shadow:0 4px 14px rgba(0,0,0,.12);max-width:92vw;text-align:center}' +
      '.amt-toast{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483001;font:800 16px/1.3 system-ui,sans-serif;padding:12px 18px;border-radius:14px;background:#0f9d58;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.18);transition:opacity .4s}';
    document.head.appendChild(s);
  }
  function status(kind) {
    if (!save) return;
    ui(function () {
      css();
      if (!pill) { pill = document.createElement('div'); pill.className = 'amt-pill'; document.body.appendChild(pill); }
      var text = { saving: 'Saving…', saved: 'Saved ✓', offline: 'No connection — will save when back online', signin: 'Signed out — sign in again to save' }[kind];
      pill.textContent = text; pill.className = 'amt-pill on' + (kind === 'offline' || kind === 'signin' ? ' bad' : '');
      clearTimeout(pillTimer);
      if (kind === 'saved') pillTimer = setTimeout(function () { pill.className = 'amt-pill'; }, 1500);
    });
  }
  function toast(text) {
    ui(function () {
      css();
      var t = document.createElement('div'); t.className = 'amt-toast'; t.textContent = text; document.body.appendChild(t);
      setTimeout(function () { t.style.opacity = '0'; }, 2600);
      setTimeout(function () { t.remove(); }, 3200);
    });
  }
  if (mode === 'review' || mode === 'preview') {
    ui(function () {
      css();
      var b = document.createElement('div'); b.className = 'amt-banner';
      b.textContent = mode === 'review'
        ? '👀 Viewing ' + (student ? student.firstName + '’s' : 'this student’s') + ' progress as ' + viewer.role + '. Anything you try here is not saved.'
        : '🔍 Preview mode. Nothing is saved.';
      document.body.appendChild(b);
      setTimeout(function () { b.style.transition = 'opacity .6s'; b.style.opacity = '0.35'; }, 6000);
    });
  }

  window.AMT = {
    version: '1.0',
    mode: mode,
    tool: BOOT ? BOOT.tool : { slug: slug, name: document.title },
    student: student,
    viewer: viewer,
    settings: (BOOT && BOOT.settings) || {},
    isStudent: mode === 'student' || mode === 'standalone',
    isAdult: !!viewer && viewer.role !== 'student',
    canSave: save,
    storage: BOOT ? storage : realLS,
    attempt: attempt,
    award: award,
    history: history,
    flush: function () { return flushAll(false); },
    toast: toast,
  };
})();
