-- jobhunt: one person's search, as a record of reality. Extracted from huntctrl.
-- Prefixed table names (hunt_*) — this area's company/contact are NOT core's customer or
-- crm's contact: an agency is not a trading partner, and a recruiter is not a pursuit target.
CREATE TABLE IF NOT EXISTS hunt_company (
  id         TEXT PRIMARY KEY,             -- CO-0001
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT,                         -- end_client|consultancy|staffing_agency|product_vendor|rpo
  notes      TEXT,
  red_flags  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunt_contact (
  id           TEXT PRIMARY KEY,           -- HC-0001
  company_id   TEXT REFERENCES hunt_company(id),
  name         TEXT NOT NULL,
  role         TEXT,
  email        TEXT,
  phone        TEXT,
  linkedin_url TEXT,
  relationship TEXT NOT NULL DEFAULT 'cold',   -- cold|contacted|responsive|warm_scout|dead
  source       TEXT NOT NULL,              -- JH-2: how we know this person
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunt_resume_version (
  id          TEXT PRIMARY KEY,            -- RV-0001
  label       TEXT NOT NULL UNIQUE,
  platform    TEXT,
  external_id TEXT,
  headline    TEXT,
  focus       TEXT,
  file_path   TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunt_posting (
  id              TEXT PRIMARY KEY,        -- JP-0001
  title           TEXT NOT NULL,
  company_id      TEXT NOT NULL REFERENCES hunt_company(id),
  end_client_id   TEXT REFERENCES hunt_company(id),   -- JH-5: who the work is actually for
  req_id          TEXT,
  source          TEXT,
  url             TEXT,
  jd_text         TEXT,
  location        TEXT,
  work_mode       TEXT,
  comp_min        INTEGER,                 -- JH-11: annualized USD cents? huntctrl used dollars; here CENTS like everything in Saybooks
  comp_max        INTEGER,
  comp_notes      TEXT,
  employment_type TEXT,
  fit_score       REAL,
  fit_notes       TEXT,
  resume_version_id TEXT REFERENCES hunt_resume_version(id),
  red_flags       TEXT,
  status          TEXT NOT NULL DEFAULT 'lead',   -- lead|evaluated|skipped|applied
  skip_reason     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hposting_company ON hunt_posting(company_id);
CREATE INDEX IF NOT EXISTS idx_hposting_req ON hunt_posting(req_id);

CREATE TABLE IF NOT EXISTS hunt_application (
  id                TEXT PRIMARY KEY,      -- APP-0001
  posting_id        TEXT NOT NULL UNIQUE REFERENCES hunt_posting(id),   -- JH-4 in SQL
  resume_version_id TEXT REFERENCES hunt_resume_version(id),
  channel           TEXT,
  via_contact_id    TEXT REFERENCES hunt_contact(id),
  applied_at        TEXT,                  -- ISO date or the literal 'unknown' (JH-1)
  status            TEXT NOT NULL DEFAULT 'submitted',
  status_changed_at TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunt_interaction (
  id                INTEGER PRIMARY KEY,
  posting_id        TEXT REFERENCES hunt_posting(id),
  contact_id        TEXT REFERENCES hunt_contact(id),
  at                TEXT NOT NULL,
  direction         TEXT NOT NULL,         -- in|out
  medium            TEXT,
  summary           TEXT NOT NULL,
  next_action       TEXT,
  next_action_due   TEXT,
  next_action_state TEXT,                  -- open|superseded|done (NULL when none)
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hint_posting ON hunt_interaction(posting_id, at);
CREATE INDEX IF NOT EXISTS idx_hint_open ON hunt_interaction(next_action_state, next_action_due);

CREATE TABLE IF NOT EXISTS hunt_interview (
  id             TEXT PRIMARY KEY,         -- IV-0001
  application_id TEXT NOT NULL REFERENCES hunt_application(id),
  round          INTEGER,
  kind           TEXT,
  scheduled_at   TEXT,
  interviewer    TEXT,
  outcome        TEXT NOT NULL DEFAULT 'pending',
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- JH-13: thresholds are reference data.
CREATE TABLE IF NOT EXISTS hunt_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO hunt_config VALUES
  ('follow_up_days', '5'), ('stale_days', '14'), ('ghost_days', '21');
