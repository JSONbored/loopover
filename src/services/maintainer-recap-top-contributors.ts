// Maintainer-recap TOP-CONTRIBUTORS section (#2244, content slice of the #1963 recap digest).
//
// Pure section builder over a RecapReport projection: a leaderboard of the window's most-merged
// contributor logins with merged-PR counts ONLY — NO scoring / reward / trust internals. Every emitted
// line is gated through isPublicSafeText (src/signals/redaction.ts) before it can surface, matching the
// public-safe framing the notifications service already enforces (src/notifications/service.ts).
//
// Own file (mirroring maintainer-recap-calibration.ts) so it stays decoupled from the foundation builder
// and sibling sections — zero shared-file conflict surface. No delivery, no scheduling.
import { isPublicSafeText } from "../signals/redaction";

// Readability cap when the caller does not specify one — mirrors alerts.ts MAX_LISTED.
const DEFAULT_LIMIT = 8;

/** One contributor's window activity — merged-PR count only (public-safe by construction). */
export type TopContributor = { login: string; merged: number };

/** Projection of RecapReport used by the top-contributors section (window + contributors only). */
export type TopContributorsRecapSource = {
  windowDays: number;
  contributors: TopContributor[];
};

/** One titled digest section: structured rows for consumers + ready-to-emit lines for the formatter. */
export type TopContributorsRecapSection = {
  title: string;
  /** Public-safe contributors, sorted by merged desc (ties by login asc), capped at the limit. */
  rows: TopContributor[];
  /** Contributors dropped because their emitted line failed the public-safe gate. */
  dropped: number;
  lines: string[];
};

/**
 * Pure top-contributors section over a RecapReport projection.
 *
 * - Each contributor's emitted line (`login: N merged`) must pass {@link isPublicSafeText}; any that would
 *   leak a reward/score/trust term (or a local path) is DROPPED and counted in `dropped`.
 * - Survivors are sorted by merged descending, ties broken by login ascending (deterministic), then capped
 *   at `limit` (a non-positive limit yields an empty leaderboard).
 */
export function buildTopContributorsRecapSection(
  report: TopContributorsRecapSource,
  limit = DEFAULT_LIMIT,
): TopContributorsRecapSection {
  const withLines = report.contributors.map((c) => ({
    login: c.login,
    merged: c.merged,
    line: `${c.login}: ${c.merged} merged`,
  }));
  // Reject any line that fails the public-safe gate (defense in depth — a login must never carry an
  // economic/identity term or a local path onto a public digest surface).
  const safe = withLines.filter((c) => isPublicSafeText(c.line));
  const dropped = withLines.length - safe.length;

  const ranked = safe
    .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login))
    .slice(0, Math.max(0, limit));

  const title = "Top contributors";
  const lines =
    ranked.length === 0
      ? [`No contributor activity in the last ${report.windowDays} day(s).`]
      : ranked.map((c) => c.line);

  return {
    title,
    rows: ranked.map(({ login, merged }) => ({ login, merged })),
    dropped,
    lines,
  };
}
