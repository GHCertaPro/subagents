// dashboard/app.js
//
// Polls GET /api/logs on an interval and renders one of two views,
// switched by the Live/History toggle at the top of the page:
//   - "live": a fixed 3-slot "Currently Running" grid + variable-length
//     "Queued" list (the original default view)
//   - "history": all terminal-status (done/failed/cancelled) runs,
//     newest-first
//
// Both views are derived from the SAME single polled array (state.logs) --
// no separate fetch loop for History. FETCH_LIMIT was bumped from 50 to
// 200 specifically so that one poll cycle carries enough terminal-status
// rows to populate History too; GET /api/logs supports up to 500 and a
// plain LIMIT-based SELECT at this row count is trivial for Postgres, so
// reusing the existing 15s poll cadence at a higher limit was simpler and
// cheaper than adding a second endpoint/fetch loop or three separate
// status-filtered requests (the API only supports a single ?status= value
// per call, and terminal covers three statuses).
//
// Elapsed-time counters re-render once per minute from the ISO timestamps
// already in memory (no extra network calls needed for the ticking).

const POLL_INTERVAL_MS = 15000;
const TICK_INTERVAL_MS = 60000; // display-only cadence: queued "waiting X" text refreshes once/minute.
const RUNNING_TICK_INTERVAL_MS = 5000; // display-only cadence: running "elapsed X" text refreshes every 5s (Gabe's request, running-slots only).
const FETCH_LIMIT = 200; // was 50; raised so one shared poll also carries enough history for the History view.
const RUNNING_SLOTS = 3;
const TERMINAL_STATUSES = ["done", "failed", "cancelled"];

const state = {
  logs: [],
  lastFetchAt: null,
  lastError: null,
  view: "live", // "live" | "history"
};

const els = {
  apiBase: document.getElementById("api-base"),
  lastUpdated: document.getElementById("last-updated"),
  errorBanner: document.getElementById("error-banner"),
  runningGrid: document.getElementById("running-grid"),
  queuedList: document.getElementById("queued-list"),
  liveView: document.getElementById("live-view"),
  historyView: document.getElementById("history-view"),
  historyList: document.getElementById("history-list"),
  viewBtnLive: document.getElementById("view-btn-live"),
  viewBtnHistory: document.getElementById("view-btn-history"),
};

function setView(view) {
  state.view = view;
  const isHistory = view === "history";
  els.liveView.hidden = isHistory;
  els.historyView.hidden = !isHistory;
  els.viewBtnLive.classList.toggle("active", !isHistory);
  els.viewBtnHistory.classList.toggle("active", isHistory);
  els.viewBtnLive.setAttribute("aria-selected", String(!isHistory));
  els.viewBtnHistory.setAttribute("aria-selected", String(isHistory));
  render();
}

els.viewBtnLive.addEventListener("click", () => setView("live"));
els.viewBtnHistory.addEventListener("click", () => setView("history"));

els.apiBase.textContent = window.SUBAGENTS_API_BASE;

function formatElapsed(fromIso) {
  if (!fromIso) return "0s";
  const fromMs = new Date(fromIso).getTime();
  if (Number.isNaN(fromMs)) return "?";
  let deltaSec = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));

  const h = Math.floor(deltaSec / 3600);
  deltaSec -= h * 3600;
  const m = Math.floor(deltaSec / 60);
  const s = deltaSec - m * 60;

  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function isRunning(log) {
  // Per spec: status 'running' == started_at is set and ended_at is null.
  return log.status === "running" && !!log.started_at && !log.ended_at;
}

function isQueued(log) {
  // Per spec: status 'queued' == started_at is still null.
  return log.status === "queued" && !log.started_at;
}

function isTerminal(log) {
  // History view: any run that has finished one way or another.
  return TERMINAL_STATUSES.includes(log.status);
}

