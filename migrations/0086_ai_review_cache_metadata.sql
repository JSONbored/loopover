-- Store structured, non-secret observability for cached AI reviews so cache hits retain the same RAG attribution
-- metadata as the cold review that produced the notes/findings.
ALTER TABLE ai_review_cache ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
