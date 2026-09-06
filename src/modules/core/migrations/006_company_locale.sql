-- 0.2: where the business is, what it bills in, and its tax scheme. Money stays integer minor
-- units. A space may bill in several currencies (a set, with a default); the invoice carries
-- its own. Tax is a scheme on the profile — label, default rate, registered or not — so an
-- unregistered business can never accidentally charge it.
ALTER TABLE company_profile ADD COLUMN country TEXT;                       -- ISO 3166-1 alpha-2, e.g. NZ, CZ, HU, US
ALTER TABLE company_profile ADD COLUMN currency TEXT;                      -- default currency, ISO 4217 (null = USD)
ALTER TABLE company_profile ADD COLUMN currencies TEXT;                    -- JSON array of allowed currencies (null = [currency])
ALTER TABLE company_profile ADD COLUMN tax_label TEXT;                     -- GST, VAT, Sales tax, ÁFA, DPH
ALTER TABLE company_profile ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;   -- default rate for registered businesses (1500 = 15%)
ALTER TABLE company_profile ADD COLUMN tax_registered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company_profile ADD COLUMN tax_id_label TEXT;                  -- how the tax id is captioned on documents (GST No., IRD number, VAT ID, EIN)
ALTER TABLE company_profile ADD COLUMN number_format TEXT;                 -- INV-{NNNN} (default) · INV-{YYYY}-{NNN} · {YY}-{NNNN}
