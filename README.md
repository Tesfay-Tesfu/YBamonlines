# AMtutorTools

The Afro-Merica Tutor platform for grade 5–12 math and physics tools.

- **Students** sign in with a username and PIN (no email needed) and see only the tools assigned to them. Their progress is saved on the server, so it follows them to any device.
- **Parents** join with an invite code, give consent, and see their child's time, answers, accuracy, badges and "practice these next" list. They can open the child's tools to look at progress (nothing they do there is saved) and make a new PIN.
- **Tutors** add students, set a weekly plan for each tool their students have been given (e.g. "×6 and ×7 tables"), invite parents, reset progress, and see reports.
- **Admins** do all of that for everyone, plus give and remove tools (tutors only see and open the tools an admin has given to their students), manage accounts, find and delete duplicate names, upload new tools, give a tool to a whole grade at once, import students from a spreadsheet, and see the activity log of who viewed which student's records.

Built with Node.js (no framework) and PostgreSQL. The only npm dependency is `pg`.

---

## 1. Run it on your computer

You need **Node.js 20+** and **PostgreSQL**.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
createdb amtutortools
npm start                     # creates the tables and the first admin
npm run seed:demo             # optional: demo tutor, parent and two students
```

Open http://localhost:3000.

Demo accounts (after `npm run seed:demo`):

| Role | Sign in with |
|---|---|
| Tutor | tutor@demo.test / Tutor12345 |
| Parent | parent@demo.test / Parent12345 |
| Student | username `aminah`, PIN `1234` (grade 5) |
| Student | username `kofi`, PIN `2345` (grade 8) |

---

## 2. Deploy to Render.com

1. Put this folder in a GitHub repository (private is fine).
2. In Render, click **New + → Blueprint** and choose the repository. Render reads `render.yaml` and creates:
   - a **web service** `amtutortools`
   - a **PostgreSQL database** `amtutortools-db`, already connected through `DATABASE_URL`
3. Render asks for these values:
   - `APP_URL` – your site address, e.g. `https://amtutortools.onrender.com` (used in email links)
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` – your first admin account (8+ characters with a letter and a number)
   - `RESEND_API_KEY` and `MAIL_FROM` – optional, for emails (see below). Leave empty to skip.
4. Click **Apply**. After the first deploy, open the site and sign in with the admin email and password. Change the password under **Account**.

**Plans and cost.** `render.yaml` starts the web service on the **free** plan (it sleeps after 15 minutes without visitors and takes about a minute to wake up) and the database on the smallest **paid** plan (`0.1c-256mb`). Render's free databases are deleted 30 days after creation, so they are not suitable for real student records. When you have real students, also switch the web service to a paid plan so it doesn't sleep. You can change plans in the Render dashboard at any time.

**Your own domain.** In Render, open the web service → **Settings → Custom Domains**, add e.g. `tools.afromericatutor.com`, and update `APP_URL`.

**Backups.** Paid Render databases include daily backups. You can also download everything from **Admin → Students → Download list** and **Overview → Download all answers**.

### Email (optional)

Email is used for "forgot password" and "confirm your email". Without it, the platform still works: admins can set a new password for anyone under **People**, and links are printed in the Render log.

To turn email on, create a free account at [resend.com](https://resend.com) (or [brevo.com](https://brevo.com)), verify your sending domain, then set in Render:

```
RESEND_API_KEY = re_...            (or BREVO_API_KEY = xkeysib-...)
MAIL_FROM      = AMtutorTools <no-reply@yourdomain.com>
```

---

## 3. Everyday use

### Adding students and parents
1. **Students → Add a student** (or **Import from a spreadsheet** for many at once). The PIN is shown once: print the login cards.
2. On the student's page, **Parents & tutors → Make invite code**. Send the code to the parent. They open the site, choose **I have an invite code**, create an account and confirm consent. A parent with two children enters a second code under **Account**.
3. An admin opens **Tools → Give a tool** on the student's page. Then the tutor (or admin) uses **Plan** to choose what the student should practice this week and leave them a note.

### Duplicate names
When someone adds a student or account with a name that already exists, the site asks first. To clean up copies that are already there, go to **Students → Find duplicates** (or **People → Find duplicates**, or the "Names entered more than once" line on the Overview). Tick the extra copies and press **Delete selected**. The copy with the most use is marked **Keep**. Tutors can also delete a student they added themselves, as long as that student has no saved answers yet.

Spreadsheet import columns: `name, grade, username, pin, tutor_email, parent_email` (only `name` is required). A `parent_email` creates a 30-day invite code for that parent; a `tutor_email` links an existing tutor.

### Connecting a tutor to students
A tutor only sees the students they are linked to. As admin:
- **Many at once:** **Students** → tick **No tutor yet** (or any students) → **👩‍🏫 Assign a tutor** → pick the tutor → **Assign**.
- **One student:** open the student → **Parents & tutors** → **👩‍🏫 Assign a tutor**. **👪 Link an existing parent** works the same way for parent accounts.
- Students a tutor adds themselves are linked to that tutor automatically. A student can have more than one tutor; remove one under **Parents & tutors → Remove**.

### Students with more than one tutor (e.g. Math and English)
Each tutor sees only their own work with the student. Parents and admins see everything.
- **Tools:** on the student's **Tools** tab, the **Tutor** column says who each tool is for: one tutor, or **All tutors**. A tutor only sees, opens and gets reports, answers and badges for their own tools (and the shared ones). Choose the tutor when you **Give a tool**, too.
- **When a second tutor is linked**, the tools the student already had stay with the first tutor automatically. Set the whiteboard (or any tool both should use) to **All tutors**.
- **Messages:** each tutor has a private conversation with the student and parents, plus a **General** conversation everyone shares. Tutors never see another tutor's conversation or files.
- **Whiteboard:** a tutor sees the boards they made plus boards the student made; never another tutor's boards.
- **Subjects:** give tutors a subject under **People → Manage → Subject** so everyone sees "Math · Tesfaye", "English · Ruth".

### Adding tutors and admins
**People → Add an account** (you set a temporary password) or **Invite a tutor** (they set their own password with a code).

---

## 4. Adding new math and physics tools

There are two ways. Both give each student their own saved progress automatically.

### A. Upload a single HTML file (easiest)
**Tools → Upload a tool**, choose the `.html` file, fill in the name, subject and grades, then **Give to students**.

- Tools that save with `localStorage` work as they are. Inside the platform, `localStorage` is replaced with storage that is saved on the server for each student, so the original `aminah_fast_facts.html` works without any changes.
- To upload a new version, open the tool's **Edit → Upload new version**. Students keep their progress.
- Uploaded tools are stored in the database, because Render's disk is wiped on every deploy.

### B. Add a folder to `tools/` (best for tools with images or several files)
1. Copy `tools/_template` to `tools/your-tool-name` (lowercase letters, numbers and dashes).
2. Edit `manifest.json` and `index.html`. Put images, sounds or extra scripts in the same folder and link them with relative paths (`img/car.png`).
3. Commit and push. Render redeploys and the tool appears under **Tools**. When you change a tool, increase `version` in `manifest.json` so the new name, grades and description are picked up.

### manifest.json

```json
{
  "name": "Fractions Lab",
  "subject": "math",                 // math | physics | chemistry | science | other
  "grade_min": 5,
  "grade_max": 7,
  "icon": "🍕",
  "version": "1.0.0",
  "description": "Shown in the catalog and on the student's tile.",
  "settings": [                      // what tutors can set in "Plan" for each student
    { "key": "level", "label": "Level", "type": "select", "options": ["easy", "medium", "hard"] },
    { "key": "topics", "label": "Topics", "type": "multi", "options": ["add", "compare"], "labels": ["Adding", "Comparing"] },
    { "key": "note", "label": "Note to the student", "type": "text" }
  ]
}
```

Setting types: `select`, `multi`, `text`, `number`, `checkbox`.

### What a tool can use: `window.AMT`

The platform adds `window.AMT` to every tool page. Check for it so the file also works when opened on its own.

| | |
|---|---|
| `AMT.student` | `{ id, name, firstName, grade }` |
| `AMT.viewer` | `{ id, role, name }` — who is looking (student, parent, tutor, admin) |
| `AMT.mode` | `student` (saved), `review` (an adult viewing a student — not saved), `preview`, or `standalone` |
| `AMT.isStudent` / `AMT.isAdult` | handy for hiding detailed records from students |
| `AMT.settings` | the tutor's plan for this student (keys from `manifest.json`), plus `_updated` and `_by` |
| `AMT.storage` | same methods as `localStorage`; saved per student and tool |
| `AMT.attempt({...})` | record an answer for parent/tutor reports |
| `AMT.award(code, title, icon)` | give a badge once |
| `AMT.history({ limit, days })` | promise of this student's past answers in this tool |
| `AMT.flush()` | save now (saving also happens automatically) |

```js
const AM = window.AMT || null;
if (AM) AM.attempt({
  question: "7 × 8", response: "54", answer: "56", correct: false,
  ms: 4200, topic: "×7 table", mode: "Practice"
});
if (AM && streak === 10) AM.award("streak-10", "10 correct in a row", "🎯");
```

If the internet drops, changes are kept in the browser and sent when the connection returns. A small "Saved ✓" note appears at the bottom right.

`tools/fast-facts` (math, grades 3–6) and `tools/motion-lab` (physics, grades 6–10) are complete examples.

**Only upload tools you trust.** Tools run on the same site as the platform, so a tool's code acts with the permissions of whoever opens it. Only admins can upload tools.

---

### The live whiteboard (`tools/whiteboard`)

Give **Whiteboard** to a student like any other tool. The student opens it from their tools; the tutor opens it from the student's page (**Tools → Open**). Both draw on the same board at the same time, and every board is saved.

- **Tools:** pressure-sensitive pen (Wacom and other drawing tablets, iPad with stylus), highlighters, eraser (whole strokes or precise; the back of a tablet pen erases too), text with math symbols, lines and arrows, rectangles, ellipses, triangles, polygons, angles that show their size, labelled points, coordinate axes, protractor, ruler, images (button, paste or drag in) and a laser pointer.
- **Paper:** grid, graph paper, dots, lined or plain, with snapping to the grid. Several pages per board; many boards per student.
- **Live:** everyone sees each other's pointer, sees strokes as they are drawn, and the tutor can press **📣 Lead** so the student follows the tutor's page and view.
- **Lesson prep:** a tutor can open Whiteboard from **Tools** without a student to prepare lesson boards, then use **Copy a lesson board** in a student's board list.
- **Who can do what:** the student and their tutor (and admins) can draw. Parents can watch but not change anything. Removing the tool removes access.
- **Export:** a page as PNG, or all pages as a PDF.
- **Shortcuts:** V select, Space hold to move, P pen, M highlighter, E eraser, T text, L line, A arrow, R rectangle, O ellipse, G polygon, N angle, X axes, K laser, 1–9 colours, [ ] size, Ctrl+Z / Ctrl+Shift+Z, Ctrl+D duplicate, Del delete, Ctrl + scroll zoom, Ctrl+0 fit.

Live editing keeps open boards in the server's memory, so the web service must run as **one instance** (Render's Starter plan does). Boards are saved to the database a moment after each change and when the server restarts.

### Messages, homework and files

Every student has **one conversation** shared by the student, their parents, their tutor(s) and admins. Open it from **Messages** in the menu (a badge shows new messages) or the **💬 Messages** button on a student's page.

- **Write and attach files:** PDF, PowerPoint, Word, Excel, Keynote/Pages, pictures (shown as pictures), audio, video and ZIP, up to 15 MB each and 10 per message. Drag files in, paste a picture, or use 📎. Web pages, scripts and SVG files can't be attached.
- **Homework:** tutors and admins tick **📝 Homework** and pick a due date. The student sees it on their home screen and taps **Mark as done**; everyone sees when it was done. **📝 Homework** at the top of a conversation shows only homework.
- **🔒 Adults only:** parents, tutors and admins can write notes the student can't see.
- **👥 Also send to…:** tutors and admins can send the same message and files to several students at once; each student gets it in their own conversation.
- **Email alerts (optional):** when email is set up (see above), parents and tutors get an email about new messages, at most one per conversation every 30 minutes. Students are never emailed.
- **Deleting:** people can delete their own messages; admins can delete any message.
- **Storage:** attachments are kept in the database. `MESSAGE_STORAGE_MB` (default 500) caps the total; admins see the space used on the Messages page. Raise it only if your Render database has room (check its disk size in Render), and delete old attachments if it fills up. Files not attached to any message are cleaned up after a day.

### Interest form and Leads (finding new families)

A public sign-up page for parents is at **`/interest`** (e.g. `https://amtutortools.onrender.com/interest`). It takes about a minute: subjects (Math, Physics, Science, Python for Kids), grades, goals, format, best time, start date and the parent's contact, with consent to be contacted. It looks good on phones and shows a preview card when the link is shared.

