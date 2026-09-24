// dashboard/app.js
//
// Shared script for the two real, separate dashboard pages:
//   - dashboard/index.html  ("/")         -- Live: fixed 3-slot "Currently
//     Running" grid + variable-length "Queued" list.
//   - dashboard/history.html ("/history") -- History: 50 most-recent
//     terminal-status runs, newest-first, with "Load More" pagination.
//
// Auth: JWT stored in localStorage (key: __auth_token). If not present,
//   the user is redirected to /login. The per-bot API key token
//   (DASHBOARD_TOKEN) is still used for x-api-key headers on API calls
//   so the server can filter logs by bot_id.

// ── JWT Auth Gate ─────────────────────────────────────────────────────────────
// Runs immediately on page load. Redirects to /login if no JWT found.
// Also injects user info (email + logout) into the header.
(function initJwtGate() {
  const jwtToken = localStorage.getItem("__auth_token");
  if (!jwtToken) {
    window.location.replace("/login");
    return;
  }

  // User identity is now shown on the Settings page (/settings), not the header.
})();

const POLL_INTERVAL_MS = 15000;
const TICK_INTERVAL_MS = 60000;
const RUNNING_TICK_INTERVAL_MS = 5000;
const LIVE_FETCH_LIMIT = 100;
const LIVE_STATUS_PARAM = "queued,running";
const HISTORY_STATUS_PARAM = "done,failed,cancelled";
const HISTORY_INITIAL_LIMIT = 50;
const HISTORY_LOAD_MORE_LIMIT = 25;
const RUNNING_SLOTS = 3;

// ── Token resolution ──────────────────────────────────────────────────────────
// Priority: ?token= URL param > sessionStorage
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

// Inject token into all nav links so the token persists across page navigation.
// Without this, clicking History drops ?token= from the URL.
if (DASHBOARD_TOKEN) {
  document.querySelectorAll("a.nav-link").forEach((a) => {
    try {
      const url = new URL(a.href, window.location.origin);
      url.searchParams.set("token", DASHBOARD_TOKEN);
      a.href = url.toString();
    } catch (_) {}
  });
  // Also rewrite history-detail links when rows are clicked (handled inline below).
}

// Build fetch options with x-api-key header if we have a token
function apiFetchOptions() {
  const opts = { cache: "no-store" };
  if (DASHBOARD_TOKEN) {
    opts.headers = { "x-api-key": DASHBOARD_TOKEN };
  }
  return opts;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  logs: [],
  lastFetchAt: null,
  lastError: null,
};

const historyState = {
  logs: [],
  ids: new Set(),
  total: 0,
  loading: false,
  initialized: false,
};

const els = {
  lastUpdated: document.getElementById("last-updated"),
  errorBanner: document.getElementById("error-banner"),
  runningGrid: document.getElementById("running-grid"),
  queuedList: document.getElementById("queued-list"),
  historyList: document.getElementById("history-list"),
  historyLoadMore: document.getElementById("history-load-more"),
  tokenGate: document.getElementById("token-gate"),
  liveView: document.getElementById("live-view"),
  historyView: document.getElementById("history-view"),
};

// ── Token gate ────────────────────────────────────────────────────────────────
// JWT auth is now the primary gate (handled by initJwtGate above).
// DASHBOARD_TOKEN (old per-bot API key) is optional — used only for
// bot-level log filtering via x-api-key header. Authenticated users
// without a token see all public logs.
function checkTokenGate() {
  // JWT gate already redirected to /login if not authenticated.
  // Always allow rendering; hide the legacy token-gate prompt.
  if (els.tokenGate) els.tokenGate.style.display = "none";
  return true;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
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
  return log.status === "running" && !!log.started_at && !log.ended_at;
}

function isQueued(log) {
  return log.status === "queued" && !log.started_at;
}

