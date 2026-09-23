-- 003_add_bot_id.sql
-- Add bot_id column to subagent_logs for multi-tenant isolation.
-- Each row is owned by one bot; the API server stamps this automatically
-- from the authenticated API key (callers cannot set it themselves).

ALTER TABLE subagent_logs ADD COLUMN IF NOT EXISTS bot_id TEXT;
CREATE INDEX IF NOT EXISTS idx_subagent_logs_bot_id ON subagent_logs (bot_id);
