// dashboard/time-tracker.js
//
// Clock-in / clock-out time tracker widget for the Live dashboard (index.html).
// Loaded after app.js; reads JWT from localStorage and uses window.SUBAGENTS_API_BASE
// from config.js.
//
// Layout: two-column section at the bottom of the live view.
//   Left:  large Clock In / Clock Out button + live elapsed counter.
//   Right: scrollable list of recent time entries (newest first).

(function () {
  "use strict";

  const API = window.SUBAGENTS_API_BASE || "";

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getJwt() {
    return localStorage.getItem("__auth_token") || null;
  }

  function authHeaders() {
    const jwt = getJwt();
    return jwt ? { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" } : {};
  }

  /** Format a Date to "Mon Sep 23 | 9:00 AM" style. */
  function fmtDatetime(dt) {
    if (!dt) return "—";
    const d = typeof dt === "string" ? new Date(dt) : dt;
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${day} | ${time}`;
  }

  /** Format minutes (integer) into "Xh Ym" or "Ym". */
  function fmtMinutes(mins) {
    if (mins == null) return "";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  }

  /** Compute elapsed minutes between a Date and now. */
  function elapsedMins(from) {
    return Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 60000));
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let clockedInEntry = null; // null or { id, clocked_in, ... } if open
  let elapsedTimer = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const btnEl = document.getElementById("clock-btn");
  const elapsedEl = document.getElementById("clock-elapsed");
  const listEl = document.getElementById("time-entries-list");

  if (!btnEl || !listEl) return; // section not present — bail

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderButton() {
    if (clockedInEntry) {
      btnEl.textContent = "🔴 Clock Out";
      btnEl.className = "clock-btn clock-out";
    } else {
      btnEl.textContent = "🟢 Clock In";
      btnEl.className = "clock-btn clock-in";
    }
    btnEl.disabled = false;
  }

  function startElapsedTick() {
    stopElapsedTick();
    if (!clockedInEntry) {
      elapsedEl.style.display = "none";
      return;
    }
    function tick() {
      const mins = elapsedMins(clockedInEntry.clocked_in);
      elapsedEl.textContent = `Working for ${fmtMinutes(mins)}`;
      elapsedEl.style.display = "";
    }
    tick();
    elapsedTimer = setInterval(tick, 60000);
  }

  function stopElapsedTick() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    elapsedEl.style.display = "none";
  }

  function renderEntries(entries) {
    if (!entries || entries.length === 0) {
      listEl.innerHTML = '<div class="time-entries-empty">No time entries yet.</div>';
      return;
    }
    listEl.innerHTML = entries
      .map((e) => {
        const isOpen = !e.clocked_out;
        const start = fmtDatetime(e.clocked_in);
        const end = isOpen ? "working…" : fmtDatetime(e.clocked_out).split(" | ")[1];
        const dur = isOpen ? fmtMinutes(elapsedMins(e.clocked_in)) : fmtMinutes(e.duration_minutes);
        const dateLabel = new Date(e.clocked_in).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        return `<div class="time-entry-row${isOpen ? " open" : ""}">
          <strong>${dateLabel}</strong> &nbsp;${start.split(" | ")[1] || "?"} → ${end} <span style="color:#888;">(${dur})</span>
        </div>`;
      })
      .join("");
  }

  // ── API calls ──────────────────────────────────────────────────────────────

  async function loadStatus() {
    try {
      const res = await fetch(`${API}/api/time/status`, { headers: authHeaders() });
      if (res.status === 401) return; // not logged in — tracker hidden or silent
      if (!res.ok) return;
      const data = await res.json();
      clockedInEntry = data.clocked_in ? data.entry : null;
      renderButton();
      startElapsedTick();
    } catch (_) {
      // ignore network errors silently for this widget
    }
  }

  async function loadEntries() {
    try {
      const res = await fetch(`${API}/api/time/entries?limit=20`, { headers: authHeaders() });
      if (res.status === 401) {
        listEl.innerHTML = '<div class="time-entries-empty">Sign in to track time.</div>';
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      renderEntries(data.entries);
    } catch (_) {
      listEl.innerHTML = '<div class="time-entries-empty">Could not load entries.</div>';
    }
  }

  async function clockIn() {
    btnEl.disabled = true;
    try {
      const res = await fetch(`${API}/api/time/clock-in`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.status === 409) {
        // Already clocked in — re-sync state
        await loadStatus();
        await loadEntries();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Clock-in failed: ${err.error || res.status}`);
        btnEl.disabled = false;
        return;
      }
      const entry = await res.json();
      clockedInEntry = entry;
      renderButton();
      startElapsedTick();
      await loadEntries();
    } catch (e) {
      alert(`Clock-in error: ${e.message}`);
      btnEl.disabled = false;
    }
  }

  async function clockOut() {
    btnEl.disabled = true;
    try {
      const res = await fetch(`${API}/api/time/clock-out`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.status === 409) {
        // Not clocked in — re-sync state
        clockedInEntry = null;
        renderButton();
        stopElapsedTick();
        await loadEntries();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Clock-out failed: ${err.error || res.status}`);
        btnEl.disabled = false;
        return;
      }
      clockedInEntry = null;
      renderButton();
      stopElapsedTick();
      await loadEntries();
    } catch (e) {
      alert(`Clock-out error: ${e.message}`);
      btnEl.disabled = false;
    }
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  btnEl.addEventListener("click", () => {
    if (clockedInEntry) {
      clockOut();
    } else {
      clockIn();
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  // Only activate if JWT is present (user is logged in)
  if (!getJwt()) {
    listEl.innerHTML = '<div class="time-entries-empty">Sign in to track time.</div>';
    btnEl.disabled = true;
    return;
  }

  loadStatus();
  loadEntries();
})();
