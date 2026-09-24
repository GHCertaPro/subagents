// dashboard/settings.js
//
// Script for the Settings page (/settings → dashboard/settings.html).
// - Checks JWT auth (redirects to /login if missing)
// - Calls GET /api/auth/me to get live user info (email, role)
// - Populates the settings fields
// - Wires the Sign Out button
// - Work Sessions: list, inline edit, inline delete, manual add, stats
// - Rewrites nav links to preserve the per-bot DASHBOARD_TOKEN query param

// ── Token resolution (per-bot API key, optional) ──────────────────────────────
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

/** Get Monday 00:00:00 of the current week in local time */
function getMondayOfWeek() {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

/** Get first day of current month 00:00:00 */
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

/** Convert ISO string to datetime-local input value (local time, no seconds) */
function toDatetimeLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Work Sessions state ───────────────────────────────────────────────────────
let wsOffset = 0;
const WS_LIMIT = 50;
let wsTotal = 0;
let wsAllEntries = []; // accumulated for week/month stats
let wsEntriesMap = {}; // id (string) → entry object, for quick row re-render

// ── Row rendering ─────────────────────────────────────────────────────────────

/** Build HTML for one table row and register it in wsEntriesMap */
function renderEntryRow(e) {
  const id = String(e.id);
  wsEntriesMap[id] = e;
  const isOpen = !e.clocked_out;
  const dur = isOpen ? "&mdash;" : fmtMinutes(e.duration_minutes);
  const clockOut = isOpen
    ? '<span style="color:#9fdc9f;">working&hellip;</span>'
    : fmtTime(e.clocked_out);
  return `<tr data-id="${id}" class="${isOpen ? "open-entry" : ""}">
    <td>${fmtDate(e.clocked_in)}</td>
    <td>${fmtTime(e.clocked_in)}</td>
    <td>${clockOut}</td>
    <td>${dur}</td>
    <td class="ws-actions-cell">
      <button class="ws-act-btn" data-action="edit" data-id="${id}" title="Edit">Edit</button>
      <button class="ws-act-btn ws-act-btn--del" data-action="delete" data-id="${id}" title="Delete">Del</button>
    </td>
  </tr>`;
}

/** Replace a DOM row with fresh HTML (insert after, then remove old) */
function replaceRow(row, newHtml) {
  row.insertAdjacentHTML("afterend", newHtml);
  row.remove();
}

// ── Inline edit mode ──────────────────────────────────────────────────────────

function enterEditMode(row, id) {
  const entry = wsEntriesMap[id];
  if (!entry) return;
  row.innerHTML = `
    <td colspan="4">
      <div class="ws-edit-form">
        <label class="ws-edit-label">Clock In
          <input type="datetime-local" class="ws-dt-input" data-field="clocked_in"
                 value="${toDatetimeLocal(entry.clocked_in)}">
        </label>
        <label class="ws-edit-label">Clock Out
          <input type="datetime-local" class="ws-dt-input" data-field="clocked_out"
                 value="${toDatetimeLocal(entry.clocked_out)}">
        </label>
        <button class="ws-act-btn ws-act-btn--save" data-action="save-edit" data-id="${id}">Save</button>
        <button class="ws-act-btn" data-action="cancel-edit" data-id="${id}">Cancel</button>
        <span class="ws-inline-err"></span>
      </div>
    </td>
    <td></td>
  `;
  row.className = "ws-editing";
}

function exitEditMode(row, id) {
  const entry = wsEntriesMap[id];
  if (!entry) return;
  replaceRow(row, renderEntryRow(entry));
}

async function saveEdit(row, id, jwt) {
  const cinInput = row.querySelector('.ws-dt-input[data-field="clocked_in"]');
  const coutInput = row.querySelector('.ws-dt-input[data-field="clocked_out"]');
  const errEl = row.querySelector(".ws-inline-err");

  const cin = cinInput?.value || "";
  const cout = coutInput?.value || "";

  const setErr = (msg) => { if (errEl) errEl.textContent = msg; };
  setErr("");

  if (!cin) { setErr("Clock In is required."); return; }

  const cinDate = new Date(cin);
  const coutDate = cout ? new Date(cout) : null;

  if (isNaN(cinDate.getTime())) { setErr("Invalid Clock In date."); return; }
  if (coutDate && isNaN(coutDate.getTime())) { setErr("Invalid Clock Out date."); return; }
  if (coutDate && coutDate <= cinDate) { setErr("Clock Out must be after Clock In."); return; }

  const body = {
    clocked_in: cinDate.toISOString(),
    clocked_out: coutDate ? coutDate.toISOString() : null,
  };

  row.querySelectorAll("button").forEach((b) => (b.disabled = true));

  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/time/entries/${id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      row.querySelectorAll("button").forEach((b) => (b.disabled = false));
      setErr(errData.error || "Failed to save.");
      return;
    }

    const updated = await res.json();

    // Sync state
    const idx = wsAllEntries.findIndex((e) => String(e.id) === id);
    if (idx !== -1) wsAllEntries[idx] = updated;
    wsEntriesMap[id] = updated;

    replaceRow(row, renderEntryRow(updated));
    computeAndRenderStats();
  } catch (err) {
    row.querySelectorAll("button").forEach((b) => (b.disabled = false));
    setErr(err.message);
  }
}

