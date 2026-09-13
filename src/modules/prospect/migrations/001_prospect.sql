-- prospect: the holding area in front of a curated list. Rows arrive in batches from a pull
-- somebody paid for or scraped; they are NOT accounts and are counted in no statistic until a
-- person promotes them. An agent may judge a row and must say why; only a person promotes.
CREATE TABLE IF NOT EXISTS pros_source (
  id            TEXT PRIMARY KEY,          -- PUL-0001
  label         TEXT NOT NULL,             -- what the pull was, in the buyer's words
  hash          TEXT NOT NULL UNIQUE,      -- the same pull never lands twice
  criteria      TEXT NOT NULL,             -- PRO-2: the brief it was pulled under, mandatory
  campaign_id   TEXT,                      -- the campaign it was pulled for, if decided
  row_count     INTEGER NOT NULL,          -- what the file said it held
  rows_in       INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  imported_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pros_row (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES pros_source(id),
  row_index     INTEGER NOT NULL,          -- position in the pull; provenance
  company       TEXT NOT NULL,
  website       TEXT,
  industry      TEXT,
  employees     INTEGER,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  description   TEXT,                      -- the seller's blurb, verbatim
  raw           TEXT,                      -- the line as read
  -- The verdict is a separate axis from the row. A row with no verdict has not been judged;
  -- that is the "what is left" query and it is the one that matters (PRO-4).
  verdict       TEXT,                      -- qualified | rejected | unclear
  verdict_reason TEXT,                     -- PRO-3: mandatory, and it is the product
  verdict_source_url TEXT,
  verdict_by    TEXT,
  verdict_at    TEXT,
  -- Promotion is terminal and records where the row went.
  account_id    TEXT,                      -- the crm account a person made from it
  promoted_by   TEXT,
  promoted_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pros_row_source ON pros_row(source_id);
-- The two queries that are actually asked: what is unjudged, and what is judged and unpromoted.
CREATE INDEX IF NOT EXISTS idx_pros_row_verdict ON pros_row(verdict, account_id);
CREATE INDEX IF NOT EXISTS idx_pros_row_company ON pros_row(company);
