-- crm 0.3: the agent writes, a person sends. A draft is a proposal held against a contact
-- until a person does something with it; this system has no outbound channel and never will.
CREATE TABLE IF NOT EXISTS crm_draft (
  id          TEXT PRIMARY KEY,            -- D-0001
  account_id  TEXT NOT NULL REFERENCES account(id),
  contact_id  TEXT NOT NULL REFERENCES contact(id),
  channel     TEXT NOT NULL,               -- email | linkedin | letter | other
  subject     TEXT,
  body        TEXT NOT NULL,
  rationale   TEXT NOT NULL,               -- CRM-16: for the reviewer, never sent
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | discarded
  status_reason TEXT,
  sent_at     TEXT,                        -- CRM-5: when it actually went
  activity_id INTEGER,                     -- the trail row its text was copied onto
  written_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_contact ON crm_draft(contact_id);
CREATE INDEX IF NOT EXISTS idx_draft_status ON crm_draft(status);

-- What may be said, and what may never be, per campaign. A person writes both: an agent
-- choosing which claims it is allowed to make is the check marking its own homework (CRM-17).
CREATE TABLE IF NOT EXISTS campaign_claim (
  id          INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  kind        TEXT NOT NULL,               -- allowed | refused
  text        TEXT NOT NULL,               -- allowed: the claim, as it may be put.
                                           -- refused: a word or phrase no draft may contain.
  note        TEXT,
  added_by    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_campaign ON campaign_claim(campaign_id, kind);

-- Parking is a fact about what happened; status is a judgement about where a pursuit sits.
-- Conflating them loses the story: "both intake routes are dead" is not a pipeline position.
ALTER TABLE account ADD COLUMN parked_at TEXT;
ALTER TABLE account ADD COLUMN parked_reason TEXT;
ALTER TABLE account ADD COLUMN parked_by TEXT;
