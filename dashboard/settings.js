// dashboard/settings.js
//
// Script for the Settings page (/settings → dashboard/settings.html).
// - Checks JWT auth (redirects to /login if missing)
// - Calls GET /api/auth/me to get live user info (email, role)
// - Populates the settings fields
// - Wires the Sign Out button
// - Rewrites nav links to preserve the per-bot DASHBOARD_TOKEN query param

// ── Token resolution (per-bot API key, optional) ──────────────────────────────
// Same pattern as app.js so clicking nav links back to Live/History
// preserves ?token= in the URL.
const SESSION_KEY = "subagents_dashboard_token";

function resolveToken() {
  const urlParam = new URLSearchParams(window.location.search).get("token");
  if (urlParam && urlParam.trim()) {
    sessionStorage.setItem(SESSION_KEY, urlParam.trim());
    return urlParam.trim();
  }
  return sessionStorage.getItem(SESSION_KEY) || null;
}

const DASHBOARD_TOKEN = resolveToken();

// Inject token into nav links so it persists when navigating away.
if (DASHBOARD_TOKEN) {
  document.querySelectorAll("a.nav-link").forEach((a) => {
    try {
      const url = new URL(a.href, window.location.origin);
      url.searchParams.set("token", DASHBOARD_TOKEN);
      a.href = url.toString();
    } catch (_) {}
  });
}

// ── Work Sessions helpers ────────────────────────────────────────────────────

/** Format minutes into "Xh Ym" or "Ym" or "—" */
function fmtMinutes(mins) {
  if (mins == null || mins === 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Format total minutes into "Xh Ym" for stat boxes */
function fmtHours(totalMins) {
  if (totalMins == null) return "—";
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Get Monday 00:00:00 of the current week in local time, as a Date */
function getMondayOfWeek() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon …
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

/** Get first day of current month 00:00:00, as a Date */
function getFirstOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

/** Format ISO string to "9:00 AM" */
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Format ISO string to "Mon Sep 23" */
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ── Work Sessions state ───────────────────────────────────────────────────────
let wsOffset = 0;
const WS_LIMIT = 50;
let wsTotal = 0;
let wsAllEntries = []; // accumulated for week/month stats

async function loadWorkSessions(jwt, reset = false) {
  if (reset) {
    wsOffset = 0;
    wsAllEntries = [];
    const tbody = document.getElementById("ws-table-body");
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="color:#555;font-style:italic;padding:12px;">Loading…</td></tr>';
  }

  try {
    const res = await fetch(
      `${window.SUBAGENTS_API_BASE}/api/time/entries?limit=${WS_LIMIT}&offset=${wsOffset}`,
      { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
    );

    if (res.status === 401) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    wsTotal = data.total;
    wsAllEntries = wsAllEntries.concat(data.entries || []);
    wsOffset += data.entries.length;

    renderWorkSessions(data.entries, reset);
    computeAndRenderStats();

    const loadMoreBtn = document.getElementById("ws-load-more");
    if (loadMoreBtn) {
      if (wsOffset < wsTotal) {
        loadMoreBtn.style.display = "";
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = `Load More (${wsTotal - wsOffset} remaining)`;
      } else {
        loadMoreBtn.style.display = "none";
      }
    }
  } catch (err) {
    const tbody = document.getElementById("ws-table-body");
    if (tbody && reset) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:#a33;">Failed to load: ${err.message}</td></tr>`;
    }
  }
}

function renderWorkSessions(entries, reset) {
  const tbody = document.getElementById("ws-table-body");
  if (!tbody) return;

  if (reset) tbody.innerHTML = "";

  if (!entries || entries.length === 0) {
    if (reset) tbody.innerHTML = '<tr><td colspan="4" style="color:#555;font-style:italic;padding:12px;">No sessions recorded yet.</td></tr>';
    return;
  }

  const rows = entries.map((e) => {
    const isOpen = !e.clocked_out;
    const dur = isOpen ? '&mdash;' : fmtMinutes(e.duration_minutes);
    const clockOut = isOpen ? '<span style="color:#9fdc9f;">working&hellip;</span>' : fmtTime(e.clocked_out);
    return `<tr class="${isOpen ? 'open-entry' : ''}">
      <td>${fmtDate(e.clocked_in)}</td>
      <td>${fmtTime(e.clocked_in)}</td>
      <td>${clockOut}</td>
      <td>${dur}</td>
    </tr>`;
  });
  tbody.insertAdjacentHTML("beforeend", rows.join(""));
}

function computeAndRenderStats() {
  const monday = getMondayOfWeek();
  const firstOfMonth = getFirstOfMonth();

  let weekMins = 0;
  let monthMins = 0;

  for (const e of wsAllEntries) {
    if (!e.clocked_out || e.duration_minutes == null) continue;
    const d = new Date(e.clocked_in);
    if (d >= monday) weekMins += e.duration_minutes;
    if (d >= firstOfMonth) monthMins += e.duration_minutes;
  }

  const weekEl = document.getElementById("ws-hours-week");
  const monthEl = document.getElementById("ws-hours-month");
  if (weekEl) weekEl.textContent = fmtHours(weekMins);
  if (monthEl) monthEl.textContent = fmtHours(monthMins);
}

// ── Auth gate + page init ─────────────────────────────────────────────────────
(async function init() {
  const jwtToken = localStorage.getItem("__auth_token");
  if (!jwtToken) {
    window.location.replace("/login");
    return;
  }

  const emailEl = document.getElementById("settings-email");
  const roleEl = document.getElementById("settings-role");
  const errorBanner = document.getElementById("error-banner");

  // Wire logout button
  document.getElementById("logout-btn").addEventListener("click", () => {
    localStorage.removeItem("__auth_token");
    localStorage.removeItem("__auth_user");
    window.location.replace("/login");
  });

  // Fetch live user info from /api/auth/me
  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
      cache: "no-store",
    });

    if (res.status === 401) {
      // Token expired or invalid — clear and redirect to login
      localStorage.removeItem("__auth_token");
      localStorage.removeItem("__auth_user");
      window.location.replace("/login");
      return;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const user = await res.json();
    if (emailEl) emailEl.textContent = user.email || "—";
    if (roleEl) roleEl.textContent = user.role || "—";

    // Keep cached user data in sync
    try {
      localStorage.setItem("__auth_user", JSON.stringify({ email: user.email, role: user.role }));
    } catch (_) {}

  } catch (err) {
    if (errorBanner) {
      errorBanner.textContent = `Failed to load account info: ${err.message}`;
      errorBanner.classList.add("visible");
    }
    // Fall back to cached data if available
    try {
      const cached = JSON.parse(localStorage.getItem("__auth_user") || "{}");
      if (cached.email && emailEl) emailEl.textContent = cached.email;
      if (cached.role && roleEl) roleEl.textContent = cached.role;
    } catch (_) {}
  }

  // ── Work Sessions ──────────────────────────────────────────────────────────
  // Load work sessions even if account info fetch failed; jwtToken is still valid.
  await loadWorkSessions(jwtToken, true);

  // Wire Load More button
  const loadMoreBtn = document.getElementById("ws-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", async () => {
      loadMoreBtn.disabled = true;
      await loadWorkSessions(jwtToken, false);
    });
  }
})();
