-- Transfers between the person's own accounts (purchases 0.7): the two statement rows of one move
-- (checking out, card in) paired, so the money is counted once and never as spending or income.
CREATE TABLE IF NOT EXISTS purch_transfer (
  id              TEXT PRIMARY KEY,            -- TR-0001
  out_tx          TEXT NOT NULL REFERENCES purch_transaction(id),   -- the side money left
  in_tx           TEXT NOT NULL REFERENCES purch_transaction(id),   -- the side it arrived
  out_was         TEXT NOT NULL,               -- each row's review before pairing, JSON, put back on unpair
  in_was          TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  unpaired_at     TEXT,
  unpaired_by     TEXT,
  unpair_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ptransfer_out ON purch_transfer(out_tx);
CREATE INDEX IF NOT EXISTS idx_ptransfer_in ON purch_transfer(in_tx);
