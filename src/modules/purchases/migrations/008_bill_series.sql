-- Household bills (purchases 0.9): a vendor whose bill comes every period (the electric bill, never the
-- same amount), so a missing or unusually high one is named; and autopay, a person's standing approval
-- for that vendor's bills from one account.
CREATE TABLE IF NOT EXISTS purch_bill_series (
  id                  TEXT PRIMARY KEY,          -- BS-0001
  vendor_id           TEXT NOT NULL REFERENCES purch_vendor(id),
  cadence             TEXT NOT NULL,             -- monthly | quarterly | yearly
  category            TEXT,
  currency            TEXT NOT NULL,
  typical_amount      INTEGER,                   -- what the person says it usually is, until there are bills to tell
  due_day             INTEGER,                   -- the usual due day, if the person says
  autopay_account_id  TEXT,                      -- the account the vendor takes payment from on its own
  autopay_set_by      TEXT,
  autopay_set_at      TEXT,
  autopay_reason      TEXT,
  status              TEXT NOT NULL DEFAULT 'active',   -- active | ended
  end_reason          TEXT,
  reason              TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
