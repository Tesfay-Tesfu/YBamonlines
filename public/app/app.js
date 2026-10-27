/* AMtutorTools web app — one page, hash routes, no build step. */
"use strict";

/* =====================================================================
   Helpers
   ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = () => $("#app");

const ME = { user: null, mailEnabled: false };

async function api(method, path, body) {
  const opt = { method, headers: { "X-AMT": "1" }, credentials: "same-origin" };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = {};
  try { data = await r.json(); } catch { /* not json */ }
  if (!r.ok) {
    const e = new Error(data.error || `Request failed (${r.status})`);
    e.status = r.status;
    if (r.status === 401 && !path.startsWith("/api/auth/")) { ME.user = null; location.hash = "#/login"; }
    throw e;
  }
  return data;
}
const GET = p => api("GET", p);
const POST = (p, b = {}) => api("POST", p, b);
const PATCH = (p, b = {}) => api("PATCH", p, b);
const DEL = p => api("DELETE", p);

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 3000);
}
const fail = e => toast(e.message || String(e), true);

function modal(html, { wide = false, onMount } = {}) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", e => { if (e.target === back) close(); });
  $$("[data-close]", back).forEach(b => b.onclick = close);
  const first = $("input, select, textarea, button", back);
  if (first) setTimeout(() => first.focus(), 30);
  if (onMount) onMount(back.firstElementChild, close);
  return close;
}
function confirmBox(title, text, okLabel = "Confirm", danger = false) {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><p>${text}</p><div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="ok">${esc(okLabel)}</button></div>`,
      { onMount: (m, close) => { $("#ok", m).onclick = () => { close(); res(true); }; } });
  });
}

// Reads a form's named inputs into an object
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") o[el.name] = el.checked;
    else o[el.name] = el.value.trim();
  }
  return o;
}
// Wires a form: disables button while working, shows errors inline
function onSubmit(form, fn) {
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("button[type=submit]", form), err = $(".form-error", form);
    if (err) err.remove();
    if (btn) btn.disabled = true;
    try { await fn(formData(form)); }
    catch (ex) {
      const box = document.createElement("div"); box.className = "form-error"; box.textContent = ex.message;
      form.prepend(box);
    } finally { if (btn) btn.disabled = false; }
  });
}

const minutes = s => {
  const m = Math.round((s || 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};
const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDateTime = d => d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
function ago(d) {
  if (!d) return "never";
  const days = Math.floor((Date.now() - new Date(d)) / 86400e3);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return fmtDate(d);
}
function meter(pct) {
  if (pct === null || pct === undefined) return '<span class="muted">—</span>';
  const cls = pct >= 80 ? "" : pct >= 60 ? " mid" : " low";
  return `<span class="meter${cls}"><i><u style="width:${pct}%"></u></i>${pct}%</span>`;
}
const gradeText = g => g ? `Grade ${g}` : "No grade set";
const roleName = r => ({ admin: "Admin", tutor: "Tutor", parent: "Parent", student: "Student" }[r] || r);
const tutorLabel = t => (t.subject ? `${t.subject} · ${t.name}` : t.name); // e.g. "Math · Tesfaye Tutor"
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed — select and copy by hand", true); } }
function downloadText(name, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === "," || c === "\t") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

/* =====================================================================
   Layout
   ===================================================================== */
const NAV = {
  admin: [["#/", "Overview"], ["#/students", "Students"], ["#/messages", "Messages"], ["#/admin/leads", "Leads"], ["#/admin/users", "People"], ["#/admin/tools", "Tools"], ["#/admin/invites", "Invites"], ["#/admin/audit", "Activity log"]],
  tutor: [["#/", "My students"], ["#/messages", "Messages"], ["#/catalog", "Tools"]],
  parent: [["#/", "My children"], ["#/messages", "Messages"]],
  student: [["#/", "My tools"], ["#/messages", "Messages"]],
};
function shell(content, { sheet = false } = {}) {
  const u = ME.user;
  const here = location.hash || "#/";
  const nav = u ? NAV[u.role].map(([h, t]) => `<a href="${h}" class="${(h === "#/" ? here === "#/" || here === "" : here.startsWith(h)) ? "on" : ""}">${t}${h === "#/messages" ? `<span class="nbadge" id="nbadge"${UNREAD.unread ? "" : " hidden"}>${UNREAD.unread}</span>` : ""}</a>`).join("") : "";
  app().innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/"><span class="mark">AM</span><span>AMtutorTools <span class="sub">Afro-Merica Tutor</span></span></a>
      <nav class="nav" aria-label="Main">${nav}</nav>
      ${u ? `<div class="who"><span class="name">${esc(u.name)}</span><span class="role">${roleName(u.role)}</span>
        ${u.role !== "student" ? `<button id="acct" title="Account">Account</button>` : ""}<button id="logout">Sign out</button></div>` : ""}
    </header>
    <div class="${sheet ? "sheet" : ""}"><main class="page" id="page">${content}</main></div>`;
  if (u) {
    $("#logout").onclick = async () => { await POST("/api/auth/logout").catch(() => {}); ME.user = null; location.hash = "#/login"; };
    if ($("#acct")) $("#acct").onclick = () => { location.hash = "#/account"; };
    refreshUnread();
  }
  window.scrollTo(0, 0);
  return $("#page");
}
const loading = () => shell('<p class="muted">Loading…</p>');

/* =====================================================================
   Router
   ===================================================================== */
const ROUTES = [];
const route = (pattern, fn, opts = {}) => ROUTES.push({ re: new RegExp("^" + pattern.replace(/:(\w+)/g, "([^/?]+)") + "/?$"), fn, ...opts });

async function render() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = hash.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    if (!r.public && !ME.user) { location.hash = "#/login"; return; }
    if (r.roles && !r.roles.includes(ME.user.role)) { location.hash = "#/"; return; }
    try { await r.fn(...m.slice(1).map(decodeURIComponent), query); }
    catch (e) { if (e.status !== 401) shell(`<div class="panel"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Go home</a></div>`); }
    return;
  }
  shell(`<div class="panel"><h2>Page not found</h2><a class="btn" href="#/">Go home</a></div>`);
}
window.addEventListener("hashchange", render);

/* =====================================================================
   Sign in, invites, email links
   ===================================================================== */
route("/login", async (q) => {
  if (ME.user) { location.hash = "#/"; return; }
  let who = sessionStorage.getItem("amt-who") || "student";
  const page = shell(`<div class="auth"><div class="auth-card" id="card"></div></div>`, { sheet: true });
  function draw() {
    $("#card", page).innerHTML = `
      <h1>Welcome to AMtutorTools</h1>
      <p class="muted">Math and physics practice from Afro-Merica Tutor.</p>
      <div class="who-picker" role="tablist">
        <button role="tab" data-w="student" class="${who === "student" ? "on" : ""}">I’m a student</button>
        <button role="tab" data-w="adult" class="${who === "adult" ? "on" : ""}">Parent, tutor or admin</button>
      </div>
      ${who === "student" ? `
        <form id="f">
          <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
          <label class="field"><span>PIN</span><input class="pin-input" type="password" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="current-password" required></label>
          <button class="btn primary big" type="submit" style="width:100%">Sign in</button>
        </form>
        <div class="auth-foot"><span class="muted">Forgot your PIN? Ask your parent or tutor.</span></div>` : `
        <form id="f">
          <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>
          <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn primary big" type="submit" style="width:100%">Sign in</button>
        </form>
        <div class="auth-foot"><a href="#/forgot">Forgot password?</a><a href="#/join">I have an invite code</a></div>`}`;
    $$(".who-picker button", page).forEach(b => b.onclick = () => { who = b.dataset.w; sessionStorage.setItem("amt-who", who); draw(); });
    onSubmit($("#f", page), async d => {
      if (who === "student") await POST("/api/auth/student-login", { username: d.username, pin: d.pin });
      else await POST("/api/auth/login", { email: d.email, password: d.password });
      await refreshMe();
      location.hash = sessionStorage.getItem("amt-after") || "#/";
      sessionStorage.removeItem("amt-after");
    });
    const first = $("input", page); if (first) first.focus();
  }
  draw();
}, { public: true });

route("/join", () => joinPage(""), { public: true });
route("/join/:code", code => joinPage(code), { public: true });
async function joinPage(code) {
  const page = shell(`<div class="auth"><div class="auth-card" id="card"></div></div>`, { sheet: true });
  const card = $("#card", page);
  card.innerHTML = `<h1>Join with an invite code</h1>
    <p class="muted">Your tutor or Afro-Merica Tutor gave you a code like <b>ABCD-2345</b>.</p>
    <form id="cf"><label class="field"><span>Invite code</span><input type="text" name="code" value="${esc(code)}" autocapitalize="characters" required style="text-transform:uppercase;letter-spacing:.08em"></label>
    <button class="btn primary" type="submit">Continue</button></form>
    <div class="auth-foot"><a href="#/login">Back to sign in</a></div>`;
  onSubmit($("#cf", card), async d => {
    const c = d.code.toUpperCase().replace(/\s/g, "");
    const inv = await GET(`/api/auth/invite/${encodeURIComponent(c)}`);
    showInvite(c, inv);
  });
  if (code) $("#cf", card).requestSubmit();

  function showInvite(c, inv) {
    const forKid = inv.studentFirstName ? ` for <b>${esc(inv.studentFirstName)}</b>` : "";
    const consent = inv.role === "parent" ? `<label class="check"><input type="checkbox" name="consent" required>
      <span>I am ${inv.studentFirstName ? esc(inv.studentFirstName) + "’s" : "the child’s"} parent or legal guardian, and I agree that Afro-Merica Tutor may store their name, grade and practice results to run these tools.</span></label>` : "";
    if (ME.user && ME.user.role !== "student") {
      card.innerHTML = `<h1>Add to your account</h1><p>This ${roleName(inv.role).toLowerCase()} code${forKid} will be added to <b>${esc(ME.user.email)}</b>.</p>
        <form id="lf">${consent}<button class="btn primary" type="submit">Add to my account</button></form>`;
      onSubmit($("#lf", card), async d => { await POST("/api/auth/redeem", { code: c, consent: d.consent }); toast("Added to your account"); location.hash = "#/"; });
      return;
    }
    card.innerHTML = `<h1>Create your ${roleName(inv.role).toLowerCase()} account</h1>
      <p class="muted">Invite code <b>${esc(c)}</b>${forKid}.</p>
      <form id="sf">
        <label class="field"><span>Your name</span><input type="text" name="name" autocomplete="name" required></label>
        <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" value="${esc(inv.email || "")}" ${inv.email ? "readonly" : ""} required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required><small>At least 8 characters, with a letter and a number.</small></label>
        ${consent}
        <button class="btn primary big" type="submit" style="width:100%">Create account</button>
      </form>
      <div class="auth-foot"><span class="muted">Already have an account?</span><a href="#/login" id="si">Sign in first</a></div>`;
    $("#si", card).onclick = () => sessionStorage.setItem("amt-after", `#/join/${c}`);
    onSubmit($("#sf", card), async d => {
      await POST("/api/auth/redeem", { ...d, code: c });
      await refreshMe();
      toast("Account created");
      location.hash = "#/";
    });
  }
}

route("/forgot", () => {
  const page = shell(`<div class="auth"><div class="auth-card"><h1>Reset your password</h1>
    <form id="f"><label class="field"><span>Email</span><input type="email" name="email" required></label>
    <button class="btn primary" type="submit">Send reset link</button></form>
    <div class="auth-foot"><a href="#/login">Back to sign in</a></div></div></div>`, { sheet: true });
  onSubmit($("#f", page), async d => {
    await POST("/api/auth/forgot", d);
    $(".auth-card", page).innerHTML = `<h1>Check your email</h1><p>If <b>${esc(d.email)}</b> has an account, a reset link is on its way. It works for 2 hours.</p>
      <p class="muted small">No email? Ask an admin to set a new password for you.</p><a class="btn" href="#/login">Back to sign in</a>`;
  });
}, { public: true });

route("/reset/:token", token => {
  const page = shell(`<div class="auth"><div class="auth-card"><h1>Choose a new password</h1>
    <form id="f"><label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required>
    <small>At least 8 characters, with a letter and a number.</small></label>
    <button class="btn primary" type="submit">Save password</button></form></div></div>`, { sheet: true });
  onSubmit($("#f", page), async d => {
    await POST("/api/auth/reset", { token, password: d.password });
    toast("Password saved. Sign in with it now.");
    location.hash = "#/login";
  });
}, { public: true });

route("/verify/:token", async token => {
  const page = shell(`<div class="auth"><div class="auth-card"><h1>Confirming your email…</h1></div></div>`, { sheet: true });
  try {
    await POST("/api/auth/verify", { token });
    if (ME.user) ME.user.email_verified = true;
    $(".auth-card", page).innerHTML = `<h1>Email confirmed</h1><p>Thank you. Your account is all set.</p><a class="btn primary" href="#/">Continue</a>`;
  } catch (e) {
    $(".auth-card", page).innerHTML = `<h1>That link didn’t work</h1><p>${esc(e.message)}</p><a class="btn" href="#/">Continue</a>`;
  }
}, { public: true });

route("/account", () => {
  const u = ME.user;
  const page = shell(`<div class="page-head"><h1>Your account</h1></div>
    <div class="split"><div class="panel"><h2>Change password</h2>
      <form id="f"><label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required><small>At least 8 characters, with a letter and a number.</small></label>
      <button class="btn primary" type="submit">Change password</button></form></div>
    <div class="panel"><h2>Details</h2><p><b>${esc(u.name)}</b><br>${esc(u.email)}<br>${roleName(u.role)}</p>
      ${u.email_verified ? '<span class="tag good">Email confirmed</span>' : `<span class="tag warn">Email not confirmed</span> <button class="btn small" id="rv">Send confirmation again</button>`}
      <p class="muted small" style="margin-top:14px">Have a code for another child? <a href="#/join">Enter an invite code</a>.</p></div></div>`);
  onSubmit($("#f", page), async d => { await POST("/api/auth/change-password", d); toast("Password changed"); $("#f", page).reset(); });
  if ($("#rv", page)) $("#rv", page).onclick = async () => {
    try { const r = await POST("/api/auth/resend-verify"); toast(r.mailEnabled ? "Confirmation email sent" : "Email isn’t set up on this server. An admin can confirm your account."); } catch (e) { fail(e); }
  };
}, { roles: ["admin", "tutor", "parent"] });

/* =====================================================================
   Home (depends on role)
   ===================================================================== */
route("/", async () => {
  const r = ME.user.role;
  if (r === "student") return studentHome();
  if (r === "parent") return parentHome();
  if (r === "tutor") return studentsPage({ title: "My students" });
  return adminOverview();
});

