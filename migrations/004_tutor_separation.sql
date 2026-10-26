-- Keep each tutor's work separate when a student has several tutors (e.g. Math and English).
-- Tutors can have a subject, shown next to their name.
ALTER TABLE users ADD COLUMN subject TEXT;

-- Each tool given to a student can belong to one tutor. NULL = shared by all the student's tutors.
ALTER TABLE allocations ADD COLUMN tutor_id INT REFERENCES users(id) ON DELETE SET NULL;

-- Messages: each tutor has a private conversation with the student and parents (tutor_key = tutor's id);
-- tutor_key 0 is the general conversation that everyone linked to the student shares.
ALTER TABLE messages ADD COLUMN tutor_key INT NOT NULL DEFAULT 0;
UPDATE messages SET tutor_key = sender_id WHERE sender_role = 'tutor' AND sender_id IS NOT NULL;
DROP INDEX IF EXISTS messages_student_idx;
CREATE INDEX messages_thread_idx ON messages(student_id, tutor_key, id);
ALTER TABLE thread_reads ADD COLUMN tutor_key INT NOT NULL DEFAULT 0;
ALTER TABLE thread_reads DROP CONSTRAINT thread_reads_pkey;
ALTER TABLE thread_reads ADD PRIMARY KEY (student_id, tutor_key, user_id);

-- Whiteboards made by a tutor belong to that tutor; boards made by the student or an admin are shared (0).
ALTER TABLE boards ADD COLUMN tutor_key INT NOT NULL DEFAULT 0;
UPDATE boards b SET tutor_key = b.created_by FROM users u WHERE u.id = b.created_by AND u.role = 'tutor' AND b.student_id IS NOT NULL;

-- Students who already have two or more tutors: tools stay shared until an admin picks a tutor for each.
