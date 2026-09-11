// server/lib/deriveSummary.js
//
// Deterministic (NO LLM call) short-summary derivation from a subagent's
// long `notes` writeup. Used by:
//   - PATCH /api/logs/:id (server/routes/logs.js) -- auto-populates the
//     `summary` column at write time whenever a caller sets status to
//     done/failed and supplies `notes` but no explicit `summary`, so the
//     column is durably populated without depending on every subagent/
//     parent remembering to send a separate summary string.
//   - server/backfill-summaries.js -- the one-off backfill applying the
//     same logic to historical rows that predate this fix.
//
// Root cause this exists to fix: migration 002 added `summary TEXT` so
// History-row hover tooltips could show a short blurb instead of a
// truncated chunk of the long `notes` field, but the only thing that ever
// populated `summary` was a caller explicitly sending it -- which almost
// never happened, since the standing reporting convention only tells
// subagents to send a full structured `notes` report. This derives a
// reasonable `summary` automatically instead.
//
// NOT literally shared code with dashboard/app.js's briefSummaryFor() --
// that runs as static JS in the browser, this runs in the Node server
// process, and the inputs differ (this one specifically looks for a
// "Changes made" section first, since nearly every subagent report
// follows that structured "Changes made / Completion Verification /
// Deploy and Live Verification" convention, and the "Changes made" text
// is the most useful glance-summary of what a row actually did). The
// final truncate-to-sentence-or-~140-chars step below conceptually
// mirrors briefSummaryFor()'s fallback truncation, by design, so the two
// code paths produce visually consistent-feeling results even though
// they're separate implementations in separate runtimes.

const MAX_LEN = 140;

function truncateToSentenceOrLength(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // Prefer the first sentence if it ends reasonably early -- reads more
  // naturally than a mid-thought truncation for well-formed prose.
  const sentenceMatch = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (sentenceMatch && sentenceMatch[0].trim().length > 0 && sentenceMatch[0].length <= MAX_LEN) {
    return sentenceMatch[0].trim();
  }

  if (trimmed.length <= MAX_LEN) return trimmed;

  // Hard-truncate at the nearest word boundary at/before MAX_LEN, then
  // append an ellipsis, so we don't cut a word in half.
  let cut = trimmed.slice(0, MAX_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.trim()}\u2026`;
}

// Extracts a short glance-summary string from a subagent's `notes` field.
// Deterministic only -- no external/LLM calls, safe to run synchronously
// on every PATCH request. Returns "" if `notes` has no usable content
// (caller decides what to do in that case -- e.g. leave `summary`
// untouched rather than writing an empty string over it).
export function deriveSummaryFromNotes(notes) {
  if (notes === null || notes === undefined) return "";
  const text = String(notes).trim();
  if (!text) return "";

  // Most subagent reports follow the "Changes made / Completion
  // Verification / Deploy and Live Verification" structured convention.
  // Pull just the "Changes made" section's text when present -- it's the
  // most useful glance-summary of what actually happened, vs. the
  // verification/deploy prose that follows it. Falls back to the whole
  // `notes` text when no recognizable "Changes made" header is found
  // (e.g. older/free-form reports).
  const sectionMatch = text.match(
    /Changes made:?\s*([\s\S]*?)(?:\n\s*\n\s*(?:Completion Verification|Deploy(?: and Live)? Verification)\b|$)/i
  );

  let candidate =
    sectionMatch && sectionMatch[1] && sectionMatch[1].trim() ? sectionMatch[1].trim() : text;

  // Strip a leading list-bullet marker ("- " or "* ") so the extracted
  // text reads as a sentence rather than starting with a dash.
  candidate = candidate.replace(/^[-*]\s*/, "");

  return truncateToSentenceOrLength(candidate);
}
