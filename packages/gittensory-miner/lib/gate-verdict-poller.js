// Maintainer-gate verdict watcher (#4273): polls the gittensory API for the REAL gate disposition of one of
// the miner's own PRs and maps it to a small typed verdict. The authoritative gate verdict is server-internal
// `gate_decision` state — NOT a GitHub check-run — so `ci-poller.js`'s CI-check-run aggregate (which
// `manage-poll.js`'s `mapPollConclusionToGateVerdict` turns into a pass/block/advisory proxy) is only a
// heuristic. This reads the authoritative source instead.
//
// Read-only: targets the gittensory API (not api.github.com), so it needs NO GitHub token; any auth the polled
// endpoint requires for a contributor's OWN PR is passed via `options.headers` (none required for the public
// open-pr-monitor today). No writes. `ci-poller.js`'s CI-check-run polling is left untouched — CI state and
// gate verdict are two different signals a caller can record independently.
//
// Fully testable via injected `fetchFn`/`sleepFn` (mirrors `ci-poller.js`) — no real network in tests.
//
// UNWIRED (#5394 investigation): no production caller exists anywhere in this package, and the endpoint this
// module was built to poll doesn't have a real match today. The only real route serving a contributor their
// own open-PR state is GET /v1/contributors/:login/open-pr-monitor (src/api/routes.ts, backed by
// buildContributorOpenPrMonitor, src/signals/contributor-open-pr-monitor.ts) — but its response shape is a
// LIST of `{ repoFullName, number, classification: OpenPrWorkClassification, ... }` packets across every open
// PR for that login, not the single decided `{ disposition | gateDisposition | verdict }` field this module's
// own `readGateDisposition` expects for ONE targeted PR. `loop-cli.js`'s real CI/gate-status observation
// (#5394) uses `ci-poller.js`'s real GitHub check-run polling instead — the documented fallback for exactly
// this case. Wiring this module for real needs either a new single-PR gate-decision route or a rewrite of
// `readGateDisposition`/`mapGateDisposition` against `open-pr-monitor`'s real `classification` vocabulary —
// deliberately left as a separate follow-up rather than guessed at here.

import { fetchWithRetry } from "./http-retry.js";

/** The typed gate verdicts, decided ones first, `pending` (not-yet-decided) last. */
export const GATE_VERDICTS = Object.freeze(["merge", "close", "hold", "pending"]);

/**
 * Map a raw gate disposition string to one of {@link GATE_VERDICTS}. Liberal on synonyms; an unknown, empty, or
 * missing disposition maps to `pending` (not-yet-decided) — never a false decided verdict. Pure.
 * @param {unknown} disposition
 * @returns {"merge" | "close" | "hold" | "pending"}
 */
export function mapGateDisposition(disposition) {
  const d = typeof disposition === "string" ? disposition.trim().toLowerCase() : "";
  switch (d) {
    case "merge":
    case "merged":
    case "approved":
    case "auto_merge":
      return "merge";
    case "close":
    case "closed":
    case "rejected":
    case "auto_close":
      return "close";
    case "hold":
    case "held":
    case "manual_review":
    case "action_required":
    case "flagged":
      return "hold";
    default:
      return "pending"; // pending / open / unknown / missing — not yet decided
  }
}

/**
 * Read the gate disposition field from an API response body, tolerant of it living at `disposition`,
 * `gateDisposition`, or `verdict`. Returns the raw string, or null when absent/non-string. Pure.
 * @param {unknown} body
 * @returns {string | null}
 */
export function readGateDisposition(body) {
  if (!body || typeof body !== "object") return null;
  const raw = body.disposition ?? body.gateDisposition ?? body.verdict ?? null;
  return typeof raw === "string" ? raw : null;
}

function backoffDelayMs(attemptIndex, minIntervalMs, maxIntervalMs) {
  const exponent = Math.min(10, Math.max(0, attemptIndex));
  return Math.min(maxIntervalMs, minIntervalMs * 2 ** exponent);
}

function positiveInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Poll a gittensory gate-verdict endpoint until it returns a DECIDED verdict (merge/close/hold) or `maxAttempts`
 * is exhausted, backing off exponentially while `pending`. Dependencies are injected (`fetchFn`, `sleepFn`) so
 * this is fully unit-testable with no real network. Throws on a missing URL or a non-OK HTTP response.
 * @param {string} url
 * @param {{ fetchFn?: Function, sleepFn?: Function, headers?: Record<string,string>,
 *   maxAttempts?: number, minIntervalMs?: number, maxIntervalMs?: number }} [options]
 * @returns {Promise<{ verdict: string, disposition: string | null, attempts: number, body: unknown }>}
 */
export async function pollGateVerdict(url, options = {}) {
  if (typeof url !== "string" || !url) throw new Error("invalid_gate_verdict_url");
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const headers = options.headers ?? {};
  const maxAttempts = positiveInt(options.maxAttempts, 10, 1, 20);
  const minIntervalMs = positiveInt(options.minIntervalMs, 2000, 1, 60 * 60_000);
  const maxIntervalMs = positiveInt(options.maxIntervalMs, 60_000, 1, 60 * 60_000);

  let latest = { verdict: "pending", disposition: null, attempts: 0, body: null };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Retry transient network errors / 5xx around this single call (#4829), distinct from the pending-retry loop.
    const response = await fetchWithRetry(fetchFn, url, { headers }, { sleepFn });
    if (!response || !response.ok) throw new Error(`gate_verdict_http_${response ? response.status : "error"}`);
    const body = await response.json();
    const disposition = readGateDisposition(body);
    const verdict = mapGateDisposition(disposition);
    latest = { verdict, disposition, attempts: attempt + 1, body };
    if (verdict !== "pending") return latest; // decided — stop
    if (attempt === maxAttempts - 1) return latest; // exhausted while still pending
    await sleepFn(backoffDelayMs(attempt, minIntervalMs, maxIntervalMs));
  }
  return latest;
}
