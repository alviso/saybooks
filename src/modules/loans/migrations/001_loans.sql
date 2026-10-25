-- Loans (loans 0.1): a mortgage, a car loan, a student or personal loan, from the lender's figures;
-- the statement rows that paid it, each split into principal, interest and escrow. The balance, the
-- schedule ahead and the payoff date are derived, never stored.
CREATE TABLE IF NOT EXISTS loan_loan (
  id                 TEXT PRIMARY KEY,         -- LN-0001
  account_id         TEXT NOT NULL,            -- the purchases register's loan account
  kind               TEXT NOT NULL,            -- mortgage | auto | student | personal | other
  lender             TEXT,
  currency           TEXT NOT NULL,
  balance            INTEGER NOT NULL,         -- what was owed on balance_date, from the lender
  balance_date       TEXT NOT NULL,
  rate_bp            INTEGER NOT NULL,         -- fixed annual rate: 650 = 6.5%
  payment            INTEGER NOT NULL,         -- scheduled principal and interest each month
  escrow             INTEGER NOT NULL DEFAULT 0, -- taxes and insurance collected with it each month
  due_day            INTEGER NOT NULL,         -- day of the month the payment is due
  original_principal INTEGER,
  term_months        INTEGER,
  source             TEXT NOT NULL,            -- where the figures come from: "lender statement, Oct 2026"
  created_by         TEXT,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loan_payment (
  id             TEXT PRIMARY KEY,             -- LP-0001
  loan_id        TEXT NOT NULL REFERENCES loan_loan(id),
  transaction_id TEXT NOT NULL,                -- the statement row that paid it (purchases)
  date           TEXT NOT NULL,
  amount         INTEGER NOT NULL,             -- positive: what the row paid
  principal      INTEGER NOT NULL,
  interest       INTEGER NOT NULL,
  escrow         INTEGER NOT NULL,
  split_from     TEXT NOT NULL,                -- lender | schedule
  row_was        TEXT NOT NULL,                -- the row's review before linking, JSON
  reason         TEXT NOT NULL,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  unlinked_at    TEXT,
  unlink_reason  TEXT
);
