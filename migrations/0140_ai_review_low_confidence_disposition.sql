-- AI-review low-confidence disposition (#4603, resolving the dead aiReviewCloseConfidence floor audit
-- finding). Governs what happens when an ai_consensus_defect/ai_review_split finding's confidence is BELOW
-- the configured aiReviewCloseConfidence floor: 'hold_for_review' (default -- flips the undocumented
-- unconditional-close drift from commit 311b7613d/#1781 back to a safe default) routes the would-be close
-- through the existing held-for-manual-review mechanism instead of one-shot-closing; 'one_shot' keeps
-- today's unconditional-close behavior (opt-in); 'advisory_only' drops a sub-floor finding to fully
-- non-blocking. See src/rules/advisory.ts's isConfiguredGateBlocker and gittensory-gate-setting-wiring.
ALTER TABLE repository_settings ADD COLUMN ai_review_low_confidence_disposition TEXT NOT NULL DEFAULT 'hold_for_review';
