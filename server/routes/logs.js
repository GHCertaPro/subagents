// server/routes/logs.js
//
// CRUD-ish routes for subagent_logs. Kept intentionally small: this is a
// backend for a future dashboard, not a general-purpose API.

import { Router } from "express";
import { getPool } from "../db.js";
import { requireApiKey, requireAdmin } from "../auth.js";
import { deriveSummaryFromNotes } from "../lib/deriveSummary.js";

const router = Router();

const VALID_STATUSES = ["queued", "running", "done", "failed", "cancelled"];

// Cap notes at 2 KB to keep Neon storage bounded across many bots/users.
// The summary column is the right place for the short human-readable result;
// notes is for structured detail that doesn't need to be a full transcript.
const NOTES_MAX_LEN = 2048;
const capNotes = (s) =>
  s && s.length > NOTES_MAX_LEN ? s.slice(0, NOTES_MAX_LEN) + "…" : s;

// POST /api/logs
// Create a new log entry. Can represent a task being queued
// (status defaults to "queued", started_at omitted) or a task that is
// starting immediately (pass status: "running", started_at: <iso>).
// bot_id is auto-stamped from the authenticated API key; callers cannot
// set it themselves (any bot_id in the body is ignored).
router.post("/", requireApiKey, async (req, res) => {
  // eslint-disable-next-line no-unused-vars -- bot_id in body is intentionally ignored
  const { task_name, status, queued_at, started_at, notes, summary, requested_by, metadata, bot_id: _ignored } =
    req.body ?? {};

  if (!task_name || typeof task_name !== "string") {
    return res.status(400).json({ error: "task_name (string) is required." });
  }

  const finalStatus = status ?? "queued";
  if (!VALID_STATUSES.includes(finalStatus)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
    });
  }

  // bot_id comes from the authenticated key, never from the request body
  const botId = req.bot_id;

  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO subagent_logs
         (task_name, status, queued_at, started_at, notes, summary, requested_by, metadata, bot_id)
       VALUES
         ($1, $2, COALESCE($3, now()), $4, $5, $6, $7, COALESCE($8, '{}'::jsonb), $9)
       RETURNING *`,
      [
        task_name,
        finalStatus,
        queued_at ?? null,
        started_at ?? null,
        capNotes(notes ?? null),
        summary ?? null,
        requested_by ?? null,
        metadata ? JSON.stringify(metadata) : null,
        botId ?? null,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[POST /api/logs] error:", err.message);
    return res.status(500).json({ error: "Failed to create log entry." });
  }
});

// PATCH /api/logs/:id
// Partial update — e.g. fill in started_at on dequeue, or ended_at +
// status on completion. Only provided fields are updated.
router.patch("/:id", requireApiKey, async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "id must be a positive integer." });
  }

  const { status, started_at, ended_at, notes, summary, requested_by, metadata } = req.body ?? {};

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
    });
  }

  const fields = [];
  const values = [];
  let i = 1;

  const set = (col, val) => {
    fields.push(`${col} = $${i++}`);
    values.push(val);
  };

  if (status !== undefined) set("status", status);
  if (started_at !== undefined) set("started_at", started_at);
  if (ended_at !== undefined) set("ended_at", ended_at);
  if (notes !== undefined) set("notes", capNotes(notes));

  // `summary` handling: an explicit, non-empty `summary` in this request
  // always wins (caller knows best). Otherwise, when this request is
  // marking the row done/failed AND supplying `notes`, auto-derive a
  // short summary server-side from `notes` and write it into the
  // `summary` column -- this is the durable fix for the root bug where
  // `summary` almost never got populated because callers only ever sent
  // the long structured `notes` report and were never told to also send
  // a short `summary`. See server/lib/deriveSummary.js for the
  // deterministic (no LLM call) extraction logic. If `summary` was sent
  // explicitly but auto-derivation conditions aren't met (e.g. an
  // intentional clear via summary: "", or status isn't done/failed),
  // fall back to honoring whatever was actually sent.
  const explicitSummary =
    summary !== undefined && String(summary).trim() !== "" ? String(summary).trim() : null;
  if (explicitSummary) {
    set("summary", explicitSummary);
  } else if (status !== undefined && (status === "done" || status === "failed") && notes !== undefined) {
    const derived = deriveSummaryFromNotes(notes);
    if (derived) set("summary", derived);
  } else if (summary !== undefined) {
    set("summary", summary);
  }

  if (requested_by !== undefined) set("requested_by", requested_by);
  if (metadata !== undefined) set("metadata", JSON.stringify(metadata));

  if (fields.length === 0) {
    return res.status(400).json({ error: "No updatable fields provided." });
  }

  values.push(id);

  try {
    const pool = getPool();

    // Cross-bot write protection: verify the row's bot_id matches the
    // authenticated caller's bot_id before allowing the update.
    // Rows with bot_id = NULL are treated as legacy/unowned and can be
    // updated by any authenticated caller (backward compat with rows
    // created before multi-tenancy was added).
    const ownerCheck = await pool.query(
      `SELECT bot_id FROM subagent_logs WHERE id = $1`,
      [id]
    );
    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    const rowBotId = ownerCheck.rows[0].bot_id;
    if (rowBotId !== null && rowBotId !== req.bot_id) {
      return res.status(403).json({ error: "Not authorized to modify this log entry." });
    }

    const result = await pool.query(
      `UPDATE subagent_logs SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("[PATCH /api/logs/:id] error:", err.message);
    return res.status(500).json({ error: "Failed to update log entry." });
  }
});

