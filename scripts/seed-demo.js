// Adds demo accounts so you can try every role locally:  npm run seed:demo
// Refuses to run in production unless you pass --force.
const config = require('../src/config');
const db = require('../src/db');
const migrate = require('../src/migrate');
const A = require('../src/auth');
const { scanFolderTools } = require('../src/tools');

async function adult(role, name, email, password) {
  const u = await db.one('SELECT id FROM users WHERE email=$1', [email]);
  if (u) return u.id;
  return (await db.one(`INSERT INTO users(role,name,email,password_hash,email_verified) VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [role, name, email, await A.hashSecret(password)])).id;
}
async function student(name, username, pin, grade) {
  const u = await db.one('SELECT id FROM users WHERE username=$1', [username]);
  if (u) return u.id;
  return (await db.one(`INSERT INTO users(role,name,username,pin_hash,grade) VALUES ('student',$1,$2,$3,$4) RETURNING id`,
    [name, username, await A.hashSecret(pin), grade])).id;
}
const link = (s, a, rel) => db.q(`INSERT INTO student_links(student_id,adult_id,relation,consent_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [s, a, rel, rel === 'parent' ? new Date() : null]);
async function give(s, slug, settings = {}) {
  const t = await db.one('SELECT id FROM tools WHERE slug=$1', [slug]);
  if (t) await db.q(`INSERT INTO allocations(student_id,tool_id,settings) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [s, t.id, JSON.stringify(settings)]);
}

(async () => {
  if (config.isProd && !process.argv.includes('--force')) { console.error('Refusing to add demo accounts in production (use --force).'); process.exit(1); }
  await migrate();
  await scanFolderTools();
  const tutor = await adult('tutor', 'Tesfaye Tutor', 'tutor@demo.test', 'Tutor12345');
  const parent = await adult('parent', 'Hawa Bello', 'parent@demo.test', 'Parent12345');
  const aminah = await student('Aminah Bello', 'aminah', '1234', 5);
  const kofi = await student('Kofi Mensah', 'kofi', '2345', 8);
  await link(aminah, tutor, 'tutor'); await link(kofi, tutor, 'tutor'); await link(aminah, parent, 'parent');
  await give(aminah, 'fast-facts', { ops: ['×', '÷'], tables: [6, 7], max: 10, note: 'Use 5 + 1 and 5 + 2 groups!', _updated: new Date().toISOString(), _by: 'Tesfaye Tutor' });
  await give(kofi, 'motion-lab', { topics: ['speed', 'distance', 'time', 'graphs'], level: 'basic', _updated: new Date().toISOString(), _by: 'Tesfaye Tutor' });
  await give(kofi, 'fast-facts');
  console.log(`Demo accounts ready:
  Tutor    tutor@demo.test   / Tutor12345
  Parent   parent@demo.test  / Parent12345   (Aminah's parent)
  Student  aminah / PIN 1234  (grade 5, Fast Facts)
  Student  kofi   / PIN 2345  (grade 8, Motion Lab + Fast Facts)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