async function studentHome() {
  loading();
  const d = await GET("/api/my/tools");
  const first = ME.user.name.split(" ")[0];
  const tiles = d.tools.map(t => `
    <a class="tool-tile ${esc(t.subject)}" href="#/play/${esc(t.slug)}">
      <div class="icon" aria-hidden="true">${esc(t.icon)}</div>
      <h2>${esc(t.name)}</h2>
      ${t.settings && t.settings.note ? `<div class="plan-note">📌 ${esc(t.settings.note)}</div>` : ""}
      <p>${esc(t.description)}</p>
      <div class="foot"><span>${t.seconds_7d ? `${minutes(t.seconds_7d)} this week` : t.last_day ? `Last used ${ago(t.last_day)}` : "New for you"}</span><span class="go">Open</span></div>
    </a>`).join("");
  shell(`
    <div class="hello">
      <h1>Hi ${esc(first)} <span class="eq">=</span> ready?</h1>
      ${d.streak ? `<span class="streak">🔥 ${d.streak}-day streak</span>` : ""}
    </div>
    <div id="msgCallout"></div>
    ${d.tools.length ? `<div class="tool-grid">${tiles}</div>` : `<div class="panel"><h2>No tools yet</h2><p>Your tutor hasn’t given you any tools yet. Check back soon, or ask them.</p></div>`}
    ${d.badges.length ? `<h2 style="margin:34px 0 12px">Your badges</h2><div class="badges">${d.badges.map(b => `<div class="badge" title="${esc(b.tool || "")}, ${fmtDate(b.created_at)}"><span class="bi">${esc(b.icon)}</span>${esc(b.title)}</div>`).join("")}</div>` : ""}
  `, { sheet: true });
  GET("/api/messages/unread").then(u => {
    if (!u.unread && !u.homework) return;
    $("#msgCallout").innerHTML = `<a class="callout" href="#/messages">📬 ${u.unread ? `<b>${u.unread} new message${u.unread === 1 ? "" : "s"}</b>` : ""}${u.unread && u.homework ? " · " : ""}${u.homework ? `<b>${u.homework} homework</b> to do` : ""}<span class="go">Open messages ›</span></a>`;
  }).catch(() => {});
}

/* ---------- tool player ---------- */
route("/play/:slug", (slug, q) => {
  const sid = q.student ? `?student=${encodeURIComponent(q.student)}` : "";
  const back = q.student ? `#/student/${encodeURIComponent(q.student)}` : ME.user.role === "student" ? "#/" : (q.from || "#/");
  app().innerHTML = `<div class="play">
    <div class="play-bar"><a href="${esc(back)}">‹ Back</a><span class="t" id="pt">Loading…</span>
      ${ME.user.role !== "student" ? `<span class="small note" id="pnote" style="opacity:.8">${q.student ? "Viewing a student · not saved" : "Preview · not saved"}</span>` : ""}
      ${document.fullscreenEnabled ? '<button id="fs" title="Full screen">⛶</button>' : ""}</div>
    <iframe id="tool" src="/tools/${encodeURIComponent(slug)}/${sid}" title="Tool" allow="fullscreen"></iframe></div>`;
  const fr = $("#tool");
  fr.addEventListener("load", () => {
    try {
      $("#pt").textContent = fr.contentDocument.title || slug;
      // tools that save adults' work themselves (the whiteboard) say so with <meta name="amt-banner" content="off">
      if ($("#pnote") && fr.contentDocument.querySelector('meta[name="amt-banner"][content="off"]')) $("#pnote").remove();
    } catch { $("#pt").textContent = slug; }
  });
  if ($("#fs")) $("#fs").onclick = () => { const p = $(".play"); (p.requestFullscreen ? p.requestFullscreen() : Promise.reject()).catch(() => {}); };
});

/* ---------- parent home ---------- */
async function parentHome() {
  loading();
  const { students } = await GET("/api/students");
  const cards = students.map(s => `
    <a class="kid-card" href="#/student/${s.id}">
      <h2>${esc(s.name)}</h2><div class="muted small">${gradeText(s.grade)} · ${s.tools} tool${s.tools === 1 ? "" : "s"}</div>
      <dl><div><dt>Practice this week</dt><dd>${minutes(s.seconds_7d)}</dd></div>
        <div><dt>Answers this week</dt><dd>${s.attempts_7d}</dd></div>
        <div><dt>Correct</dt><dd>${s.accuracy_7d === null ? "—" : s.accuracy_7d + "%"}</dd></div></dl>
      <div class="small muted" style="margin-top:10px">Last practiced ${ago(s.last_active)}</div>
    </a>`).join("");
  // (each child's messages are under Messages, or the button on the child's page)
  shell(`<div class="page-head"><h1>My children</h1><div class="actions"><a class="btn" href="#/join">Add a child with a code</a></div></div>
    ${!ME.user.email_verified ? `<div class="form-note">Please confirm your email address so you can reset your password if you forget it. <a href="#/account">Account settings</a></div>` : ""}
    ${students.length ? `<div class="grid cols-2">${cards}</div>` : `<div class="panel"><h2>No children linked yet</h2><p>Ask your child’s tutor for an invite code, then <a href="#/join">enter it here</a>.</p></div>`}`);
}

/* =====================================================================
   Students list (tutor home, admin Students page)
   ===================================================================== */
route("/students", q => studentsPage({ title: "Students", notutor: q.notutor === "1" }), { roles: ["admin", "tutor"] });

async function studentsPage({ title, notutor = false }) {
  loading();
  const isAdmin = ME.user.role === "admin";
  let q = "", grade = "", picked = new Set();
  const page = shell(`<div class="page-head"><h1>${esc(title)}</h1>
      <div class="actions"><button class="btn primary" id="add">Add a student</button>${isAdmin ? `<button class="btn" id="bulk">Import from a spreadsheet</button><a class="btn" href="#/admin/duplicates">Find duplicates</a><a class="btn" href="/api/admin/export/students.csv">Download list</a>` : ""}</div></div>
    <div class="inline" style="margin-bottom:14px"><input type="search" id="q" placeholder="Search by name or username" aria-label="Search">
      <select id="g" aria-label="Grade"><option value="">All grades</option>${[5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4].map(g => `<option value="${g}">Grade ${g}</option>`).join("")}</select>
      ${isAdmin ? `<label class="check" style="margin:0"><input type="checkbox" id="nt" ${notutor ? "checked" : ""}><span>No tutor yet</span></label>` : ""}</div>
    ${isAdmin ? `<div class="bulkbar" id="bulkbar" hidden><b id="bcount"></b><button class="btn primary small" id="bAssign">👩‍🏫 Assign a tutor</button><button class="btn small" id="bClear">Clear</button></div>` : ""}
    <div id="list"><p class="muted">Loading…</p></div>`);
  async function load() {
    const { students } = await GET(`/api/students?q=${encodeURIComponent(q)}&grade=${grade}${notutor ? "&notutor=1" : ""}`);
    $("#list", page).innerHTML = students.length ? `<div class="table-wrap"><table class="data">
      <thead><tr>${isAdmin ? `<th style="width:34px"><input type="checkbox" id="pickAll" aria-label="Select all"></th>` : ""}<th>Name</th><th>Grade</th><th>Username</th><th class="num">Tools</th><th class="num">This week</th><th>Correct (7 days)</th><th>Last practiced</th>${isAdmin ? "<th>Tutor</th>" : ""}<th>Parents</th></tr></thead>
      <tbody>${students.map(s => `<tr class="link" data-id="${s.id}">${isAdmin ? `<td class="pick"><input type="checkbox" data-pick="${s.id}" ${picked.has(s.id) ? "checked" : ""} aria-label="Select ${esc(s.name)}"></td>` : ""}<td><b>${esc(s.name)}</b>${s.active ? "" : ' <span class="tag bad">Off</span>'}</td><td>${s.grade || "—"}</td><td>${esc(s.username)}</td>
        <td class="num">${s.tools}</td><td class="num">${minutes(s.seconds_7d)}</td><td>${meter(s.accuracy_7d)}</td><td>${ago(s.last_active)}</td>
        ${isAdmin ? `<td>${s.tutors ? esc(s.tutors) : '<span class="tag warn">None</span>'}</td>` : ""}<td>${s.parents ? esc(s.parents) : '<span class="tag warn">Not linked</span>'}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="panel empty">${notutor && !q && !grade ? "🎉 Every student has a tutor." : q || grade || notutor ? "No students match." : "No students yet. Add your first student to give them tools."}</div>`;
    $$("tr.link", page).forEach(tr => tr.onclick = e => { if (e.target.closest(".pick")) return; location.hash = `#/student/${tr.dataset.id}`; });
    if (!isAdmin) return;
    const sync = () => { $("#bulkbar", page).hidden = !picked.size; $("#bcount", page).textContent = `${picked.size} selected`; };
    $$("[data-pick]", page).forEach(b => b.onchange = () => { b.checked ? picked.add(+b.dataset.pick) : picked.delete(+b.dataset.pick); sync(); });
    if ($("#pickAll", page)) $("#pickAll", page).onchange = e => { students.forEach(s => e.target.checked ? picked.add(s.id) : picked.delete(s.id)); $$("[data-pick]", page).forEach(b => b.checked = e.target.checked); sync(); };
    sync();
  }
  if (isAdmin) {
    $("#nt", page).onchange = e => { notutor = e.target.checked; picked.clear(); load().catch(fail); };
    $("#bClear", page).onclick = () => { picked.clear(); load().catch(fail); };
    $("#bAssign", page).onclick = () => assignTutorModal([...picked], () => { picked.clear(); load().catch(fail); });
  }
  let t; $("#q", page).oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; load().catch(fail); }, 250); };
  $("#g", page).onchange = e => { grade = e.target.value; load().catch(fail); };
  $("#add", page).onclick = () => addStudentModal();
  if ($("#bulk", page)) $("#bulk", page).onclick = () => bulkImportModal();
  await load();
}

// Pick a tutor and link them to one or more students (admins)
async function assignTutorModal(studentIds, done) {
  const { users } = await GET("/api/admin/users?role=tutor");
  const tutors = users.filter(u => u.active);
  if (!tutors.length) return modal(`<h2>No tutors yet</h2><p>Add a tutor first: <b>People → Add an account</b> (role: Tutor), or <b>Invite a tutor</b>.</p><div class="btn-row"><a class="btn primary" href="#/admin/users" data-close>Go to People</a></div>`);
  modal(`<h2>Assign a tutor</h2><p class="muted small">${studentIds.length} student${studentIds.length === 1 ? "" : "s"} will be linked to the tutor you choose. The tutor then sees them under <b>My students</b>, can set plans and open their tools, whiteboard and messages. A student can have more than one tutor.</p>
    <label class="field"><span>Tutor</span><select id="tsel">${tutors.map(t => `<option value="${t.id}">${esc(tutorLabel(t))} — ${esc(t.email)} (${t.students} student${t.students === 1 ? "" : "s"})</option>`).join("")}</select></label>
    <p class="small muted">If a student already has a tutor, the tools they had stay with that first tutor, so the new tutor doesn’t see them. You can change this per tool on the student’s <b>Tools</b> tab.</p>
    <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tGo">Assign</button></div>`, {
    onMount: (m, close) => { $("#tGo", m).onclick = async () => { try { const r = await POST("/api/admin/links/bulk", { adult_id: Number($("#tsel", m).value), student_ids: studentIds }); close(); toast(`${r.name} is now tutor for ${r.linked} student${r.linked === 1 ? "" : "s"}`); done && done(); } catch (e) { fail(e); } }; },
  });
}

function addStudentModal() {
  modal(`<h2>Add a student</h2>
    <p class="muted small">Students sign in with a username and PIN, so children don’t need an email address.</p>
    <form id="f">
      <label class="field"><span>Student’s full name</span><input type="text" name="name" required></label>
      <div class="grid cols-2">
        <label class="field"><span>Grade</span><select name="grade"><option value="">—</option>${Array.from({ length: 12 }, (_, i) => `<option>${i + 1}</option>`).join("")}</select></label>
        <label class="field"><span>PIN</span><input type="text" name="pin" inputmode="numeric" maxlength="6" placeholder="Leave empty to make one"></label>
      </div>
      <label class="field"><span>Username</span><input type="text" name="username" autocapitalize="none" placeholder="Leave empty to make one from the name"></label>
      <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add student</button></div>
    </form>`, {
    onMount: (m, close) => onSubmit($("#f", m), async d => {
      const { students: same } = await GET(`/api/students/similar?name=${encodeURIComponent(d.name)}`);
      if (same.length && !(await sameNameOk(same.map(s => `${s.name} — username ${s.username}${s.grade ? `, grade ${s.grade}` : ""}, added ${fmtDate(s.created_at)}`), "student"))) return;
      const { student } = await POST("/api/students", d);
      close();
      credentialsModal([student], { title: "Student added", next: `#/student/${student.id}` });
    }),
  });
}

