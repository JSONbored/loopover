import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";

// Local ETag cache for discovery's small policy-doc fetches (#4842). `discover` refetches each target repo's
// AI-USAGE.md/CONTRIBUTING.md on every run even though they rarely change, spending rate-limit budget on static
// content; this store lets opportunity-fanout.js revalidate with a conditional GET (If-None-Match) instead, and
// GitHub answers an unchanged doc with a 304 that costs no primary rate-limit budget. A 304 is a GitHub-confirmed
// unchanged body -- the cached content is only ever served AFTER a same-run revalidation, never blindly -- so this
// can never surface a stale policy that would wrongly permit autonomous work on an opted-out repo. Same 100%
// local/client-side discipline (mirrors run-state.js and the other stores this package owns via local-store.js):
// the file lives only on this machine and is never uploaded, synced, or phoned home with.

const defaultDbFileName = "policy-doc-cache.sqlite3";

export function resolvePolicyDocCacheDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_POLICY_DOC_CACHE_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolvePolicyDocCacheDbPath(), "invalid_policy_doc_cache_db_path");
}

function normalizeUrl(url) {
  if (typeof url !== "string") throw new Error("invalid_policy_doc_url");
  const trimmed = url.trim();
  if (!trimmed) throw new Error("invalid_policy_doc_url");
  return trimmed;
}

/**
 * Opens the 100% local/client-side miner policy-doc ETag cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4842)
 */
export function initPolicyDocCacheStore(dbPath = resolvePolicyDocCacheDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_doc_cache (
      url TEXT PRIMARY KEY,
      etag TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
  applySchemaMigrations(db, []);

  const getStatement = db.prepare("SELECT etag, content FROM policy_doc_cache WHERE url = ?");
  const putStatement = db.prepare(`
    INSERT INTO policy_doc_cache (url, etag, content, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      etag = excluded.etag,
      content = excluded.content,
      updated_at = excluded.updated_at
  `);

  return {
    dbPath: resolvedPath,
    /** The last-known `{ etag, content }` for a policy-doc URL, or null when it has never been cached. Both columns
     *  are `TEXT NOT NULL`, so a present row always carries string values. */
    get(url) {
      const row = getStatement.get(normalizeUrl(url));
      return row ? { etag: row.etag, content: row.content } : null;
    },
    /** Record the fresh ETag + body so the next run can revalidate it with a conditional GET. */
    put(url, etag, content) {
      const normalizedUrl = normalizeUrl(url);
      if (typeof etag !== "string" || !etag.trim()) throw new Error("invalid_policy_doc_etag");
      if (typeof content !== "string") throw new Error("invalid_policy_doc_content");
      const updatedAt = new Date().toISOString();
      putStatement.run(normalizedUrl, etag, content, updatedAt);
      return { url: normalizedUrl, etag, content, updatedAt };
    },
    close() {
      db.close();
    },
  };
}
