-- Owned by the registry itself, not by any module.
-- Every state change in this system arrives as a command, from a human clicking a button or
-- an agent calling a tool. Both land here, in the same shape, with the actor recorded.
CREATE TABLE IF NOT EXISTS command_log (
  id           INTEGER PRIMARY KEY,
  at           TEXT    NOT NULL,
  command      TEXT    NOT NULL,
  actor_kind   TEXT    NOT NULL,        -- human | agent
  actor        TEXT    NOT NULL,        -- 'peter', 'claude'
  session      TEXT,                    -- MCP session or browser tab; groups a burst of work
  reason       TEXT,                    -- why: the prompt or the UI intent, when supplied
  subject_type TEXT,
  subject_id   TEXT,
  args_json    TEXT    NOT NULL,
  ok           INTEGER NOT NULL,
  result_json  TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_subject ON command_log(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_log_at      ON command_log(at);
