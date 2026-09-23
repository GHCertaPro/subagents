-- 004_add_bot_tokens_and_invites.sql
--
-- Adds DB-backed token management tables (bot_tokens, invites) to replace
-- the BOT_KEYS env-var-only approach. Existing bot_tokens can be seeded
-- from BOT_KEYS on first startup by server/index.js.

CREATE TABLE IF NOT EXISTS bot_tokens (
  id            BIGSERIAL PRIMARY KEY,
  bot_id        TEXT NOT NULL UNIQUE,
  api_key       TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  bot_id        TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  redeemed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bot_tokens_api_key ON bot_tokens (api_key);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites (code);
