// server/migrate.js
//
// Minimal migration runner: applies any .sql files in server/migrations/
// in filename order, tracking what has already run in a
// `schema_migrations` table so re-running is a safe no-op.
//
// Usage: npm run migrate   (reads DATABASE_URL from the environment / .env)

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) {
    console.error(
      "[migrate] ERROR: DATABASE_URL is not set. Copy .env.example to .env " +
        "and fill in a real Neon connection string before running migrations."
    );
    process.exit(1);
  }
  return url;
}

async function main() {
  const connectionString = requireDatabaseUrl();
  const client = new pg.Client({ connectionString });

  try {
    await client.connect();
  } catch (err) {
    console.error("[migrate] ERROR: could not connect to database:", err.message);
    process.exit(1);
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map(
        (r) => r.filename
      )
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ranCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip (already applied): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`[migrate] applying: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        ranCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log(`[migrate] done. ${ranCount} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err.message);
  process.exit(1);
});
