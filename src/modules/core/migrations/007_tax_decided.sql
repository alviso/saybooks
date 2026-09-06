-- "Not registered" must be an answer, never a default. tax_decided flips to 1 the first time
-- someone states registered yes or no; until then the setup checklist reports the question open.
ALTER TABLE company_profile ADD COLUMN tax_decided INTEGER NOT NULL DEFAULT 0;
UPDATE company_profile SET tax_decided = 1 WHERE tax_registered = 1;
