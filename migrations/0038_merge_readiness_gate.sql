-- Merge-readiness composite gate (#551). One tunable `merge_readiness_gate_mode`: off (default) | advisory |
-- block. When set, it rolls the four sub-gates (linked-issue, duplicate, quality/readiness, slop) into a
-- single `Gittensory Gate` pass/fail so a maintainer keeps ONE required check instead of four. Default 'off'
-- preserves existing behavior for every current repo.
ALTER TABLE repository_settings ADD COLUMN merge_readiness_gate_mode TEXT NOT NULL DEFAULT 'off';
