import { createApp } from "./api/routes";
import { RateLimiter } from "./auth/rate-limit";
import { delayUntil, shouldWaitForGitHubRateLimit } from "./github/rate-limit";
import { processDlqBatch } from "./queue/dlq";
import { processJob } from "./queue/processors";
import { isOpsEnabled } from "./review/ops-wire";
import { isRagEnabled } from "./review/rag-wire";
import { isSelfTuneEnabled } from "./review/selftune-wire";
import type { JobMessage } from "./types";

const app = createApp();

export { RateLimiter };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    // Both dead-letter queues (the maintenance lane's gittensory-jobs-dlq and the webhook lane's
    // gittensory-webhooks-dlq, #1276) drain through the same observability + self-heal consumer.
    if (batch.queue?.endsWith("-dlq")) {
      await processDlqBatch(batch, env);
      return;
    }
    for (const message of batch.messages) {
      try {
        await processJob(env, message.body);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "queue_message_failed",
            messageId: message.id,
            /* v8 ignore next -- JavaScript can throw non-Error values, but queue processors throw Error instances in practice. */
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
        // If the shared GitHub REST budget is exhausted, this failure is most likely a rate-limit — retry AFTER the
        // reset so a real webhook OUTLASTS a transient rate-limit window instead of burning its retries immediately
        // and being dead-lettered (the surviving event-loss path). (#audit-rate-headroom)
        const resetAt = await shouldWaitForGitHubRateLimit(env).catch(() => undefined);
        if (resetAt) message.retry({ delaySeconds: delayUntil(resetAt) });
        else message.retry();
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enqueueScheduledJobs(env, controller));
  },
};

async function enqueueScheduledJobs(env: Env, controller: ScheduledController): Promise<void> {
  const scheduledAt = new Date(controller.scheduledTime ?? Date.now());
  const minute = scheduledAt.getUTCMinutes();
  const hour = scheduledAt.getUTCHours();
  const isHourly = minute === 0;
  const isFullSyncWindow = isHourly && hour % 6 === 0;
  // The light auto-maintain sweep runs EVERY cron tick (~every 2 min) so an approved+clean PR MERGES and a
  // red-CI non-owner PR CLOSES promptly — reviewbot parity (its cron fired every minute). It re-fetches LIVE CI +
  // mergeable and only ACTS (merge/close/hold); it never re-runs the AI, so it is cheap enough for this cadence.
  // Previously this was gated by `isHourly`, so an approved PR could wait ~an hour for its merge pass.
  const jobs: JobMessage[] = [{ type: "agent-regate-sweep", requestedBy: "schedule" }];
  // The heavier sync/health jobs keep their ~30-minute cadence even though the cron now ticks every ~2 minutes.
  if (minute % 30 === 0) {
    jobs.push({ type: "backfill-registered-repos", requestedBy: "schedule", mode: isFullSyncWindow ? "full" : "light" });
    jobs.push({ type: "repair-data-fidelity", requestedBy: "schedule" });
    jobs.push({ type: "refresh-installation-health", requestedBy: "schedule" });
  }
  if (isHourly) {
    jobs.push({ type: "refresh-registry", requestedBy: "schedule" });
    jobs.push({ type: "refresh-scoring-model", requestedBy: "schedule" });
    jobs.push({ type: "refresh-upstream-drift", requestedBy: "schedule" });
    jobs.push({ type: "rollup-product-usage", requestedBy: "schedule", days: 7 });
    // Convergence (ops / observability, flag GITTENSORY_REVIEW_OPS). Hourly anomaly scan over gittensory's own
    // review-outcome data. Enqueued ONLY when the flag is ON — flag-OFF (default) this job is never created,
    // so the cron tick does ZERO new work and the enqueued set is byte-identical to today.
    if (isOpsEnabled(env)) jobs.push({ type: "ops-alerts", requestedBy: "schedule" });
    // Convergence (self-improve / auto-tune, flag GITTENSORY_REVIEW_SELFTUNE). Hourly self-improvement tick over
    // gittensory's own review-outcome data: compute tuning recommendations, shadow-soak any strictly-tightening
    // one, and auto-promote it to live only after the soak window passes the gate (TIGHTENING-ONLY, audited).
    // Enqueued ONLY when the flag is ON — flag-OFF (default) this job is never created, so the cron tick does
    // ZERO new tuning work and the enqueued set is byte-identical to today.
    if (isSelfTuneEnabled(env)) jobs.push({ type: "selftune", requestedBy: "schedule" });
  }
  if (isHourly && scheduledAt.getUTCDay() === 1 && hour === 12) {
    jobs.push({ type: "generate-weekly-value-report", requestedBy: "schedule", variant: "operator", days: 7 });
  }
  // Prune expired log/snapshot rows once a day (03:00 UTC) per the conservative RETENTION_POLICY.
  if (isHourly && hour === 3) {
    jobs.push({ type: "prune-retention", requestedBy: "schedule" });
  }
  if (isFullSyncWindow) {
    jobs.push({ type: "generate-signal-snapshots", requestedBy: "schedule" });
    jobs.push({ type: "build-burden-forecasts", requestedBy: "schedule" });
    jobs.push({ type: "build-contributor-evidence", requestedBy: "schedule" });
    jobs.push({ type: "build-contributor-decision-packs", requestedBy: "schedule" });
    jobs.push({ type: "file-upstream-drift-issues", requestedBy: "schedule" });
    // Convergence (RAG / codebase index, flag GITTENSORY_REVIEW_RAG). SLOW-CADENCE full re-index: in the six-hourly
    // full-sync window, enqueue the RAG index fan-out (the processor fans out to one per-repo job for every
    // registered + cutover-allowlisted repo, mirroring the signal-snapshot fan-out). Enqueued ONLY when the flag
    // is ON — flag-OFF (default) this job is never created, so the cron does ZERO new RAG work and the enqueued
    // set is byte-identical to today.
    if (isRagEnabled(env)) jobs.push({ type: "rag-index-repo", requestedBy: "schedule" });
  }
  await Promise.all(jobs.map((job) => env.JOBS.send(job)));
}
