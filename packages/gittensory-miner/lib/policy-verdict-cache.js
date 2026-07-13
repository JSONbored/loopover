import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";

// Local cache of resolved AI-usage-policy verdicts (#4843). Even with #4842's conditional-GET doc cache, the small
// but non-zero cost of resolving `resolveAiPolicyVerdict` from raw doc text was still paid on every discover run.
// This stores the verdict itself, keyed by repo + the ETag of whichever doc actually decided it, so a repeat run
// against an unchanged repo reuses the prior verdict outright once opportunity-fanout.js's same-run conditional-GET
// confirms that doc's ETag hasn't moved -- never served blindly, exactly the same "cheaper, never less correct"
// discipline as policy-doc-cache.js. 100% local/client-side, same as every other store this package owns via
// local-store.js: the file lives only on this machine and is never uploaded, synced, or phoned home with.

const defaultDbFileName = "policy-verdict-cache.sqlite3";
const DECISIVE_DOCS = new Set(["AI-USAGE.md", "CONTRIBUTING.md"]);

export function resolvePolicyVerdictCacheDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "GITTENSORY_MINER_POLICY_VERDICT_CACHE_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolvePolicyVerdictCacheDbPath(), "invalid_policy_verdict_cache_db_path");
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_policy_verdict_repo_full_name");
  const trimmed = repoFullName.trim();
  if (!trimmed) throw new Error("invalid_policy_verdict_repo_full_name");
  return trimmed;
}

function normalizeDecisiveDoc(decisiveDoc) {
  if (!DECISIVE_DOCS.has(decisiveDoc)) throw new Error("invalid_policy_verdict_decisive_doc");
  return decisiveDoc;
}

function normalizeEtag(etag) {
  if (typeof etag !== "string" || !etag.trim()) throw new Error("invalid_policy_verdict_etag");
  return etag;
}

function serializeVerdict(verdict) {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("invalid_policy_verdict");
  }
  return JSON.stringify(verdict);
}

/**
 * Opens the 100% local/client-side miner policy-verdict cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4843)
 */
export function initPolicyVerdictCacheStore(dbPath = resolvePolicyVerdictCacheDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_verdict_cache (
      repo_full_name TEXT PRIMARY KEY,
      decisive_doc TEXT NOT NULL,
      etag TEXT NOT NULL,
      verdict TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
  applySchemaMigrations(db, []);

  const getStatement = db.prepare(
    "SELECT decisive_doc, etag, verdict FROM policy_verdict_cache WHERE repo_full_name = ?",
  );
  const putStatement = db.prepare(`
    INSERT INTO policy_verdict_cache (repo_full_name, decisive_doc, etag, verdict, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo_full_name) DO UPDATE SET
      decisive_doc = excluded.decisive_doc,
      etag = excluded.etag,
      verdict = excluded.verdict,
      updated_at = excluded.updated_at
  `);

  return {
    dbPath: resolvedPath,
    /** The last-known `{ decisiveDoc, etag, verdict }` for a repo, or null when it has never been cached. */
    get(repoFullName) {
      const row = getStatement.get(normalizeRepoFullName(repoFullName));
      if (!row) return null;
      return { decisiveDoc: row.decisive_doc, etag: row.etag, verdict: JSON.parse(row.verdict) };
    },
    /** Record the resolved verdict against the ETag of the doc that decided it, so the next run can reuse it. */
    put(repoFullName, decisiveDoc, etag, verdict) {
      const normalizedRepoFullName = normalizeRepoFullName(repoFullName);
      const normalizedDecisiveDoc = normalizeDecisiveDoc(decisiveDoc);
      const normalizedEtag = normalizeEtag(etag);
      const serializedVerdict = serializeVerdict(verdict);
      const updatedAt = new Date().toISOString();
      putStatement.run(normalizedRepoFullName, normalizedDecisiveDoc, normalizedEtag, serializedVerdict, updatedAt);
      return { repoFullName: normalizedRepoFullName, decisiveDoc: normalizedDecisiveDoc, etag: normalizedEtag, verdict, updatedAt };
    },
    close() {
      db.close();
    },
  };
}
