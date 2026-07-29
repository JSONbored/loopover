// Loop results-delivery composer (pure) — packages a completed loop iteration into the customer-facing
// result: a PR link, a plain-language summary, and a bounded diff preview (#4801, part of the Rent-a-Loop
// path #4778). Deterministic and side-effect-free: a plain in/out transform over already-computed iteration
// metadata (no IO, no GitHub calls), mirroring the intake bridge (#4798) at the other end of the loop.

import { redactSecrets } from "./subprocess-env.js";

// Cap the preview so a large change never floods the customer surface; the totals below still count every file.
export const MAX_DIFF_PREVIEW_FILES = 10;

export type LoopResultStatus = "open" | "merged" | "closed";

export type ResultChangedFile = {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
};

/** The already-computed outcome of one completed loop iteration. */
export type IterationResult = {
  repoFullName: string;
  /** The opened pull request's number, or null/absent when the iteration produced no PR. */
  prNumber?: number | null | undefined;
  title: string;
  changedFiles?: ResultChangedFile[] | undefined;
  status?: LoopResultStatus | undefined;
};

export type DiffPreviewFile = { path: string; additions: number; deletions: number };

export type ResultsPayload = {
  /** Canonical PR URL, or null when no PR was opened. */
  prLink: string | null;
  /** One readable, public-safe sentence a customer can act on without assembling anything. */
  summary: string;
  /** Up to {@link MAX_DIFF_PREVIEW_FILES} changed files; `totals` still reflects the full change. */
  diffPreview: DiffPreviewFile[];
  totals: { files: number; additions: number; deletions: number };
};

/** Package a completed iteration into the customer-facing results payload (#4801). Pure: it formats
 *  already-fetched iteration metadata, it does not fetch, open, or deliver anything. */
// #9611: the same path-safety guard restated locally (this engine package must not import from the miner
// package, and governor-ledger.ts keeps its own copy for the same reason): a repo segment is entirely
// [A-Za-z0-9._-] and is not a bare "." / ".." traversal segment.
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
function isValidRepoSegment(segment: string): boolean {
  return REPO_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..";
}

// #9611: same non-negative-integer normalization the sibling Rent-a-Loop modules use (tenant-quota.ts etc.),
// so a caller-supplied negative or fractional additions/deletions count can't flow into totals or the diff.
function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function buildResultsPayload(result: IterationResult): ResultsPayload {
  const normalized: DiffPreviewFile[] = (result.changedFiles ?? []).map((f) => ({
    path: f.path,
    additions: finiteNonNegativeInt(f.additions ?? 0),
    deletions: finiteNonNegativeInt(f.deletions ?? 0),
  }));
  const totals = normalized.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );

  // #9611: `prLink` becomes a clickable customer-facing URL, so validate BOTH interpolated values. An
  // unvalidated repoFullName like "acme/widgets/../../evil" resolves in the browser to github.com/evil; a
  // non-positive or non-integer prNumber renders ".../pull/0" or ".../pull/-3". Treat repoFullName as real
  // only when it is exactly two path-safe segments, and require a positive integer PR number.
  const repoSegments = result.repoFullName.split("/");
  const validRepo = repoSegments.length === 2 && repoSegments.every((segment) => isValidRepoSegment(segment));
  const repoDisplay = validRepo ? result.repoFullName : "unknown repository";

  const hasPr =
    result.prNumber !== null && result.prNumber !== undefined && Number.isInteger(result.prNumber) && result.prNumber > 0;
  const prLink = hasPr && validRepo ? `https://github.com/${result.repoFullName}/pull/${result.prNumber}` : null;
  const status: LoopResultStatus = result.status ?? "open";

  const prPart = hasPr ? `Opened PR #${result.prNumber} in ${repoDisplay}` : `No pull request was opened for ${repoDisplay}`;
  const changePart =
    totals.files === 0
      ? "no file changes"
      : `${totals.files} file${totals.files === 1 ? "" : "s"} changed (+${totals.additions} / -${totals.deletions})`;
  // `result.title` is contributor/miner-authored free text; scrub it with the same secret-redaction primitive this
  // package already applies to any free text that reaches a public surface (pr-body-draft, gate-advisory, the
  // agent-sdk driver) so the documented "public-safe" contract actually holds for a title carrying a token shape.
  const safeTitle = redactSecrets(result.title);
  const summary = `${prPart}: ${safeTitle}. ${changePart}. Status: ${status}.`;

  return { prLink, summary, diffPreview: normalized.slice(0, MAX_DIFF_PREVIEW_FILES), totals };
}
