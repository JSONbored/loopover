// Read-only client for the local ranked-candidates API (#7675). The dashboard is a browser app and the miner's
// discovery-ranking store is a `node:sqlite` file on disk, so the view never touches SQL — it fetches the dev
// server's local read-only endpoint (see `vite-ranked-candidates-api.ts`), which itself calls into
// `packages/loopover-miner/lib/ranked-candidates.js`'s existing exports. Mirrors `lib/run-history.ts`'s shape.
//
// This surfaces the SAME per-issue discovery breakdown (laneFit/freshness/potential/feasibility/dupRisk) the
// browser extension's opportunity badge already reads from this endpoint (#4859 prerequisite) — no ranking
// logic duplicated here, strictly a read-only view of already-existing data.

import { DEMO_RANKED_CANDIDATES, isDemoMode } from "./demo-data";

export const RANKED_CANDIDATES_API_PATH = "/api/ranked-candidates";

/** One ranked-candidate row as served by the local API — mirrors `ranked-candidates.js`'s row shape. */
export type RankedCandidateRow = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  htmlUrl: string | null;
  rankScore: number;
  laneFit: number;
  freshness: number;
  potential: number;
  feasibility: number;
  dupRisk: number;
  rankedAt: string;
};

export type RankedCandidatesResult = { ok: true; candidates: RankedCandidateRow[] } | { ok: false; error: string };

function isRankedCandidateRow(value: unknown): value is RankedCandidateRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.repoFullName === "string" &&
    typeof row.issueNumber === "number" &&
    typeof row.title === "string" &&
    (row.htmlUrl === null || typeof row.htmlUrl === "string") &&
    typeof row.rankScore === "number" &&
    typeof row.laneFit === "number" &&
    typeof row.freshness === "number" &&
    typeof row.potential === "number" &&
    typeof row.feasibility === "number" &&
    typeof row.dupRisk === "number" &&
    typeof row.rankedAt === "string"
  );
}

/** Stable React key / identity for a ranked-candidate row. */
export function rankedCandidateRowKey(row: Pick<RankedCandidateRow, "repoFullName" | "issueNumber">): string {
  return `${row.repoFullName}#${row.issueNumber}`;
}

/** Render a 0..1 score fraction as a whole-percent string ("0.81" -> "81%"). */
export function formatScorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Fetch the local ranked-candidates rows. Failures (server down, malformed payload) surface as a typed error
 *  result — the view renders them as a message, never a crash. `fetchImpl` is injectable for tests. */
export async function fetchRankedCandidates(fetchImpl: typeof fetch = fetch): Promise<RankedCandidatesResult> {
  if (isDemoMode()) return { ok: true, candidates: DEMO_RANKED_CANDIDATES };
  try {
    const response = await fetchImpl(RANKED_CANDIDATES_API_PATH);
    if (!response.ok) return { ok: false, error: `local ranked-candidates API responded ${response.status}` };
    const payload: unknown = await response.json();
    const candidates = (payload as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || !candidates.every(isRankedCandidateRow)) {
      return { ok: false, error: "local ranked-candidates API returned an unexpected payload shape" };
    }
    return { ok: true, candidates };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local ranked-candidates API",
    };
  }
}
