-- #9034: confidence-parking used to be an unbounded absorbing state. A blocker BELOW the close-confidence floor
-- still blocks, but under the default `hold_for_review` disposition it converts a one-shot close into an OPEN
-- hold -- with no cap on how many times the same PR may re-enter that hold. A PR shaped to keep drawing
-- low-confidence blockers therefore survives indefinitely, consuming the manual queue on every roll, and (with
-- the re-roll surface) can be walked toward a clean merge from there. These columns count the holds so the
-- Nth one closes instead. The head SHA makes the count per-ROLL rather than per-pass: a re-gate of the same
-- commit is the same hold, while each new commit that draws a fresh low-confidence blocker is a new one.
ALTER TABLE pull_requests ADD COLUMN low_confidence_hold_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN low_confidence_hold_head_sha TEXT;
