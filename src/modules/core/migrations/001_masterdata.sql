-- core: master data. Money is INTEGER minor units (cents), never float.
CREATE TABLE IF NOT EXISTS customer (
  id           TEXT PRIMARY KEY,         -- C-0001
  name         TEXT NOT NULL UNIQUE,
  email        TEXT,
  terms        TEXT NOT NULL DEFAULT 'net30',   -- due:immediate|net15|net30|net60
  credit_limit INTEGER NOT NULL DEFAULT 0,      -- cents; 0 = no credit, prepay only
  currency     TEXT NOT NULL DEFAULT 'USD',
  on_hold      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item (
  id         TEXT PRIMARY KEY,           -- SKU, operator-supplied
  name       TEXT NOT NULL,
  unit_price INTEGER NOT NULL,           -- cents, list price
  on_hand    INTEGER NOT NULL DEFAULT 0,
  stocked    INTEGER NOT NULL DEFAULT 1, -- 0 = service line, never depletes
  created_at TEXT NOT NULL
);
