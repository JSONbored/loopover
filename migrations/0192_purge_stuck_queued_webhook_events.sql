-- #9054: one-off purge of webhook_events rows PERMANENTLY stuck at 'queued'/'superseded' by the dedup-guard
-- bug fixed alongside this migration (src/github/webhook.ts's enqueueWebhookByEnv). Before that fix, a row
-- left at 'queued' (the insert happened but WEBHOOKS.send() was lost, or the enqueued job vanished) or
-- 'superseded' (overwritten by a later coalesced delivery before either was claimed) could NEVER be
-- redelivered: every GitHub retry and every operator "Redeliver" click carries the identical delivery_id and
-- (usually) the identical payload hash, hit the dedup guard, and was silently discarded as a no-op
-- duplicate, forever.
--
-- On the live box this incident left 5,547 such rows (4,900 of them check_suite.completed -- the
-- maybeReReviewOnCiCompletion auto-merge trigger), all from a ~3.5-week cutover-era window that was already
-- quiescent by the time this was diagnosed. Replaying them is not useful: the code-level fix means any
-- FUTURE stuck delivery becomes redeliverable after STALE_QUEUED_WEBHOOK_MS (10 minutes) rather than never,
-- so there is no ongoing gap to backfill, and the PRs behind this historical backlog are long since
-- resolved one way or another. Simply deleting them (rather than replaying) is what the issue itself called
-- for, so the stuck-delivery metric is meaningful again going forward.
--
-- Applies once, wherever/whenever this migration runs: any 'queued'/'superseded' row still unprocessed a
-- full day after receipt is dead by definition (real processing completes in well under a second), so this
-- is safe as a general one-time data-hygiene sweep on any environment, and a no-op on a fresh database with
-- no history to purge.
DELETE FROM webhook_events
 WHERE status IN ('queued', 'superseded')
   AND processed_at IS NULL
   AND received_at < datetime('now', '-1 day');
