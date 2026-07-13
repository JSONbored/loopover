/** Read the latest ranked discovery candidates back out of the local event ledger (#4859).
 *
 * `discover` persists each enqueued row as a `discovered_issue` event (portfolio-discovery.js) but the ranked
 * array it prints to stdout is otherwise ephemeral — the only workflow that got it into the contributor miner
 * extension was a manual copy/paste of `discover --json`. This reader reconstructs the same ranked-candidate
 * shape the extension consumes directly from that append-only audit trail, so a local surface (the miner-ui
 * `/api/discovery` bridge) can serve it for a live fetch instead. It is strictly READ-ONLY: it never appends,
 * never enqueues, and never calls GitHub. */
import { initEventLedger } from "./event-ledger.js";

const DISCOVERED_ISSUE_EVENT_TYPE = "discovered_issue";

/** Reconstruct one ranked candidate from a `discovered_issue` ledger entry, applying the SAME validation as
 * `normalizeRankedIssue` in portfolio-discovery.js (the writer) so a malformed or partial event is dropped
 * rather than surfaced to the extension. Returns null for anything that fails a check. */
function normalizeDiscoveredCandidate(entry) {
  // The caller only ever passes an entry whose `type` already equalled the discovered-issue constant, so `entry`
  // is guaranteed non-null here — read `payload` directly rather than through an optional chain that could never
  // take its nullish branch.
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return null;
  const repoFullName = typeof entry.repoFullName === "string" ? entry.repoFullName.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!Number.isInteger(payload.issueNumber) || payload.issueNumber <= 0) return null;
  if (typeof payload.rankScore !== "number" || !Number.isFinite(payload.rankScore) || payload.rankScore < 0) {
    return null;
  }
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const labels = Array.isArray(payload.labels)
    ? payload.labels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim())
    : [];
  return { repoFullName: `${owner}/${repo}`, issueNumber: payload.issueNumber, title, labels, rankScore: payload.rankScore };
}

/**
 * List the latest ranked discovery candidate per issue from the local event ledger, newest-ranked first.
 *
 * Rows are read in `seq ASC` order, so re-discovering an issue (a fresh `discovered_issue` event with a new
 * rankScore) naturally supersedes the earlier one — the last write for a given `repoFullName#issueNumber`
 * wins. The result is sorted by `rankScore` descending, with a stable `repoFullName`/`issueNumber` tie-break so
 * two equally-ranked issues always come back in the same order.
 *
 * `options.eventLedger` injects an already-open ledger (the caller then owns closing it); `options.initEventLedger`
 * injects the opener; otherwise the module's default `initEventLedger()` opens — and this function closes — its
 * own instance. `options.repoFullName` scopes the read to a single `owner/repo` (passed through to the ledger's
 * own repo filter).
 */
export function listDiscoveredRankedCandidates(options = {}) {
  const ownsLedger = options.eventLedger === undefined;
  const ledger = options.eventLedger ?? (options.initEventLedger ?? initEventLedger)();
  try {
    const events = ledger.readEvents({ repoFullName: options.repoFullName ?? null });
    const latestByIssue = new Map();
    for (const entry of events) {
      if (entry?.type !== DISCOVERED_ISSUE_EVENT_TYPE) continue;
      const candidate = normalizeDiscoveredCandidate(entry);
      if (!candidate) continue;
      latestByIssue.set(`${candidate.repoFullName}#${candidate.issueNumber}`, candidate);
    }
    return [...latestByIssue.values()].sort(
      (a, b) =>
        b.rankScore - a.rankScore ||
        a.repoFullName.localeCompare(b.repoFullName) ||
        a.issueNumber - b.issueNumber,
    );
  } finally {
    if (ownsLedger) ledger.close();
  }
}
