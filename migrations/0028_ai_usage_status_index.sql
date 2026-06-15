-- Covers the daily AI-neuron budget query (sumAiEstimatedNeuronsSince):
--   SELECT sum(estimated_neurons) FROM ai_usage_events WHERE status = 'ok' AND created_at >= ?
-- Without this index that aggregate full-scans ai_usage_events, and it runs on every AI review/summary.
-- Numbered 0028 to avoid colliding with migrations 0026/0027 reserved by the AI-review PR (#652); the
-- D1 migration runner applies un-applied files in order and tolerates gaps.
CREATE INDEX IF NOT EXISTS ai_usage_events_status_created_idx ON ai_usage_events (status, created_at);