// GET /api/logs
// List entries for the dashboard. Supports:
//   ?status=running              filter by exact status
//   ?status=done,failed,cancelled  comma-separated list filters to ANY of
//                                   the given statuses (added for the
//                                   History tab, which needs all three
//                                   terminal statuses in one call)
//   ?limit=50                    cap result count (default 50, max 500)
//   ?offset=0                    skip this many matching rows before
//                                 taking `limit` (real server-side pagination)
//   ?order_by=queued_at|ended_at   sort key (default queued_at)
//   ?task_name=foo               filter by exact task_name
//   ?bot_id=<id>                 optional: filter by bot_id. If the request
//                                 includes a valid x-api-key header, the
//                                 bot_id is resolved from the key and this
//                                 param is IGNORED (user sees only their bot).
//                                 If no key: backward-compat open behavior.
//
// Response shape: { count, total, logs }.
router.get("/", async (req, res) => {
  const { status, task_name } = req.query;

  // If caller supplies a valid x-api-key, resolve bot_id from the token table
  // and force-filter to that bot (user isolation). Ignore any ?bot_id= param.
  let bot_id = req.query.bot_id;
  const apiKey = req.get("x-api-key");
  if (apiKey) {
    try {
      const pool = getPool();
      const tokenRow = await pool.query(
        "SELECT bot_id FROM bot_tokens WHERE api_key = $1",
        [apiKey]
      );
      if (tokenRow.rowCount > 0) {
        // Key resolved — override bot_id with the token's bot
        bot_id = tokenRow.rows[0].bot_id;
      } else {
        // Key provided but not found — try BOT_KEYS env fallback
        const raw = process.env.BOT_KEYS;
        if (raw) {
          try {
            const botKeys = JSON.parse(raw);
            const resolved = Object.keys(botKeys).find((id) => botKeys[id] === apiKey);
            if (resolved) bot_id = resolved;
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.warn("[GET /api/logs] token lookup failed:", err.message);
      // Non-fatal — fall through with whatever bot_id was in the query
    }
  }
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const orderByParam = req.query.order_by;
  if (orderByParam !== undefined && !["queued_at", "ended_at"].includes(orderByParam)) {
    return res.status(400).json({
      error: "order_by must be one of: queued_at, ended_at",
    });
  }
  const orderExpr =
    orderByParam === "ended_at" ? "COALESCE(ended_at, started_at, queued_at)" : "queued_at";

  const clauses = [];
  const values = [];
  let i = 1;

  if (status !== undefined) {
    const statuses = String(status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statuses) {
      if (!VALID_STATUSES.includes(s)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")} (comma-separated for multiple)`,
        });
      }
    }
    clauses.push(`status = ANY($${i++})`);
    values.push(statuses);
  }

  if (task_name !== undefined) {
    clauses.push(`task_name = $${i++}`);
    values.push(task_name);
  }

  if (bot_id !== undefined) {
    clauses.push(`bot_id = $${i++}`);
    values.push(String(bot_id).trim());
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const whereValues = values.slice();

  const pageValues = values.slice();
  pageValues.push(limit, offset);
  const limitIdx = whereValues.length + 1;
  const offsetIdx = whereValues.length + 2;

  try {
    const pool = getPool();
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM subagent_logs ${where} ORDER BY ${orderExpr} DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        pageValues
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM subagent_logs ${where}`, whereValues),
    ]);
    return res.json({
      count: result.rowCount,
      total: countResult.rows[0]?.total ?? 0,
      logs: result.rows,
    });
  } catch (err) {
    console.error("[GET /api/logs] error:", err.message);
    return res.status(500).json({ error: "Failed to list log entries." });
  }
});

// GET /api/logs/:id
// Single-row fetch, used by the dashboard's History detail view (the
// "full summary" click-through page) to load the complete notes/summary
// text for one row. Unauthenticated, same as GET /api/logs -- read-only.
// The list endpoint already returns every column for rows it includes,
// so this route exists purely so the detail view can load a row directly
// (e.g. a bookmarked/shared #/history/:id link, or a row from an older
// page the client hasn't fetched) without re-fetching a whole history
// page just to find one id.
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "id must be a positive integer." });
  }

  try {
    const pool = getPool();
    const result = await pool.query(`SELECT * FROM subagent_logs WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("[GET /api/logs/:id] error:", err.message);
    return res.status(500).json({ error: "Failed to fetch log entry." });
  }
});

export default router;
