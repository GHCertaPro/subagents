// server/index.js
//
// Express server exposing the subagent_logs API + dashboard admin panel.

import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import logsRouter from "./routes/logs.js";
import authRouter from "./routes/auth.js";
import timeRouter from "./routes/time.js";
import { requireAdmin } from "./auth.js";
import { getPool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, "..", "dashboard");

function checkRequiredEnv() {
  const missing = [];
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    missing.push("DATABASE_URL");
  }
  return missing;
}

// ── Seed bot_tokens from BOT_KEYS env var on first run ──────────────────────
// If bot_tokens table is empty AND BOT_KEYS is set, migrate existing keys.
async function seedBotTokens() {
  const raw = process.env.BOT_KEYS;
  if (!raw || !raw.trim()) return;

  let botKeys;
  try {
    botKeys = JSON.parse(raw);
    if (typeof botKeys !== "object" || Array.isArray(botKeys) || botKeys === null) return;
  } catch {
    console.warn("[startup] BOT_KEYS is not valid JSON — skipping seed.");
    return;
  }

  try {
    const pool = getPool();

    // Only seed if the table is empty
    const countRes = await pool.query("SELECT COUNT(*) AS c FROM bot_tokens");
    const count = parseInt(countRes.rows[0].c, 10);
    if (count > 0) {
      console.log(`[startup] bot_tokens already has ${count} row(s) — skipping seed.`);
      return;
    }

    for (const [botId, apiKey] of Object.entries(botKeys)) {
      await pool.query(
        `INSERT INTO bot_tokens (bot_id, api_key, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (bot_id) DO NOTHING`,
        [botId, apiKey, botId]
      );
      console.log(`[startup] seeded bot_token: bot_id=${botId}`);
    }
  } catch (err) {
    console.warn("[startup] Failed to seed bot_tokens:", err.message);
  }
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
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "subagents-log-service" });
  });

  app.use("/api/logs", logsRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/time", timeRouter);

  // ── POST /api/redeem — public, redeem an invite code ──────────────────────
  app.post("/api/redeem", async (req, res) => {
    const { code } = req.body ?? {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "code (string) is required." });
    }

    try {
      const pool = getPool();
      const inviteRes = await pool.query(
        "SELECT * FROM invites WHERE code = $1",
        [code.trim()]
      );
      if (inviteRes.rowCount === 0) {
        return res.status(404).json({ error: "Invite code not found." });
      }
      const invite = inviteRes.rows[0];

      if (invite.redeemed_at) {
        return res.status(409).json({ error: "This invite code has already been redeemed." });
      }
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        return res.status(410).json({ error: "This invite code has expired." });
      }

      // Mark redeemed
      await pool.query(
        "UPDATE invites SET redeemed_at = now() WHERE id = $1",
        [invite.id]
      );

      // Get the api_key for this bot_id from bot_tokens
      const tokenRes = await pool.query(
        "SELECT api_key FROM bot_tokens WHERE bot_id = $1",
        [invite.bot_id]
      );
      if (tokenRes.rowCount === 0) {
        return res.status(500).json({ error: "Bot token not found. Contact admin." });
      }
      const { api_key } = tokenRes.rows[0];

      const base = process.env.DASHBOARD_URL || "https://aria-subagents-dashboard-production.up.railway.app";
      const dashboardUrl = `${base}/?token=${encodeURIComponent(api_key)}`;

      return res.json({
        bot_id: invite.bot_id,
        api_key,
        display_name: invite.display_name,
        dashboard_url: dashboardUrl,
      });
    } catch (err) {
      console.error("[POST /api/redeem] error:", err.message);
      return res.status(500).json({ error: "Failed to redeem invite." });
    }
  });

  // ── Admin routes ───────────────────────────────────────────────────────────

  // GET /admin/api/bots — list all bot_tokens with run counts
  app.get("/admin/api/bots", requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(`
        SELECT
          bt.id,
          bt.bot_id,
          bt.display_name,
          bt.api_key,
          bt.created_at,
          COUNT(sl.id)::int AS total_runs,
          COUNT(sl.id) FILTER (WHERE sl.status = 'running')::int AS running_now,
          MAX(COALESCE(sl.ended_at, sl.started_at, sl.queued_at)) AS last_run_at
        FROM bot_tokens bt
        LEFT JOIN subagent_logs sl ON sl.bot_id = bt.bot_id
        GROUP BY bt.id, bt.bot_id, bt.display_name, bt.api_key, bt.created_at
        ORDER BY bt.created_at ASC
      `);
      const base = process.env.DASHBOARD_URL || "https://aria-subagents-dashboard-production.up.railway.app";
      const bots = result.rows.map((row) => ({
        ...row,
        dashboard_url: `${base}/?token=${encodeURIComponent(row.api_key)}`,
      }));
      return res.json({ bots });
    } catch (err) {
      console.error("[GET /admin/api/bots] error:", err.message);
      return res.status(500).json({ error: "Failed to list bots." });
    }
  });

  // GET /admin/api/invites — list all invites
  app.get("/admin/api/invites", requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        "SELECT * FROM invites ORDER BY created_at DESC"
      );
      const base = process.env.DASHBOARD_URL || "https://aria-subagents-dashboard-production.up.railway.app";
      const invites = result.rows.map((row) => ({
        ...row,
        invite_url: `${base}/invite.html?code=${encodeURIComponent(row.code)}`,
      }));
      return res.json({ invites });
    } catch (err) {
      console.error("[GET /admin/api/invites] error:", err.message);
      return res.status(500).json({ error: "Failed to list invites." });
    }
  });

  // POST /admin/api/invites — create a new invite + bot_token
  app.post("/admin/api/invites", requireAdmin, async (req, res) => {
    const { display_name, bot_id: botIdOverride, expiry_days } = req.body ?? {};
    if (!display_name || typeof display_name !== "string" || !display_name.trim()) {
      return res.status(400).json({ error: "display_name (string) is required." });
    }

    // Auto-generate bot_id from slugified display_name + 4 random chars
    const slug = display_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const suffix = crypto.randomBytes(2).toString("hex"); // 4 hex chars
    const botId = botIdOverride?.trim() || `${slug}-${suffix}`;

    // Generate random 8-char alphanumeric invite code
    const code = crypto.randomBytes(4).toString("hex"); // 8 hex chars

    // Generate a new api_key for this bot
    const apiKey = crypto.randomBytes(32).toString("hex");

    let expiresAt = null;
    if (expiry_days && Number.isFinite(Number(expiry_days)) && Number(expiry_days) > 0) {
      const d = new Date();
      d.setDate(d.getDate() + Number(expiry_days));
      expiresAt = d.toISOString();
    }

    try {
      const pool = getPool();

      // Insert bot_token (create the API key for this bot)
      await pool.query(
        `INSERT INTO bot_tokens (bot_id, api_key, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (bot_id) DO UPDATE SET api_key = EXCLUDED.api_key, display_name = EXCLUDED.display_name`,
        [botId, apiKey, display_name.trim()]
      );

      // Insert invite
      const inviteRes = await pool.query(
        `INSERT INTO invites (code, bot_id, display_name, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [code, botId, display_name.trim(), expiresAt]
      );
      const invite = inviteRes.rows[0];

      const base = process.env.DASHBOARD_URL || "https://aria-subagents-dashboard-production.up.railway.app";
      return res.status(201).json({
        invite,
        invite_url: `${base}/invite.html?code=${encodeURIComponent(code)}`,
        dashboard_url: `${base}/?token=${encodeURIComponent(apiKey)}`,
        bot_id: botId,
        api_key: apiKey,
      });
    } catch (err) {
      console.error("[POST /admin/api/invites] error:", err.message);
      return res.status(500).json({ error: "Failed to create invite." });
    }
  });

  // ── Static pages ───────────────────────────────────────────────────────────
  app.get("/history", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIR, "history.html"));
  });

  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIR, "admin.html"));
  });

  app.get("/invite", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIR, "invite.html"));
  });

  app.get("/login", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIR, "login.html"));
  });

  app.get("/redeem", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIR, "redeem.html"));
  });

  app.get("/settings", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIR, "settings.html"));
  });

  app.use(express.static(DASHBOARD_DIR));

  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/admin/api/") || req.path === "/health") {
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
  app.listen(port, async () => {
    console.log(`[startup] subagents-log-service listening on port ${port}`);
    // Seed bot_tokens from BOT_KEYS env var if table is empty
    await seedBotTokens();
  });
}

main();
