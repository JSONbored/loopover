// Telling a superseded contributor they forgot to link an issue (#10168).
//
// metagraphed#8886 linked issue #8829 correctly at 09:22:36. At 09:30:24 a rival PR (#8881) linking the SAME
// issue merged, and one second later the issue closed. From then on #8886's every evaluation produced
// `hold | missing_linked_issue` with the message "The PR cites an issue number, but it could not be verified
// as a currently open issue" and the advice "link it explicitly in the PR body" -- advice that cannot work,
// because re-linking a closed issue changes nothing. The contributor was told to fix a mistake they did not
// make. (It is also the shape that never clears, which is what #10184's backoff exists to throttle.)
//
// `confirmedNoOpenLinkedIssue` (#unlinked-issue-guardrail-followup) collapses two different situations:
//
//   GAMING     -- the PR cited an already-dead issue to clear `linkedIssueGateMode: block`. Real, and the
//                 countermeasure this flag exists for. Unchanged by this module.
//   SUPERSEDED -- the PR linked a genuinely OPEN issue, and a different PR merged first and closed it.
//                 Ordinary contributor collision, and not a linking failure at all.
//
// ── HOW THE TWO ARE SEPARATED ─────────────────────────────────────────────────────────────────────────────
// Two facts already in hand, no new GitHub call:
//
//   1. the issue was OPEN when this PR was created -- `closedAt` postdates `createdAt`. GitHub's issue payload
//      already carries `closed_at` (LinkedIssueFactsResult, added by #4528), and the linked-issue verification
//      pass already fetches every linked issue; it just discarded everything but a boolean.
//   2. a MERGED sibling PR in this repo cites the same issue, and merged into the window that ends at the
//      close. Our own `pull_requests` rows answer this -- the duplicate/overlap machinery cannot, because it
//      keys on OPEN siblings and the rival stopped being one the moment it merged (#10168).
//
// Deliberately NOT GitHub's issue-timeline API: it would be a second network call per linked issue on the
// hottest path, to re-derive a fact our own ledger already recorded when we merged the rival ourselves.
//
// ── WHY EVERY UNCERTAIN CASE RESOLVES TO "NOT SUPERSEDED" ─────────────────────────────────────────────────
// A supersession verdict CLOSES a contributor's pull request. That is destructive and one-shot, so a missing
// timestamp, an unparseable date, an absent rival, or a PR whose own `createdAt` was never synced must all
// resolve to null -- the PR keeps its existing disposition rather than being closed on incomplete evidence.
// This is the same discipline as #10184's backoff, pointed the other way: there, uncertainty must not
// SUPPRESS a review; here, uncertainty must not TAKE an irreversible action.

/** One linked issue's closure state, as read from the live issue payload. */
export type LinkedIssueClosure = {
  issueNumber: number;
  /** Lowercased GitHub issue state. Only a non-`open` issue can have superseded anything. */
  state: string;
  /** GitHub's `closed_at`, or null while open. */
  closedAt: string | null;
};

/** A candidate rival: a pull request in the same repo that has MERGED, and what it cited. */
export type MergedRivalPullRequest = {
  number: number;
  /** GitHub's `merged_at`. Null for a PR that closed without merging -- never a supersession. */
  mergedAt: string | null;
  linkedIssues: number[];
};

/** The evidence behind a supersession, carried onto the finding so the message can name the rival. */
export type SupersededByRival = {
  issueNumber: number;
  rivalPullNumber: number;
  rivalMergedAt: string;
  issueClosedAt: string;
};

/**
 * How long after a rival's merge the issue's own close may land and still count as caused by it.
 *
 * GitHub closes a linked issue as a side effect of the merge, normally within a second (#8886: merge 09:30:24,
 * close 09:30:25). The window absorbs webhook/relay lag without stretching so far that an UNRELATED manual
 * close minutes later gets misattributed to a merge that happened to precede it.
 */
export const SUPERSEDED_CLOSE_WINDOW_MS = 5 * 60_000;

