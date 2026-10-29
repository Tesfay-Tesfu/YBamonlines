-- Writing Studio: English writing pieces shared by a student and their tutor.
-- The student writes (plan + text); the tutor comments, scores with a rubric and gives feedback.
CREATE TABLE writings (
  id           SERIAL PRIMARY KEY,
  student_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tutor_key    INT NOT NULL DEFAULT 0,              -- 0 = shared by all the student's tutors, else that tutor's id
  title        TEXT NOT NULL DEFAULT 'Untitled',
  genre        TEXT NOT NULL DEFAULT 'narrative',
  prompt       TEXT,
  target_words INT,
  due_date     DATE,
  body         TEXT NOT NULL DEFAULT '',
  plan         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'revise', 'reviewed', 'done')),
  comments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric       JSONB NOT NULL DEFAULT '{}'::jsonb,
  glow         TEXT,
  grow         TEXT,
  words        INT NOT NULL DEFAULT 0,
  version      INT NOT NULL DEFAULT 0,
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  reviewed_at  TIMESTAMPTZ
);
CREATE INDEX writings_student_idx ON writings(student_id, updated_at DESC);

-- A copy of the text each time it is turned in or reviewed, so changes between drafts can be shown
CREATE TABLE writing_versions (
  id          SERIAL PRIMARY KEY,
  writing_id  INT NOT NULL REFERENCES writings(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  body        TEXT NOT NULL,
  words       INT NOT NULL DEFAULT 0,
  by_id       INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX writing_versions_idx ON writing_versions(writing_id, id);
