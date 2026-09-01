-- 001_create_subagent_logs.sql
-- Core table for subagent lifecycle tracking, replacing the Google Sheets
-- "SubLogs" tab. Mirrors the queue-first / spawn-later flow used there:
-- a row can be created at queue time (status='queued', started_at NULL),
-- then updated when the subagent actually starts, and again on completion.

CREATE TABLE IF NOT EXISTS subagent_logs (
  id            BIGSERIAL PRIMARY KEY,

  -- Human-readable identifier for the task, e.g. "aria_subagents_repo_neon_backend_scaffold".
  -- Not required to be globally unique (a task name may recur across runs).
  task_name     TEXT NOT NULL,

  -- Lifecycle timestamps. queued_at is set at row creation (or explicitly
  -- passed in). started_at is filled in once the subagent actually begins
  -- executing (may equal queued_at if there was no queue delay). ended_at
  -- stays NULL while the task is in progress.
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,

  -- Lifecycle status. Kept as TEXT with a CHECK constraint rather than a
  -- Postgres ENUM so new statuses can be added later via a simple
  -- migration instead of an ALTER TYPE dance.
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),

  -- Free-text notes/summary — e.g. a short result blurb, error message on
  -- failure, or any other context worth surfacing on a dashboard.
  notes         TEXT,

  -- Which agent/session/requester spawned this subagent, if known. Useful
  -- for a dashboard to group/filter by origin. Nullable — not always known.
  requested_by  TEXT,

  -- Free-form JSON bag for anything else worth attaching later (e.g. model
  -- used, token counts, links to artifacts) without another migration.
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subagent_logs_status ON subagent_logs (status);
CREATE INDEX IF NOT EXISTS idx_subagent_logs_queued_at ON subagent_logs (queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_subagent_logs_task_name ON subagent_logs (task_name);

-- Keep updated_at current on every row update.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subagent_logs_updated_at ON subagent_logs;
CREATE TRIGGER trg_subagent_logs_updated_at
  BEFORE UPDATE ON subagent_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