/**
 * PURE. The narrowest range of merge times that can still contain a qualifying rival, or null when the
 * evidence for a supersession cannot exist at all.
 *
 * Keeping this beside {@link resolveSupersession} rather than at the call site means the whole "can this even
 * be superseded" judgement is one tested unit, and the caller reduces to a bounded read plus the resolver.
 * The range runs from this PR's own creation (a merge that predates it cannot have taken work not yet
 * proposed) to the latest observed close plus the tolerance, so the read stays small no matter how long the
 * pull request has been sitting.
 */
export function supersededSearchWindow(
  prCreatedAt: string | null | undefined,
  closures: readonly LinkedIssueClosure[],
): { sinceIso: string; untilIso: string } | null {
  const created = parseInstant(prCreatedAt);
  if (created === null) return null;
  const closedInstants = closures.flatMap((closure) => {
    const parsed = parseInstant(closure.closedAt);
    return parsed === null ? [] : [parsed.ms];
  });
  if (closedInstants.length === 0) return null;
  return { sinceIso: created.iso, untilIso: new Date(Math.max(...closedInstants) + SUPERSEDED_CLOSE_WINDOW_MS).toISOString() };
}

/** PURE. Parse a GitHub timestamp, keeping the original string beside the epoch ms so a caller that has
 *  already proved a timestamp parses never needs a second, unreachable null-check to use its text. Null when
 *  the value is absent or unparseable. */
function parseInstant(value: string | null | undefined): { iso: string; ms: number } | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { iso: value, ms } : null;
}

/**
 * PURE. Decide whether this pull request was superseded, and by which rival.
 *
 * Returns null -- meaning "not superseded, leave the disposition alone" -- for every case that is not a fully
 * evidenced collision. Determinism matters because the result closes a PR: candidates are resolved in
 * ascending issue number, and within one issue the EARLIEST qualifying merge wins, so the same inputs always
 * name the same rival regardless of row order.
 */
export function resolveSupersession(args: {
  prNumber: number;
  /** The superseded PR's own creation time. Absent (never synced) ⇒ null, since fact 1 cannot be established. */
  prCreatedAt: string | null | undefined;
  closures: readonly LinkedIssueClosure[];
  mergedRivals: readonly MergedRivalPullRequest[];
}): SupersededByRival | null {
  const created = parseInstant(args.prCreatedAt);
  if (created === null) return null;
  const closures = [...args.closures].sort((a, b) => a.issueNumber - b.issueNumber);
  for (const closure of closures) {
    if (closure.state === "open") continue;
    const closed = parseInstant(closure.closedAt);
    if (closed === null) continue;
    // Fact 1: the issue was still open when this PR was created. A PR that cited an ALREADY-closed issue is
    // the gaming case the linked-issue guardrail exists for, and must keep reading as `missing_linked_issue`.
    if (closed.ms <= created.ms) continue;
    let earliest: { rival: MergedRivalPullRequest; mergedIso: string; mergedMs: number } | null = null;
    // Ascending PR number, so that two rivals merged at the SAME instant (a batch merge lands both `merged_at`
    // values in the same second often enough to matter) resolve to the lower number rather than to whichever
    // row the database happened to return first.
    for (const rival of [...args.mergedRivals].sort((a, b) => a.number - b.number)) {
      if (rival.number === args.prNumber) continue;
      if (!rival.linkedIssues.includes(closure.issueNumber)) continue;
      const merged = parseInstant(rival.mergedAt);
      if (merged === null) continue;
      // Fact 2: the rival merged inside the window that ends at the close -- after this PR opened (a merge
      // that predates it cannot have taken work this PR had not yet proposed) and not so long before the
      // close that some other actor is the likelier cause.
      if (merged.ms < created.ms) continue;
      if (merged.ms > closed.ms + SUPERSEDED_CLOSE_WINDOW_MS) continue;
      if (earliest !== null && merged.ms >= earliest.mergedMs) continue;
      earliest = { rival, mergedIso: merged.iso, mergedMs: merged.ms };
    }
    if (earliest !== null) {
      return {
        issueNumber: closure.issueNumber,
        rivalPullNumber: earliest.rival.number,
        rivalMergedAt: earliest.mergedIso,
        issueClosedAt: closed.iso,
      };
    }
  }
  return null;
}
