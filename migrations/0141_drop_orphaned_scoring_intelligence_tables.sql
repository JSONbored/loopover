-- Drop 2 tables scaffolded in 0004_scoring_intelligence.sql that never gained a real reader or writer
-- (#4619, review-stack architecture audit). Their sibling tables from the same migration
-- (scoring_model_snapshots, score_previews, contributor_evidence, contributor_scoring_profiles,
-- burden_forecasts, bounty_lifecycle_events) all got wired with real read+write paths; these two alone
-- never did -- the "issue quality report" concept now lives entirely in the generic signal_snapshots
-- cache via src/services/issue-quality.ts instead. Confirmed zero rows on the live production database
-- before writing this migration (both tables empty).
DROP TABLE IF EXISTS issue_quality_reports;
DROP TABLE IF EXISTS registry_drift_events;
