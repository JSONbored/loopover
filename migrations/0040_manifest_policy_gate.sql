-- Focus-manifest policy gate (#555). One tunable `manifest_policy_gate_mode`: off (default) | advisory |
-- block. When set to block, the focus manifest's declared policy (blocked paths, required-linked-issue, test
-- expectations) becomes an enforceable `Gittensory Gate` blocker — surfaced through the single required check.
-- An INDEPENDENT dimension, deliberately not folded into the merge-readiness composite. Default 'off'
-- preserves existing behavior for every current repo.
ALTER TABLE repository_settings ADD COLUMN manifest_policy_gate_mode TEXT NOT NULL DEFAULT 'off';
