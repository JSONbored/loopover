-- Convergence (RAG / codebase index — Layer C, flag GITTENSORY_REVIEW_RAG): the chunk-text STORE that backs
-- vector retrieval. This is the missing storage half of RAG: src/review/rag.ts already reads/writes this table
-- (the retrieval path was wired in the rag-wire chunk) but no migration created it, so the index was unbacked.
-- This migration creates it so the index-population job (src/review/rag-index.ts → upsertChunks) has somewhere
-- to write the chunk text and retrieval (retrieveContext → readChunkTexts) has somewhere to read it from.
--
-- WHO READS/WRITES IT — every repo_chunks SQL string in src/review/rag.ts. The columns below are derived
-- EXACTLY from those statements (do not add/rename columns without matching the SQL):
--   - upsertChunks:        INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (…)
--                          ON CONFLICT(id) DO UPDATE SET text=…, kind=…, chunk_index=…, updated_at=CURRENT_TIMESTAMP
--   - countRepoChunks:     SELECT COUNT(*) FROM repo_chunks WHERE project = ? AND repo = ?
--   - deleteChunksForPaths:SELECT id FROM repo_chunks WHERE project=? AND repo=? AND path IN (…)
--                          DELETE FROM repo_chunks WHERE id IN (…)
--   - readChunkTexts:      SELECT id, text FROM repo_chunks WHERE id IN (…)
-- So the column set is { id, project, repo, path, chunk_index, kind, text, updated_at } — `id` is the PK
-- (ON CONFLICT(id) target; vector ids and the storage PK are GLOBAL — the chunk id already embeds the
-- namespace, see chunkId() in rag.ts), and `updated_at` carries the conflict touch.
--
-- The vector EMBEDDING itself lives in Vectorize (the `gittensory-review-rag` index), NOT here — this table is
-- only the chunk text + light addressing metadata. Vectorize is the index; repo_chunks is the source-of-truth
-- text the retrieved vector ids resolve back to.
--
-- Kept raw-SQL-only (matching the 0046–0050 convergence parity-store convention); deliberately NOT added to the
-- Drizzle schema. Additive + idempotent (IF NOT EXISTS): the table is only ever read/written when the
-- GITTENSORY_REVIEW_RAG flag is ON AND a Vectorize/AI binding is present, so a deploy without RAG is unaffected.
--
-- Privacy: indexes a repo's CODE/docs for code-review context only (isIndexablePath skips the content/data
-- corpus). Internal review infrastructure — never surfaced publicly beyond the prompt the reviewer sees.
CREATE TABLE IF NOT EXISTS repo_chunks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The hot reads all scope by (project, repo): countRepoChunks (the cold-index COUNT) and deleteChunksForPaths
-- (the path lookup). Index (project, repo, path) so both the COUNT and the path-scoped delete are cheap; this
-- composite also covers the (project, repo) prefix the COUNT uses.
CREATE INDEX IF NOT EXISTS idx_repo_chunks_project_repo_path ON repo_chunks (project, repo, path);
