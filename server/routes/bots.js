// server/routes/bots.js
//
// Public-ish bot list endpoint. Returns all bots with their api_key so the
// dashboard's bot-switcher dropdown can switch between bots without needing
// a separate admin key. Requires a valid bot x-api-key (requireApiKey) — any
// authenticated bot can see all bots. Since bots already have full log-read
// access, returning api_keys here doesn't increase the effective attack surface.

import { Router } from "express";
import { getPool } from "../db.js";
import { requireApiKey } from "../auth.js";

const router = Router();

// GET /api/bots
// Returns all bots (bot_id, display_name, api_key) ordered by bot_id.
// Requires a valid x-api-key header (any registered bot key is accepted).
router.get("/", requireApiKey, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT bot_id, display_name, api_key FROM bot_tokens ORDER BY bot_id ASC"
    );
    return res.json({ bots: result.rows });
  } catch (err) {
    console.error("[GET /api/bots] error:", err.message);
    return res.status(500).json({ error: "Failed to list bots." });
  }
});

export default router;