function formatDateOnly(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTaskName(taskName) {
  if (taskName === null || taskName === undefined) return "";
  return String(taskName).replace(/_/g, " ");
}

// ── Render helpers ────────────────────────────────────────────────────────────
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
    <div class="task-name">${escapeHtml(formatTaskName(log.task_name))}</div>
    <div class="elapsed" data-started-at="${escapeHtml(log.started_at)}">running ${elapsed}</div>
  `;
  div.dataset.id = log.id;
  return div;
}

function renderQueuedRow(log) {
  const li = document.createElement("li");
  const waiting = formatElapsed(log.queued_at);
  const queuedAtLabel = log.queued_at ? new Date(log.queued_at).toLocaleString() : "unknown";
  li.innerHTML = `
    <span class="task-name">${escapeHtml(formatTaskName(log.task_name))}</span>
    <span class="queued-at">queued ${escapeHtml(queuedAtLabel)}</span>
    <span class="waiting" data-queued-at="${escapeHtml(log.queued_at)}">waiting ${waiting}</span>
  `;
  li.dataset.id = log.id;
  return li;
}

function briefSummaryFor(log) {
  const source =
    log.summary && String(log.summary).trim() !== ""
      ? String(log.summary).trim()
      : log.notes && String(log.notes).trim() !== ""
        ? String(log.notes).trim()
        : "";
  if (!source) {
    const name = formatTaskName(log.task_name);
    return name ? `${name} — no summary recorded for this run.` : "No summary recorded for this run.";
  }
  const MAX_LEN = 140;
  const sentenceMatch = source.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (sentenceMatch && sentenceMatch[0].trim().length > 0 && sentenceMatch[0].length <= MAX_LEN) {
    return sentenceMatch[0].trim();
  }
  if (source.length <= MAX_LEN) return source;
  let cut = source.slice(0, MAX_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.trim()}…`;
}

function renderHistoryRow(log) {
  const li = document.createElement("li");
  li.className = `status-${escapeHtml(log.status)}`;
  li.innerHTML = `
    <span class="task-name">${escapeHtml(formatTaskName(log.task_name))}</span>
    <span class="status-badge">${escapeHtml(log.status)}</span>
    <span class="history-times">ended ${escapeHtml(formatDateOnly(log.ended_at))}</span>
  `;
  li.dataset.id = log.id;

  const brief = briefSummaryFor(log);
  if (brief) {
    li.title = brief;
    li.classList.add("has-summary");
  }
  li.classList.add("history-row-link");

  li.addEventListener("click", () => {
    const detailUrl = new URL(`history-detail.html`, window.location.origin);
    detailUrl.searchParams.set("id", log.id);
    if (DASHBOARD_TOKEN) detailUrl.searchParams.set("token", DASHBOARD_TOKEN);
    window.location.href = detailUrl.toString();
  });

  return li;
}

// ── Live page ─────────────────────────────────────────────────────────────────
function renderLive() {
  const running = state.logs.filter(isRunning).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const queued = state.logs.filter(isQueued).sort((a, b) => new Date(a.queued_at) - new Date(b.queued_at));

  els.runningGrid.innerHTML = "";
  for (let i = 0; i < RUNNING_SLOTS; i++) {
    els.runningGrid.appendChild(renderRunningSlot(running[i] || null));
  }

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

  if (state.lastFetchAt && els.lastUpdated) {
    const timeLabel = state.lastFetchAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    els.lastUpdated.textContent = `last updated ${timeLabel}`;
  }

  if (els.errorBanner) {
    if (state.lastError) {
      els.errorBanner.textContent = `Error fetching logs: ${state.lastError}`;
      els.errorBanner.classList.add("visible");
    } else {
      els.errorBanner.classList.remove("visible");
    }
  }
}

