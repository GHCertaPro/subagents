// dashboard/history-detail.js
//
// Standalone script for history-detail.html — the "full summary" page
// Gabe asked for (option two, opens in a new PAGE on click, same tab,
// NOT a new browser tab). Reads `?id=` from this page's own URL, fetches
// that single row from GET /api/logs/:id, and renders its full
// `notes`/`summary` text with line breaks preserved.
//
// Intentionally has zero shared state with app.js/historyState — this
// page can be reached via a fresh navigation (row click, direct link,
// reload) and always re-fetches from scratch.

const els = {
  loading: document.getElementById("detail-loading"),
  error: document.getElementById("detail-error"),
  content: document.getElementById("detail-content"),
  taskName: document.getElementById("detail-task-name"),
  statusBadge: document.getElementById("detail-status-badge"),
  times: document.getElementById("detail-times"),
  requestedBy: document.getElementById("detail-requested-by"),
  summarySection: document.getElementById("detail-summary-section"),
  summaryText: document.getElementById("detail-summary-text"),
  notesSection: document.getElementById("detail-notes-section"),
  notesText: document.getElementById("detail-notes-text"),
  emptySection: document.getElementById("detail-empty-section"),
};

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Same display-only underscore->space rule as app.js's formatTaskName —
// never used for lookups, only for the visible heading text.
function formatTaskName(taskName) {
  if (taskName === null || taskName === undefined) return "";
  return String(taskName).replace(/_/g, " ");
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
    second: "2-digit",
  });
}

// Renders free text with line breaks preserved (the ask was "at minimum
// preserve line breaks"). Uses textContent + CSS `white-space: pre-wrap`
// on .detail-text-block (see style.css) rather than manually splitting on
// \n and building <br> nodes — simpler, and safe against any HTML-special
// characters in the source text since nothing is ever set via innerHTML
// here.
function renderTextBlock(el, text) {
  el.textContent = text;
}

function getIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("id");
}

async function loadDetail() {
  const id = getIdFromUrl();
  if (!id || !/^\d+$/.test(id)) {
    els.loading.hidden = true;
    els.error.textContent = "No valid run id given in the URL (expected ?id=<number>).";
    els.error.classList.add("visible");
    return;
  }

  try {
    const res = await fetch(`${window.SUBAGENTS_API_BASE}/api/logs/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (res.status === 404) {
      throw new Error(`Run #${id} was not found.`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const log = await res.json();
    renderLog(log);
  } catch (err) {
    els.loading.hidden = true;
    els.error.textContent = `Error loading run detail: ${err.message || err}`;
    els.error.classList.add("visible");
    return;
  }

  els.loading.hidden = true;
  els.content.hidden = false;
}

function renderLog(log) {
  document.title = `${formatTaskName(log.task_name) || "Run"} — Subagents Dashboard`;

  els.taskName.textContent = formatTaskName(log.task_name);

  els.statusBadge.textContent = log.status || "";
  els.statusBadge.className = `status-badge status-${escapeHtml(log.status || "")}`;

  const started = formatTimestamp(log.started_at);
  const ended = formatTimestamp(log.ended_at);
  const queued = formatTimestamp(log.queued_at);
  els.times.textContent = `queued ${queued} → started ${started} → ended ${ended}`;

  els.requestedBy.textContent = log.requested_by ? `requested by ${log.requested_by}` : "";

  const hasSummary = log.summary && String(log.summary).trim() !== "";
  const hasNotes = log.notes && String(log.notes).trim() !== "";

  if (hasSummary) {
    els.summarySection.hidden = false;
    renderTextBlock(els.summaryText, String(log.summary));
  }
  if (hasNotes) {
    els.notesSection.hidden = false;
    renderTextBlock(els.notesText, String(log.notes));
  }
  if (!hasSummary && !hasNotes) {
    els.emptySection.hidden = false;
  }
}

loadDetail();
