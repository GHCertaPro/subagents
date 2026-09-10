# Subagents Dashboard (frontend)

Static frontend for the subagent-lifecycle backend in this repo. Plain
HTML/CSS/vanilla JS — no build step, no framework, no dependencies. It is a
**read-only consumer** of `GET /api/logs`; it never calls `POST`/`PATCH` and
never needs the backend's `API_KEY`.

This is now **two separate pages**, not a single-page client-side toggle:

- **`index.html`, served at `/`** — the **Live** page, and the app's
  homepage/default route. Shows ONLY currently running + queued
  subagents.
- **`history.html`, served at `/history`** — the **History** page. Shows
  ONLY completed (`done`) and failed/cancelled past runs.

Both pages share the same `<nav>` (Live / History links) so you can move
between them, and both load the same `dashboard/app.js`, which gates its
two init paths on which page's unique DOM elements are present (see the
file-level comment at the top of `app.js`). `server/index.js` is what
maps the `/history` URL to `history.html` (`/` and everything else still
falls through to `index.html`, unchanged).

## What it shows

### Live (`/`)

- **Currently Running** — a fixed grid of exactly **3 slots**, mirroring
  this project's real max-3-concurrent-subagent cap. Each populated slot
  shows a task with `status: 'running'` (i.e. `started_at` set,
  `ended_at` null) and how long it's been running, updating every 5s.
  Empty slots render as a styled "No task running" placeholder — the
  layout is always exactly 3 slots, never fewer/more.
- **Queued** — a variable-length list below it, one row per task with
  `status: 'queued'` (`started_at` still null), showing when it was
  queued and how long it's been waiting, updating once a minute.

The Live page polls `GET /api/logs?status=queued,running&limit=100` every
15 seconds and re-renders both sections from the fresh response.
Elapsed-time text is recomputed from the in-memory ISO timestamps on its
own `setInterval` timers, independent of the poll cycle, so counters tick
smoothly between polls.

### History (`/history`)

- The 50 most-recent terminal-status (`done`/`failed`/`cancelled`) runs,
  newest-first, with a **Load More** button that fetches 25 more at a
  time via real server-side offset pagination (`GET
  /api/logs?status=done,failed,cancelled&order_by=ended_at&limit=...&offset=...`).
  Loaded once when the page opens — no polling timer, since finished runs
  don't change.
- Each row shows a brief one-sentence hover tooltip (native `title`
  attribute) and is clickable through to a full detail page
  (`history-detail.html?id=<id>`) with the complete notes/summary text.

## Running it

No server-side rendering or build step required — it's static files.

**Option A — open directly:**

```bash
open dashboard/index.html   # or just double-click it
```

Note: some browsers restrict `fetch()` from `file://` pages. If you hit
that, use option B instead.

**Option B — serve it with any static file server**, e.g.:

```bash
cd dashboard
python3 -m http.server 8080
# then open http://localhost:8080/
```

Or any static host (GitHub Pages, Netlify, S3+CloudFront, etc.) — just
publish the contents of this `dashboard/` directory.

## Pointing it at a backend

The backend API base URL is **not hardcoded** to one deployment — it's
resolved in `dashboard/config.js`, in this priority order:

1. **Query param**: open the dashboard with `?api=<url>`, e.g.
   `http://localhost:8080/?api=https://your-backend.example.com`
   (no trailing slash needed — it's stripped automatically). This also
   saves the value to `localStorage` so subsequent loads without the
   query param remember it.
2. **`localStorage`**: previously-saved value under the key
   `subagents_api_base`. Set/clear manually from the browser console:
   ```js
   localStorage.setItem("subagents_api_base", "https://your-backend.example.com");
   localStorage.removeItem("subagents_api_base"); // reset to default
   ```
3. **Default**: `http://localhost:3000`, hardcoded as `DEFAULT_API_BASE` at
   the top of `dashboard/config.js` — this documented local-dev default is
   used because as of this writing the backend has not yet been deployed
   to a public host. **When you deploy the backend for real, update
   `DEFAULT_API_BASE` in `config.js`** (or just always pass `?api=...`).

## Why no framework

This is a small internal tool: one poll loop, two render functions, no
routing, no state management complexity. Plain JS keeps it trivially
auditable and removes any build/toolchain dependency for a static page
that just needs to run in a browser.

## Known gaps

- The backend has no `DELETE /api/logs/:id` route as of this writing, so
  there's no way to remove old/test rows from the dashboard or via the
  API. Test rows inserted during development/verification were prefixed
  `test_dashboard_verify_` to make them easy to spot and ignore (or
  manually delete via direct DB access) until a delete route exists.
