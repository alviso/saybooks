-- crm 0.2: campaigns become first-class (CRM-12/13). The 0.1 extraction erased the campaign
-- by promoting it to "the whole deployment"; this restores it as the goal-bearing entity.

CREATE TABLE IF NOT EXISTS campaign (
  id             TEXT PRIMARY KEY,          -- CAM-0001
  name           TEXT NOT NULL UNIQUE,
  goal           TEXT NOT NULL,             -- CRM-13: the thesis; the brief agents read
  target_profile TEXT,
  status         TEXT NOT NULL DEFAULT 'active',   -- active | paused | concluded
  status_reason  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Rebuild account: drop the global UNIQUE(name) (uniqueness is now per campaign) and add
-- campaign_id. Existing rows are grandfathered into an honestly named holding campaign.
INSERT INTO campaign (id, name, goal, status, created_at, updated_at)
  SELECT 'CAM-0001', 'Uncategorized', 'Pre-campaign rows grandfathered by the 0.2 migration — sort them into real campaigns.', 'active', datetime('now'), datetime('now')
  WHERE EXISTS (SELECT 1 FROM account) AND NOT EXISTS (SELECT 1 FROM campaign);

CREATE TABLE account_v2 (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaign(id),
  name          TEXT NOT NULL,
  tier          INTEGER,
  vertical      TEXT,
  why_them      TEXT NOT NULL,
  trigger_event TEXT,
  hook          TEXT,
  source_url    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'not_started',
  status_reason TEXT,
  customer_id   TEXT REFERENCES customer(id),
  owner_note    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO account_v2 (id, campaign_id, name, tier, vertical, why_them, trigger_event, hook, source_url, status, status_reason, customer_id, owner_note, created_at, updated_at)
  SELECT id, 'CAM-0001', name, tier, vertical, why_them, trigger_event, hook, source_url, status, status_reason, customer_id, owner_note, created_at, updated_at FROM account;
DROP TABLE account;
ALTER TABLE account_v2 RENAME TO account;
CREATE UNIQUE INDEX idx_account_campaign_name ON account(campaign_id, lower(name));
CREATE INDEX idx_account_campaign ON account(campaign_id);
