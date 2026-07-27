-- #9083: no RETENTION_POLICY (src/db/retention.ts) table had an index whose LEADING column is its
-- retention timestamp -- every existing index on these tables either doesn't exist at all
-- (webhook_events, signal_snapshots, score_previews, repo_snapshots) or has the timestamp only in a
-- trailing position (audit_events, ai_usage_events, product_usage_events,
-- github_rate_limit_observations, agent_context_snapshots, notification_deliveries). Paired with the
-- pruneExpiredRecords rewrite (PK-ordered range delete instead of a rowid/ctid semi-join), the inner
-- SELECT in each batched delete is now an index range scan instead of a full table scan.
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at ON ai_usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_product_usage_events_occurred_at ON product_usage_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_github_rate_limit_observations_observed_at ON github_rate_limit_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_signal_snapshots_generated_at ON signal_snapshots(generated_at);
CREATE INDEX IF NOT EXISTS idx_score_previews_generated_at ON score_previews(generated_at);
CREATE INDEX IF NOT EXISTS idx_repo_snapshots_fetched_at ON repo_snapshots(fetched_at);
CREATE INDEX IF NOT EXISTS idx_agent_context_snapshots_created_at ON agent_context_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created_at ON notification_deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_predicted_gate_calls_created_at ON predicted_gate_calls(created_at);

-- #9083: the four never-pruned caches (grounding_file_content_cache, ai_review_cache, ai_slop_cache,
-- linked_issue_satisfaction_cache) newly gained a retention rule in the same change -- index their
-- timestamp column too so the new prune sweep stays cheap as they grow.
CREATE INDEX IF NOT EXISTS idx_grounding_file_content_cache_fetched_at ON grounding_file_content_cache(fetched_at);
CREATE INDEX IF NOT EXISTS idx_ai_review_cache_created_at ON ai_review_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_slop_cache_created_at ON ai_slop_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_linked_issue_satisfaction_cache_created_at ON linked_issue_satisfaction_cache(created_at);

-- #9083: the three newly-retained append-only tables (review_audit, decision_records, orb_webhook_events)
-- each already had an index touching their timestamp column, but only in a trailing/combined position --
-- add the leading single-column index the new PK-ordered delete needs.
CREATE INDEX IF NOT EXISTS idx_review_audit_created_at ON review_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_decision_records_created_at ON decision_records(created_at);
CREATE INDEX IF NOT EXISTS idx_orb_webhook_events_received_at ON orb_webhook_events(received_at);
