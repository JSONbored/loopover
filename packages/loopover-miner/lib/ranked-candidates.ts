import type { SQLOutputValue } from "node:sqlite";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { RANKED_CANDIDATES_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";

// Last-discover-run ranked-candidates snapshot (#4859 prerequisite): `discover-cli.js`'s runDiscover already
// computes the FULL per-issue ranking breakdown (rankScore/laneFit/freshness/potential/feasibility/dupRisk, via
// opportunity-ranker.js) and prints it to stdout with `--json`, but nothing durable ever stores it -- the
// portfolio queue only carries a single derived `priority` number, not the per-dimension detail. This module
// gives that output a durable home so a local HTTP endpoint (apps/loopover-miner-ui's ranked-candidates
// dashboard view) can serve it instead of requiring a manual copy/paste of `discover --json`'s output.
//
// Deliberately a SNAPSHOT, not a ledger: each real (non-dry-run) discover invocation REPLACES the whole table
// wholesale (this run's candidates are what's live-fetchable now; a stale prior run's rows would be actively
// misleading, not historically useful the way an append-only ledger's rows are). No forge (api_base_url) scoping
// either -- unlike the portfolio-queue/claim-ledger/governor-state stores, which track ongoing state across many
// runs and many repos over time, this is a disposable "the miner's current opinion" cache for one local
// operator's browsing session; if a later run targets a different forge, replacing the whole snapshot is exactly
// the right behavior, not a gap.

export type RankedCandidateInput = {
  repoFullName: string;
  issueNumber: number;
  title?: string;
  htmlUrl?: string | null;
  rankScore: number;
  laneFit?: number;
  freshness?: number;
  potential?: number;
  feasibility?: number;
  dupRisk?: number;
};

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

export type RankedCandidatesSaveResult = {
  count: number;
  rankedAt: string;
};

export type RankedCandidatesStore = {
  dbPath: string;
  saveRankedCandidates(candidates: RankedCandidateInput[], nowMs?: number): RankedCandidatesSaveResult;
  listRankedCandidates(): RankedCandidateRow[];
  /** Delete every snapshot row for one repo (#8009); returns the number of rows removed. */
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** Private shape of a normalized candidate (a `RankedCandidateRow` minus its store-assigned `rankedAt`). */
type NormalizedRankedCandidate = {
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
};

/** Private shape of a `miner_ranked_candidates` SELECT * row after casting off `Record<string, SQLOutputValue>`. */
type RankedCandidateDbRow = {
  repo_full_name: string;
  issue_number: number;
  title: string;
  html_url: string | null;
  rank_score: number;
  lane_fit: number;
  freshness: number;
  potential: number;
  feasibility: number;
  dup_risk: number;
  ranked_at: string;
};

const defaultDbFileName = "ranked-candidates.sqlite3";
let defaultRankedCandidatesStore: RankedCandidatesStore | null = null;

export function resolveRankedCandidatesDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_RANKED_CANDIDATES_DB", env);
}

function normalizeDbPath(dbPath: string): string {
  return normalizeLocalStoreDbPath(dbPath, resolveRankedCandidatesDbPath(), "invalid_ranked_candidates_db_path");
}

function normalizeFiniteRankDimension(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/** Guard an owner/repo value to the canonical `owner/repo` shape. Shared by the candidate write path and
 *  purgeByRepo (#8009), each throwing its own error name — a rejected candidate and a rejected purge target are
 *  different operator mistakes. */
function normalizeRepoFullName(value: unknown, error: string): string {
  const repoFullName = typeof value === "string" ? value.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) throw new Error(error);
  return `${owner}/${repo}`;
}

function normalizeCandidate(candidate: RankedCandidateInput): NormalizedRankedCandidate {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid_ranked_candidate");
  const repoFullName = normalizeRepoFullName(candidate.repoFullName, "invalid_ranked_candidate");
  const issueNumber = candidate.issueNumber;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("invalid_ranked_candidate");
  const rankScore = Number(candidate.rankScore);
  if (!Number.isFinite(rankScore)) throw new Error("invalid_ranked_candidate");
  return {
    repoFullName,
    issueNumber,
    title: typeof candidate.title === "string" ? candidate.title : "",
    htmlUrl: typeof candidate.htmlUrl === "string" ? candidate.htmlUrl : null,
    rankScore,
    // A dimension the ranker didn't supply degrades to the SAME neutral defaults opportunity-ranker.js's own
    // normalizeCandidate uses for a missing signal (0 for a benefit dimension, 1 -- max risk -- for dupRisk),
    // rather than silently coercing a non-finite value to 0 across the board.
    laneFit: normalizeFiniteRankDimension(candidate.laneFit, 0),
    freshness: normalizeFiniteRankDimension(candidate.freshness, 0),
    potential: normalizeFiniteRankDimension(candidate.potential, 0),
    feasibility: normalizeFiniteRankDimension(candidate.feasibility, 0),
    dupRisk: normalizeFiniteRankDimension(candidate.dupRisk, 1),
  };
}

function rowToCandidate(row: RankedCandidateDbRow): RankedCandidateRow {
  return {
    repoFullName: row.repo_full_name,
    issueNumber: row.issue_number,
    title: row.title,
    htmlUrl: row.html_url,
    rankScore: row.rank_score,
    laneFit: row.lane_fit,
    freshness: row.freshness,
    potential: row.potential,
    feasibility: row.feasibility,
    dupRisk: row.dup_risk,
    rankedAt: row.ranked_at,
  };
}

function asRankedCandidateDbRow(row: Record<string, SQLOutputValue>): RankedCandidateDbRow {
  return row as unknown as RankedCandidateDbRow;
}

/**
 * Opens the 100% local/client-side ranked-candidates snapshot store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents.
 */
export function initRankedCandidatesStore(dbPath: string = resolveRankedCandidatesDbPath()): RankedCandidatesStore {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS miner_ranked_candidates (
      repo_full_name TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      html_url TEXT,
      rank_score REAL NOT NULL,
      lane_fit REAL NOT NULL,
      freshness REAL NOT NULL,
      potential REAL NOT NULL,
      feasibility REAL NOT NULL,
      dup_risk REAL NOT NULL,
      ranked_at TEXT NOT NULL,
      PRIMARY KEY (repo_full_name, issue_number)
    )
  `);
  // Schema-version convention (#4832): stamp the baseline. No post-baseline migrations yet -- this is a new store.
  applySchemaMigrations(db, []);

  const deleteAllStatement = db.prepare("DELETE FROM miner_ranked_candidates");
  const insertStatement = db.prepare(`
    INSERT INTO miner_ranked_candidates
      (repo_full_name, issue_number, title, html_url, rank_score, lane_fit, freshness, potential, feasibility, dup_risk, ranked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listStatement = db.prepare("SELECT * FROM miner_ranked_candidates ORDER BY rank_score DESC");

  // Atomic replace: a reader between the DELETE and the INSERTs must never observe an empty table mid-write.
  // node:sqlite's DatabaseSync has no `.transaction()` helper (unlike better-sqlite3) -- mirrors
  // portfolio-queue.js's batchClaim: explicit BEGIN IMMEDIATE/COMMIT, ROLLBACK + rethrow on failure.
  function replaceAll(normalizedCandidates: NormalizedRankedCandidate[], rankedAt: string): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteAllStatement.run();
      for (const candidate of normalizedCandidates) {
        insertStatement.run(
          candidate.repoFullName,
          candidate.issueNumber,
          candidate.title,
          candidate.htmlUrl,
          candidate.rankScore,
          candidate.laneFit,
          candidate.freshness,
          candidate.potential,
          candidate.feasibility,
          candidate.dupRisk,
          rankedAt,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    dbPath: resolvedPath,
    /** Replaces the whole snapshot wholesale with this run's ranked candidates. `nowMs` is caller-supplied
     *  (never reads the clock internally) so tests get a deterministic `rankedAt`. */
    saveRankedCandidates(candidates, nowMs) {
      const normalized = (Array.isArray(candidates) ? candidates : []).map(normalizeCandidate);
      const rankedAt = new Date(Number.isFinite(nowMs) ? (nowMs as number) : Date.now()).toISOString();
      replaceAll(normalized, rankedAt);
      return { count: normalized.length, rankedAt };
    },
    /** Every candidate from the last saved run, highest rankScore first. Empty (not an error) before any
     *  discover run has ever saved a snapshot, or if the last run found zero candidates. */
    listRankedCandidates() {
      return listStatement.all().map((row) => rowToCandidate(asRankedCandidateDbRow(row)));
    },
    /** Explicit, operator-invoked right-to-be-forgotten purge (#8009) — never runs automatically; this is what
     *  `loopover-miner purge` invokes. Reuses store-maintenance.js's identifier-guarded purgeStoreByRepo,
     *  exactly like the other repo-scoped stores. */
    purgeByRepo(repoFullName) {
      return purgeStoreByRepo(db, RANKED_CANDIDATES_PURGE_SPEC, normalizeRepoFullName(repoFullName, "invalid_repo_full_name"));
    },
    close() {
      db.close();
    },
  };
}

function getDefaultRankedCandidatesStore(): RankedCandidatesStore {
  defaultRankedCandidatesStore ??= initRankedCandidatesStore();
  return defaultRankedCandidatesStore;
}

export function saveRankedCandidates(candidates: RankedCandidateInput[], nowMs?: number): RankedCandidatesSaveResult {
  return getDefaultRankedCandidatesStore().saveRankedCandidates(candidates, nowMs);
}

export function listRankedCandidates(): RankedCandidateRow[] {
  return getDefaultRankedCandidatesStore().listRankedCandidates();
}

export function closeDefaultRankedCandidatesStore(): void {
  if (!defaultRankedCandidatesStore) return;
  defaultRankedCandidatesStore.close();
  defaultRankedCandidatesStore = null;
}
