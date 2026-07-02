-- PR reviews cache invalidation marker (#2537): bumped by a `pull_request_review` webhook
-- (submitted/dismissed/edited) to signal the cached `pull_request_reviews` rows are stale. NULL (the
-- default) means no invalidating event has been recorded, so a subsequent fetchAndStorePullRequestDetails
-- pass can skip the `GET /pulls/{n}/reviews` call when reviews_synced_at already covers it.
ALTER TABLE pull_request_detail_sync_state ADD COLUMN reviews_invalidated_at TEXT;

-- One-time cleanup (gate review finding): reviews_synced_at has existed since migration 0006, long before
-- today it gains any cache-skip meaning -- every sync pass since then has stamped it UNCONDITIONALLY,
-- including passes whose review fetch itself failed (there was no per-segment success timestamp before this
-- PR). A `status != 'complete'` row is exactly the set where SOME segment failed on its last sync (`status`
-- only reads 'complete' when that pass recorded zero warnings across files/reviews/checks, which is a
-- reliable historical guarantee reviews specifically succeeded); for every other status the failure could
-- have been reviews, so trusting a stale reviews_synced_at there the moment this cache-skip logic goes live
-- would silently skip re-fetching reviews that were never actually captured. Reset ONLY the ambiguous rows;
-- a genuinely 'complete' row's reviews_synced_at is trustworthy as-is and is left untouched.
UPDATE pull_request_detail_sync_state SET reviews_synced_at = NULL WHERE status != 'complete' AND reviews_synced_at IS NOT NULL;
