-- Impact-map query cache (#4500): computeImpactMap issues one retrieveContextWithMetrics call per
-- changed-symbol file (up to MAX_IMPACT_MAP_INPUT_FILES=20), and each call does a REAL embedding-model
-- inference call plus a live vector-index query with no result cache -- only a 60-second cold-index
-- existence check is memoized (rag.ts's chunkCountCache), not query results. Unlike grounding_file_content_cache
-- (migration 0130), this DOES need a TTL: the underlying vector index can change as new commits get embedded,
-- so an identical query issued later could legitimately have a different correct answer. query_fingerprint
-- hashes every input that affects the result (queryText, excludePaths, topK, minScore, reranker) since all of
-- them vary meaningfully -- excludePaths in particular varies per changed file (each excludes itself).
CREATE TABLE IF NOT EXISTS impact_map_query_cache (
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  query_fingerprint TEXT NOT NULL,
  context TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project, repo, query_fingerprint)
);
