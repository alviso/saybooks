-- Spec 0.2: the business's own identity. One row per workspace — master data, not config.
-- An invoice document needs a seller; the profile is where the seller comes from.
CREATE TABLE IF NOT EXISTS company_profile (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  name                 TEXT NOT NULL,
  address              TEXT,
  tax_id               TEXT,
  payment_instructions TEXT,
  footer_note          TEXT,
  updated_at           TEXT NOT NULL
);
