// server/index.js
//
// Minimal Express server exposing the subagent_logs API. Fails fast with a
// clear message (not a stack trace) if DATABASE_URL is unset, since every
// route depends on it.

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import logsRouter from "./routes/logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, "..", "dashboard");

function checkRequiredEnv() {
  const missing = [];
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    missing.push("DATABASE_URL");
  }
  if (!process.env.API_KEY || !process.env.API_KEY.trim()) {
    missing.push("API_KEY");
  }
  return missing;
}

function main() {
  const missing = checkRequiredEnv();
  if (missing.length > 0) {
    console.error(
      `[startup] ERROR: missing required environment variable(s): ${missing.join(", ")}\n` +
        `[startup] Copy .env.example to .env and fill in real values before starting the server.`
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "subagents-log-service" });
  });

  app.use("/api/logs", logsRouter);

  // Serve the static dashboard (dashboard/index.html etc.) from the same
  // origin/port as the API, so the whole thing runs behind one Railway
  // URL instead of needing a separate GitHub Pages deploy. The dashboard's
  // own JS defaults to same-origin API calls when no explicit base URL is
  // configured (see dashboard/config.js).
  app.use(express.static(DASHBOARD_DIR));

  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path === "/health") {
      return res.status(404).json({ error: "Not found." });
    }
    res.sendFile(path.join(DASHBOARD_DIR, "index.html"));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[unhandled error]", err);
    res.status(500).json({ error: "Internal server error." });
  });

  const port = parseInt(process.env.PORT, 10) || 3000;
  app.listen(port, () => {
    console.log(`[startup] subagents-log-service listening on port ${port}`);
  });
}

main();
