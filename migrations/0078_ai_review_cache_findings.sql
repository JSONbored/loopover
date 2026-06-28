-- Preserve the gate-relevant AI verdict when reusing a cached review: the public notes alone are not enough
-- because block-mode consensus/split/inconclusive findings are advisory side effects that must be replayed.
ALTER TABLE ai_review_cache ADD COLUMN findings_json TEXT NOT NULL DEFAULT '[]';
