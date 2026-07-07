-- Review-evasion: repeated ready<->draft cycling (#gaming-tactic-draft-cycle). A contributor converting their
-- OWN PR to draft more than once is using draft state as a repeated shield to harvest AI-review/CI feedback
-- for free while dodging the one-shot disposition. Counts every converted_to_draft webhook ever processed for
-- this PR NUMBER (not scoped to head SHA -- a new commit between draft cycles is still the same evasion shape).
ALTER TABLE pull_requests ADD COLUMN draft_conversion_count INTEGER NOT NULL DEFAULT 0;
