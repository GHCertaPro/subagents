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
})();
