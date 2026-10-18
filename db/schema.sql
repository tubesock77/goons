-- Runs automatically every time the server starts. Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trails (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  area             TEXT,
  state            TEXT,
  difficulty       TEXT,             -- Easy | Moderate | Hard | Expert
  trail_type       TEXT,             -- Single track, Dirt road, etc.
  rating           SMALLINT,         -- 1-5
  color            TEXT,
  notes            TEXT,
  geometry         JSONB NOT NULL,   -- GeoJSON MultiLineString, coords [lng, lat, ele?]
  source           TEXT NOT NULL DEFAULT 'drawn', -- drawn | gpx
  distance_mi      NUMERIC(8,2),
  elevation_gain_ft INTEGER,
  min_ele_ft       INTEGER,
  max_ele_ft       INTEGER,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rides (
  id          SERIAL PRIMARY KEY,
  trail_id    INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  ride_date   DATE NOT NULL,
  riders      TEXT[] NOT NULL DEFAULT '{}',
  conditions  TEXT,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rides_trail_idx ON rides(trail_id);

CREATE TABLE IF NOT EXISTS photos (
  id          SERIAL PRIMARY KEY,
  trail_id    INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  caption     TEXT,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  thumb       BYTEA,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_trail_idx ON photos(trail_id);

-- Session store table used by connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