function appendHistoryLogs(logs) {
  for (const log of logs) {
    if (historyState.ids.has(log.id)) continue;
    historyState.ids.add(log.id);
    historyState.logs.push(log);
  }
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (historyState.logs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.style.border = "none";
    li.style.background = "none";
    // Fix A: if loading finished with an error, show it prominently instead
    // of the generic "No completed runs yet." so it doesn't go unnoticed.
    if (!historyState.loading && state.lastError) {
      li.style.color = "#f66";
      li.style.fontWeight = "bold";
      li.style.padding = "12px 0";
      li.textContent = `Error loading history: ${state.lastError}`;
    } else {
      li.textContent = historyState.loading ? "Loading\u2026" : "No completed runs yet.";
    }
    els.historyList.appendChild(li);
  } else {
    for (const log of historyState.logs) {
      els.historyList.appendChild(renderHistoryRow(log));
    }
  }

  const hasMore = historyState.logs.length < historyState.total;
  if (!historyState.initialized || historyState.logs.length === 0) {
    els.historyLoadMore.hidden = true;
  } else if (!hasMore) {
    els.historyLoadMore.hidden = false;
    els.historyLoadMore.disabled = true;
    els.historyLoadMore.textContent = "No more history";
  } else {
    els.historyLoadMore.hidden = false;
    els.historyLoadMore.disabled = historyState.loading;
    els.historyLoadMore.textContent = historyState.loading ? "Loading…" : "Load More";
  }

  if (els.errorBanner) {
    if (state.lastError) {
      els.errorBanner.textContent = `Error fetching logs: ${state.lastError}`;
      els.errorBanner.classList.add("visible");
    } else {
      els.errorBanner.classList.remove("visible");
    }
  }
}

async function fetchHistoryPage(offset, limit) {
  const params = new URLSearchParams({
    status: HISTORY_STATUS_PARAM,
    order_by: "ended_at",
    limit: String(limit),
    offset: String(offset),
  });
  const res = await fetch(
    `${window.SUBAGENTS_API_BASE}/api/logs?${params.toString()}`,
    apiFetchOptions()
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadInitialHistory() {
  if (historyState.loading) return;
  historyState.loading = true;
  historyState.logs = [];
  historyState.ids = new Set();
  historyState.total = 0;
  renderHistory();
  try {
    const data = await fetchHistoryPage(0, HISTORY_INITIAL_LIMIT);
    console.log('[history] fetch returned:', data.count, 'rows, total:', data.total);
    appendHistoryLogs(Array.isArray(data.logs) ? data.logs : []);
    historyState.total = Number.isFinite(data.total) ? data.total : historyState.logs.length;
    historyState.initialized = true;
    state.lastError = null;
  } catch (err) {
    console.error('[history] fetch error:', err);
    state.lastError = err.message || String(err);
  }
  historyState.loading = false;
  renderHistory();
}

async function loadMoreHistory() {
  if (historyState.loading) return;
  if (historyState.logs.length >= historyState.total) return;
  historyState.loading = true;
  renderHistory();
  try {
    const data = await fetchHistoryPage(historyState.logs.length, HISTORY_LOAD_MORE_LIMIT);
    appendHistoryLogs(Array.isArray(data.logs) ? data.logs : []);
    historyState.total = Number.isFinite(data.total) ? data.total : historyState.total;
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message || String(err);
  }
  historyState.loading = false;
  renderHistory();
}

function tickRunning() {
  document.querySelectorAll(".elapsed[data-started-at]").forEach((el) => {
    el.textContent = `running ${formatElapsed(el.getAttribute("data-started-at"))}`;
  });
}

function tickQueued() {
  document.querySelectorAll(".waiting[data-queued-at]").forEach((el) => {
    el.textContent = `waiting ${formatElapsed(el.getAttribute("data-queued-at"))}`;
  });
}

async function poll() {
  try {
    const params = new URLSearchParams({
      status: LIVE_STATUS_PARAM,
      limit: String(LIVE_FETCH_LIMIT),
    });
    const res = await fetch(
      `${window.SUBAGENTS_API_BASE}/api/logs?${params.toString()}`,
      apiFetchOptions()
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.logs = Array.isArray(data.logs) ? data.logs : [];
    state.lastFetchAt = new Date();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message || String(err);
  }
  renderLive();
}

// ── Page init ─────────────────────────────────────────────────────────────────
function initLive() {
  if (!checkTokenGate()) return;
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(tickRunning, RUNNING_TICK_INTERVAL_MS);
  setInterval(tickQueued, TICK_INTERVAL_MS);
}

function initHistory() {
  if (!checkTokenGate()) return;
  els.historyLoadMore.addEventListener("click", () => loadMoreHistory());
  loadInitialHistory();
}

if (els.runningGrid && els.queuedList) {
  initLive();
} else if (els.historyList) {
  initHistory();
}
