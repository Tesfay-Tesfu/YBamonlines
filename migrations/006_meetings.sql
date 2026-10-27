-- Online classes (Google Meet, Zoom, ...): only admins create and change them.
-- Students in a class, their parents and their tutor see it (a class with a tutor: only that tutor).
CREATE TABLE meetings (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  meet_url      TEXT NOT NULL,
  dial          TEXT,
  pin           TEXT,
  more_url      TEXT,
  notes         TEXT,
  tz            TEXT NOT NULL DEFAULT 'America/New_York',
  start_date    DATE NOT NULL,
  start_time    TEXT NOT NULL,           -- 'HH:MM' wall-clock time in tz
  duration_min  INT NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 5 AND 720),
  repeat        TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'weekly')),
  days          INT[] NOT NULL DEFAULT '{}', -- 0 = Sunday … 6 = Saturday (weekly)
  until_date    DATE,
  tutor_id      INT REFERENCES users(id) ON DELETE SET NULL,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE meeting_students (
  meeting_id  INT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  student_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, student_id)
);
CREATE INDEX meeting_students_student_idx ON meeting_students(student_id);
