-- The company logo: branding, not a fact. Stored as a data URL (PNG/JPEG/SVG/WebP, <= 300 KB)
-- so documents never hotlink; NOT part of the frozen seller block on issued invoices.
ALTER TABLE company_profile ADD COLUMN logo TEXT;
