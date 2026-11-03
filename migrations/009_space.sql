-- Space Lab: the free one-time mission on the public /space page (for families who aren't students yet)
CREATE TABLE space_plays (
  id          SERIAL PRIMARY KEY,
  cookie_id   TEXT NOT NULL,
  ip_hash     TEXT,
  grade       INT,
  mission     INT NOT NULL DEFAULT 0,       -- highest mission reached (1-6)
  score       INT,
  total       INT,
  source      TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX space_plays_cookie_idx ON space_plays(cookie_id);
CREATE INDEX space_plays_ip_idx ON space_plays(ip_hash, started_at DESC);
