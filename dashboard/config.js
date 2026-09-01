// dashboard/config.js
//
// Points the dashboard at a backend API base URL. Resolution order
// (first match wins):
//
//   1. `?api=` query param on the dashboard's own URL, e.g.
//      https://your-dashboard-host/dashboard/?api=https://your-backend.example.com
//      (also persists the value to localStorage so you don't have to pass
//      it on every load)
//   2. A previously-saved value in localStorage (key: "subagents_api_base"),
//      set automatically by step 1, or settable manually from the browser
//      console: `localStorage.setItem("subagents_api_base", "https://...")`
//   3. The DEFAULT_API_BASE constant below.
//
// See dashboard/README.md for details on repointing this at a deployed
// backend URL later.

// When the dashboard is served from the SAME origin as the backend (e.g.
// Railway serving both dashboard/ and /api/logs from one service), default
// to same-origin (empty string -> relative URLs) instead of localhost.
// Falls back to localhost:3000 only when opened directly from a file://
// or a dev server on a different port than the backend.
const DEFAULT_API_BASE =
  window.location.protocol === "http:" || window.location.protocol === "https:"
    ? (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:3000"
        : "")
    : "http://localhost:3000";

function resolveApiBase() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("api");
  if (fromQuery) {
    try {
      localStorage.setItem("subagents_api_base", fromQuery);
    } catch (_) {
      // localStorage unavailable (e.g. file:// in some browsers) — ignore.
    }
    return fromQuery.replace(/\/$/, "");
  }

  try {
    const fromStorage = localStorage.getItem("subagents_api_base");
    if (fromStorage) return fromStorage.replace(/\/$/, "");
  } catch (_) {
    // ignore
  }

  return DEFAULT_API_BASE.replace(/\/$/, "");
}

// Exposed as a global for app.js (no build step / bundler for this small tool).
window.SUBAGENTS_API_BASE = resolveApiBase();
