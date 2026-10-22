-- AMtutorTools initial schema

CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('admin','tutor','parent','student')),
  name           TEXT NOT NULL,
  -- adults sign in with email + password
  email          TEXT UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash  TEXT,
  -- students sign in with username + PIN (no email needed for children)
  username       TEXT UNIQUE,
  pin_hash       TEXT,
  grade          SMALLINT CHECK (grade IS NULL OR grade BETWEEN 1 AND 12),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  CHECK (role = 'student' OR email IS NOT NULL),
  CHECK (role <> 'student' OR username IS NOT NULL)
);

-- Which adults can see which students
CREATE TABLE student_links (
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  adult_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (relation IN ('parent','tutor')),
  consent_at  TIMESTAMPTZ,            -- parent consent recorded when linking (COPPA)
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, adult_id)
);
CREATE INDEX student_links_adult ON student_links(adult_id);

-- Tool catalog. source = 'folder' (tools/<slug>/ in the repo) or 'upload' (stored in the DB)
CREATE TABLE tools (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT 'math',
  grade_min   SMALLINT NOT NULL DEFAULT 5,
  grade_max   SMALLINT NOT NULL DEFAULT 12,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '🧮',
  version     TEXT NOT NULL DEFAULT '1.0.0',
  source      TEXT NOT NULL DEFAULT 'folder' CHECK (source IN ('folder','upload')),
  settings_schema JSONB NOT NULL DEFAULT '[]'::jsonb,  -- fields a tutor can set (from manifest.json)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Files of uploaded tools (Render's disk is wiped on every deploy, so uploads live here)
CREATE TABLE tool_files (
  tool_id    INT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  content    BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, path)
);

-- Which student may use which tool
CREATE TABLE allocations (
  id          SERIAL PRIMARY KEY,
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id     INT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- tutor's plan for this tool
  expires_at  TIMESTAMPTZ,
  assigned_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, tool_id)
);

-- Each tool's saved data for each student (key/value, like localStorage)
CREATE TABLE tool_state (
  student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id    INT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, tool_id)
);

-- Every answer a student gives (reported to parents / tutors / admins)
CREATE TABLE attempts (
  id          BIGSERIAL PRIMARY KEY,
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id     INT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  session_key TEXT,
  mode        TEXT,
  topic       TEXT,
  question    TEXT NOT NULL,
  response    TEXT,
  answer      TEXT,
  correct     BOOLEAN NOT NULL,
  ms          INT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attempts_student_tool_time ON attempts(student_id, tool_id, created_at DESC);

-- Time spent: seconds of active use per student, tool and day
CREATE TABLE activity (
  student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id    INT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  seconds    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (student_id, tool_id, day)
);

-- Badges / milestones that a tool or the platform awards
CREATE TABLE achievements (
  id          SERIAL PRIMARY KEY,
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id     INT REFERENCES tools(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  title       TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '🏅',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, tool_id, code)
);

-- Invite codes: link a parent/tutor to a student, or create a tutor/admin account
CREATE TABLE invites (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('parent','tutor','admin')),
  student_id  INT REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_by     INT REFERENCES users(id) ON DELETE SET NULL,
  used_at     TIMESTAMPTZ,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   INT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  student_id INT REFERENCES users(id) ON DELETE SET NULL,
  detail     JSONB,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time ON audit_log(created_at DESC);