// Asks before adding a second account with a name that already exists.
function sameNameOk(lines, kind) {
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.className = "modal-back"; box.style.zIndex = 200;
    box.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>This name is already here</h2>
      <p>You already have ${lines.length === 1 ? `a ${kind}` : `${lines.length} ${kind}s`} with this name:</p>
      <ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
      <p class="muted small">If it is the same person, cancel and use the existing account. Add a new one only if this is a different person with the same name.</p>
      <div class="btn-row"><button class="btn primary" id="no">Cancel</button><button class="btn" id="yes">Add a new ${kind} anyway</button></div></div>`;
    document.body.appendChild(box);
    const done = v => { box.remove(); resolve(v); };
    box.querySelector("#no").onclick = () => done(false);
    box.querySelector("#yes").onclick = () => done(true);
  });
}

function credentialsModal(list, { title = "Sign-in details", next } = {}) {
  const ok = list.filter(s => s.username);
  modal(`<div class="print-area"><h2>${esc(title)}</h2>
    <p class="muted small no-print">Write these down or print them. PINs are shown only once.</p>
    <div class="cred-grid">${ok.map(s => `<div class="cred"><b>${esc(s.name)}</b>
      Website: ${esc(location.host)}<br>Username: <code>${esc(s.username)}</code><br>PIN: <code>${esc(s.pin)}</code>
      ${s.parent_invite ? `<br><span class="small">Parent invite code: <code>${esc(s.parent_invite)}</code></span>` : ""}</div>`).join("")}</div></div>
    <div class="btn-row no-print"><button class="btn" id="pr">Print</button>${ok.length > 1 ? '<button class="btn" id="dl">Download as CSV</button>' : ""}<button class="btn primary" id="done">Done</button></div>`,
  {
    wide: ok.length > 2,
    onMount: (m, close) => {
      $("#pr", m).onclick = () => window.print();
      if ($("#dl", m)) $("#dl", m).onclick = () => downloadText("student_logins.csv",
        "﻿Name,Username,PIN,Parent invite code\r\n" + ok.map(s => [s.name, s.username, s.pin, s.parent_invite || ""].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n"));
      $("#done", m).onclick = () => { close(); if (next) location.hash = next; else render(); };
    },
  });
}

async function bulkImportModal() {
  const { tools } = await GET("/api/tools");
  modal(`<h2>Import students</h2>
    <p class="small">Paste rows from a spreadsheet. The first row must be the column names. Only <b>name</b> is required.</p>
    <p class="small muted">Columns: <code>name, grade, username, pin, tutor_email, parent_email</code>. A tutor email links an existing tutor. A parent email creates a 30-day invite code for that parent.</p>
    <form id="f">
      <label class="field"><textarea name="csv" placeholder="name,grade,tutor_email,parent_email&#10;Aminah Bello,5,tutor@example.com,parent@example.com" required></textarea></label>
      <label class="field"><span>Give everyone these tools (optional)</span>
        <div class="chips" id="tt">${tools.filter(t => t.active).map(t => `<button type="button" class="chip" data-id="${t.id}">${esc(t.icon)} ${esc(t.name)}</button>`).join("")}</div></label>
      <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Import</button></div>
    </form>`, {
    wide: true,
    onMount: (m, close) => {
      $$("#tt .chip", m).forEach(c => c.onclick = () => c.classList.toggle("on"));
      onSubmit($("#f", m), async d => {
        const rows = parseCSV(d.csv);
        if (rows.length < 2) throw new Error("Add a header row and at least one student.");
        const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));
        if (!head.includes("name")) throw new Error("The first row needs a “name” column.");
        const objs = rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
        const tool_ids = $$("#tt .chip.on", m).map(c => Number(c.dataset.id));
        const { results } = await POST("/api/admin/students/bulk", { rows: objs, tool_ids });
        close();
        const bad = results.filter(r => !r.ok);
        if (bad.length) toast(`${bad.length} row${bad.length > 1 ? "s" : ""} not imported: ${bad.map(b => `row ${b.row + 1} (${b.error})`).join("; ")}`, true);
        credentialsModal(results.filter(r => r.ok), { title: `${results.length - bad.length} students imported` });
      });
    },
  });
}

/* =====================================================================
   One student: overview, tools & plans, report, people
   ===================================================================== */
route("/student/:id", (id, q) => studentPage(Number(id), q.tab || "overview"), { roles: ["admin", "tutor", "parent"] });

async function studentPage(id, tab) {
  loading();
  const d = await GET(`/api/students/${id}`);
  const s = d.student;
  const tabs = [["overview", "Overview"], ["tools", "Tools"], ["report", "Report"], ["people", "Parents & tutors"]];
  const page = shell(`
    <p class="small" style="margin:0 0 6px"><a href="#/">‹ ${ME.user.role === "parent" ? "My children" : "All students"}</a></p>
    <div class="page-head"><div><h1>${esc(s.name)}</h1>
      <div class="muted">${gradeText(s.grade)} · username <b>${esc(s.username)}</b>${s.active ? "" : ' · <span class="tag bad">Sign-in turned off</span>'}</div></div>
      <div class="actions"><a class="btn" href="#/messages/${s.id}">💬 Messages</a>${d.canResetPin ? '<button class="btn" id="pin">New PIN</button>' : ""}${d.canManage ? '<button class="btn" id="edit">Edit</button>' : ""}</div></div>
    <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-t="${k}" class="${k === tab ? "on" : ""}">${t}</button>`).join("")}</div>
    <div id="tab"></div>`);
  $$(".tabs button", page).forEach(b => b.onclick = () => { history.replaceState(null, "", `#/student/${id}?tab=${b.dataset.t}`); $$(".tabs button", page).forEach(x => x.classList.toggle("on", x === b)); show(b.dataset.t); });
  if ($("#pin", page)) $("#pin", page).onclick = async () => {
    if (!(await confirmBox("Make a new PIN?", `${esc(s.name.split(" ")[0])} will need the new PIN to sign in. The old PIN stops working.`, "Make new PIN"))) return;
    try { const r = await POST(`/api/students/${id}/pin`); credentialsModal([{ name: s.name, username: s.username, pin: r.pin }], { title: "New PIN" }); } catch (e) { fail(e); }
  };
  if ($("#edit", page)) $("#edit", page).onclick = () => editStudentModal(s, d.canDelete);

  function show(t) {
    const box = $("#tab", page);
    if (t === "overview") overviewTab(box, d);
    if (t === "tools") toolsTab(box, d, id);
    if (t === "report") reportTab(box, id).catch(fail);
    if (t === "people") peopleTab(box, d, id);
  }
  show(tab);
}

