// server/backfill-summaries.js
//
// One-off backfill: applies the same deterministic derivation logic used
// by PATCH /api/logs/:id (see server/lib/deriveSummary.js) to EXISTING
// done/failed rows whose `summary` is NULL/empty but `notes` has real
// content. This is a one-time historical catch-up for rows created before
// the auto-derivation fix landed in server/routes/logs.js -- going
// forward, new done/failed rows get `summary` populated automatically at
// write time and never need this script.
//
// Usage:
//   DATABASE_URL=... node server/backfill-summaries.js
//   DATABASE_URL=... node server/backfill-summaries.js --dry-run
//
// Safe to re-run: only touches rows where summary IS NULL or empty AND
// notes has real content, so already-backfilled or already-populated rows
// are left untouched on subsequent runs.

import pg from "pg";
import { deriveSummaryFromNotes } from "./lib/deriveSummary.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !connectionString.trim()) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const beforeCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM subagent_logs
       WHERE status IN ('done', 'failed')
         AND (summary IS NULL OR trim(summary) = '')`
    );
    console.log(`Before: ${beforeCount.rows[0].c} done/failed rows with empty summary.`);

    const candidates = await pool.query(
      `SELECT id, notes FROM subagent_logs
       WHERE status IN ('done', 'failed')
         AND (summary IS NULL OR trim(summary) = '')
         AND notes IS NOT NULL AND trim(notes) != ''
       ORDER BY id`
    );

    console.log(`Found ${candidates.rowCount} rows with usable notes to derive a summary from.`);

    let updated = 0;
    let skippedNoDerivable = 0;

    for (const row of candidates.rows) {
      const derived = deriveSummaryFromNotes(row.notes);
      if (!derived) {
        skippedNoDerivable++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`[dry-run] id ${row.id}: would set summary = ${JSON.stringify(derived)}`);
      } else {
        await pool.query(`UPDATE subagent_logs SET summary = $1 WHERE id = $2`, [derived, row.id]);
      }
      updated++;
    }

    console.log(
      `${DRY_RUN ? "[dry-run] Would update" : "Updated"} ${updated} rows; ${skippedNoDerivable} skipped (no derivable text).`
    );

    const afterCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM subagent_logs
       WHERE status IN ('done', 'failed')
         AND (summary IS NULL OR trim(summary) = '')`
    );
    console.log(
      `After${DRY_RUN ? " (dry-run, not actually applied)" : ""}: ${afterCount.rows[0].c} done/failed rows with empty summary.`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
