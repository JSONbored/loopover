import { createApp } from "./api/routes";
import { RateLimiter } from "./auth/rate-limit";
import { processJob } from "./queue/processors";
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
  }
  if (isHourly && scheduledAt.getUTCDay() === 1 && hour === 12) {
    jobs.push({ type: "generate-weekly-value-report", requestedBy: "schedule", variant: "operator", days: 7 });
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
