-- 002_add_summary_to_subagent_logs.sql
-- Adds a dedicated `summary` column: a SHORT, clean one-or-two-sentence
-- result blurb intended for glanceable UI surfaces (e.g. the dashboard's
-- History-tab hover-tooltip popup), distinct from the existing free-text
-- `notes` column.
--
-- Why a new column instead of reusing `notes`: in practice, `notes` values
-- have grown into full multi-sentence engineering reports (commit hashes,
-- test pass/fail counts, edge-case call-outs, deployment verification
-- detail) -- valuable for a full audit trail, but far too long/dense to
-- show in a quick hover popup without either overwhelming the user or
-- forcing awkward truncation. `summary` is meant to stay short (a
-- sentence or two) and `notes` keeps carrying the full detail going
-- forward. Both are optional/nullable, so existing POST/PATCH callers
-- that only send `notes` (or neither) keep working completely unchanged.
--
-- Nullable, no default, no backfill -- per this project's standing rule
-- that the dashboard starts clean from when real logging began, and that
-- rule extends to new fields too. Historical rows will simply have
-- summary = NULL; the dashboard renders no tooltip for those rows.

ALTER TABLE subagent_logs
  ADD COLUMN IF NOT EXISTS summary TEXT;