// ── Inline delete mode ────────────────────────────────────────────────────────

function enterDeleteMode(row, id) {
  row.innerHTML = `
    <td colspan="4" class="ws-delete-confirm">
      Delete this session?&nbsp;
      <button class="ws-act-btn ws-act-btn--yes" data-action="confirm-delete" data-id="${id}">Yes</button>
      <button class="ws-act-btn" data-action="cancel-delete" data-id="${id}">No</button>
    </td>
    <td></td>
  `;
  row.className = "ws-confirming-delete";
}

function exitDeleteMode(row, id) {
  const entry = wsEntriesMap[id];
  if (!entry) return;
  replaceRow(row, renderEntryRow(entry));
}

async function confirmDelete(row, id, jwt) {
  row.querySelectorAll("button").forEach((b) => (b.disabled = true));

  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/time/entries/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      row.querySelectorAll("button").forEach((b) => (b.disabled = false));
      alert(errData.error || "Failed to delete.");
      return;
    }

    // Sync state
    const idx = wsAllEntries.findIndex((e) => String(e.id) === id);
    if (idx !== -1) wsAllEntries.splice(idx, 1);
    delete wsEntriesMap[id];
    if (wsTotal > 0) wsTotal--;

    row.remove();

    // Show empty state if no data rows remain and no more to load
    const tbody = document.getElementById("ws-table-body");
    if (tbody && tbody.querySelectorAll("tr[data-id]").length === 0 && wsOffset >= wsTotal) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="color:#555;font-style:italic;padding:12px;">No sessions recorded yet.</td></tr>';
    }

    computeAndRenderStats();
  } catch (err) {
    row.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}

// ── Add Entry form ────────────────────────────────────────────────────────────

function showAddForm() {
  const form = document.getElementById("ws-add-form");
  if (form) {
    form.style.display = "";
    // Pre-fill clock-in with current time if empty
    const cinInput = document.getElementById("ws-add-clock-in");
    if (cinInput && !cinInput.value) {
      cinInput.value = toDatetimeLocal(new Date().toISOString());
    }
  }
  const btn = document.getElementById("ws-add-entry-btn");
  if (btn) btn.style.display = "none";
}

function hideAddForm() {
  const form = document.getElementById("ws-add-form");
  if (form) {
    form.style.display = "none";
    form.querySelectorAll("input[type=datetime-local]").forEach((i) => (i.value = ""));
    const errEl = form.querySelector(".ws-add-err");
    if (errEl) errEl.textContent = "";
  }
  const btn = document.getElementById("ws-add-entry-btn");
  if (btn) btn.style.display = "";
}

