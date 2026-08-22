-- crm: relationship pursuit. Accounts earned their place; contacts arrive with sources or
-- as gaps; nothing is deleted (CRM-6) — statuses carry the history.
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,          -- A-0001
  name          TEXT NOT NULL UNIQUE,
  tier          INTEGER,
  vertical      TEXT,
  why_them      TEXT NOT NULL,             -- CRM-3: mandatory at the door
  trigger_event TEXT,
  hook          TEXT,
  source_url    TEXT NOT NULL,             -- CRM-3
  status        TEXT NOT NULL DEFAULT 'not_started',
  status_reason TEXT,                      -- CRM-7: why it was parked or killed
  customer_id   TEXT REFERENCES customer(id),   -- CRM-8: set once, by promotion
  owner_note    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_path_in (
  id         INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  sort       INTEGER NOT NULL,
  bullet     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_path_account ON account_path_in(account_id);

CREATE TABLE IF NOT EXISTS contact (
  id              TEXT PRIMARY KEY,        -- P-0001
  account_id      TEXT NOT NULL REFERENCES account(id),
  role_type       TEXT NOT NULL,           -- OPERATIONS OWNER / ECONOMIC SPONSOR / ...
  status          TEXT NOT NULL,           -- gap | named | departed
  name            TEXT,                    -- NULL is meaningful: a gap has no name (CRM-2)
  title           TEXT,
  source          TEXT,                    -- CRM-1: mandatory for named
  confidence_note TEXT,
  gap_note        TEXT,                    -- CRM-2: mandatory for gap
  -- CRM-4: human-only — written by a person from their own network, never by an agent
  mutual_via      TEXT,
  mutual_url      TEXT,
  linkedin_path   TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_account ON contact(account_id);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id),
  contact_id  TEXT REFERENCES contact(id),
  direction   TEXT,                        -- outbound | inbound
  medium      TEXT,                        -- call | email | meeting | linkedin | other
  summary     TEXT NOT NULL,
  occurred_at TEXT NOT NULL,               -- CRM-5: when it happened, not when it was typed
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_account ON activity(account_id);
