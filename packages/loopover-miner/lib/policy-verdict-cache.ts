import type { AiPolicyVerdict } from "@loopover/engine";
import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { POLICY_VERDICT_CACHE_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";

// Local cache of resolved AI-usage-policy verdicts (#4843). Even with #4842's conditional-GET doc cache, the small
// but non-zero cost of resolving `resolveAiPolicyVerdict` from raw doc text was still paid on every discover run.
// This stores the verdict itself, keyed by repo SCOPE (the tenant's `apiBaseUrl` plus `owner/repo` -- see
// `policyVerdictCacheKey` in opportunity-fanout.js, same "the caller owns what makes a cache key" precedent as
// policy-doc-cache.js keying on the full request URL) + the ETag of whichever doc actually decided it, so a
// repeat run against an unchanged repo reuses the prior verdict outright once opportunity-fanout.js's same-run
// conditional-GET confirms that doc's ETag hasn't moved -- never served blindly, exactly the same "cheaper, never
// less correct" discipline as policy-doc-cache.js. `owner/repo` alone is NOT a safe key: two different tenant
// forge hosts can each have their own unrelated `acme/widgets`, and without the host in the key a verdict
// resolved against one host's docs could be served for the other's. 100% local/client-side, same as every other
// store this package owns via local-store.js: the file lives only on this machine and is never uploaded, synced,
// or phoned home with.

export type PolicyVerdictDecisiveDoc = "AI-USAGE.md" | "CONTRIBUTING.md";

export type PolicyVerdictCacheEntry = {
  decisiveDoc: PolicyVerdictDecisiveDoc;
  etag: string;
  verdict: AiPolicyVerdict;
};

export type PolicyVerdictCacheWrite = PolicyVerdictCacheEntry & {
  repoScope: string;
  updatedAt: string;
};

export type PolicyVerdictCacheStore = {
  dbPath: string;
  /** `repoScope` must uniquely identify a tenant forge host + repo (see `policyVerdictCacheKey` in
   *  opportunity-fanout.js) -- a bare `owner/repo` is not safe across multiple forge hosts. */
  get(repoScope: string): PolicyVerdictCacheEntry | null;
  put(
    repoScope: string,
    decisiveDoc: PolicyVerdictDecisiveDoc,
    etag: string,
    verdict: AiPolicyVerdict,
  ): PolicyVerdictCacheWrite;
  /** Delete every cached verdict row for one repo scope (#6987); returns the number of rows removed. */
  purgeByRepo(repoScope: string): number;
  close(): void;
};

/** The read/write surface opportunity-fanout.js needs to inject a cache without depending on the SQLite store. */
export type PolicyVerdictCache = Pick<PolicyVerdictCacheStore, "get" | "put">;

type PolicyVerdictCacheRow = {
  decisive_doc: string;
  etag: string;
  verdict: string;
};

const defaultDbFileName = "policy-verdict-cache.sqlite3";
const DECISIVE_DOCS = new Set<string>(["AI-USAGE.md", "CONTRIBUTING.md"]);

export function resolvePolicyVerdictCacheDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB", env);
}

function normalizeDbPath(dbPath: string | null | undefined): string {
  return normalizeLocalStoreDbPath(dbPath, resolvePolicyVerdictCacheDbPath(), "invalid_policy_verdict_cache_db_path");
}

function normalizeRepoScope(repoScope: unknown): string {
  if (typeof repoScope !== "string") throw new Error("invalid_policy_verdict_repo_scope");
  const trimmed = repoScope.trim();
  if (!trimmed) throw new Error("invalid_policy_verdict_repo_scope");
  return trimmed;
}

function normalizeDecisiveDoc(decisiveDoc: unknown): PolicyVerdictDecisiveDoc {
  if (!DECISIVE_DOCS.has(decisiveDoc as string)) throw new Error("invalid_policy_verdict_decisive_doc");
  return decisiveDoc as PolicyVerdictDecisiveDoc;
}

function normalizeEtag(etag: unknown): string {
  if (typeof etag !== "string" || !etag.trim()) throw new Error("invalid_policy_verdict_etag");
  return etag;
}

function serializeVerdict(verdict: unknown): string {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("invalid_policy_verdict");
  }
  return JSON.stringify(verdict);
}

/**
 * Opens the 100% local/client-side miner policy-verdict cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4843)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations / purge still use the underlying DatabaseSync until those helpers are
 * migrated. Public API stays synchronous so callers need no async cascade in this #7282 slice.
 */
export function initPolicyVerdictCacheStore(dbPath: string = resolvePolicyVerdictCacheDbPath()): PolicyVerdictCacheStore {
  const resolvedPath = normalizeDbPath(dbPath);
  const { db, driver } = openLocalStoreAdapter(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_verdict_cache (
      repo_scope TEXT PRIMARY KEY,
      decisive_doc TEXT NOT NULL,
      etag TEXT NOT NULL,
      verdict TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
  applySchemaMigrations(db, []);

  const getSql =
    "SELECT decisive_doc, etag, verdict FROM policy_verdict_cache WHERE repo_scope = ?";
  const putSql = `
    INSERT INTO policy_verdict_cache (repo_scope, decisive_doc, etag, verdict, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo_scope) DO UPDATE SET
      decisive_doc = excluded.decisive_doc,
      etag = excluded.etag,
      verdict = excluded.verdict,
      updated_at = excluded.updated_at
  `;

  return {
    dbPath: resolvedPath,
    /** The last-known `{ decisiveDoc, etag, verdict }` for a repo scope, or null when it has never been cached. */
    get(repoScope) {
      const { rows } = driver.query(getSql, [normalizeRepoScope(repoScope)]);
      const row = rows[0] as PolicyVerdictCacheRow | undefined;
      if (!row) return null;
      return {
        decisiveDoc: row.decisive_doc as PolicyVerdictDecisiveDoc,
        etag: row.etag,
        verdict: JSON.parse(row.verdict) as AiPolicyVerdict,
      };
    },
    /** Record the resolved verdict against the ETag of the doc that decided it, so the next run can reuse it. */
    put(repoScope, decisiveDoc, etag, verdict) {
      const normalizedRepoScope = normalizeRepoScope(repoScope);
      const normalizedDecisiveDoc = normalizeDecisiveDoc(decisiveDoc);
      const normalizedEtag = normalizeEtag(etag);
      const serializedVerdict = serializeVerdict(verdict);
      const updatedAt = new Date().toISOString();
      driver.query(putSql, [normalizedRepoScope, normalizedDecisiveDoc, normalizedEtag, serializedVerdict, updatedAt]);
      return { repoScope: normalizedRepoScope, decisiveDoc: normalizedDecisiveDoc, etag: normalizedEtag, verdict, updatedAt };
    },
    /**
     * Delete every cached verdict row for one repo scope (#6987) -- the right-to-be-forgotten path
     * `loopover-miner purge` invokes. Returns the number of rows removed. Reuses store-maintenance.js's
     * identifier-guarded purgeStoreByRepo, exactly like the other repo-scoped stores.
     */
    purgeByRepo(repoScope) {
      return purgeStoreByRepo(db, POLICY_VERDICT_CACHE_PURGE_SPEC, normalizeRepoScope(repoScope));
    },
    close() {
      db.close();
    },
  };
}
