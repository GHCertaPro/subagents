# subagents

Backend service that stores subagent lifecycle log data (task name, queued/start/end
timestamps, status, notes) in a Neon Postgres database. This replaces the
Google-Sheets-based "SubLogs" tracking method with a real database and a small
HTTP API, intended as the backend for a future dashboard website showing
subagent progress. **This repo is backend-only** — no dashboard UI lives here.

This is a brand-new, standalone service. It does **not** share a database
with, connect to, or reference any other project's Neon instance.

## Stack

- **Node.js + Express** — chosen over Fastify purely for familiarity/ubiquity;
  either would work fine for a service this small. Express has the larger
  ecosystem and simplest mental model for a handful of CRUD routes.
- **pg** (node-postgres) — direct SQL, no ORM. Keeps the schema/migrations
  explicit and easy to reason about for a small table.
- **Neon Postgres** — serverless Postgres, connected via a standard
  `DATABASE_URL` connection string (SSL required).

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in real values:

   ```bash
   cp .env.example .env
   ```

   - `DATABASE_URL` — a Neon Postgres connection string for a database
     dedicated to this service (create a new Neon project/database — do not
     reuse another project's database). Format:
     `postgresql://user:password@host/db?sslmode=require`
   - `API_KEY` — a shared secret required in the `x-api-key` header on
     write routes (`POST`/`PATCH`). Generate one with e.g. `openssl rand -hex 32`.
   - `PORT` — optional, defaults to `3000`.

3. Run the migration to create the `subagent_logs` table:

   ```bash
   npm run migrate
   ```

   This is idempotent — it tracks applied migrations in a `schema_migrations`
   table and skips ones already run.

4. Start the server:

   ```bash
   npm start
   ```

   For local development with auto-restart on file changes:

   ```bash
   npm run dev
   ```

If `DATABASE_URL` or `API_KEY` is not set, the server prints a clear startup
error and exits (no crash/stack trace).

## Schema

See `server/migrations/001_create_subagent_logs.sql`. Summary of the
`subagent_logs` table:

| Column         | Type          | Notes                                                              |
|----------------|---------------|---------------------------------------------------------------------|
| `id`           | bigserial PK  |                                                                     |
| `task_name`    | text          | required                                                            |
| `queued_at`    | timestamptz   | defaults to `now()` — when the task was queued/spawned              |
| `started_at`   | timestamptz   | nullable — filled in when the subagent actually starts running      |
| `ended_at`     | timestamptz   | nullable — filled in on completion (success or failure)             |
| `status`       | text          | `queued` \| `running` \| `done` \| `failed` \| `cancelled`           |
| `notes`        | text          | free-text summary/result/error notes                                |
| `requested_by` | text          | which agent/session/requester spawned this task, if known           |
| `metadata`     | jsonb         | free-form bag for anything else (model used, token counts, links)   |
| `created_at`   | timestamptz   | row creation time                                                   |
| `updated_at`   | timestamptz   | auto-updated on every row update via trigger                        |

## API

All routes are rooted at `/api/logs`. `POST` and `PATCH` require an
`x-api-key` header matching the configured `API_KEY`; `GET` is unauthenticated
(read-only, intended to feed a dashboard).

### `POST /api/logs`

Create a new log entry — either at queue time or as an immediately-started task.

```bash
curl -X POST http://localhost:3000/api/logs \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"task_name": "example_task", "status": "queued"}'
```

Body fields: `task_name` (required, string), `status` (optional, one of
`queued|running|done|failed|cancelled`, defaults to `queued`), `queued_at`,
`started_at`, `notes`, `requested_by`, `metadata` (all optional).

### `PATCH /api/logs/:id`

Partially update an entry — e.g. fill in `started_at` on dequeue, or
`ended_at` + `status` on completion. Only fields present in the body are
updated.

```bash
curl -X PATCH http://localhost:3000/api/logs/1 \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"status": "done", "ended_at": "2026-08-31T21:00:00Z", "notes": "completed successfully"}'
```

### `GET /api/logs`

List entries, most recently queued first. Query params (all optional):

- `status` — filter by exact status
- `task_name` — filter by exact task name
- `limit` — max rows to return (default 50, max 500)

```bash
curl "http://localhost:3000/api/logs?status=running&limit=20"
```

### `GET /health`

Basic liveness check, no auth required.

## Project layout

```
server/
  index.js                 Express app entrypoint
  db.js                    pg Pool, reads DATABASE_URL
  auth.js                  shared-secret API key middleware
  migrate.js                migration runner
  migrations/
    001_create_subagent_logs.sql
  routes/
    logs.js                POST/PATCH/GET /api/logs
.env.example
package.json
```
