// dashboard/app.js
//
// Shared script for the two real, separate dashboard pages:
//   - dashboard/index.html  ("/")         -- Live: fixed 3-slot "Currently
//     Running" grid + variable-length "Queued" list. This is the app's
//     homepage / default route.
//   - dashboard/history.html ("/history") -- History: the 50 most-recent
//     terminal-status (done/failed/cancelled) runs, newest-first, with a
//     "Load More" button that fetches 25 more at a time via real
//     server-side offset pagination.
//
// This file is loaded by BOTH pages (same <script src="app.js">, no build
// step) but each page only has the DOM elements for its own view, so the
// two code paths below are gated on `document.getElementById(...)` checks
// for the elements that are unique to each page -- initLive() only runs
// on index.html (where #running-grid/#queued-list exist), initHistory()
// only runs on history.html (where #history-list exists). There used to
// be a single-page client-side view-toggle (`state.view`, `setView()`)
// switching between two hidden/unhidden <div>s on one URL; that's gone
// now that Live and History are two distinct pages/routes served by
// server/index.js -- navigation between them is just the <nav> links in
// each page's markup doing normal full page loads.
//
// ARCHITECTURE NOTE (unchanged from before the page split): Live and
// History have their OWN separate fetch paths, because they are
// fundamentally different concerns:
//   - Live's job is a cheap, small, recurring poll (every 15s) that only
//     ever needs the *current* queued+running rows -- there are at most a
//     handful of those at once, so `poll()` below asks the API for
//     exactly `?status=queued,running` and nothing else.
//   - History's job is a one-shot "give me N most recent finished rows"
//     load, followed by on-demand "give me the next 25" loads triggered
//     by the Load More button -- there is no reason to re-fetch this on a
//     15s timer, and re-fetching would also fight with the pagination
//     offset the user has scrolled through.
//
// Elapsed-time counters re-render once per minute from the ISO timestamps
// already in memory (no extra network calls needed for the ticking).

const POLL_INTERVAL_MS = 15000;
const TICK_INTERVAL_MS = 60000; // display-only cadence: queued "waiting X" text refreshes once/minute.
const RUNNING_TICK_INTERVAL_MS = 5000; // display-only cadence: running "elapsed X" text refreshes every 5s (Gabe's request, running-slots only).
const LIVE_FETCH_LIMIT = 100; // Live view only ever needs current queued+running rows -- always a small set.
const LIVE_STATUS_PARAM = "queued,running";
const HISTORY_STATUS_PARAM = "done,failed,cancelled";
const HISTORY_INITIAL_LIMIT = 50; // Gabe's ask: History shows the 50 most recent terminal-status rows initially.
const HISTORY_LOAD_MORE_LIMIT = 25; // Gabe's ask: "Load More" fetches up to 25 more at a time.
const RUNNING_SLOTS = 3;

const state = {
  logs: [],
  lastFetchAt: null,
  lastError: null,
};

// Separate state for the History page's own paginated fetch path. Kept
// distinct from `state` (which is the live-poll-only array) so the two
// fetch loops never step on each other, even though they no longer share
// a page.
const historyState = {
  logs: [], // accumulated rows, newest-first, across all loaded pages
  ids: new Set(), // de-dupe guard -- see appendHistoryLogs()
  total: 0, // total matching rows on the server, per the last response's `total`
  loading: false,
  initialized: false, // true once the first page has successfully loaded
};

