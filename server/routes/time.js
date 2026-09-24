// server/routes/time.js
//
// Clock-in / clock-out time tracking routes.
// All routes require JWT auth via verifyToken (Bearer or __auth_token cookie).
// JWT payload: { id, email, role }

import { Router } from "express";
import { getPool } from "../db.js";
import { verifyToken } from "../auth.js";

const router = Router();

// All routes in this file require JWT auth.
router.use(verifyToken);

// ── POST /api/time/clock-in ───────────────────────────────────────────────────
// Start a new time entry for the authenticated user.
// 409 if the user already has an open entry (clocked_out IS NULL).
router.post("/clock-in", async (req, res) => {
  const email = req.user.email;

  try {
    const pool = getPool();

    // Check for an existing open entry
    const openCheck = await pool.query(
      "SELECT id FROM time_entries WHERE user_email = $1 AND clocked_out IS NULL ORDER BY clocked_in DESC LIMIT 1",
      [email]
    );
    if (openCheck.rowCount > 0) {
      return res.status(409).json({ error: "Already clocked in." });
    }

    const result = await pool.query(
      `INSERT INTO time_entries (user_email, clocked_in)
       VALUES ($1, now())
       RETURNING id, user_email, clocked_in`,
      [email]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[POST /api/time/clock-in] error:", err.message);
    return res.status(500).json({ error: "Failed to clock in." });
  }
});

// ── POST /api/time/clock-out ──────────────────────────────────────────────────
// Close the most recent open time entry for the authenticated user.
// 409 if no open entry exists.
router.post("/clock-out", async (req, res) => {
  const email = req.user.email;

  try {
    const pool = getPool();

    // Find most recent open entry
    const openCheck = await pool.query(
      "SELECT id FROM time_entries WHERE user_email = $1 AND clocked_out IS NULL ORDER BY clocked_in DESC LIMIT 1",
      [email]
    );
    if (openCheck.rowCount === 0) {
      return res.status(409).json({ error: "Not clocked in." });
    }
    const entryId = openCheck.rows[0].id;

    const result = await pool.query(
      `UPDATE time_entries
       SET clocked_out = now()
       WHERE id = $1
       RETURNING id, user_email, clocked_in, clocked_out`,
      [entryId]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("[POST /api/time/clock-out] error:", err.message);
    return res.status(500).json({ error: "Failed to clock out." });
  }
});

// ── GET /api/time/status ──────────────────────────────────────────────────────
// Returns whether the authenticated user is currently clocked in,
// and the open entry if so.
router.get("/status", async (req, res) => {
  const email = req.user.email;

  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, user_email, clocked_in, clocked_out FROM time_entries WHERE user_email = $1 AND clocked_out IS NULL ORDER BY clocked_in DESC LIMIT 1",
      [email]
    );

    if (result.rowCount === 0) {
      return res.json({ clocked_in: false, entry: null });
    }
    return res.json({ clocked_in: true, entry: result.rows[0] });
  } catch (err) {
    console.error("[GET /api/time/status] error:", err.message);
    return res.status(500).json({ error: "Failed to get time status." });
  }
});

// ── GET /api/time/entries ─────────────────────────────────────────────────────
// List time entries for the authenticated user, newest-first.
// Query params: ?limit=50&offset=0
// Each entry includes duration_minutes (null if still open).
router.get("/entries", async (req, res) => {
  const email = req.user.email;

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    const pool = getPool();
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT
           id,
           clocked_in,
           clocked_out,
           CASE
             WHEN clocked_out IS NOT NULL
             THEN ROUND(EXTRACT(EPOCH FROM (clocked_out - clocked_in)) / 60)::int
             ELSE NULL
           END AS duration_minutes
         FROM time_entries
         WHERE user_email = $1
         ORDER BY clocked_in DESC
         LIMIT $2 OFFSET $3`,
        [email, limit, offset]
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total FROM time_entries WHERE user_email = $1",
        [email]
      ),
    ]);

    return res.json({
      count: result.rowCount,
      total: countResult.rows[0]?.total ?? 0,
      entries: result.rows,
    });
  } catch (err) {
    console.error("[GET /api/time/entries] error:", err.message);
    return res.status(500).json({ error: "Failed to list time entries." });
  }
});

export default router;
