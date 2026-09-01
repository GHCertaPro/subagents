# Subagents Dashboard (frontend)

Static frontend for the subagent-lifecycle backend in this repo. Plain
HTML/CSS/vanilla JS — no build step, no framework, no dependencies. It is a
**read-only consumer** of `GET /api/logs`; it never calls `POST`/`PATCH` and
never needs the backend's `API_KEY`.

## What it shows

- **Currently Running** — a fixed grid of exactly **3 slots**, mirroring
  this project's real max-3-concurrent-subagent cap. Each populated slot
  shows a task with `status: 'running'` (i.e. `started_at` set,
  `ended_at` null) and how long it's been running, updating every second.
  Empty slots render as a styled "No task running" placeholder — the
  layout is always exactly 3 slots, never fewer/more.
- **Queued** — a variable-length list below it, one row per task with
  `status: 'queued'` (`started_at` still null), showing when it was
  queued and how long it's been waiting, also updating every second.

The page polls `GET /api/logs?limit=50` every 4 seconds and re-renders both
sections from the fresh response. Elapsed-time text is recomputed from the
in-memory ISO timestamps every second via `setInterval`, independent of the
poll cycle, so counters tick smoothly between polls.

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
