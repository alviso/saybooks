-- The person's public profile URL: a sourced fact, agent-writable — unlike the connection
-- path fields (mutual_via, mutual_url, linkedin_path), which stay human-only per CRM-4.
ALTER TABLE contact ADD COLUMN linkedin_url TEXT;