function overviewTab(box, d) {
  const week = d.days.slice(-7), sec7 = week.reduce((a, x) => a + x.seconds, 0);
  const activeDays = week.filter(x => x.seconds > 0 || x.attempts > 0).length;
  const max = Math.max(60, ...d.days.map(x => x.seconds));
  const usable = d.tools.filter(t => t.usable);
  box.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="figure"><b>${minutes(sec7)}</b><span>practice in the last 7 days</span></div>
      <div class="figure"><b>${activeDays} of 7</b><span>days with practice</span></div>
      <div class="figure"><b>${week.reduce((a, x) => a + x.attempts, 0)}</b><span>answers in the last 7 days</span></div>
      <div class="figure"><b>${usable.length}</b><span>tool${usable.length === 1 ? "" : "s"} available</span></div>
    </div>
    <div class="split">
      <div class="panel"><h3>Minutes of practice, last 4 weeks</h3>
        <div class="bars">${d.days.map(x => `<div class="${x.seconds ? "" : "zero"}" style="height:${Math.max(2, x.seconds / max * 100)}%" data-tip="${fmtDate(x.day + "T12:00")}: ${minutes(x.seconds)}, ${x.attempts} answers"></div>`).join("")}</div>
        <div class="bars-axis"><span>${fmtDate(d.days[0].day + "T12:00")}</span><span>Today</span></div></div>
      <div class="panel"><h3>Badges</h3>${d.achievements.length ? `<div class="badges">${d.achievements.slice(0, 18).map(b => `<div class="badge" title="${esc(b.tool || "")}, ${fmtDate(b.created_at)}"><span class="bi">${esc(b.icon)}</span>${esc(b.title)}</div>`).join("")}</div>` : '<p class="muted">No badges yet. Badges appear as practice milestones are reached.</p>'}</div>
    </div>
    <div class="panel" style="margin-top:16px"><h3>Tools</h3>${toolTable(d.tools.filter(t => t.status === "active"), d.student.id, false)}</div>`;
}

function toolTable(tools, sid, manage, tutors = null) {
  if (!tools.length) return '<p class="muted">No tools assigned yet.</p>';
  const tutorCell = t => !tutors ? "" : `<td>${tutors.length ? `<select class="tsel" data-tt="${t.tool_id}" aria-label="Tutor for ${esc(t.name)}"><option value="0">All tutors</option>${tutors.map(x => `<option value="${x.id}" ${t.tutor_id === x.id ? "selected" : ""}>${esc(tutorLabel(x))}</option>`).join("")}${t.tutor_id && !tutors.some(x => x.id === t.tutor_id) ? `<option value="${t.tutor_id}" selected>${esc(t.tutor_name || "Former tutor")} (not linked)</option>` : ""}</select>` : '<span class="muted small">No tutor yet</span>'}</td>`;
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Tool</th>${tutors ? "<th>Tutor</th>" : ""}<th class="num">Time (7 days)</th><th class="num">Time (all)</th><th class="num">Answers</th><th>Correct</th><th>Last used</th><th></th></tr></thead><tbody>
    ${tools.map(t => `<tr><td>${esc(t.icon)} <b>${esc(t.name)}</b><br><span class="subject ${esc(t.subject)}">${esc(t.subject)}</span>
        ${t.status === "revoked" ? ' <span class="tag bad">Removed</span>' : !t.tool_active ? ' <span class="tag warn">Tool turned off</span>' : t.expires_at ? ` <span class="tag ${new Date(t.expires_at) < new Date() ? "bad" : "info"}">Until ${fmtDate(t.expires_at)}</span>` : ""}
        ${!tutors && t.tutor_id && ME.user.role === "parent" ? `<div class="small muted">${esc(t.tutor_subject ? `${t.tutor_subject} · ${t.tutor_name}` : t.tutor_name || "")}</div>` : ""}</td>
      ${tutorCell(t)}<td class="num">${minutes(t.seconds_7d)}</td><td class="num">${minutes(t.seconds_total)}</td><td class="num">${t.attempts}</td><td>${meter(t.accuracy)}</td><td>${ago(t.last_day || t.last_at)}</td>
      <td style="white-space:nowrap"><a class="btn small" href="#/play/${esc(t.slug)}?student=${sid}">Open</a>
        ${manage ? `<button class="btn small" data-plan="${t.tool_id}">Plan</button><button class="btn small" data-more="${t.tool_id}">${ME.user.role === "admin" ? "More" : "Start over"}</button>` : ""}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function toolsTab(box, d, sid) {
  const admin = ME.user.role === "admin";
  const tutors = d.adults.filter(a => a.relation === "tutor");
  box.innerHTML = `${admin ? `<div class="btn-row" style="margin-bottom:14px"><button class="btn primary" id="assign">Give a tool</button>${tutors.length > 1 ? `<span class="small muted">${esc(d.student.name.split(" ")[0])} has ${tutors.length} tutors. Use the <b>Tutor</b> column so each tutor sees only their own tools, answers and reports.</span>` : ""}</div>`
      : d.canManage ? `<p class="muted small" style="margin:0 0 12px">These are the tools an admin has given to ${esc(d.student.name.split(" ")[0])}. You can set the plan for each one. To add or remove a tool, ask an admin.</p>` : ""}
    ${toolTable(d.tools, sid, d.canManage, admin ? tutors : null)}
    <p class="muted small" style="margin-top:10px">“Open” shows the tool with ${esc(d.student.name.split(" ")[0])}’s saved progress. Nothing you do there is saved.</p>`;
  if (!d.canManage) return;
  if ($("#assign", box)) $("#assign", box).onclick = () => assignToolModal(d, sid);
  $$("[data-tt]", box).forEach(sel => sel.onchange = async () => {
    try { await PATCH(`/api/students/${sid}/tools/${sel.dataset.tt}`, { tutor_id: Number(sel.value) }); toast(sel.value === "0" ? "Shared by all tutors" : `Now only ${sel.options[sel.selectedIndex].text} sees this tool`); }
    catch (e) { fail(e); studentPage(sid, "tools"); }
  });
  $$("[data-plan]", box).forEach(b => b.onclick = () => planModal(d.tools.find(t => t.tool_id === Number(b.dataset.plan)), sid, d.student));
  $$("[data-more]", box).forEach(b => b.onclick = () => allocationModal(d.tools.find(t => t.tool_id === Number(b.dataset.more)), sid, d.student));
}

const tutorsOf = d => d.adults.filter(a => a.relation === "tutor");
async function assignToolModal(d, sid) {
  const { tools } = await GET("/api/tools");
  const have = new Set(d.tools.filter(t => t.status === "active").map(t => t.tool_id));
  const g = d.student.grade;
  const avail = tools.filter(t => t.active && !have.has(t.id)).sort((a, b) => (fits(b) - fits(a)) || a.name.localeCompare(b.name));
  function fits(t) { return g && g >= t.grade_min && g <= t.grade_max ? 1 : 0; }
  modal(`<h2>Give a tool to ${esc(d.student.name.split(" ")[0])}</h2>
    ${avail.length ? `<div class="table-wrap"><table class="data"><tbody>${avail.map(t => `<tr><td>${esc(t.icon)} <b>${esc(t.name)}</b> <span class="subject ${esc(t.subject)}">${esc(t.subject)}</span>
      <div class="small muted">Grades ${t.grade_min}–${t.grade_max}${g && !fits(t) ? ` · <span class="tag warn">Outside grade ${g}</span>` : ""}</div></td>
      <td class="num"><a class="btn small" href="#/play/${esc(t.slug)}?from=${encodeURIComponent(location.hash)}" data-close>Preview</a> <button class="btn small primary" data-id="${t.id}">Give</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="muted">This student already has every available tool.</p>'}
    ${tutorsOf(d).length ? `<label class="field" style="margin-top:14px"><span>Which tutor is this tool for?</span><select id="ttool"><option value="0">All of ${esc(d.student.name.split(" ")[0])}’s tutors</option>${tutorsOf(d).map(x => `<option value="${x.id}" ${tutorsOf(d).length > 1 && x === tutorsOf(d)[0] ? "" : ""}>${esc(tutorLabel(x))} only</option>`).join("")}</select><small>Only this tutor will see the tool, its answers and reports. Parents and admins always see everything.</small></label>` : ""}
    <label class="field" style="margin-top:14px"><span>Access ends (optional)</span><input type="date" id="exp"><small>Leave empty for no end date.</small></label>
    <div class="btn-row"><button class="btn" data-close>Close</button></div>`, {
    wide: true,
    onMount: (m, close) => $$("[data-id]", m).forEach(b => b.onclick = async () => {
      try {
        await POST(`/api/students/${sid}/tools`, { tool_id: Number(b.dataset.id), tutor_id: $("#ttool", m) ? Number($("#ttool", m).value) : 0, expires_at: $("#exp", m).value ? new Date($("#exp", m).value + "T23:59:59").toISOString() : null });
        toast("Tool given"); close(); studentPage(sid, "tools");
      } catch (e) { fail(e); }
    }),
  });
}

// Plan editor built from the tool's manifest "settings"
function planModal(t, sid, student) {
  const schema = Array.isArray(t.settings_schema) ? t.settings_schema : [];
  const cur = t.settings || {};
  const fieldHtml = f => {
    const labels = f.labels || f.options || [];
    const v = cur[f.key];
    if (f.type === "multi") return `<div class="field"><span style="display:block;font-weight:500;font-size:.9rem;margin-bottom:6px">${esc(f.label || f.key)}</span>
      <div class="chips" data-multi="${esc(f.key)}">${(f.options || []).map((o, i) => `<button type="button" class="chip${Array.isArray(v) && v.map(String).includes(String(o)) ? " on" : ""}" data-v="${esc(o)}" data-num="${typeof o === "number" ? 1 : 0}">${esc(labels[i] ?? o)}</button>`).join("")}</div></div>`;
    if (f.type === "select") return `<label class="field"><span>${esc(f.label || f.key)}</span><select name="${esc(f.key)}" data-num="${typeof (f.options || [])[0] === "number" ? 1 : 0}"><option value="">Student chooses</option>
      ${(f.options || []).map((o, i) => `<option value="${esc(o)}" ${String(v) === String(o) ? "selected" : ""}>${esc(labels[i] ?? o)}</option>`).join("")}</select></label>`;
    if (f.type === "number") return `<label class="field"><span>${esc(f.label || f.key)}</span><input type="number" name="${esc(f.key)}" value="${esc(v ?? "")}" data-num="1"></label>`;
    if (f.type === "checkbox") return `<label class="check"><input type="checkbox" name="${esc(f.key)}" ${v ? "checked" : ""}><span>${esc(f.label || f.key)}</span></label>`;
    return `<label class="field"><span>${esc(f.label || f.key)}</span><input type="text" name="${esc(f.key)}" value="${esc(v ?? "")}" maxlength="300"></label>`;
  };
  modal(`<h2>${esc(t.icon)} ${esc(t.name)}: plan for ${esc(student.name.split(" ")[0])}</h2>
    <p class="muted small">The tool opens with these settings and shows your note. ${cur._updated ? `Last changed ${fmtDateTime(cur._updated)}${cur._by ? ` by ${esc(cur._by)}` : ""}.` : ""}</p>
    ${schema.length ? `<form id="f">${schema.map(fieldHtml).join("")}
      <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save plan</button></div></form>`
      : `<p>This tool has no plan settings. Tool authors can add them in <code>manifest.json</code>.</p><div class="btn-row"><button class="btn" data-close>Close</button></div>`}`, {
    onMount: (m, close) => {
      $$(".chip", m).forEach(c => c.onclick = () => c.classList.toggle("on"));
      if (!$("#f", m)) return;
      onSubmit($("#f", m), async () => {
        const settings = {};
        for (const f of schema) {
          if (f.type === "multi") {
            const vals = $$(`[data-multi="${CSS.escape(f.key)}"] .chip.on`, m).map(c => c.dataset.num === "1" ? Number(c.dataset.v) : c.dataset.v);
            if (vals.length) settings[f.key] = vals;
          } else {
            const el = $(`[name="${CSS.escape(f.key)}"]`, m);
            if (!el) continue;
            if (el.type === "checkbox") settings[f.key] = el.checked;
            else if (el.value !== "") settings[f.key] = el.dataset.num === "1" ? Number(el.value) : el.value;
          }
        }
        await PATCH(`/api/students/${sid}/tools/${t.tool_id}`, { settings });
        toast("Plan saved"); close(); studentPage(sid, "tools");
      });
    },
  });
}

function allocationModal(t, sid, student) {
  const first = esc(student.name.split(" ")[0]), admin = ME.user.role === "admin";
  modal(`<h2>${esc(t.icon)} ${esc(t.name)}</h2>
    ${admin ? `<label class="field"><span>Access ends</span><div class="inline"><input type="date" id="exp" value="${t.expires_at ? new Date(t.expires_at).toISOString().slice(0, 10) : ""}"><button class="btn" id="saveExp">Save date</button></div><small>Empty means no end date.</small></label>
    <div class="btn-row" style="justify-content:flex-start;margin:6px 0 14px">
      ${t.status === "active" ? `<button class="btn danger" id="revoke">Remove from ${first}</button>` : `<button class="btn primary" id="restore">Give back to ${first}</button>`}</div>` : ""}
    <h3>Start over</h3>
    <p class="small muted">Clears ${first}’s saved progress in this tool, so it opens like new. You can keep or delete the answer history used in reports.</p>
    <div class="btn-row" style="justify-content:flex-start"><button class="btn" id="r1">Clear progress, keep history</button><button class="btn danger" id="r2">Clear progress and history</button></div>
    <div class="btn-row"><button class="btn" data-close>Close</button></div>`, {
    onMount: (m, close) => {
      const done = msg => { toast(msg); close(); studentPage(sid, "tools"); };
      if ($("#saveExp", m)) $("#saveExp", m).onclick = () => PATCH(`/api/students/${sid}/tools/${t.tool_id}`, { expires_at: $("#exp", m).value ? new Date($("#exp", m).value + "T23:59:59").toISOString() : null }).then(() => done("Date saved")).catch(fail);
      if ($("#revoke", m)) $("#revoke", m).onclick = () => PATCH(`/api/students/${sid}/tools/${t.tool_id}`, { status: "revoked" }).then(() => done("Tool removed. Progress is kept if you give it back.")).catch(fail);
      if ($("#restore", m)) $("#restore", m).onclick = () => PATCH(`/api/students/${sid}/tools/${t.tool_id}`, { status: "active" }).then(() => done("Tool given back")).catch(fail);
      $("#r1", m).onclick = async () => { if (await confirmBox("Clear progress?", `${first} will start ${esc(t.name)} from the beginning.`, "Clear progress", true)) DEL(`/api/students/${sid}/tools/${t.tool_id}/progress`).then(() => done("Progress cleared")).catch(fail); };
      $("#r2", m).onclick = async () => { if (await confirmBox("Clear progress and history?", "This also deletes answers, time and badges for this tool. It can’t be undone.", "Delete everything", true)) DEL(`/api/students/${sid}/tools/${t.tool_id}/progress?history=1`).then(() => done("Progress and history cleared")).catch(fail); };
    },
  });
}

async function reportTab(box, sid) {
  let days = 7;
  box.innerHTML = `<div class="inline" style="margin-bottom:14px"><div class="chips" id="rd">${[[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]].map(([n, t]) => `<button class="chip${n === days ? " on" : ""}" data-d="${n}">${t}</button>`).join("")}</div>
    <span style="flex:1"></span><a class="btn small" id="csv" href="#">Download all answers (CSV)</a></div><div id="rb"><p class="muted">Loading…</p></div>`;
  $$("#rd .chip", box).forEach(c => c.onclick = () => { days = Number(c.dataset.d); $$("#rd .chip", box).forEach(x => x.classList.toggle("on", x === c)); draw().catch(fail); });
  async function draw() {
    $("#csv", box).href = `/api/students/${sid}/attempts?format=csv&days=${days}`;
    const [r, a] = await Promise.all([GET(`/api/students/${sid}/report?days=${days}`), GET(`/api/students/${sid}/attempts?days=${days}&limit=100`)]);
    const T = r.totals;
    $("#rb", box).innerHTML = `
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="figure"><b>${minutes(T.seconds)}</b><span>practice time</span></div>
        <div class="figure"><b>${T.active_days}</b><span>days with practice</span></div>
        <div class="figure"><b>${T.attempts}</b><span>answers</span></div>
        <div class="figure ${T.accuracy !== null && T.accuracy < 60 ? "warn" : ""}"><b>${T.accuracy === null ? "—" : T.accuracy + "%"}</b><span>correct</span></div>
      </div>
      <div class="split">
        <div class="panel"><h3>By tool</h3>${r.perTool.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Tool</th><th class="num">Time</th><th class="num">Days</th><th class="num">Answers</th><th>Correct</th><th class="num">Avg. time</th></tr></thead><tbody>
          ${r.perTool.map(t => `<tr><td>${esc(t.icon)} ${esc(t.name)}</td><td class="num">${minutes(t.seconds)}</td><td class="num">${t.days_practiced}</td><td class="num">${t.attempts}</td><td>${meter(t.accuracy)}</td><td class="num">${t.avg_ms ? (t.avg_ms / 1000).toFixed(1) + " s" : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No tools assigned.</p>'}</div>
        <div class="panel"><h3>Practice these next</h3>${r.missed.length ? `<table class="data"><tbody>${r.missed.map(x => `<tr><td><b>${esc(x.question)}</b><div class="small muted">${esc(x.tool)} · answer ${esc(x.answer)}</div></td><td class="num"><span class="tag bad">${x.wrong} wrong</span></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Nothing missed in this period.</p>'}
          ${r.badges.length ? `<h3 style="margin-top:16px">New badges</h3><div class="badges">${r.badges.map(b => `<div class="badge"><span class="bi">${esc(b.icon)}</span>${esc(b.title)}</div>`).join("")}</div>` : ""}</div>
      </div>
      <div class="panel" style="margin-top:16px"><h3>Latest answers</h3>${a.attempts.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Tool</th><th>Question</th><th>Answer given</th><th>Correct answer</th><th></th><th class="num">Time</th></tr></thead><tbody>
        ${a.attempts.map(x => `<tr><td>${fmtDateTime(x.created_at)}</td><td>${esc(x.tool)}</td><td><b>${esc(x.question)}</b></td><td>${esc(x.response)}</td><td>${esc(x.answer)}</td><td>${x.correct ? '<span class="tag good">Correct</span>' : '<span class="tag bad">Wrong</span>'}</td><td class="num">${x.ms != null ? (x.ms / 1000).toFixed(1) + " s" : ""}</td></tr>`).join("")}</tbody></table></div>
        <p class="small muted" style="margin-top:8px">Showing the latest ${a.attempts.length}. Download the CSV for everything.</p>` : '<p class="muted">No answers in this period.</p>'}</div>`;
  }
  await draw();
}

function peopleTab(box, d, sid) {
  const first = esc(d.student.name.split(" ")[0]);
  box.innerHTML = `<div class="split"><div class="panel"><h3>People who can see ${first}’s progress</h3>
      ${d.adults.length ? `<table class="data"><tbody>${d.adults.map(a => `<tr><td><b>${esc(a.name)}</b>${a.email ? `<div class="small muted">${esc(a.email)}</div>` : ""}</td>
        <td><span class="tag ${a.relation === "tutor" ? "info" : ""}">${a.relation === "tutor" ? (a.subject ? `${esc(a.subject)} tutor` : "Tutor") : "Parent"}</span>${a.relation === "parent" && a.consent_at ? `<div class="small muted">Consent ${fmtDate(a.consent_at)}</div>` : ""}</td>
        <td class="num">${d.canManage && (a.relation === "parent" || ME.user.role === "admin") ? `<button class="btn small danger" data-unlink="${a.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Nobody is linked yet.</p>'}</div>
    ${ME.user.role === "admin" ? `<div class="panel"><h3>Link a tutor or parent</h3>
      <p class="small muted">Link an account that already exists. ${first} then shows up in their list right away.</p>
      <div class="inline" style="flex-wrap:wrap"><button class="btn primary" id="lTutor">👩‍🏫 Assign a tutor</button><button class="btn" id="lParent">👪 Link an existing parent</button></div></div>` : ""}
    ${d.canManage ? `<div class="panel"><h3>Invite a parent</h3>
      <p class="small">Make a code for ${first}’s parent. They enter it at <b>${esc(location.host)}</b> under “I have an invite code” to create an account and see ${first}’s progress.</p>
      <form id="inv"><label class="field"><span>Parent’s email (optional)</span><input type="email" name="email"><small>If you add an email, only that email can use the code.</small></label>
      ${ME.user.role === "admin" ? `<label class="field"><span>Code for</span><select name="role"><option value="parent">A parent</option><option value="tutor">A tutor</option></select></label>` : ""}
      <button class="btn primary" type="submit">Make invite code</button></form>
      ${d.invites.length ? `<h3 style="margin-top:18px">Unused codes</h3><table class="data"><tbody>${d.invites.map(i => `<tr><td><b>${esc(i.code)}</b><div class="small muted">${roleName(i.role)}${i.email ? " · " + esc(i.email) : ""} · until ${fmtDate(i.expires_at)}</div></td><td class="num"><button class="btn small" data-copy="${esc(i.code)}">Copy</button></td></tr>`).join("")}</tbody></table>` : ""}
    </div>` : ""}</div>`;
  $$("[data-unlink]", box).forEach(b => b.onclick = async () => {
    if (!(await confirmBox("Remove access?", "This person will no longer see this student’s progress.", "Remove", true))) return;
    DEL(`/api/students/${sid}/links/${b.dataset.unlink}`).then(() => { toast("Removed"); studentPage(sid, "people"); }).catch(fail);
  });
  $$("[data-copy]", box).forEach(b => b.onclick = () => copy(b.dataset.copy));
  if ($("#lTutor", box)) $("#lTutor", box).onclick = () => assignTutorModal([sid], () => studentPage(sid, "people"));
  if ($("#lParent", box)) $("#lParent", box).onclick = async () => {
    const { users } = await GET("/api/admin/users?role=parent");
    const list = users.filter(u => u.active && !d.adults.some(a => a.id === u.id));
    if (!list.length) return modal(`<h2>No parent accounts to link</h2><p>Make an invite code below instead. The parent creates their own account with it.</p><div class="btn-row"><button class="btn primary" data-close>OK</button></div>`);
    modal(`<h2>Link an existing parent</h2><label class="field"><span>Parent</span><select id="psel">${list.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(u.email)}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="pcons"><span>This person confirmed they are ${first}’s parent or legal guardian.</span></label>
      <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pGo">Link parent</button></div>`, {
      onMount: (m, close) => { $("#pGo", m).onclick = async () => { if (!$("#pcons", m).checked) return toast("Please confirm the parent or guardian first.", true); try { await POST("/api/admin/links", { student_id: sid, adult_id: Number($("#psel", m).value), relation: "parent", consent: true }); close(); toast("Parent linked"); studentPage(sid, "people"); } catch (e) { fail(e); } }; },
    });
  };
  if ($("#inv", box)) onSubmit($("#inv", box), async f => {
    const { invite } = await POST(`/api/students/${sid}/invites`, f);
    inviteModal(invite, d.student);
  });
}

function inviteModal(inv, student) {
  const link = `${location.origin}/#/join/${inv.code}`;
  const who = student ? student.name.split(" ")[0] : null;
  const msg = `Hello,\n\n${who ? `You can now follow ${who}’s practice` : "You’re invited to AMtutorTools"} with Afro-Merica Tutor.\n\n1. Open ${link}\n2. Create your account (the code is ${inv.code})\n\nThe code works until ${fmtDate(inv.expires_at)}.\n\nAfro-Merica Tutor`;
  modal(`<h2>Invite code ready</h2><p><span class="code-big">${esc(inv.code)}</span></p>
    <p class="small muted">Works until ${fmtDate(inv.expires_at)}${inv.email ? ` for ${esc(inv.email)} only` : ""}. Send this message by email or text:</p>
    <label class="field"><textarea readonly id="msg" style="font-family:inherit;min-height:170px">${esc(msg)}</textarea></label>
    <div class="btn-row"><button class="btn" id="cp">Copy message</button>${inv.email ? `<a class="btn" href="mailto:${esc(inv.email)}?subject=${encodeURIComponent("Your AMtutorTools invite")}&body=${encodeURIComponent(msg)}">Open in email</a>` : ""}<button class="btn primary" data-close>Done</button></div>`,
  { onMount: (m, close) => { $("#cp", m).onclick = () => copy(msg); $$("[data-close]", m).forEach(b => b.addEventListener("click", () => { if (student) studentPage(student.id, "people"); else render(); })); } });
}

function editStudentModal(s, canDelete = false) {
  const admin = ME.user.role === "admin";
  modal(`<h2>Edit ${esc(s.name)}</h2><form id="f">
    <label class="field"><span>Full name</span><input type="text" name="name" value="${esc(s.name)}" required></label>
    <div class="grid cols-2"><label class="field"><span>Grade</span><select name="grade"><option value="">—</option>${Array.from({ length: 12 }, (_, i) => `<option ${s.grade === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select></label>
    <label class="field"><span>Username</span><input type="text" name="username" value="${esc(s.username)}" required></label></div>
    ${admin ? `<label class="check"><input type="checkbox" name="active" ${s.active ? "checked" : ""}><span>Can sign in</span></label>` : ""}
    <div class="btn-row">${admin || canDelete ? '<button type="button" class="btn danger" id="del" style="margin-right:auto">Delete student</button>' : ""}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, {
    onMount: (m, close) => {
      onSubmit($("#f", m), async d => { await PATCH(`/api/students/${s.id}`, d); toast("Saved"); close(); studentPage(s.id, "overview"); });
      if ($("#del", m)) $("#del", m).onclick = async () => {
        close();
        if (!(await confirmBox(`Delete ${s.name}?`, "This deletes the student’s account and all their progress, answers and badges. It can’t be undone.", "Delete student", true))) return;
        DEL(`/api/students/${s.id}`).then(() => { toast("Student deleted"); location.hash = admin ? "#/students" : "#/"; }).catch(fail);
      };
    },
  });
}

/* =====================================================================
   Tool catalog (tutors) — preview tools
   ===================================================================== */
route("/catalog", async () => {
  loading();
  const { tools } = await GET("/api/tools");
  const tutor = ME.user.role === "tutor";
  shell(`<div class="page-head"><h1>${tutor ? "My students’ tools" : "Tools"}</h1></div>
    <p class="muted">${tutor ? "These are the tools an admin has given to your students. Open a preview to try one. To give a student a new tool, ask an admin." : "Open a preview to try a tool. To give a tool to a student, go to the student’s page."}</p>
    <div class="tool-grid">${tools.map(t => `<a class="tool-tile ${esc(t.subject)}" href="#/play/${esc(t.slug)}?from=%23%2Fcatalog">
      <div class="icon" aria-hidden="true">${esc(t.icon)}</div><h2>${esc(t.name)}</h2><p>${esc(t.description)}</p>
      <div class="foot"><span>${t.students ? `${t.students} student${t.students === 1 ? "" : "s"}` : `Grades ${t.grade_min}–${t.grade_max}`}</span><span class="go">Preview</span></div></a>`).join("") || `<p class="muted">${tutor ? "None of your students has been given a tool yet." : "No tools yet."}</p>`}</div>`);
}, { roles: ["tutor", "admin"] });

/* =====================================================================
   Admin
   ===================================================================== */
async function adminOverview() {
  loading();
  const d = await GET("/api/admin/overview");
  const c = Object.fromEntries(d.counts.map(x => [x.role, x]));
  const W = d.week;
  const maxS = Math.max(1, ...d.daily.map(x => x.students));
  shell(`<div class="page-head"><h1>Overview</h1><div class="actions"><a class="btn" href="#/students">Students</a><a class="btn" href="#/admin/tools">Tools</a></div></div>
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="figure"><b>${W.active_students} of ${c.student ? c.student.active : 0}</b><span>students practiced this week</span></div>
      <div class="figure"><b>${minutes(W.seconds)}</b><span>practice this week</span></div>
      <div class="figure"><b>${W.attempts}</b><span>answers this week${W.accuracy !== null ? `, ${W.accuracy}% correct` : ""}</span></div>
      <div class="figure"><b>${W.active_tools}</b><span>tools turned on</span></div>
    </div>
    <div class="split">
      <div class="panel"><h3>Students practicing per day</h3>
        <div class="bars">${d.daily.map(x => `<div class="${x.students ? "" : "zero"}" style="height:${Math.max(2, x.students / maxS * 100)}%" data-tip="${fmtDate(x.day + "T12:00")}: ${x.students} student${x.students === 1 ? "" : "s"}, ${minutes(x.seconds)}"></div>`).join("")}</div>
        <div class="bars-axis"><span>2 weeks ago</span><span>Today</span></div>
        <h3 style="margin-top:22px">Most used tools this week</h3>
        <table class="data"><tbody>${d.topTools.map(t => `<tr><td>${esc(t.icon)} ${esc(t.name)}</td><td class="num">${t.students} students</td><td class="num">${minutes(t.seconds)}</td></tr>`).join("") || '<tr><td class="muted">No tools yet</td></tr>'}</tbody></table>
      </div>
      <div class="panel"><h3>Needs attention</h3>
        <table class="data"><tbody>
          <tr><td>Students with no practice this week</td><td class="num">${W.inactive_students ? `<span class="tag warn">${W.inactive_students}</span>` : '<span class="tag good">0</span>'}</td></tr>
          <tr><td><a href="#/students?notutor=1">Students without a tutor</a></td><td class="num">${W.students_without_tutor ? `<span class="tag warn">${W.students_without_tutor}</span>` : '<span class="tag good">0</span>'}</td></tr>
          <tr><td>Students without a linked parent</td><td class="num">${W.students_without_parent ? `<span class="tag warn">${W.students_without_parent}</span>` : '<span class="tag good">0</span>'}</td></tr>
          <tr><td><a href="#/admin/leads?status=new">New parents from the interest form</a></td><td class="num">${W.new_leads ? `<a href="#/admin/leads?status=new" class="tag warn">${W.new_leads}</a>` : '<span class="tag good">0</span>'}</td></tr>
          <tr><td><a href="#/admin/duplicates">Names entered more than once</a></td><td class="num">${W.duplicate_names ? `<a href="#/admin/duplicates" class="tag warn">${W.duplicate_names}</a>` : '<span class="tag good">0</span>'}</td></tr>
        </tbody></table>
        <h3 style="margin-top:22px">Accounts</h3>
        <table class="data"><tbody>${["student", "parent", "tutor", "admin"].map(r => `<tr><td>${roleName(r)}s</td><td class="num">${c[r] ? c[r].n : 0}</td></tr>`).join("")}</tbody></table>
        <p class="small" style="margin-top:14px"><a href="/api/admin/export/attempts.csv?days=30">Download all answers from the last 30 days (CSV)</a></p>
      </div>
    </div>`);
}

/* ---------- people (adult accounts) ---------- */
route("/admin/users", async (q) => {
  loading();
  let role = q.role || "", search = "";
  const page = shell(`<div class="page-head"><h1>People</h1><div class="actions"><button class="btn primary" id="add">Add an account</button><button class="btn" id="inv">Invite a tutor</button><a class="btn" href="#/admin/duplicates">Find duplicates</a></div></div>
    <div class="inline" style="margin-bottom:14px"><input type="search" id="q" placeholder="Search name or email" aria-label="Search">
    <select id="r" aria-label="Role"><option value="">Everyone</option><option value="tutor">Tutors</option><option value="parent">Parents</option><option value="admin">Admins</option></select></div>
    <div id="list"></div>`);
  $("#r", page).value = role;
  async function load() {
    const { users } = await GET(`/api/admin/users?role=${role}&q=${encodeURIComponent(search)}`);
    $("#list", page).innerHTML = users.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="num">Students</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td><b>${esc(u.name)}</b>${u.subject ? ` <span class="tag info">${esc(u.subject)}</span>` : ""}${u.active ? "" : ' <span class="tag bad">Off</span>'}</td><td>${esc(u.email)} ${u.email_verified ? "" : '<span class="tag warn">Not confirmed</span>'}</td>
        <td>${roleName(u.role)}</td><td class="num">${u.students}</td><td>${ago(u.last_login_at)}</td><td class="num"><button class="btn small" data-id="${u.id}">Manage</button></td></tr>`).join("")}</tbody></table></div>`
      : '<div class="panel empty">No accounts match.</div>';
    $$("[data-id]", page).forEach(b => b.onclick = () => userModal(users.find(u => u.id === Number(b.dataset.id)), load));
  }
  let t; $("#q", page).oninput = e => { clearTimeout(t); t = setTimeout(() => { search = e.target.value; load().catch(fail); }, 250); };
  $("#r", page).onchange = e => { role = e.target.value; load().catch(fail); };
  $("#add", page).onclick = () => modal(`<h2>Add an account</h2><form id="f">
      <label class="field"><span>Role</span><select name="role"><option value="tutor">Tutor</option><option value="parent">Parent</option><option value="admin">Admin</option></select></label>
      <label class="field"><span>Name</span><input type="text" name="name" required></label>
      <label class="field subj"><span>Subject (for tutors)</span><input type="text" name="subject" maxlength="40" placeholder="e.g. Math, English, Physics"></label>
      <label class="field"><span>Email</span><input type="email" name="email" required></label>
      <label class="field"><span>Temporary password</span><input type="text" name="password" placeholder="Leave empty to make one"><small>Share it privately. They can change it under Account.</small></label>
      <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add account</button></div></form>`, {
    onMount: (m, close) => { const rs = $("select[name=role]", m); rs.onchange = () => { $(".subj", m).hidden = rs.value !== "tutor"; }; onSubmit($("#f", m), async d => {
      const key = String(d.name || "").trim().replace(/\s+/g, " ").toLowerCase();
      const { users: found } = await GET(`/api/admin/users?q=${encodeURIComponent(String(d.name || "").trim())}`);
      const same = found.filter(u => u.name.trim().replace(/\s+/g, " ").toLowerCase() === key);
      if (same.length && !(await sameNameOk(same.map(u => `${u.name} — ${roleName(u.role)}, ${u.email}`), "account"))) return;
      const r = await POST("/api/admin/users", d);
      close();
      modal(`<h2>Account added</h2><p><b>${esc(r.user.name)}</b> (${roleName(r.user.role)}) can sign in now.</p>
        <p>Email: <b>${esc(r.user.email)}</b><br>Temporary password: <span class="code-big" style="font-size:1.1rem">${esc(r.password)}</span></p>
        <div class="btn-row"><button class="btn" id="cp">Copy password</button><button class="btn primary" data-close>Done</button></div>`,
      { onMount: mm => $("#cp", mm).onclick = () => copy(r.password) });
      load().catch(fail);
    }); },
  });
  $("#inv", page).onclick = () => modal(`<h2>Invite a tutor</h2><p class="small muted">They’ll create their own password with the code.</p><form id="f">
      <label class="field"><span>Tutor’s email (optional)</span><input type="email" name="email"></label>
      <label class="field"><span>Account type</span><select name="role"><option value="tutor">Tutor</option><option value="admin">Admin</option></select></label>
      <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Make invite code</button></div></form>`, {
    onMount: (m, close) => onSubmit($("#f", m), async d => { const { invite } = await POST("/api/admin/invites", d); close(); inviteModal(invite, null); }),
  });
  await load();
}, { roles: ["admin"] });

/* ---------- duplicate names ---------- */
route("/admin/duplicates", async () => {
  loading();
  const d = await GET("/api/admin/duplicates");
  const group = (rows) => { const m = new Map(); rows.forEach(r => { if (!m.has(r.key)) m.set(r.key, []); m.get(r.key).push(r); }); return [...m.values()]; };
  const sg = group(d.students), ag = group(d.adults);
  const keepHint = list => { // suggest keeping the one with the most use
    const score = r => (r.attempts || 0) * 10 + (r.tools || 0) + (r.students || 0) + (r.last_login_at ? 1 : 0);
    return list.reduce((a, b) => (score(b) > score(a) ? b : a)).id;
  };
  const page = shell(`<div class="page-head"><h1>Duplicate names</h1><div class="actions"><a class="btn" href="#/students">Students</a><a class="btn" href="#/admin/users">People</a></div></div>
    <p class="muted">Accounts below share the same name. Tick the extra copies you want to delete, then press <b>Delete selected</b>. The copy with the most use is marked <span class="tag good">Keep</span>.
      Deleting a student removes their progress and answers; deleting a tutor or parent account only removes their links to students.</p>
    <div class="panel"><h3>Students (${sg.length} name${sg.length === 1 ? "" : "s"})</h3>
      ${sg.length ? sg.map(g => { const keep = keepHint(g); return `<div class="table-wrap" style="margin-bottom:14px"><table class="data"><thead><tr><th></th><th>${esc(g[0].name)}</th><th>Username</th><th>Grade</th><th class="num">Tools</th><th class="num">Answers</th><th>Last sign-in</th><th>Tutor</th><th>Parents</th><th>Added</th></tr></thead><tbody>
        ${g.map(s => `<tr><td><input type="checkbox" data-s="${s.id}" aria-label="Select ${esc(s.username)}"></td><td><a href="#/student/${s.id}">${esc(s.name)}</a> ${s.id === keep ? '<span class="tag good">Keep</span>' : ""}</td><td>${esc(s.username)}</td><td>${s.grade || "—"}</td>
          <td class="num">${s.tools}</td><td class="num">${s.attempts}</td><td>${ago(s.last_login_at)}</td><td>${esc(s.tutors || "—")}</td><td>${esc(s.parents || "—")}</td><td>${fmtDate(s.created_at)}</td></tr>`).join("")}</tbody></table></div>`; }).join("")
      : '<p class="muted">No students share a name. 👍</p>'}</div>
    <div class="panel" style="margin-top:16px"><h3>Tutors, parents and admins (${ag.length} name${ag.length === 1 ? "" : "s"})</h3>
      ${ag.length ? ag.map(g => { const keep = keepHint(g); return `<div class="table-wrap" style="margin-bottom:14px"><table class="data"><thead><tr><th></th><th>${esc(g[0].name)}</th><th>Role</th><th>Email</th><th class="num">Students</th><th>Last sign-in</th><th>Added</th></tr></thead><tbody>
        ${g.map(u => `<tr><td>${u.id === ME.user.id ? "" : `<input type="checkbox" data-u="${u.id}" aria-label="Select ${esc(u.email)}">`}</td><td>${esc(u.name)} ${u.id === keep ? '<span class="tag good">Keep</span>' : ""}${u.id === ME.user.id ? ' <span class="tag info">You</span>' : ""}</td><td>${roleName(u.role)}</td><td>${esc(u.email)}</td>
          <td class="num" title="${esc(u.student_names || "")}">${u.students}</td><td>${ago(u.last_login_at)}</td><td>${fmtDate(u.created_at)}</td></tr>`).join("")}</tbody></table></div>`; }).join("")
      : '<p class="muted">No tutors, parents or admins share a name. 👍</p>'}</div>
    ${sg.length || ag.length ? `<div class="btn-row" style="margin-top:16px"><span class="muted" id="cnt">Nothing selected</span><button class="btn danger" id="go" disabled>Delete selected</button></div>` : ""}`);
  if (!$("#go", page)) return;
  const picked = () => ({ students: $$("[data-s]:checked", page).map(b => Number(b.dataset.s)), users: $$("[data-u]:checked", page).map(b => Number(b.dataset.u)) });
  $$("input[type=checkbox]", page).forEach(b => b.onchange = () => {
    const p = picked(), n = p.students.length + p.users.length;
    $("#cnt", page).textContent = n ? `${n} selected` : "Nothing selected"; $("#go", page).disabled = !n;
  });
  $("#go", page).onclick = async () => {
    const p = picked();
    const withWork = d.students.filter(s => p.students.includes(s.id) && s.attempts > 0);
    const text = `${p.students.length ? `${p.students.length} student account${p.students.length === 1 ? "" : "s"}` : ""}${p.students.length && p.users.length ? " and " : ""}${p.users.length ? `${p.users.length} tutor/parent/admin account${p.users.length === 1 ? "" : "s"}` : ""} will be deleted. It can’t be undone.` +
      (withWork.length ? ` Warning: ${withWork.map(s => `${s.username} has ${s.attempts} saved answers`).join("; ")}.` : "");
    if (!(await confirmBox("Delete the selected accounts?", esc(text), "Delete", true))) return;
    try { const r = await POST("/api/admin/delete-many", p); toast(`Deleted ${r.students + r.users} account${r.students + r.users === 1 ? "" : "s"}`); render(); } catch (e) { fail(e); }
  };
}, { roles: ["admin"] });

function userModal(u, reload) {
  const self = u.id === ME.user.id;
  modal(`<h2>${esc(u.name)}</h2><form id="f">
    <label class="field"><span>Name</span><input type="text" name="name" value="${esc(u.name)}" required></label>
    <label class="field"><span>Email</span><input type="email" name="email" value="${esc(u.email)}" required></label>
    <label class="field"><span>Role</span><select name="role" ${self ? "disabled" : ""}>${["tutor", "parent", "admin"].map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${roleName(r)}</option>`).join("")}</select></label>
    <label class="field subj"${u.role === "tutor" ? "" : " hidden"}><span>Subject (for tutors)</span><input type="text" name="subject" value="${esc(u.subject || "")}" maxlength="40" placeholder="e.g. Math, English, Physics"><small>Shown next to the tutor’s name, so students and parents know who is who.</small></label>
    <label class="field"><span>New password</span><input type="text" name="password" placeholder="Leave empty to keep the current one" autocomplete="off"></label>
    <label class="check"><input type="checkbox" name="email_verified" ${u.email_verified ? "checked" : ""}><span>Email confirmed</span></label>
    <label class="check"><input type="checkbox" name="active" ${u.active ? "checked" : ""} ${self ? "disabled" : ""}><span>Can sign in</span></label>
    <div class="btn-row">${self ? "" : '<button type="button" class="btn danger" id="del" style="margin-right:auto">Delete account</button>'}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, {
    onMount: (m, close) => {
      const rs = $("select[name=role]", m); if (rs) rs.onchange = () => { $(".subj", m).hidden = rs.value !== "tutor"; };
      onSubmit($("#f", m), async d => {
        if (self) { delete d.role; delete d.active; }
        if (!d.password) delete d.password;
        await PATCH(`/api/admin/users/${u.id}`, d); toast("Saved"); close(); reload().catch(fail);
      });
      if ($("#del", m)) $("#del", m).onclick = async () => {
        close();
        if (!(await confirmBox(`Delete ${u.name}?`, "Their account and links to students are removed. Students and their progress stay.", "Delete account", true))) return;
        DEL(`/api/admin/users/${u.id}`).then(() => { toast("Account deleted"); reload(); }).catch(fail);
      };
    },
  });
}

/* ---------- tools ---------- */
route("/admin/tools", async () => {
  loading();
  const { tools } = await GET("/api/admin/tools");
  const page = shell(`<div class="page-head"><h1>Tools</h1><div class="actions"><button class="btn primary" id="up">Upload a tool</button><button class="btn" id="scan">Check the tools folder</button></div></div>
    <p class="muted">Built-in tools live in the project’s <code>tools/</code> folder. Uploaded tools are single HTML files stored in the database.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Tool</th><th>Subject</th><th>Grades</th><th>Version</th><th class="num">Students</th><th class="num">Use (30 days)</th><th>Status</th><th></th></tr></thead><tbody>
    ${tools.map(t => `<tr><td>${esc(t.icon)} <b>${esc(t.name)}</b><div class="small muted">${esc(t.slug)} · ${t.source === "upload" ? "uploaded" : "built-in"}</div></td>
      <td><span class="subject ${esc(t.subject)}">${esc(t.subject)}</span></td><td>${t.grade_min}–${t.grade_max}</td><td>${esc(t.version)}</td>
      <td class="num">${t.assigned}</td><td class="num">${minutes(t.seconds_30d)}</td><td>${t.active ? '<span class="tag good">On</span>' : '<span class="tag bad">Off</span>'}</td>
      <td style="white-space:nowrap"><a class="btn small" href="#/play/${esc(t.slug)}?from=%23%2Fadmin%2Ftools">Preview</a> <button class="btn small" data-assign="${t.id}">Give to students</button> <button class="btn small" data-edit="${t.id}">Edit</button></td></tr>`).join("") || '<tr><td colspan="8" class="empty">No tools yet. Upload one or add a folder to tools/.</td></tr>'}
    </tbody></table></div>`);
  $("#up", page).onclick = () => uploadToolModal(null);
  $("#scan", page).onclick = async () => { try { const r = await POST("/api/admin/tools/rescan"); toast(`Found ${r.found.length} built-in tool${r.found.length === 1 ? "" : "s"}`); render(); } catch (e) { fail(e); } };
  $$("[data-edit]", page).forEach(b => b.onclick = () => editToolModal(tools.find(t => t.id === Number(b.dataset.edit))));
  $$("[data-assign]", page).forEach(b => b.onclick = () => bulkAssignModal(tools.find(t => t.id === Number(b.dataset.assign))));
}, { roles: ["admin"] });

const subjectOptions = cur => ["math", "physics", "chemistry", "science", "other"].map(s => `<option ${s === cur ? "selected" : ""}>${s}</option>`).join("");
const gradeOptions = cur => Array.from({ length: 12 }, (_, i) => `<option ${Number(cur) === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("");

function uploadToolModal(existing) {
  const t = existing || { subject: "math", grade_min: 5, grade_max: 8, icon: "🧮" };
  modal(`<h2>${existing ? `Replace ${esc(t.name)}` : "Upload a tool"}</h2>
    <p class="small muted">Choose a single <code>.html</code> file. Tools that save with <code>localStorage</code> work as they are: each student’s data is saved on the server automatically. Use <code>AMT.attempt()</code> to send answers to reports (see <code>tools/_template</code>).</p>
    <form id="f">
      <label class="field"><span>HTML file</span><input type="file" id="file" accept=".html,.htm,text/html" ${existing ? "" : "required"}></label>
      <div class="grid cols-2">
        <label class="field"><span>Name</span><input type="text" name="name" value="${esc(t.name || "")}" required></label>
        <label class="field"><span>Short name for links</span><input type="text" name="slug" value="${esc(t.slug || "")}" ${existing ? "readonly" : ""} required pattern="[a-z0-9][a-z0-9\\-]{1,48}" placeholder="fractions-lab"><small>Lowercase letters, numbers and dashes.</small></label>
        <label class="field"><span>Subject</span><select name="subject">${subjectOptions(t.subject)}</select></label>
        <label class="field"><span>Icon (an emoji)</span><input type="text" name="icon" value="${esc(t.icon)}" maxlength="8"></label>
        <label class="field"><span>From grade</span><select name="grade_min">${gradeOptions(t.grade_min)}</select></label>
        <label class="field"><span>To grade</span><select name="grade_max">${gradeOptions(t.grade_max)}</select></label>
      </div>
      <label class="field"><span>Description</span><input type="text" name="description" value="${esc(t.description || "")}" maxlength="500"></label>
      <details><summary class="small" style="cursor:pointer;margin-bottom:10px">Plan settings for tutors (optional, JSON)</summary>
        <label class="field"><textarea name="settings_schema" placeholder='[{"key":"level","label":"Level","type":"select","options":["easy","hard"]}]'>${existing && existing.settings_schema && existing.settings_schema.length ? esc(JSON.stringify(existing.settings_schema, null, 1)) : ""}</textarea></label></details>
      <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${existing ? "Upload new version" : "Upload tool"}</button></div>
    </form>`, {
    wide: true,
    onMount: (m, close) => {
      const file = $("#file", m);
      file.onchange = () => {
        const f = file.files[0]; if (!f) return;
        const base = f.name.replace(/\.html?$/i, "");
        if (!$('[name="slug"]', m).value) $('[name="slug"]', m).value = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
        if (!$('[name="name"]', m).value) $('[name="name"]', m).value = base.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      };
      onSubmit($("#f", m), async d => {
        let html;
        if (file.files[0]) { if (file.files[0].size > 8e6) throw new Error("The file is larger than 8 MB."); html = await file.files[0].text(); }
        else if (existing) {
          const r = await fetch(`/api/admin/tools/${existing.id}/download`); if (!r.ok) throw new Error("Choose a file."); html = await r.text();
        }
        await POST("/api/admin/tools/upload", { ...d, html });
        toast(existing ? "New version uploaded" : "Tool uploaded"); close(); render();
      });
    },
  });
}

function editToolModal(t) {
  modal(`<h2>${esc(t.icon)} ${esc(t.name)}</h2>
    ${t.source === "folder" ? `<p class="small muted">Built-in tool from <code>tools/${esc(t.slug)}/</code>. Changes here stay until the tool’s manifest version changes.</p>` : ""}
    <form id="f"><div class="grid cols-2">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(t.name)}" required></label>
      <label class="field"><span>Icon</span><input type="text" name="icon" value="${esc(t.icon)}" maxlength="8"></label>
      <label class="field"><span>Subject</span><select name="subject">${subjectOptions(t.subject)}</select></label>
      <label class="field"><span>Grades</span><div class="inline"><select name="grade_min">${gradeOptions(t.grade_min)}</select> to <select name="grade_max">${gradeOptions(t.grade_max)}</select></div></label></div>
      <label class="field"><span>Description</span><input type="text" name="description" value="${esc(t.description)}" maxlength="500"></label>
      <label class="check"><input type="checkbox" name="active" ${t.active ? "checked" : ""}><span>Turned on (students with this tool can open it)</span></label>
      <div class="btn-row">
        ${t.source === "upload" ? `<button type="button" class="btn danger" id="del" style="margin-right:auto">Delete</button><button type="button" class="btn" id="rep">Upload new version</button><a class="btn" href="/api/admin/tools/${t.id}/download">Download</a>` : ""}
        <button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, {
    wide: true,
    onMount: (m, close) => {
      onSubmit($("#f", m), async d => { await PATCH(`/api/admin/tools/${t.id}`, d); toast("Saved"); close(); render(); });
      if ($("#rep", m)) $("#rep", m).onclick = () => { close(); uploadToolModal(t); };
      if ($("#del", m)) $("#del", m).onclick = async () => {
        close();
        if (!(await confirmBox(`Delete ${t.name}?`, `This removes the tool and every student’s progress, answers and badges in it. It can’t be undone. Turning it off keeps everything.`, "Delete tool", true))) return;
        DEL(`/api/admin/tools/${t.id}?confirm=${encodeURIComponent(t.slug)}`).then(() => { toast("Tool deleted"); render(); }).catch(fail);
      };
    },
  });
}

async function bulkAssignModal(t) {
  const { students } = await GET("/api/students");
  const { users: tutorList } = await GET("/api/admin/users?role=tutor");
  modal(`<h2>Give ${esc(t.icon)} ${esc(t.name)} to students</h2>
    <p class="small muted">Recommended for grades ${t.grade_min}–${t.grade_max}.</p>
    <div class="inline" style="margin-bottom:10px"><button class="btn small" id="fit">Select grades ${t.grade_min}–${t.grade_max}</button><button class="btn small" id="none">Clear</button><input type="search" id="q" placeholder="Filter" aria-label="Filter students"></div>
    <div class="table-wrap" style="max-height:340px;overflow:auto"><table class="data"><tbody>
      ${students.map(s => `<tr data-name="${esc(s.name.toLowerCase())}"><td><label class="check" style="margin:0"><input type="checkbox" value="${s.id}" data-grade="${s.grade || ""}"><span>${esc(s.name)}</span></label></td><td>${s.grade ? "Grade " + s.grade : ""}</td></tr>`).join("") || '<tr><td class="empty">No students yet.</td></tr>'}
    </tbody></table></div>
    <label class="field" style="margin-top:12px"><span>Tutor for this tool (optional)</span><select id="btutor"><option value="0">Shared by each student’s tutors</option>${tutorList.filter(x => x.active).map(x => `<option value="${x.id}">${esc(tutorLabel(x))} only</option>`).join("")}</select><small>If you pick a tutor, the tool belongs to that tutor for the selected students they teach.</small></label>
    <label class="field" style="margin-top:12px"><span>Access ends (optional)</span><input type="date" id="exp"></label>
    <div class="btn-row"><button class="btn danger" id="rev" style="margin-right:auto">Remove from selected</button><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Give to selected</button></div>`, {
    wide: true,
    onMount: (m, close) => {
      const boxes = () => $$("input[type=checkbox]", m);
      $("#fit", m).onclick = () => boxes().forEach(b => { const g = Number(b.dataset.grade); b.checked = g >= t.grade_min && g <= t.grade_max; });
      $("#none", m).onclick = () => boxes().forEach(b => b.checked = false);
      $("#q", m).oninput = e => $$("tr[data-name]", m).forEach(tr => tr.style.display = tr.dataset.name.includes(e.target.value.toLowerCase()) ? "" : "none");
      const send = async action => {
        const ids = boxes().filter(b => b.checked).map(b => Number(b.value));
        if (!ids.length) return toast("Select at least one student", true);
        try {
          const r = await POST("/api/admin/allocations/bulk", { tool_id: t.id, student_ids: ids, action, tutor_id: Number($("#btutor", m).value) || null, expires_at: $("#exp", m).value ? new Date($("#exp", m).value + "T23:59:59").toISOString() : null });
          toast(`${action === "revoke" ? "Removed from" : "Given to"} ${r.changed} student${r.changed === 1 ? "" : "s"}`); close(); render();
        } catch (e) { fail(e); }
      };
      $("#go", m).onclick = () => send("assign");
      $("#rev", m).onclick = () => send("revoke");
    },
  });
}

/* ---------- invites ---------- */
route("/admin/invites", async () => {
  loading();
  const { invites } = await GET("/api/admin/invites");
  const state = i => i.used_at ? `<span class="tag good">Used by ${esc(i.used_by_name || "someone")}</span>` : new Date(i.expires_at) < new Date() ? '<span class="tag">Expired</span>' : '<span class="tag info">Waiting</span>';
  const page = shell(`<div class="page-head"><h1>Invite codes</h1></div>
    <p class="muted">Parent codes are made on each student’s page under “Parents & tutors”. Tutor codes are made under People.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Code</th><th>For</th><th>Student</th><th>Email</th><th>Made by</th><th>Valid until</th><th>Status</th><th></th></tr></thead><tbody>
    ${invites.map(i => `<tr><td><b>${esc(i.code)}</b></td><td>${roleName(i.role)}</td><td>${esc(i.student_name || "—")}</td><td>${esc(i.email || "Anyone with the code")}</td><td>${esc(i.created_by_name || "")}</td><td>${fmtDate(i.expires_at)}</td><td>${state(i)}</td>
      <td class="num">${!i.used_at ? `<button class="btn small" data-copy="${esc(i.code)}">Copy</button> <button class="btn small danger" data-del="${i.id}">Cancel</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="empty">No invite codes yet.</td></tr>'}
    </tbody></table></div>`);
  $$("[data-copy]", page).forEach(b => b.onclick = () => copy(b.dataset.copy));
  $$("[data-del]", page).forEach(b => b.onclick = () => DEL(`/api/admin/invites/${b.dataset.del}`).then(() => { toast("Code cancelled"); render(); }).catch(fail));
}, { roles: ["admin"] });

/* ---------- activity log ---------- */
const ACTIONS = {
  login: "Signed in", signup_invite: "Created account with invite", link_invite: "Linked with invite", create_student: "Added student", update_student: "Edited student",
  delete_student: "Deleted student", reset_pin: "Made new PIN", assign_tool: "Gave tool", update_plan: "Changed plan", update_allocation: "Changed tool access",
  reset_progress: "Cleared progress", view_student: "Viewed student", view_tool: "Opened student’s tool", create_invite: "Made invite code", unlink_adult: "Removed parent/tutor",
  create_user: "Added account", update_user: "Edited account", delete_user: "Deleted account", link_adult: "Linked parent/tutor", bulk_import_students: "Imported students",
  update_tool: "Edited tool", upload_tool: "Uploaded tool", replace_tool: "Replaced tool", delete_tool: "Deleted tool", bulk_assign: "Gave tool to many", bulk_revoke: "Removed tool from many",
  change_password: "Changed password",
};
route("/admin/audit", async (q) => {
  loading();
  const action = q.action || "";
  const { log } = await GET(`/api/admin/audit?limit=500${action ? `&action=${encodeURIComponent(action)}` : ""}`);
  const page = shell(`<div class="page-head"><h1>Activity log</h1>
      <select id="a" aria-label="Filter" style="width:auto"><option value="">Everything</option>${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" ${k === action ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    <p class="muted">Who did what, including every time an adult opened a student’s records.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Student</th><th>Details</th></tr></thead><tbody>
    ${log.map(l => `<tr><td style="white-space:nowrap">${fmtDateTime(l.created_at)}</td><td>${esc(l.actor || "—")}${l.actor_role ? ` <span class="small muted">${roleName(l.actor_role)}</span>` : ""}</td>
      <td>${esc(ACTIONS[l.action] || l.action)}</td><td>${esc(l.student || "")}</td><td class="small muted">${l.detail ? esc(Object.entries(l.detail).map(([k, v]) => `${k}: ${v}`).join(", ")) : ""}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}
    </tbody></table></div>`);
  $("#a", page).onchange = e => { location.hash = `#/admin/audit${e.target.value ? "?action=" + e.target.value : ""}`; };
}, { roles: ["admin"] });

/* =====================================================================
   Start
   ===================================================================== */
/* =====================================================================
   Messages — one conversation per student (student, parents, tutors, admins)
   ===================================================================== */
let UNREAD = { unread: 0, homework: 0, at: 0 };
async function refreshUnread(force = false) {
  if (!ME.user || (!force && Date.now() - UNREAD.at < 20e3)) return paintBadge();
  UNREAD.at = Date.now();
  try { const u = await GET("/api/messages/unread"); UNREAD = { ...u, at: Date.now() }; } catch { /* offline */ }
  paintBadge();
}
function paintBadge() { const b = $("#nbadge"); if (!b) return; b.textContent = UNREAD.unread > 99 ? "99+" : UNREAD.unread; b.hidden = !UNREAD.unread; }
setInterval(() => { if (document.visibilityState === "visible") refreshUnread(true); }, 45e3);

const fileIcon = m => (/^image\//.test(m) ? "🖼️" : /pdf/.test(m) ? "📕" : /presentation|powerpoint|keynote/.test(m) ? "📊" : /sheet|excel|csv|numbers/.test(m) ? "📗" : /word|document|text|rtf|pages/.test(m) ? "📄" : /audio/.test(m) ? "🎧" : /video/.test(m) ? "🎬" : /zip/.test(m) ? "🗜️" : "📎");
const fileSize = n => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
const timeOf = d => new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayOf = d => { const x = new Date(d), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1); return x.toDateString() === t.toDateString() ? "Today" : x.toDateString() === y.toDateString() ? "Yesterday" : x.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); };
const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
const dueText = d => { if (!d) return ""; const days = Math.round((new Date(d + "T00:00") - new Date(new Date().toDateString())) / 86400e3); return `due ${new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${days === 0 ? " (today)" : days === 1 ? " (tomorrow)" : days < 0 ? " (late)" : ""}`; };

let MSG = { timer: null };
route("/messages", () => messagesPage(null));
route("/messages/:sid", (sid, q) => messagesPage(Number(sid), q.t));

async function messagesPage(sid, key) {
  clearInterval(MSG.timer);
  const me = ME.user;
  if (me.role === "student") sid = me.id;
  loading();
  const T = await GET("/api/messages/threads");
  const single = me.role === "student" || (T.threads.length === 1 && !sid);
  if (single && !sid && T.threads[0]) sid = T.threads[0].id;
  const page = shell(`<div class="msg-wrap ${sid ? "has-thread" : ""} ${me.role === "student" ? "solo" : ""}">
      ${me.role === "student" ? "" : `<aside class="msg-list panel"><div class="msg-list-head"><h2>Messages</h2><input type="search" id="mq" placeholder="Find a student" aria-label="Find a student"></div><div id="tlist"></div></aside>`}
      <section class="msg-thread panel" id="thread">${sid ? '<p class="muted">Loading…</p>' : `<div class="empty"><div style="font-size:2.4rem">💬</div><h3>Choose a student</h3><p>Each student has one conversation with their parents, tutor and admins. Share homework, slides and notes there.</p></div>`}</section>
    </div>`);
  page.classList.add("page-wide");
  const wrap = $(".msg-wrap", page);
  const fit = () => { if (!document.body.contains(wrap)) return window.removeEventListener("resize", fit); const top = wrap.getBoundingClientRect().top + window.scrollY; wrap.style.height = Math.max(380, window.innerHeight - top - (window.innerWidth > 800 ? 18 : 0)) + "px"; };
  fit(); window.addEventListener("resize", fit);
  // ---- conversation list
  function drawList(q = "") {
    const box = $("#tlist", page); if (!box) return;
    const list = T.threads.filter(t => !q || t.name.toLowerCase().includes(q.toLowerCase()));
    box.innerHTML = list.map(t => `<a class="thread-item ${t.id === sid ? "on" : ""}" href="#/messages/${t.id}">
        <span class="avatar">${esc(t.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase())}</span>
        <span class="ti"><b>${esc(t.name)}</b>${t.grade ? ` <span class="muted small">· Gr ${t.grade}</span>` : ""}
          <span class="prev">${t.last_id ? `${t.last_kind === "homework" ? "📝 " : ""}${esc(t.last_sender.split(" ")[0])}: ${esc(t.last_body || (t.last_files ? `📎 ${t.last_files} file${t.last_files === 1 ? "" : "s"}` : ""))}` : '<i class="muted">No messages yet</i>'}</span></span>
        <span class="tm">${t.last_at ? `<span class="small muted">${dayOf(t.last_at) === "Today" ? timeOf(t.last_at) : new Date(t.last_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>` : ""}${t.unread && (me.role !== "admin" || t.following) ? `<span class="nbadge">${t.unread}</span>` : t.open_homework ? `<span class="tag warn" title="Homework not done yet">📝 ${t.open_homework}</span>` : ""}</span></a>`).join("") || '<p class="muted small" style="padding:10px">No students.</p>';
  }
  drawList();
  if (me.role === "admin") GET("/api/messages/storage").then(st => { const h = $(".msg-list-head", page); if (h) h.insertAdjacentHTML("beforeend", `<div class="small muted" style="margin-top:8px">Attachments use ${fileSize(st.used)} of ${fileSize(st.limit)}</div>`); }).catch(() => {});
  if ($("#mq", page)) $("#mq", page).oninput = e => drawList(e.target.value);
  if (!sid) return;
  await openThread(page, sid, T, key);
}

async function openThread(page, sid, T, wantKey) {
  const me = ME.user, box = $("#thread", page);
  let D = await GET(`/api/messages/threads/${sid}${wantKey !== undefined && wantKey !== null && wantKey !== "" ? `?key=${encodeURIComponent(wantKey)}` : ""}`);
  const tabLabel = t => (t.key === 0 ? "👥 General" : `${t.key === me.id ? "💬 " : "📘 "}${esc(t.subject ? `${t.subject} · ${t.name.split(" ")[0]}` : t.name)}${t.key === me.id ? " (you)" : ""}${t.linked ? "" : " · former"}`);
  const tabsHTML = () => D.threads.length > 1 ? `<div class="th-tabs" role="tablist">${D.threads.map(t => `<a role="tab" class="th-tab ${t.key === D.key ? "on" : ""}" href="#/messages/${sid}?t=${t.key}" title="${t.key === 0 ? "Everyone: student, parents, all tutors" : `Only ${esc(t.name)}, the student, parents and admins`}">${tabLabel(t)}${t.unread && t.key !== D.key ? `<span class="nbadge">${t.unread}</span>` : ""}</a>`).join("")}</div>` : "";
  const others = T.threads.filter(t => t.id !== sid);
  let pending = [], lastSig = "", uploading = 0;
  const first = D.student.name.split(" ")[0];
  box.innerHTML = `<div class="th-head">
      ${me.role === "student" ? "" : `<a class="btn small th-back" href="#/messages">‹</a>`}
      <div class="th-title"><h2>${me.role === "student" ? "My messages" : esc(D.student.name)}</h2>
        <div class="small muted">${me.role === "student" ? "With " : ""}${D.people.length ? D.people.map(p => `${esc(p.name)} <span class="tag">${p.relation === "parent" ? "Parent" : p.subject ? esc(p.subject) + " tutor" : "Tutor"}</span>`).join(" ") : "No parent or tutor linked yet"}${me.role !== "student" ? ` · ${esc(first)}` : ""}</div></div>
      <div class="th-actions">${me.role === "student" ? "" : `<a class="btn small" href="#/student/${sid}">Student page</a>`}<button class="btn small" id="hwOnly" aria-pressed="false">📝 Homework</button></div>
    </div>
    <div id="tabs">${tabsHTML()}</div>
    <div class="msgs" id="msgs"></div>
    ${D.canWrite ? "" : `<div class="composer small muted">This tutor is no longer linked to ${esc(first)}, so this conversation is read-only.</div>`}
    <form class="composer" id="comp"${D.canWrite ? "" : " hidden"}>
      <div class="pend" id="pend"></div>
      <div class="opts" id="opts">
        ${D.canHomework ? `<label class="chip"><input type="checkbox" id="isHw"> 📝 Homework</label><label class="chip hw-due" hidden>Due <input type="date" id="due"></label>` : ""}
        ${D.canAdultsOnly ? `<label class="chip" title="${esc(first)} won’t see this message"><input type="checkbox" id="adOnly"> 🔒 Adults only</label>` : ""}
        ${D.canHomework && others.length ? `<button type="button" class="chip" id="also">👥 Also send to… <b id="alsoN"></b></button>` : ""}
      </div>
      <div class="row">
        <label class="btn attach" title="Attach files (homework, slides, PDFs, photos)">📎<input type="file" id="fpick" multiple hidden></label>
        <textarea id="mbody" rows="1" placeholder="${me.role === "student" ? "Write to your tutor and parents…" : `Write a message about ${esc(first)}…`}"></textarea>
        <button class="btn primary" id="send" type="submit">Send</button>
      </div>
      <div class="small muted hint">Attach PDFs, PowerPoint, Word, Excel, pictures, audio or video (up to 15 MB each). Ctrl + Enter sends.</div>
    </form>`;
  const msgs = $("#msgs", box), ta = $("#mbody", box);
  let hwOnly = false, also = [];
  // ---- messages
  function draw(force) {
    const sig = JSON.stringify(D.messages.map(m => [m.id, m.done_at, !!m.deleted_at]));
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
    let day = "";
    const list = D.messages.filter(m => !hwOnly || m.kind === "homework");
    msgs.innerHTML = list.map(m => {
      const mine = m.sender_id === me.id, d = dayOf(m.created_at), sep = d !== day ? `<div class="day"><span>${d}</span></div>` : ""; day = d;
      if (m.deleted_at) return sep + `<div class="msg ${mine ? "mine" : ""}"><div class="bubble deleted">Message deleted</div></div>`;
      const files = m.files.map(f => /^image\/(png|jpeg|gif|webp)$/.test(f.mime)
        ? `<a class="thumb" href="/api/messages/files/${f.id}" target="_blank" rel="noopener"><img src="/api/messages/files/${f.id}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')"><span>${esc(f.name)}</span></a>`
        : `<a class="file" href="/api/messages/files/${f.id}${/pdf|audio|video/.test(f.mime) ? "" : "?download=1"}" target="_blank" rel="noopener"><span class="fi">${fileIcon(f.mime)}</span><span><b>${esc(f.name)}</b><small>${fileSize(f.size)}</small></span><span class="dl">⤓</span></a>`).join("");
      const hw = m.kind === "homework" ? `<div class="hw ${m.done_at ? "done" : ""}"><b>📝 Homework</b> ${m.due_date ? `<span>${dueText(m.due_date)}</span>` : ""}
          <span class="hw-st">${m.done_at ? `✅ Done ${fmtDate(m.done_at)}` : "Not done yet"}</span>
          ${me.role !== "parent" ? `<button class="btn small" data-done="${m.id}" data-v="${m.done_at ? 0 : 1}">${m.done_at ? "Mark not done" : "Mark as done"}</button>` : ""}</div>` : "";
      return sep + `<div class="msg ${mine ? "mine" : ""} ${m.kind === "homework" ? "is-hw" : ""}" data-id="${m.id}">
        <div class="meta">${mine ? "You" : esc(m.sender_name)} <span class="tag role-${m.sender_role}">${roleName(m.sender_role)}</span> · ${timeOf(m.created_at)}${m.adults_only ? ' · <span class="tag warn" title="The student can’t see this">🔒 Adults only</span>' : ""}
          ${mine || me.role === "admin" ? `<button class="linkbtn" data-del="${m.id}" title="Delete">Delete</button>` : ""}</div>
        <div class="bubble">${hw}${m.body ? `<div class="text">${linkify(m.body)}</div>` : ""}${files ? `<div class="files">${files}</div>` : ""}</div></div>`;
    }).join("") || `<div class="empty"><div style="font-size:2rem">✉️</div><p>${hwOnly ? "No homework yet." : D.key === 0 ? `No messages yet. Everyone linked to ${me.role === "student" ? "you" : esc(first)} reads this General conversation.` : me.role === "student" ? "No messages yet. You can write to this tutor here." : `No messages yet. Only ${esc((D.threads.find(t => t.key === D.key) || {}).name || "this tutor")}, ${esc(first)}, the parents and admins see this conversation.`}</p></div>`;
    if (force || nearBottom) msgs.scrollTop = msgs.scrollHeight;
    $$("[data-done]", msgs).forEach(b => b.onclick = async () => { try { await POST(`/api/messages/${b.dataset.done}/done`, { done: b.dataset.v === "1" }); await reload(); toast(b.dataset.v === "1" ? "Marked as done 🎉" : "Marked as not done"); } catch (e) { fail(e); } });
    $$("[data-del]", msgs).forEach(b => b.onclick = async () => { if (!(await confirmBox("Delete this message?", "It is removed for everyone, with its attachments.", "Delete", true))) return; try { await DEL(`/api/messages/${b.dataset.del}`); await reload(); } catch (e) { fail(e); } });
  }
  async function reload() { try { D = { ...D, ...(await GET(`/api/messages/threads/${sid}?key=${D.key}`)) }; draw(); $("#tabs", box).innerHTML = tabsHTML(); refreshUnread(true); } catch { /* offline: try again next tick */ } }
  draw(true);
  refreshUnread(true);
  MSG.timer = setInterval(() => { if (!document.body.contains(box)) return clearInterval(MSG.timer); if (document.visibilityState === "visible") reload(); }, 12e3);
  $("#hwOnly", box).onclick = e => { hwOnly = !hwOnly; e.currentTarget.classList.toggle("primary", hwOnly); e.currentTarget.setAttribute("aria-pressed", hwOnly); draw(true); };
  // ---- composer
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(220, ta.scrollHeight + 2) + "px"; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#comp", box).requestSubmit(); } });
  if ($("#isHw", box)) $("#isHw", box).onchange = e => { $(".hw-due", box).hidden = !e.target.checked; if (e.target.checked && $("#adOnly", box)) $("#adOnly", box).checked = false; };
  if ($("#adOnly", box)) $("#adOnly", box).onchange = e => { if (e.target.checked && $("#isHw", box)) { $("#isHw", box).checked = false; $(".hw-due", box).hidden = true; } };
  if ($("#also", box)) $("#also", box).onclick = () => modal(`<h2>Also send to</h2><p class="small muted">The same message and files go into each student’s own conversation.</p>
      <div class="also-list">${others.map(t => `<label class="check"><input type="checkbox" value="${t.id}" ${also.includes(t.id) ? "checked" : ""}><span>${esc(t.name)}${t.grade ? ` <span class="muted small">· Grade ${t.grade}</span>` : ""}</span></label>`).join("")}</div>
      <div class="btn-row"><button class="btn" id="aAll" type="button">Select all</button><span style="flex:1"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="aOk">Done</button></div>`, {
    onMount: (m, close) => { $("#aAll", m).onclick = () => $$("input", m).forEach(i => i.checked = true); $("#aOk", m).onclick = () => { also = $$("input:checked", m).map(i => Number(i.value)); $("#alsoN", box).textContent = also.length ? `(${also.length})` : ""; close(); }; } });
  function drawPending() {
    $("#pend", box).innerHTML = pending.map((p, i) => `<span class="pfile ${p.err ? "err" : ""}">${fileIcon(p.mime || "")} ${esc(p.name)} <small>${p.err ? esc(p.err) : p.id ? fileSize(p.size) : `${p.pct || 0}%`}</small><button type="button" data-rm="${i}" aria-label="Remove">✕</button></span>`).join("");
    $$("[data-rm]", box).forEach(b => b.onclick = () => { pending.splice(+b.dataset.rm, 1); drawPending(); });
  }
  function upload(file) {
    const item = { name: file.name, size: file.size, pct: 0 }; pending.push(item); drawPending();
    if (file.size > 15 * 1048576) { item.err = "too large (max 15 MB)"; drawPending(); return; }
    uploading++;
    const x = new XMLHttpRequest(); x.open("POST", "/api/messages/files");
    x.setRequestHeader("X-AMT", "1"); x.setRequestHeader("X-Filename", encodeURIComponent(file.name)); x.setRequestHeader("Content-Type", "application/octet-stream");
    x.upload.onprogress = e => { if (e.lengthComputable) { item.pct = Math.round(e.loaded / e.total * 100); drawPending(); } };
    x.onload = () => { uploading--; let j = {}; try { j = JSON.parse(x.responseText); } catch {} if (x.status === 200) Object.assign(item, j.file); else item.err = j.error || "upload failed"; drawPending(); };
    x.onerror = () => { uploading--; item.err = "upload failed"; drawPending(); };
    x.send(file);
  }
  $("#fpick", box).onchange = e => { [...e.target.files].forEach(upload); e.target.value = ""; };
  box.addEventListener("dragover", e => { e.preventDefault(); box.classList.add("drop"); });
  box.addEventListener("dragleave", e => { if (e.target === box) box.classList.remove("drop"); });
  box.addEventListener("drop", e => { e.preventDefault(); box.classList.remove("drop"); [...(e.dataTransfer.files || [])].forEach(upload); });
  ta.addEventListener("paste", e => { const fs = [...(e.clipboardData ? e.clipboardData.files : [])]; if (fs.length) { e.preventDefault(); fs.forEach(upload); } });
  $("#comp", box).addEventListener("submit", async e => {
    e.preventDefault();
    if (uploading) return toast("Wait for the files to finish uploading.", true);
    const files = pending.filter(p => p.id).map(p => p.id), body = ta.value.trim();
    if (!body && !files.length) return ta.focus();
    const isHw = $("#isHw", box) && $("#isHw", box).checked;
    const btn = $("#send", box); btn.disabled = true;
    try {
      const r = await POST(`/api/messages/threads/${sid}`, { key: D.key, body, files, kind: isHw ? "homework" : "message", due_date: isHw ? $("#due", box).value : null, adults_only: !!($("#adOnly", box) && $("#adOnly", box).checked), also });
      ta.value = ""; grow(); pending = []; drawPending(); also = []; if ($("#alsoN", box)) $("#alsoN", box).textContent = "";
      if ($("#isHw", box)) { $("#isHw", box).checked = false; $(".hw-due", box).hidden = true; }
      if ($("#adOnly", box)) $("#adOnly", box).checked = false;
      if (r.sent > 1) toast(`Sent to ${r.sent} students`);
      await reload(); draw(true);
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
  if (window.innerWidth > 800) ta.focus();
}

/* =====================================================================
   Leads — answers from the public interest form (/interest), with a share kit
   ===================================================================== */
const LEAD_STATUS = [["new", "New", "warn"], ["contacted", "Contacted", "info"], ["trial", "Trial booked", "info"], ["enrolled", "Enrolled", "good"], ["not_now", "Not now", ""]];
const SUBJ_COLOR = { "Math": "#2563eb", "Physics": "#e66414", "Science": "#0d9b5c", "Python for Kids": "#b07f00" };
const CHANNELS = [["whatsapp", "WhatsApp"], ["telegram", "Telegram"], ["facebook", "Facebook"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["poster", "Poster / QR"]];
const shareText = (ch, url) => {
  const bold = ch === "whatsapp" ? s => `*${s}*` : ch === "telegram" ? s => `**${s}**` : s => s;
  return `🎓 ${bold("Afro-Merica Tutor & Training")}
Math ➗ · Physics ⚛️ · Science 🔬 · Python for Kids 🐍
Grades K–12 · Online & in person

✨ Hands-on visual labs that make ideas click
👩‍🏫 1-on-1 or small groups
📈 Progress reports for parents

Tell us about your child — it takes 1 minute 👇
${url}`;
};
function downloadQR(url, name) {
  const q = QR.make(url, "Q"), scale = 24, n = q.size + 8, c = document.createElement("canvas"); c.width = c.height = n * scale;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#002d5f";
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.get(x, y)) g.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
  const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = name; a.click();
}

route("/admin/leads", async q => {
  loading();
  let status = q.status || "", subject = "", search = "";
  const page = shell(`<div class="page-head"><h1>Leads</h1><div class="actions"><a class="btn" href="/interest" target="_blank" rel="noopener">Open the form ↗</a><a class="btn" href="/api/admin/export/leads.csv">Download CSV</a></div></div>
    <details class="panel sharekit" ${q.share ? "open" : ""}><summary><b>📣 Share kit</b> <span class="muted small">— links, messages, QR code and posters for WhatsApp, Telegram and social media</span></summary><div id="kit"></div></details>
    <div class="inline" style="margin:16px 0 12px"><div class="chips-row" id="stat"></div>
      <select id="subj" aria-label="Subject"><option value="">All subjects</option>${Object.keys(SUBJ_COLOR).map(s => `<option>${s}</option>`).join("")}</select>
      <input type="search" id="q" placeholder="Search name, phone, city" aria-label="Search"></div>
    <div id="sources" class="small muted" style="margin-bottom:10px"></div>
    <div id="list"><p class="muted">Loading…</p></div>`);
  // ---- share kit
  const base = `${location.origin}/interest`;
  let ch = "whatsapp";
  function drawKit() {
    const url = `${base}?src=${ch}`;
    $("#kit", page).innerHTML = `<div class="kit-tabs">${CHANNELS.map(([k, n]) => `<button class="chip-btn ${k === ch ? "on" : ""}" data-ch="${k}">${n}</button>`).join("")}</div>
      <div class="kit-grid"><div>
        <label class="field"><span>Link for ${esc(CHANNELS.find(c => c[0] === ch)[1])}</span><div class="inline"><input type="text" readonly value="${esc(url)}" id="kUrl" style="flex:1"><button class="btn" id="kCopyUrl">Copy link</button></div><small>Each channel has its own link, so the Leads list shows where every parent came from.</small></label>
        ${ch === "poster" ? `<p class="small">Print or post these. The QR code opens the form.</p><div class="btn-row"><a class="btn primary" href="/promo/poster.png" download>⬇ Poster (4:5, for posts)</a><a class="btn" href="/promo/story.png" download>⬇ Story (9:16, for Status)</a><button class="btn" id="kQR">⬇ QR code only</button></div>`
          : `<label class="field"><span>Message to post</span><textarea id="kMsg" rows="11" readonly>${esc(shareText(ch, url))}</textarea></label>
             <div class="btn-row"><button class="btn primary" id="kCopyMsg">Copy message</button>${ch === "whatsapp" ? `<a class="btn wa-btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText(ch, url))}">Open WhatsApp</a>` : ch === "telegram" ? `<a class="btn" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(shareText("plain", "").trim())}">Open Telegram</a>` : ch === "facebook" ? `<a class="btn" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Share on Facebook</a>` : ""}
             <a class="btn" href="/promo/poster.png" download>⬇ Poster image</a></div>`}
      </div><div class="kit-qr">${QR.svg(url, { level: "Q", color: "#002d5f" })}<div class="small muted">Scan to open the form</div></div></div>`;
    $$("[data-ch]", page).forEach(b => b.onclick = () => { ch = b.dataset.ch; drawKit(); });
    $("#kCopyUrl", page).onclick = () => copy(url);
    if ($("#kCopyMsg", page)) $("#kCopyMsg", page).onclick = () => copy($("#kMsg", page).value);
    if ($("#kQR", page)) $("#kQR", page).onclick = () => downloadQR(url, "afro-merica-tutor-qr.png");
  }
  drawKit();
  // ---- list
  async function load() {
    const d = await GET(`/api/admin/leads?status=${status}&subject=${encodeURIComponent(subject)}&q=${encodeURIComponent(search)}`);
    const cnt = Object.fromEntries(d.counts.map(c => [c.status, c.n])), total = d.counts.reduce((a, c) => a + c.n, 0);
    $("#stat", page).innerHTML = [["", "All", ""], ...LEAD_STATUS].map(([k, n]) => `<button class="chip-btn ${k === status ? "on" : ""}" data-st="${k}">${n} <b>${k ? cnt[k] || 0 : total}</b></button>`).join("");
    $$("[data-st]", page).forEach(b => b.onclick = () => { status = b.dataset.st; load().catch(fail); });
    $("#sources", page).innerHTML = d.sources.length ? "Came from: " + d.sources.map(s => `<span class="tag">${esc(s.source)} ${s.n}</span>`).join(" ") : "";
    $("#list", page).innerHTML = d.leads.length ? `<div class="leads">${d.leads.map(l => {
      const first = l.parent_name.split(/\s+/)[0];
      const hello = `Hello ${first}, this is Afro-Merica Tutor & Training 👋 Thank you for your interest in ${l.subjects.join(" & ")}${l.grades.length ? ` for grade ${l.grades.join(", ")}` : ""}. When is a good time to talk about a plan for your child?`;
      return `<article class="lead" data-id="${l.id}">
        <div class="lead-top"><div><b class="lname">${esc(l.parent_name)}</b> ${l.city ? `<span class="muted small">· ${esc(l.city)}</span>` : ""}
          <div class="small muted">${fmtDateTime(l.created_at)}${l.source ? ` · via <b>${esc(l.source)}</b>` : ""}${l.heard ? ` · heard on ${esc(l.heard)}` : ""}</div></div>
          <select class="lstat" data-ls="${l.id}" aria-label="Status">${LEAD_STATUS.map(([k, n]) => `<option value="${k}" ${k === l.status ? "selected" : ""}>${n}</option>`).join("")}</select></div>
        <div class="lchips">${l.subjects.map(s => `<span class="schip" style="--c:${SUBJ_COLOR[s] || "#5a6878"}">${esc(s)}</span>`).join("")}${l.grades.length ? `<span class="tag">Grade ${esc(l.grades.join(", "))}</span>` : ""}${l.start_when ? `<span class="tag ${l.start_when === "Right away" ? "warn" : ""}">${esc(l.start_when)}</span>` : ""}</div>
        <div class="ldetail small">${[l.goals.join(", "), l.formats.join(", "), l.times.join(", ")].filter(Boolean).map(esc).join(" · ")}</div>
        ${l.message ? `<p class="lmsg">“${esc(l.message)}”</p>` : ""}
        ${l.notes ? `<p class="lnotes small">📝 ${esc(l.notes)}</p>` : ""}
        <div class="btn-row"><a class="btn small wa-btn" target="_blank" rel="noopener" href="https://wa.me/${esc(l.phone_digits)}?text=${encodeURIComponent(hello)}">WhatsApp</a>
          <a class="btn small" href="tel:+${esc(l.phone_digits)}">Call ${esc(l.phone)}</a>${l.email ? `<a class="btn small" href="mailto:${esc(l.email)}?subject=${encodeURIComponent("Tutoring — Afro-Merica Tutor & Training")}&body=${encodeURIComponent(hello)}">Email</a>` : ""}
          <span style="flex:1"></span><button class="btn small" data-note="${l.id}">Notes</button><button class="btn small danger" data-del="${l.id}">Delete</button></div>
      </article>`; }).join("")}</div>`
      : `<div class="panel empty"><div style="font-size:2.2rem">📣</div><h3>${status || subject || search ? "No leads match." : "No answers yet"}</h3><p>Open the <b>Share kit</b> above and post your link on WhatsApp, Telegram and social media.</p></div>`;
    $$("[data-ls]", page).forEach(sel => sel.onchange = () => PATCH(`/api/admin/leads/${sel.dataset.ls}`, { status: sel.value }).then(() => { toast("Saved"); load(); }).catch(fail));
    $$("[data-del]", page).forEach(b => b.onclick = async () => { if (await confirmBox("Delete this lead?", "Their answers and contact details are removed.", "Delete", true)) DEL(`/api/admin/leads/${b.dataset.del}`).then(() => { toast("Deleted"); load(); }).catch(fail); });
    $$("[data-note]", page).forEach(b => b.onclick = () => { const l = d.leads.find(x => x.id === Number(b.dataset.note)); modal(`<h2>Notes — ${esc(l.parent_name)}</h2><form id="nf"><label class="field"><span>Notes (only admins see these)</span><textarea name="notes" rows="6" style="width:100%">${esc(l.notes || "")}</textarea></label><div class="btn-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, { onMount: (m, close) => onSubmit($("#nf", m), async f => { await PATCH(`/api/admin/leads/${l.id}`, { notes: f.notes }); close(); toast("Saved"); load(); }) }); });
  }
  let t; $("#q", page).oninput = e => { clearTimeout(t); t = setTimeout(() => { search = e.target.value; load().catch(fail); }, 250); };
  $("#subj", page).onchange = e => { subject = e.target.value; load().catch(fail); };
  await load();
}, { roles: ["admin"] });

async function refreshMe() {
  const r = await GET("/api/auth/me");
  ME.user = r.user; ME.mailEnabled = r.mailEnabled;
}
refreshMe().catch(() => {}).then(render);
