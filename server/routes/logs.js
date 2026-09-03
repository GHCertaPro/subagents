// server/routes/logs.js
//
// CRUD-ish routes for subagent_logs. Kept intentionally small: this is a
// backend for a future dashboard, not a general-purpose API.

import { Router } from "express";
import { getPool } from "../db.js";
import { requireApiKey } from "../auth.js";

const router = Router();

const VALID_STATUSES = ["queued", "running", "done", "failed", "cancelled"];

// POST /api/logs
// Create a new log entry. Can represent a task being queued
// (status defaults to "queued", started_at omitted) or a task that is
// starting immediately (pass status: "running", started_at: <iso>).
router.post("/", requireApiKey, async (req, res) => {
  const { task_name, status, queued_at, started_at, notes, summary, requested_by, metadata } =
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

  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO subagent_logs
         (task_name, status, queued_at, started_at, notes, summary, requested_by, metadata)
       VALUES
         ($1, $2, COALESCE($3, now()), $4, $5, $6, $7, COALESCE($8, '{}'::jsonb))
       RETURNING *`,
      [
        task_name,
        finalStatus,
        queued_at ?? null,
        started_at ?? null,
        notes ?? null,
        summary ?? null,
        requested_by ?? null,
        metadata ? JSON.stringify(metadata) : null,
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
  if (notes !== undefined) set("notes", notes);
  if (summary !== undefined) set("summary", summary);
  if (requested_by !== undefined) set("requested_by", requested_by);
  if (metadata !== undefined) set("metadata", JSON.stringify(metadata));

  if (fields.length === 0) {
    return res.status(400).json({ error: "No updatable fields provided." });
  }

  values.push(id);

  try {
    const pool = getPool();
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
// List entries for a future dashboard. Supports:
//   ?status=running          filter by exact status
//   ?limit=50                cap result count (default 50, max 500)
//   ?task_name=foo           filter by exact task_name
router.get("/", async (req, res) => {
  const { status, task_name } = req.query;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;

  const clauses = [];
  const values = [];
  let i = 1;

  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }
    clauses.push(`status = $${i++}`);
    values.push(status);
  }

  if (task_name !== undefined) {
    clauses.push(`task_name = $${i++}`);
    values.push(task_name);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(limit);

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM subagent_logs ${where} ORDER BY queued_at DESC LIMIT $${i}`,
      values
    );
    return res.json({ count: result.rowCount, logs: result.rows });
  } catch (err) {
    console.error("[GET /api/logs] error:", err.message);
    return res.status(500).json({ error: "Failed to list log entries." });
  }
});

export default router;
