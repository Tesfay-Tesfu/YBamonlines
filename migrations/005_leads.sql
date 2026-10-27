-- Interest form (public): parents who want tutoring. Admins follow up from the Leads page.
CREATE TABLE leads (
  id           SERIAL PRIMARY KEY,
  parent_name  TEXT NOT NULL,
  phone        TEXT NOT NULL,
  phone_digits TEXT NOT NULL,
  email        TEXT,
  city         TEXT,
  grades       TEXT[] NOT NULL DEFAULT '{}',
  subjects     TEXT[] NOT NULL DEFAULT '{}',
  goals        TEXT[] NOT NULL DEFAULT '{}',
  formats      TEXT[] NOT NULL DEFAULT '{}',
  times        TEXT[] NOT NULL DEFAULT '{}',
  start_when   TEXT,
  heard        TEXT,
  source       TEXT,
  message      TEXT,
  consent_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'trial', 'enrolled', 'not_now')),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_created_idx ON leads(created_at DESC);
