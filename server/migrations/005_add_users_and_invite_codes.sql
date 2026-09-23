-- 005_add_users_and_invite_codes.sql
--
-- Adds user accounts and invite-code-based authentication tables.
-- Separate from the existing `invites` / `bot_tokens` system which handles
-- per-bot API key distribution. These tables support human user login
-- (email + password) with JWT session tokens.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  email           TEXT,
  used_by_user_id INT REFERENCES users(id),
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes (code);
