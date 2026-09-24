-- 007_user_isolation.sql
--
-- Adds per-user isolation to bot_tokens and subagent_logs.
-- Note: users.id is INTEGER (not UUID) in this schema.

-- Add user_id to bot_tokens — links each API key to its owning user
ALTER TABLE bot_tokens
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Add user_id to subagent_logs — stamps each log with who triggered it
ALTER TABLE subagent_logs
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Index for fast user-scoped log queries
CREATE INDEX IF NOT EXISTS idx_subagent_logs_user_id ON subagent_logs (user_id);

-- Add a new column to users: default_bot_id — the bot this user's personal token is for
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_bot_id TEXT REFERENCES bot_tokens(bot_id) ON DELETE SET NULL;
