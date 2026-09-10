-- The map grew a second and third kind. Derivation accounts are ours and fixed; categories and
-- statement accounts are the person's own words, and the ledger needs a chart account for each.
CREATE TABLE IF NOT EXISTS bridge_map (
  kind       TEXT NOT NULL,           -- derivation | category | source
  key        TEXT NOT NULL,           -- 'Accounts Receivable' | 'groceries' | 'Visa ending 4421'
  code       TEXT,
  name       TEXT,
  tax_rate   TEXT,
  note       TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
INSERT OR IGNORE INTO bridge_map (kind, key, code, name, tax_rate, note, updated_at)
  SELECT 'derivation', account, code, name, tax_rate, note, updated_at FROM bridge_account_map;
DROP TABLE IF EXISTS bridge_account_map;
