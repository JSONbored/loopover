// Loop results-delivery composer (pure) — packages a completed loop iteration into the customer-facing
// result: a PR link, a plain-language summary, and a bounded diff preview (#4801, part of the Rent-a-Loop
// path #4778). Deterministic and side-effect-free: a plain in/out transform over already-computed iteration
// metadata (no IO, no GitHub calls), mirroring the intake bridge (#4798) at the other end of the loop.

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
export function buildResultsPayload(result: IterationResult): ResultsPayload {
  const normalized: DiffPreviewFile[] = (result.changedFiles ?? []).map((f) => ({
    path: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
  const totals = normalized.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );

  const hasPr = result.prNumber !== null && result.prNumber !== undefined;
  const prLink = hasPr ? `https://github.com/${result.repoFullName}/pull/${result.prNumber}` : null;
  const status: LoopResultStatus = result.status ?? "open";

  const prPart = hasPr ? `Opened PR #${result.prNumber} in ${result.repoFullName}` : `No pull request was opened for ${result.repoFullName}`;
  const changePart =
    totals.files === 0
      ? "no file changes"
      : `${totals.files} file${totals.files === 1 ? "" : "s"} changed (+${totals.additions} / -${totals.deletions})`;
  const summary = `${prPart}: ${result.title}. ${changePart}. Status: ${status}.`;

  return { prLink, summary, diffPreview: normalized.slice(0, MAX_DIFF_PREVIEW_FILES), totals };
}
