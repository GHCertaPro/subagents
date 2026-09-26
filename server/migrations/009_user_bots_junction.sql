-- 009_user_bots_junction.sql
-- Adds explicit many-to-many user↔bot access grants.
-- A user can be granted access to multiple system bots via this table.

CREATE TABLE IF NOT EXISTS user_bots (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id     TEXT    NOT NULL REFERENCES bot_tokens(bot_id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_user_bots_user_id ON user_bots (user_id);
CREATE INDEX IF NOT EXISTS idx_user_bots_bot_id  ON user_bots (bot_id);

-- Seed: grant gabe@prospectrdigital.com access to both cos and dispatch
INSERT INTO user_bots (user_id, bot_id)
SELECT u.id, b.bot_id
FROM users u
CROSS JOIN (VALUES ('cos'), ('dispatch')) AS b(bot_id)
WHERE u.email = 'gabe@prospectrdigital.com'
ON CONFLICT (user_id, bot_id) DO NOTHING;
