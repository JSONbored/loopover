-- Merge-train FIFO gate (#selfhost-merge-train). Off by default, same "opt-in, no surprise behavior
-- change" shape as review_evasion_protection: a PR merges the instant its own gate clears today, with
-- zero awareness of an older sibling PR still open in the same repo -- proven live to cause out-of-order
-- merges and the conflicts that follow. "audit" logs what the gate would hold without holding anything;
-- "enforce" actually defers a merge behind a still-viable older sibling.
ALTER TABLE repository_settings ADD COLUMN merge_train_mode TEXT NOT NULL DEFAULT 'off';
