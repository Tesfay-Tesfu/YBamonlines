-- Interest form spam protection: a Spam folder, the reason a lead was put there, and an admin block list.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN ('new', 'contacted', 'trial', 'enrolled', 'not_now', 'spam'));
ALTER TABLE leads ADD COLUMN spam_reason TEXT;
ALTER TABLE leads ADD COLUMN ip_hash TEXT;
ALTER TABLE leads ADD COLUMN repeats INT NOT NULL DEFAULT 0;
CREATE INDEX leads_phone_idx ON leads(phone_digits);
CREATE INDEX leads_status_idx ON leads(status, created_at DESC);

CREATE TABLE lead_blocks (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('phone', 'email', 'word', 'ip')),
  value      TEXT NOT NULL,
  note       TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
