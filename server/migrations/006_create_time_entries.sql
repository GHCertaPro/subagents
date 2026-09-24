-- 006_create_time_entries.sql
-- Clock-in / clock-out time tracking for users.

CREATE TABLE IF NOT EXISTS time_entries (
  id          BIGSERIAL PRIMARY KEY,
  user_email  TEXT NOT NULL,
  clocked_in  TIMESTAMPTZ NOT NULL DEFAULT now(),
  clocked_out TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_email      ON time_entries (user_email);
CREATE INDEX IF NOT EXISTS idx_time_entries_clocked_in ON time_entries (clocked_in DESC);
