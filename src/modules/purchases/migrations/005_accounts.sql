-- Accounts (purchases 0.6): the accounts a person has, as a register. A statement belongs to one
-- account; a thing without statements (a house, a car, an outside loan) gets values a person states,
-- dated and sourced. Balances and net worth are derived from statements and those values, never stored.
CREATE TABLE IF NOT EXISTS purch_account (
  id            TEXT PRIMARY KEY,            -- ACC-0001
  name          TEXT NOT NULL COLLATE NOCASE,  -- as statements print it: "Chase Checking ending 4410"
  kind          TEXT NOT NULL,               -- checking | savings | credit_card | loan | asset | other
  currency      TEXT NOT NULL,
  institution   TEXT,
  last4         TEXT,
  opened_on     TEXT,
  closed_on     TEXT,
  close_reason  TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (name, currency)
);
CREATE TABLE IF NOT EXISTS purch_valuation (
  id          INTEGER PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES purch_account(id),
  as_of       TEXT NOT NULL,
  value       INTEGER NOT NULL,              -- signed: what it is worth positive, what is owed negative
  source      TEXT NOT NULL,                 -- where the figure comes from: "county assessment 2026", "lender statement"
  reason      TEXT,
  recorded_by TEXT,
  created_at  TEXT NOT NULL
);
ALTER TABLE purch_source ADD COLUMN account_id TEXT REFERENCES purch_account(id);
-- Statements already on record: one account per label and currency they were printed with.
INSERT INTO purch_account (id, name, kind, currency, created_at, updated_at)
SELECT printf('ACC-%04d', ROW_NUMBER() OVER (ORDER BY MIN(period_start), MIN(id))), label,
       CASE MIN(kind) WHEN 'bank' THEN 'checking' WHEN 'card' THEN 'credit_card' ELSE 'other' END, currency, MIN(created_at), MIN(created_at)
FROM (SELECT *, COALESCE(NULLIF(TRIM(account), ''), kind || ' (unnamed)') AS label FROM purch_source)
GROUP BY label COLLATE NOCASE, currency;
UPDATE purch_source SET account_id = (SELECT a.id FROM purch_account a
  WHERE a.name = COALESCE(NULLIF(TRIM(purch_source.account), ''), purch_source.kind || ' (unnamed)') AND a.currency = purch_source.currency);
