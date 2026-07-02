-- One-off repair for pull_request_detail_sync_state.reviews_synced_at (#2537 review fix).
--
-- ROOT CAUSE (already fixed in code, this same PR): every pre-existing writer of reviews_synced_at
-- (backfillOpenPullRequestDetails / refreshPullRequestDetails / backfillRepository, all in
-- src/github/backfill.ts) stamped it UNCONDITIONALLY on every sync pass, success or failure -- even a pass that
-- ended with `status: 'partial'` due to a review-fetch error still wrote a fresh reviews_synced_at timestamp, as
-- if the reviews had actually been captured. The column now gates a durable, head-independent read-through
-- cache (fetchAndStorePullRequestDetails' reviewsUpToDate check): ANY non-null reviews_synced_at is trusted as
-- "reviews are fully synced, skip refetching" until a `pull_request_review` webhook invalidates it.
--
-- Impact of leaving existing rows as-is: a PR whose review sync previously failed (rate limit, transient
-- network error, etc.) already has a reviews_synced_at timestamp from that failed attempt. The new cache would
-- treat that PR's reviews as permanently up to date -- silently serving incomplete/stale review data forever,
-- unless that specific PR happens to receive a NEW review action after this deploys (the only thing that clears
-- the marker going forward).
--
-- Repair strategy: there is no reliable way to tell, from the stored row alone, whether a PARTICULAR existing
-- reviews_synced_at value came from a pass where reviews specifically succeeded (status reflects the aggregate
-- outcome across files/reviews/checks together, not reviews alone). Clear it for every row instead of trying to
-- guess -- the one-time cost is a single redundant review refetch for PRs that were already correctly synced,
-- which is cheap and bounded; the alternative (leaving any ambiguous row as-is) risks silently trusting bad data
-- indefinitely. The next sync pass for every tracked PR re-populates it correctly under the new,
-- only-stamp-on-success semantics.
UPDATE pull_request_detail_sync_state
   SET reviews_synced_at = NULL
 WHERE reviews_synced_at IS NOT NULL;
