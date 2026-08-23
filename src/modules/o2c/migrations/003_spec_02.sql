-- Spec 0.2: applications get their own date. The journal dates "payment applied" and
-- "credit applied" as their own events; existing rows fall back to the parent's date.
ALTER TABLE payment_application ADD COLUMN applied_at TEXT;
ALTER TABLE credit_application ADD COLUMN applied_at TEXT;
