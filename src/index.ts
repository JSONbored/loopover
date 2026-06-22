import { createApp } from "./api/routes";
import { RateLimiter } from "./auth/rate-limit";
import { processJob } from "./queue/processors";
import { isOpsEnabled } from "./review/ops-wire";
import { isSelfTuneEnabled } from "./review/selftune-wire";
import type { JobMessage } from "./types";

const app = createApp();

export { RateLimiter };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
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
        message.retry();
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
  const jobs: JobMessage[] = [
    { type: "backfill-registered-repos", requestedBy: "schedule", mode: isFullSyncWindow ? "full" : "light" },
    { type: "repair-data-fidelity", requestedBy: "schedule" },
    { type: "refresh-installation-health", requestedBy: "schedule" },
  ];
  if (isHourly) {
    jobs.push({ type: "refresh-registry", requestedBy: "schedule" });
    jobs.push({ type: "refresh-scoring-model", requestedBy: "schedule" });
    jobs.push({ type: "refresh-upstream-drift", requestedBy: "schedule" });
    jobs.push({ type: "rollup-product-usage", requestedBy: "schedule", days: 7 });
    // Agent layer (#777): re-gate stale open PRs hourly. Fans out to one job per agent-configured repo;
    // webhooks don't fire when a PR's base advances, so this is what keeps those verdicts fresh.
    jobs.push({ type: "agent-regate-sweep", requestedBy: "schedule" });
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
  }
  await Promise.all(jobs.map((job) => env.JOBS.send(job)));
}