function formatTimestamp(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderRunningSlot(log) {
  const div = document.createElement("div");
  if (!log) {
    div.className = "slot-card empty";
    div.innerHTML = `<div class="empty-label">No task running</div>`;
    return div;
  }
  div.className = "slot-card active";
  const elapsed = formatElapsed(log.started_at);
  div.innerHTML = `
    <div class="task-name">${escapeHtml(log.task_name)}</div>
    <div class="elapsed" data-started-at="${escapeHtml(log.started_at)}">running ${elapsed}</div>
    <div class="sub-meta">${escapeHtml(log.requested_by || "")}</div>
  `;
  div.dataset.id = log.id;
  return div;
}

function renderQueuedRow(log) {
  const li = document.createElement("li");
  const waiting = formatElapsed(log.queued_at);
  const queuedAtLabel = log.queued_at ? new Date(log.queued_at).toLocaleString() : "unknown";
  li.innerHTML = `
    <span class="task-name">${escapeHtml(log.task_name)}</span>
    <span class="queued-at">queued ${escapeHtml(queuedAtLabel)}</span>
    <span class="waiting" data-queued-at="${escapeHtml(log.queued_at)}">waiting ${waiting}</span>
  `;
  li.dataset.id = log.id;
  return li;
}

function renderHistoryRow(log) {
  const li = document.createElement("li");
  li.className = `status-${escapeHtml(log.status)}`;
  li.innerHTML = `
    <span class="task-name">${escapeHtml(log.task_name)}</span>
    <span class="status-badge">${escapeHtml(log.status)}</span>
    <span class="history-times">started ${escapeHtml(formatTimestamp(log.started_at))} → ended ${escapeHtml(formatTimestamp(log.ended_at))}</span>
  `;
  li.dataset.id = log.id;
  return li;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render() {
  const running = state.logs.filter(isRunning).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const queued = state.logs.filter(isQueued).sort((a, b) => new Date(a.queued_at) - new Date(b.queued_at));

  // Fixed 3 slots, always.
  els.runningGrid.innerHTML = "";
  for (let i = 0; i < RUNNING_SLOTS; i++) {
    els.runningGrid.appendChild(renderRunningSlot(running[i] || null));
  }

  // Variable-length queued list.
  els.queuedList.innerHTML = "";
  if (queued.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.style.border = "none";
    li.style.background = "none";
    li.textContent = "Queue is empty.";
    els.queuedList.appendChild(li);
  } else {
    for (const log of queued) {
      els.queuedList.appendChild(renderQueuedRow(log));
    }
  }

  // History: all terminal-status runs, newest-first. Sorted by ended_at
  // (falling back to started_at for the rare terminal row missing
  // ended_at) because "most recently finished" is what "newest" means for
  // a history-of-completed-work view -- queued_at/started_at alone would
  // put a long-running task above one that just finished a moment ago.
  const history = state.logs
    .filter(isTerminal)
    .sort((a, b) => {
      const bTime = new Date(b.ended_at || b.started_at || b.queued_at).getTime();
      const aTime = new Date(a.ended_at || a.started_at || a.queued_at).getTime();
      return bTime - aTime;
    });

  els.historyList.innerHTML = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.style.border = "none";
    li.style.background = "none";
    li.textContent = "No completed runs yet.";
    els.historyList.appendChild(li);
  } else {
    for (const log of history) {
      els.historyList.appendChild(renderHistoryRow(log));
    }
  }

  if (state.lastFetchAt) {
    const timeLabel = state.lastFetchAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    els.lastUpdated.textContent = `last updated ${timeLabel}`;
  }

  if (state.lastError) {
    els.errorBanner.textContent = `Error fetching logs: ${state.lastError}`;
    els.errorBanner.classList.add("visible");
  } else {
    els.errorBanner.classList.remove("visible");
  }
}

// Re-render only the running-slot elapsed-time text nodes every 5s, without
// re-fetching or rebuilding the whole DOM.
function tickRunning() {
  document.querySelectorAll(".elapsed[data-started-at]").forEach((el) => {
    const startedAt = el.getAttribute("data-started-at");
    el.textContent = `running ${formatElapsed(startedAt)}`;
  });
}

// Re-render only the queued-slot waiting-time text nodes once per minute,
// without re-fetching or rebuilding the whole DOM.
function tickQueued() {
  document.querySelectorAll(".waiting[data-queued-at]").forEach((el) => {
    const queuedAt = el.getAttribute("data-queued-at");
    el.textContent = `waiting ${formatElapsed(queuedAt)}`;
  });
}

async function poll() {
  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/logs?limit=${FETCH_LIMIT}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    state.logs = Array.isArray(data.logs) ? data.logs : [];
    state.lastFetchAt = new Date();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message || String(err);
  }
  render();
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
setInterval(tickRunning, RUNNING_TICK_INTERVAL_MS);
setInterval(tickQueued, TICK_INTERVAL_MS);