async function submitAddForm(jwt) {
  const form = document.getElementById("ws-add-form");
  const errEl = form?.querySelector(".ws-add-err");
  const setErr = (msg) => { if (errEl) errEl.textContent = msg; };
  setErr("");

  const cin = document.getElementById("ws-add-clock-in")?.value || "";
  const cout = document.getElementById("ws-add-clock-out")?.value || "";

  if (!cin || !cout) { setErr("Both Clock In and Clock Out are required."); return; }

  const cinDate = new Date(cin);
  const coutDate = new Date(cout);

  if (isNaN(cinDate.getTime())) { setErr("Invalid Clock In date."); return; }
  if (isNaN(coutDate.getTime())) { setErr("Invalid Clock Out date."); return; }
  if (coutDate <= cinDate) { setErr("Clock Out must be after Clock In."); return; }

  const submitBtn = document.getElementById("ws-add-submit");
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/time/entries/manual`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clocked_in: cinDate.toISOString(), clocked_out: coutDate.toISOString() }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      setErr(errData.error || "Failed to add entry.");
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    const newEntry = await res.json();

    // Insert into wsAllEntries at correct position (newest first)
    const newDate = new Date(newEntry.clocked_in);
    const insertIdx = wsAllEntries.findIndex((e) => new Date(e.clocked_in) < newDate);
    if (insertIdx === -1) {
      wsAllEntries.push(newEntry);
    } else {
      wsAllEntries.splice(insertIdx, 0, newEntry);
    }
    wsTotal++;

    // Insert row into table in chronological order (newest first)
    const tbody = document.getElementById("ws-table-body");
    if (tbody) {
      // Remove placeholder row if present
      const placeholder = tbody.querySelector("tr:not([data-id])");
      if (placeholder) placeholder.remove();

      const newRowHtml = renderEntryRow(newEntry);
      const existingRows = Array.from(tbody.querySelectorAll("tr[data-id]"));
      const insertBefore = existingRows.find((r) => {
        const e = wsEntriesMap[r.dataset.id];
        return e && new Date(e.clocked_in) < newDate;
      });

      if (insertBefore) {
        insertBefore.insertAdjacentHTML("beforebegin", newRowHtml);
      } else {
        tbody.insertAdjacentHTML("beforeend", newRowHtml);
      }
    }

    computeAndRenderStats();
    hideAddForm();
  } catch (err) {
    setErr(err.message);
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ── Load + render work sessions ───────────────────────────────────────────────

async function loadWorkSessions(jwt, reset = false) {
  if (reset) {
    wsOffset = 0;
    wsAllEntries = [];
    wsEntriesMap = {};
    const tbody = document.getElementById("ws-table-body");
    if (tbody)
      tbody.innerHTML =
        '<tr><td colspan="5" style="color:#555;font-style:italic;padding:12px;">Loading\u2026</td></tr>';
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
      tbody.innerHTML = `<tr><td colspan="5" style="color:#a33;">Failed to load: ${err.message}</td></tr>`;
    }
  }
}

function renderWorkSessions(entries, reset) {
  const tbody = document.getElementById("ws-table-body");
  if (!tbody) return;

  if (reset) tbody.innerHTML = "";

  if (!entries || entries.length === 0) {
    if (reset)
      tbody.innerHTML =
        '<tr><td colspan="5" style="color:#555;font-style:italic;padding:12px;">No sessions recorded yet.</td></tr>';
    return;
  }

  const rows = entries.map((e) => renderEntryRow(e));
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

  // Wire logout
  document.getElementById("logout-btn").addEventListener("click", () => {
    localStorage.removeItem("__auth_token");
    localStorage.removeItem("__auth_user");
    window.location.replace("/login");
  });

  // Fetch live user info
  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
      cache: "no-store",
    });

    if (res.status === 401) {
      localStorage.removeItem("__auth_token");
      localStorage.removeItem("__auth_user");
      window.location.replace("/login");
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const user = await res.json();
    if (emailEl) emailEl.textContent = user.email || "—";
    if (roleEl) roleEl.textContent = user.role || "—";

    try {
      localStorage.setItem("__auth_user", JSON.stringify({ email: user.email, role: user.role }));
    } catch (_) {}
  } catch (err) {
    if (errorBanner) {
      errorBanner.textContent = `Failed to load account info: ${err.message}`;
      errorBanner.classList.add("visible");
    }
    try {
      const cached = JSON.parse(localStorage.getItem("__auth_user") || "{}");
      if (cached.email && emailEl) emailEl.textContent = cached.email;
      if (cached.role && roleEl) roleEl.textContent = cached.role;
    } catch (_) {}
  }

  // ── Work Sessions ──────────────────────────────────────────────────────────
  await loadWorkSessions(jwtToken, true);

  // Wire Load More
  const loadMoreBtn = document.getElementById("ws-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", async () => {
      loadMoreBtn.disabled = true;
      await loadWorkSessions(jwtToken, false);
    });
  }

  // Wire Add Entry button
  document.getElementById("ws-add-entry-btn")?.addEventListener("click", showAddForm);

  // Wire Add Entry form
  document.getElementById("ws-add-submit")?.addEventListener("click", () => submitAddForm(jwtToken));
  document.getElementById("ws-add-cancel")?.addEventListener("click", hideAddForm);

  // Wire table body via event delegation (survives innerHTML clears on the tbody children)
  const tbody = document.getElementById("ws-table-body");
  if (tbody) {
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const row = tbody.querySelector(`tr[data-id="${id}"]`);

      switch (action) {
        case "edit":           if (row) enterEditMode(row, id); break;
        case "cancel-edit":    if (row) exitEditMode(row, id); break;
        case "save-edit":      if (row) saveEdit(row, id, jwtToken); break;
        case "delete":         if (row) enterDeleteMode(row, id); break;
        case "cancel-delete":  if (row) exitDeleteMode(row, id); break;
        case "confirm-delete": if (row) confirmDelete(row, id, jwtToken); break;
      }
    });
  }
})();
