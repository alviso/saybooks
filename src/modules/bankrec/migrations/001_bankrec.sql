-- Bank reconciliation (bankrec 0.1): matches between statement rows and the payments and refunds
-- recorded here, and the sign-offs people give. The reconciliation itself is derived, never stored.
CREATE TABLE IF NOT EXISTS bankrec_match (
  id              TEXT PRIMARY KEY,                -- BM-0001
  transaction_id  TEXT NOT NULL,                   -- the statement row (purchases' T-0001)
  row_was         TEXT NOT NULL,                   -- the row's review before the match, JSON, put back on unmatch
  reason          TEXT NOT NULL,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  unmatched_at    TEXT,
  unmatched_by    TEXT,
  unmatch_reason  TEXT
);
CREATE TABLE IF NOT EXISTS bankrec_match_item (
  match_id  TEXT NOT NULL REFERENCES bankrec_match(id),
  item_key  TEXT NOT NULL,                         -- o2c:payment:P-0001, solo:payment:P-0001, o2c:refund:RF-0001
  amount    INTEGER NOT NULL,                      -- signed, as it was when matched
  PRIMARY KEY (match_id, item_key)
);
CREATE TABLE IF NOT EXISTS bankrec_signoff (
  id          TEXT PRIMARY KEY,                    -- BR-0001
  account     TEXT NOT NULL,
  currency    TEXT NOT NULL,
  through     TEXT NOT NULL,
  statement_id TEXT,
  printed     INTEGER NOT NULL,
  books       INTEGER NOT NULL,
  kept_json   TEXT NOT NULL,                       -- the items as they stood
  hash        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  signed_by   TEXT,
  signed_at   TEXT NOT NULL,
  UNIQUE (account, currency, through)
);
