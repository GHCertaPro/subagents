// dashboard/app.js
//
// Polls GET /api/logs on an interval and renders:
//   - a fixed 3-slot "Currently Running" grid
//   - a variable-length "Queued" list
//
// Elapsed-time counters re-render every second from the ISO timestamps
// already in memory (no extra network calls needed for the ticking).

const POLL_INTERVAL_MS = 4000;
const TICK_INTERVAL_MS = 1000;
const FETCH_LIMIT = 50;
const RUNNING_SLOTS = 3;

const state = {
  logs: [],
  lastFetchAt: null,
  lastError: null,
};

const els = {
  apiBase: document.getElementById("api-base"),
  lastUpdated: document.getElementById("last-updated"),
  errorBanner: document.getElementById("error-banner"),
  runningGrid: document.getElementById("running-grid"),
  queuedList: document.getElementById("queued-list"),
};

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

  if (state.lastFetchAt) {
    els.lastUpdated.textContent = `last updated ${state.lastFetchAt.toLocaleTimeString()}`;
  }

  if (state.lastError) {
    els.errorBanner.textContent = `Error fetching logs: ${state.lastError}`;
    els.errorBanner.classList.add("visible");
  } else {
    els.errorBanner.classList.remove("visible");
  }
}

// Re-render only the elapsed-time text nodes every second, without
// re-fetching or rebuilding the whole DOM.
function tick() {
  document.querySelectorAll(".elapsed[data-started-at]").forEach((el) => {
    const startedAt = el.getAttribute("data-started-at");
    el.textContent = `running ${formatElapsed(startedAt)}`;
  });
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
setInterval(tick, TICK_INTERVAL_MS);
