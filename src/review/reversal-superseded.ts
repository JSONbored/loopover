// Successor-based reversal heuristics (#8166, feeds epic #8082's positive class). This gate's own one-shot
// design tells a wronged contributor "recovery = open a fresh PR", so the reopen-shaped reversal signal
// (`reversal_reopened`) is structurally near-impossible here — verified in production: zero reversal events
// ever, zero bot-closed PRs later merged. The culture's ACTUAL "the bot was wrong" shape is: bot CLOSES
// PR #N, and a SUCCESSOR PR — same linked issue, or same author reworking the same files — later MERGES.
//
// PURE MODULE: the match decision only. Conservative by design (the issue's own bar): a false "the bot was
// wrong" poisons calibration worse than a miss, so a match requires either a shared linked issue (the
// strongest intent signal this repo has — the same set-intersection `duplicate_pr_risk` trusts) or the same
// author reworking a majority of the closed PR's files. Borderline records NOTHING. The wire
// (outcomes-wire.ts's recordSupersededReversals) supplies the data and writes the events.

export const REVERSAL_SUPERSEDED_EVENT_TYPE = "reversal_superseded";

/** A successor must re-touch at least this fraction of the CLOSED PR's files for the same-author path. */
export const SUPERSEDED_FILE_OVERLAP_MIN = 0.5;

/** How far back a merge scans for bot-closed PRs it might supersede. Mirrors the calibration lookbacks'
 *  order of magnitude — a months-later rework is a new effort, not a supersession signal. */
export const SUPERSEDED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export type SupersededSide = {
  authorLogin: string | null | undefined;
  linkedIssues: readonly number[];
  files: readonly string[];
};

export type SupersededHeuristics = {
  sameLinkedIssue: boolean;
  sameAuthorFileOverlap: boolean;
  /** |shared files| / |closed PR's files|; null when the closed PR has no recorded files. */
  fileOverlapRatio: number | null;
};

/**
 * Decide whether `merged` supersedes the bot-closed `closed` PR. Returns the matched heuristics (for the
 * audit trail — every recorded event carries WHY it matched) or null when neither conservative path holds:
 *   • sameLinkedIssue — both sides link at least one common issue number;
 *   • sameAuthorFileOverlap — same author (case-insensitive; unknown authors never match) AND the merged PR
 *     re-touches ≥ {@link SUPERSEDED_FILE_OVERLAP_MIN} of the closed PR's recorded files (a closed PR with
 *     no recorded files can never match this path — fail-open to a miss, never a guess).
 * PURE and deterministic.
 */
export function evaluateSuccessorMatch(merged: SupersededSide, closed: SupersededSide): SupersededHeuristics | null {
  const sameLinkedIssue = closed.linkedIssues.length > 0 && closed.linkedIssues.some((issue) => merged.linkedIssues.includes(issue));

  const mergedAuthor = merged.authorLogin?.trim().toLowerCase() ?? "";
  const closedAuthor = closed.authorLogin?.trim().toLowerCase() ?? "";
  const sameAuthor = mergedAuthor !== "" && mergedAuthor === closedAuthor;

  let fileOverlapRatio: number | null = null;
  if (closed.files.length > 0) {
    const mergedFiles = new Set(merged.files);
    const shared = closed.files.filter((file) => mergedFiles.has(file)).length;
    fileOverlapRatio = shared / closed.files.length;
  }
  const sameAuthorFileOverlap = sameAuthor && fileOverlapRatio !== null && fileOverlapRatio >= SUPERSEDED_FILE_OVERLAP_MIN;

  if (!sameLinkedIssue && !sameAuthorFileOverlap) return null;
  return { sameLinkedIssue, sameAuthorFileOverlap, fileOverlapRatio };
}