const els = {
  lastUpdated: document.getElementById("last-updated"),
  errorBanner: document.getElementById("error-banner"),
  runningGrid: document.getElementById("running-grid"),
  queuedList: document.getElementById("queued-list"),
  historyList: document.getElementById("history-list"),
  historyLoadMore: document.getElementById("history-load-more"),
};

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
    <div class="task-name">${escapeHtml(formatTaskName(log.task_name))}</div>
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
    <span class="task-name">${escapeHtml(formatTaskName(log.task_name))}</span>
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
    <span class="task-name">${escapeHtml(formatTaskName(log.task_name))}</span>
    <span class="status-badge">${escapeHtml(log.status)}</span>
    <span class="history-times">started ${escapeHtml(formatTimestamp(log.started_at))} → ended ${escapeHtml(formatTimestamp(log.ended_at))}</span>
  `;
  li.dataset.id = log.id;

  // --- Two-tier history detail (Gabe's request) ---
  //
  // Tier 1, "brief one-sentence summary, on hover": uses the native
  // `title` attribute (simplest reliable cross-browser tooltip, no extra
  // markup/CSS/JS needed) rather than a custom CSS-hover popup. Derived
  // from whichever of `summary`/`notes` has content (preferring `summary`
  // since it's already meant to be short) via briefSummaryFor() below --
  // first-sentence-or-~140-chars truncation, no LLM call.
  //
  // Tier 2, "full summary, opens in a new PAGE on click": the whole row
  // is a same-tab navigation to history-detail.html?id=<id>, which
  // fetches GET /api/logs/:id and renders the complete notes/summary
  // text. Navigation is done via `window.location.href = ...` (see the
  // click listener below) -- explicitly NOT `window.open(...)` and NOT an
  // `<a target="_blank">` -- so it replaces the current tab's page
  // exactly like clicking a normal same-tab link would.
  const brief = briefSummaryFor(log);
  if (brief) {
    li.title = brief;
    li.classList.add("has-summary");
  }
  li.classList.add("history-row-link");
  li.dataset.id = log.id;

  // Click handler: same-tab navigation to the full-detail page (Gabe's
  // "option two" -- NOT a new browser tab, so plain `location.href`
  // assignment rather than `window.open(...)` or an <a target="_blank">).
  // Uses a real relative page (history-detail.html) alongside this one,
  // matching the existing no-build-step multi-static-file pattern already
  // used for index.html/history.html/config.js/app.js/style.css.
  li.addEventListener("click", () => {
    window.location.href = `history-detail.html?id=${encodeURIComponent(log.id)}`;
  });

  return li;
}

// Derives a short, glanceable one-sentence hover summary for a History
// row. Prefers `summary` (already meant to be short per the DB
// migration's intent) and falls back to `notes` (the long full-detail
// writeup) when no `summary` is set, since some rows may only ever get
// `notes` populated. Not an LLM call -- a simple, deterministic
// heuristic: take the text up to the first sentence-ending punctuation
// (. ! ?) if that occurs at a reasonable length, otherwise hard-truncate
// to ~140 chars at the nearest word boundary with an ellipsis. Returns
// "" (falsy) when neither field has usable content, so callers can skip
// adding a tooltip/affordance entirely.
function briefSummaryFor(log) {
  const source =
    log.summary && String(log.summary).trim() !== ""
      ? String(log.summary).trim()
      : log.notes && String(log.notes).trim() !== ""
        ? String(log.notes).trim()
        : "";
  if (!source) return "";

  const MAX_LEN = 140;

  // Prefer the first sentence if it ends reasonably early -- reads more
  // naturally than a mid-thought truncation for well-formed prose.
  const sentenceMatch = source.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (sentenceMatch && sentenceMatch[0].trim().length > 0 && sentenceMatch[0].length <= MAX_LEN) {
    return sentenceMatch[0].trim();
  }

  if (source.length <= MAX_LEN) return source;

  // Hard-truncate at the nearest word boundary at/before MAX_LEN, then
  // append an ellipsis, so we don't cut a word in half.
  let cut = source.slice(0, MAX_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.trim()}…`;
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// DISPLAY-ONLY formatting: replace underscores with spaces for the
// human-readable rendering of a task_name. This must NEVER be used for
// anything except the final text shown in the DOM -- not for dataset
// keys/ids, not for API query params, not for any lookup/matching logic.
// The raw underscored task_name string (as stored in Postgres and
// returned by GET /api/logs) is left completely untouched everywhere
// else in this file; this function is only called at the point where we
// build the visible task-name text for a slot/row.
function formatTaskName(taskName) {
  if (taskName === null || taskName === undefined) return "";
  return String(taskName).replace(/_/g, " ");
}

