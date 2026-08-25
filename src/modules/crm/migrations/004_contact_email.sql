-- Contact channels, plainly listed where the industry lists them plainly.
-- Provenance still applies (CRM-2): the source says where it came from.
ALTER TABLE contact ADD COLUMN email TEXT;
ALTER TABLE contact ADD COLUMN phone TEXT;
