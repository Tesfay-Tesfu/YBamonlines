-- Messages: one conversation per student, shared by the student, their parents, their tutors and admins.
CREATE TABLE files (
  id          SERIAL PRIMARY KEY,
  owner_id    INT REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INT NOT NULL,
  content     BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE messages (
  id           SERIAL PRIMARY KEY,
  student_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id    INT REFERENCES users(id) ON DELETE SET NULL,
  sender_name  TEXT NOT NULL,
  sender_role  TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'homework')),
  due_date     DATE,
  adults_only  BOOLEAN NOT NULL DEFAULT false,
  done_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX messages_student_idx ON messages(student_id, id);
CREATE TABLE message_files (
  message_id  INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id     INT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX message_files_file_idx ON message_files(file_id);
CREATE TABLE thread_reads (
  student_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (student_id, user_id)
);