function renderLive() {
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

// De-dupe guard for appending a fetched page of History rows onto
// historyState.logs. Load More is additive (appends, never replaces), but
// a naive append risks duplicates if a click ever re-requests an overlapping
// offset (e.g. a retry after a network blip) or drops rows if the server-side
// total shifts between clicks (new terminal runs finishing while the user is
// paging). Using `id` (stable, unique, never reused) as the de-dupe key
// keeps historyState.logs correct regardless of either scenario.
function appendHistoryLogs(logs) {
  for (const log of logs) {
    if (historyState.ids.has(log.id)) continue;
    historyState.ids.add(log.id);
    historyState.logs.push(log);
  }
}

// Renders the History list from historyState.logs (already newest-first,
// per the server's ORDER BY ended_at-coalesced DESC, id DESC) and updates
// the Load More button's visibility/label/disabled state.
function renderHistory() {
  els.historyList.innerHTML = "";
  if (historyState.logs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.style.border = "none";
    li.style.background = "none";
    li.textContent = historyState.loading ? "Loading…" : "No completed runs yet.";
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

// Shared fetch helper for both the initial History load and each
// subsequent Load More click. `offset`/`limit` map straight onto the
// server-side params supported by GET /api/logs (see
// server/routes/logs.js); `order_by=ended_at` matches the History page's
// "most recently finished" newest-first sort semantics.
async function fetchHistoryPage(offset, limit) {
  const params = new URLSearchParams({
    status: HISTORY_STATUS_PARAM,
    order_by: "ended_at",
    limit: String(limit),
    offset: String(offset),
  });
  const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/logs?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

// Initial History load: the 50 most-recent terminal-status rows (Gabe's
// spec).
async function loadInitialHistory() {
  if (historyState.loading) return;
  historyState.loading = true;
  historyState.logs = [];
  historyState.ids = new Set();
  historyState.total = 0;
  renderHistory();
  try {
    const data = await fetchHistoryPage(0, HISTORY_INITIAL_LIMIT);
    appendHistoryLogs(Array.isArray(data.logs) ? data.logs : []);
    historyState.total = Number.isFinite(data.total) ? data.total : historyState.logs.length;
    historyState.initialized = true;
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message || String(err);
  }
  historyState.loading = false;
  renderHistory();
}

// "Load More" click handler: fetches the next 25 rows starting at the
// current historyState.logs.length offset and appends them. Works
// correctly across repeated clicks (50->75->100->125->...) because the
// offset is always derived from how many rows are already loaded, not a
// fixed page counter -- so it stays correct even if appendHistoryLogs()
// ever has to skip a duplicate.
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

// Live page's own poll loop: only ever asks for queued/running rows (the
// small, currently-active set), completely separate from History's
// fetchHistoryPage()/loadInitialHistory()/loadMoreHistory() path above.
async function poll() {
  try {
    const params = new URLSearchParams({
      status: LIVE_STATUS_PARAM,
      limit: String(LIVE_FETCH_LIMIT),
    });
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/logs?${params.toString()}`, {
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
  renderLive();
}

// --- Page init: gated on which page's unique DOM elements are present ---
// (see the file-level comment above for why one shared app.js is loaded by
// both pages instead of splitting into two files).

function initLive() {
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(tickRunning, RUNNING_TICK_INTERVAL_MS);
  setInterval(tickQueued, TICK_INTERVAL_MS);
}

function initHistory() {
  els.historyLoadMore.addEventListener("click", () => loadMoreHistory());
  loadInitialHistory();
}

if (els.runningGrid && els.queuedList) {
  initLive();
} else if (els.historyList) {
  initHistory();
}