- **Leads** (admin menu) lists every answer, newest first, with **WhatsApp** (opens a chat with a ready greeting), **Call** and **Email** buttons, a status (New → Contacted → Trial booked → Enrolled / Not now) and private notes. **Download CSV** exports everything. The Overview shows how many new parents are waiting.
- **Share kit** (top of Leads): a separate link for WhatsApp, Telegram, Facebook, Instagram and TikTok, so you can see which channel brings parents; a ready-to-paste message; a QR code; and posters in `public/app/promo/` (`poster.png` 4:5 for posts, `story.png` 9:16 for WhatsApp Status/stories, `share-card.png` for link previews).
- **Optional settings in Render:** `CONTACT_WHATSAPP` (your number, e.g. `12405550123`, adds "Chat with us now" after the form), `INTEREST_OFFER` (e.g. `First lesson free`, shown as a badge), `CONTACT_DEFAULT_COUNTRY` (default `1`).
- Spam protection: a hidden bot trap, a minimum fill-in time and at most 8 answers per hour from one connection. Delete a lead to remove their details.

## 5. Privacy and safety

- Children sign in with a username and PIN; no child email is collected. Sessions for students end after 12 hours.
- Parents link to a child only with an invite code from a tutor or admin, and must confirm they are the parent or guardian. The date of consent is stored.
- Parents see only their own children. Tutors see only students linked to them, and only the tools an admin has given to those students. Every time an adult opens a student's records, it is written to the **Activity log**.
- Admins can delete a student, which removes all of that student's data. Tutors can delete only students they added who have no saved answers yet.
- After 8 wrong passwords or PINs, the account is locked for 15 minutes.
- Passwords and PINs are stored as scrypt hashes.

If you work with children under 13 in the United States, COPPA applies; if you work with schools, FERPA may too. Have someone qualified review your privacy policy and consent wording (the wording is in `public/app/app.js`, search for "legal guardian").

---

## 6. Project layout

```
render.yaml              Render Blueprint (web service + Postgres)
migrations/              database tables (run automatically on start)
src/server.js            start-up, routes, first admin
src/http.js              small router and static files
src/auth.js              sessions, hashing, who-can-see-what rules
src/tools.js             tool catalog and the tool page (adds student data + SDK)
src/routes/              auth, students, admin, catalog, sdk endpoints
public/app/              the website (sign in, dashboards, reports)
public/sdk/amtutor.js    window.AMT for tools
tools/                   built-in tools (one folder each); _template is a starter
scripts/seed-demo.js     demo accounts
```

To change the database later, add a new file such as `migrations/002_add_classes.sql`. It runs once, automatically, on the next start.
