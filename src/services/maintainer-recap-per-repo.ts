// Maintainer-recap PER-REPO section (#2241, content slice of the #1963 recap digest).
//
// Pure section builder over a RecapReport projection: a compact per-repo breakdown of PRs
// reviewed / merged / closed in the window, sorted by volume (reviewed = the terminal-outcome
// sample size) and capped like the alerts embed (MAX_LISTED = 8 at src/review/alerts.ts:150),
// with a "(+N more)" remainder line mirroring listSuffix at src/review/alerts.ts:158. No delivery,
// no scheduling — just one titled section for the formatter.
//
// Compatible with the full RecapReport (#2239 / maintainer-recap.ts): this file only needs the
// window + `repos` projection (repoFullName + reviewed/merged/closed), so it stays decoupled from
// the foundation builder and from sibling sections (own file → zero shared-file conflict surface).
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";

// Mirror alerts.ts:150 — keep the digest readable; the remainder is noted, not dropped silently.
const MAX_LISTED = 8;

/** One repo's window activity — structurally compatible with RecapReport's MaintainerRecapRepo. */
export type PerRepoRecapInput = {
  repoFullName: string;
  /** PRs with a terminal outcome (merged or closed) over the window — the volume/sort key. */
  reviewed: number;
  merged: number;
  closed: number;
};

/** Projection of RecapReport used by the per-repo section (window + repos only). */
export type PerRepoRecapSource = {
  windowDays: number;
  repos: PerRepoRecapInput[];
};

/** One rendered row: the redacted repo label + its window counts. */
export type PerRepoRecapRow = {
  repo: string;
  reviewed: number;
  merged: number;
  closed: number;
};

/** One titled digest section: structured rows for consumers + ready-to-emit lines for the formatter. */
export type PerRepoRecapSection = {
  title: string;
  /** Active repos, sorted by volume and capped at MAX_LISTED. */
  rows: PerRepoRecapRow[];
  /** Active repos beyond the cap (drives the "(+N more)" line); 0 when nothing was truncated. */
  remainder: number;
  lines: string[];
};

/** Public-safe scrub for a repo label pulled into the section (defense in depth — repo full names are
 *  public, but a mis-shaped label must never leak a local path). Mirrors maintainer-recap-calibration.ts. */
function sanitizeRecapText(value: string): string {
  return value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
}

/**
 * Pure per-repo section over a RecapReport projection.
 *
 * - Zero-activity repos (`reviewed === 0`) are excluded — they contribute no outcome sample.
 * - Sort is by `reviewed` descending (volume), tie-broken by repo label ascending for determinism.
 * - The list is capped at {@link MAX_LISTED}; any surplus is reported via `remainder` + a "(+N more)" line.
 */
export function buildPerRepoRecapSection(report: PerRepoRecapSource): PerRepoRecapSection {
  const active = report.repos
    .filter((repo) => repo.reviewed > 0)
    // Volume-first, then label — the `|| localeCompare` arm keeps ties deterministic across runs.
    .sort((a, b) => b.reviewed - a.reviewed || a.repoFullName.localeCompare(b.repoFullName));

  const shown = active.slice(0, MAX_LISTED);
  const remainder = active.length - shown.length;

  const rows: PerRepoRecapRow[] = shown.map((repo) => ({
    repo: sanitizeRecapText(repo.repoFullName),
    reviewed: repo.reviewed,
    merged: repo.merged,
    closed: repo.closed,
  }));

  const title = "Per-repo";
  const lines =
    rows.length === 0
      ? [`No repo activity in the last ${report.windowDays} day(s).`]
      : [
          ...rows.map(
            (row) => `${row.repo}: reviewed ${row.reviewed}, merged ${row.merged}, closed ${row.closed}`,
          ),
          ...(remainder > 0 ? [`(+${remainder} more)`] : []),
        ];

  return {
    title,
    rows,
    remainder,
    lines: lines.map(sanitizeRecapText),
  };
}
