-- Screenshot-table PRESENCE-mode staleness correlation (#stale-screenshot-table-fix, follow-up to #2006). JSON
-- `{headSha, evidenceFingerprint}` of the head SHA and before/after-image-URL fingerprint that last satisfied
-- screenshotTableGate's presence-mode check. NULL means presence mode has never satisfied the gate for this PR.
-- Mirrors visual_capture_satisfied_sha's headSha-keying, but also fingerprints the evidence itself since
-- presence mode (unlike bot-capture) has no independently-verified render to key satisfaction on alone.
ALTER TABLE pull_requests ADD COLUMN screenshot_table_presence_satisfied_json TEXT;
