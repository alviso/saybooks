-- Tax capture, SMB calibration (spec INV-14): the item carries a default rate in basis
-- points (875 = 8.75%). Determination is freedom; this is just the default the billing
-- act snapshots. 0 = untaxed.
ALTER TABLE item ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;
