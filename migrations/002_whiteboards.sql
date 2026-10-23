-- Whiteboards: live, shared drawing boards.
-- A board belongs to a student (shared with their tutor) or, for lesson prep, to an adult (owner_id).
CREATE TABLE boards (
  id          SERIAL PRIMARY KEY,
  student_id  INT REFERENCES users(id) ON DELETE CASCADE,
  owner_id    INT REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Board',
  data        JSONB NOT NULL DEFAULT '{"pages":[]}'::jsonb,
  version     INT NOT NULL DEFAULT 0,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (student_id IS NOT NULL OR owner_id IS NOT NULL)
);
CREATE INDEX boards_student_idx ON boards(student_id, updated_at DESC);
CREATE INDEX boards_owner_idx ON boards(owner_id, updated_at DESC);
