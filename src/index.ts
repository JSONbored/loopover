import { createApp } from "./api/routes";
import { RateLimiter } from "./auth/rate-limit";
import { delayUntil, shouldWaitForGitHubRateLimit, LOW_REST_RATE_LIMIT_REMAINING, MAINTENANCE_RESERVED_HEADROOM } from "./github/rate-limit";
import { processDlqBatch } from "./queue/dlq";
import { processJob } from "./queue/processors";
import { isOrbBrokerEnabled } from "./orb/broker";
import { isOrbBrokerMode } from "./orb/broker-client";
import { gittensorEnabledRepoFullNames } from "./review/gittensor-wire";
import { isOpsEnabled, resolveOpsManifestOverride } from "./review/ops-wire";
import { isRecapEnabled, resolveMaintainerRecapManifestOverride, shouldFireMaintainerRecap } from "./review/maintainer-recap-wire";
import { isSweepWatchdogEnabled, resolveSweepWatchdogManifestOverride } from "./review/sweep-watchdog";
import { isLoopEscalationSweepEnabled } from "./review/loop-escalation-wire";
import { isAprRepoTransferPollEnabled } from "./orb/apr-repo-transfer";
import { isPrReconciliationEnabled, resolvePrReconciliationManifestOverride } from "./review/pr-reconciliation";
import { isActiveReviewReconciliationEnabled, resolveActiveReviewReconciliationManifestOverride } from "./review/active-review-reconciliation";
import { isRagEnabled } from "./review/rag-wire";
import { isSelfTuneEnabled } from "./review/selftune-wire";
import { isSatisfactionFloorAutotuneEnabled } from "./services/satisfaction-floor-loosening-run";
import {
  githubRateLimitAdmissionKeyForJob,
  isGitHubBudgetBackgroundJob,
  queueSnapshotBacklog,
  queueSnapshotFromBinding,
  scheduledEnqueueDelaySeconds,
} from "./selfhost/queue-common";
import { isReviewExecutionJob, isSelfHostedReviewRuntime } from "./selfhost/review-runtime";
import type { JobMessage } from "./types";

const app = createApp();
// Scoped to the top-level fan-out TRIGGER only (#audit-sweep-fanout) — NOT "agent-regate-pr", whose per-repo
// backlog is normal, expected, and can legitimately stay nonzero for long periods (staggered/rate-deferred
// per-PR re-reviews), which is exactly what caused the prior broad backlog check to starve the scheduled sweep
// entirely. A pending/processing "agent-regate-sweep" message means a fan-out is already in flight; the
// per-repo drain guard (getLatestRegatedAt / isRegateSweepDraining) already protects individual repos once that
// single fan-out runs, so this only needs to stop a SECOND trigger from queuing up behind the first.
const REGATE_SWEEP_TRIGGER_TYPES = ["agent-regate-sweep"] as const;
// Same shape as REGATE_SWEEP_TRIGGER_TYPES, scoped to backlog-convergence-sweep's own top-level trigger (#4502):
// its per-repo draining guard (getLatestBacklogConvergenceRegatedAt / isRegateSweepDraining) already protects
// individual repos once a fan-out runs, so this only needs to stop a SECOND trigger queuing up behind the first
// — the gap that let a crashed/restarted worker's stuck "processing" trigger row (reclaimed only after
// queueProcessingTimeoutMs(), which defaults to this sweep's own 30-min cadence) go unnoticed by the next tick.
const BACKLOG_CONVERGENCE_SWEEP_TRIGGER_TYPES = ["backlog-convergence-sweep"] as const;

export { RateLimiter };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    // Both dead-letter queues (the maintenance lane's loopover-jobs-dlq and the webhook lane's
    // loopover-webhooks-dlq, #1276) drain through the same observability + self-heal consumer.
    if (batch.queue?.endsWith("-dlq")) {
      await processDlqBatch(batch, env, { redriveWebhooks: isSelfHostedReviewRuntime(env) });
      return;
    }
    for (const message of batch.messages) {
      try {
        if (!isSelfHostedReviewRuntime(env) && isReviewExecutionJob(message.body)) {
          // Hosted review execution is retired. The Cloudflare API worker still handles Orb ingress
          // (/v1/orb/webhook) and token brokerage, but only self-host runtimes may execute review jobs.
          // Ack stale Cloudflare review-queue messages so they do not churn into the DLQ after cutover.
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "retired_review_job_ignored",
              messageId: message.id,
              jobType: message.body.type,
            }),
          );
          message.ack();
          continue;
        }
        if (isGitHubBudgetBackgroundJob(message.body)) {
          // Scoped to THIS job's own installation bucket (#audit-rate-scoping) — an unrelated installation's or
          // the shared public token's budget must never defer (or wrongly clear) this job.
          const resetAt = await shouldWaitForGitHubRateLimit(env, MAINTENANCE_RESERVED_HEADROOM, githubRateLimitAdmissionKeyForJob(message.body) ?? undefined).catch(() => undefined);
          if (resetAt) {
            console.log(
              JSON.stringify({
                event: "github_background_job_throttled",
                messageId: message.id,
                jobType: message.body.type,
                resetAt,
              }),
            );
            await env.JOBS.send(message.body, { delaySeconds: delayUntil(resetAt) });
            message.ack();
            continue;
          }
        }
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
        // and being dead-lettered (the surviving event-loss path). (#audit-rate-headroom) Scoped to THIS job's own
        // bucket (#audit-rate-scoping) so an unrelated installation's exhaustion never delays this job's retry.
        const resetAt = await shouldWaitForGitHubRateLimit(env, LOW_REST_RATE_LIMIT_REMAINING, githubRateLimitAdmissionKeyForJob(message.body) ?? undefined).catch(() => undefined);
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
  // Self-heal (#audit-open-pr-reconciliation): every 10 minutes — much tighter than the hourly ops-alerts/
  // selftune cadence, since this exists specifically to catch a silently-lost webhook within minutes rather
  // than up to 6 hours (backfillRegisteredRepositories's freshness window).
  const isReconciliationWindow = minute % 10 === 0;
  // The light auto-maintain sweep runs EVERY cron tick (~every 2 min) so an approved+clean PR MERGES and a
  // red-CI non-owner PR CLOSES promptly — reviewbot parity (its cron fired every minute). It re-fetches LIVE CI +
  // mergeable and only ACTS (merge/close/hold); it never re-runs the AI, so it is cheap enough for this cadence.
  // Previously this was gated by `isHourly`, so an approved PR could wait ~an hour for its merge pass.
  // BACKPRESSURE (#6): the sweep + its per-repo/per-PR fan-out is the heaviest GitHub-budget consumer. When the
  // shared REST budget is already at/below the maintenance headroom, SKIP enqueuing it this tick so the remaining
  // budget is reserved for webhooks (which drive timely reviews) instead of compounding the backlog; the next
  // tick (~2 min) retries, and after the bucket resets the sweep resumes. Webhooks never pre-yield.
  const jobs: JobMessage[] = [];
  const selfHostedReviews = isSelfHostedReviewRuntime(env);
  const queueSnapshot = selfHostedReviews
    ? await queueSnapshotFromBinding(env.JOBS).catch((error) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "selfhost_queue_snapshot_failed",
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
        return null;
      })
    : null;
  const sweepTriggerBacklog = queueSnapshotBacklog(queueSnapshot, REGATE_SWEEP_TRIGGER_TYPES);
  let sweepThrottledUntil: string | undefined;
  if (selfHostedReviews) {
    sweepThrottledUntil = await shouldWaitForGitHubRateLimit(env, MAINTENANCE_RESERVED_HEADROOM);
    if (sweepThrottledUntil) {
      console.log(JSON.stringify({ event: "regate_sweep_throttled", resetAt: sweepThrottledUntil }));
    } else if (sweepTriggerBacklog > 0) {
      // A fan-out trigger is already pending/processing — skip re-arming so the queue never accumulates a
      // second identical trigger behind the first (#audit-sweep-fanout). This is scoped to the trigger job
      // itself; it does not look at (and is not blocked by) per-repo "agent-regate-pr" backlog.
      console.log(JSON.stringify({ event: "regate_sweep_trigger_backlog_deferred", backlog: sweepTriggerBacklog }));
    } else {
      jobs.push({ type: "agent-regate-sweep", requestedBy: "schedule" });
    }
  }
  // Orb relay retry: re-attempt failed forwardOrbEvent calls each sweep cycle. Only enqueued when the
  // broker is enabled — brokered self-hosts register relay URLs; hosted-cloud instances have no relay failures.
  if (isOrbBrokerEnabled(env)) jobs.push({ type: "retry-orb-relay", requestedBy: "schedule" });
  // The heavier sync/health jobs keep their ~30-minute cadence even though the cron now ticks every ~2 minutes.
  if (minute % 30 === 0) {
    // BACKPRESSURE (#audit-rate-headroom): the open-data backfill lists every registered repo and fans out a
    // per-repo segment + per-PR detail sync — a large GitHub-budget consumer second only to the sweep. Gate it
    // behind the SAME maintenance headroom the sweep yields at, so when the shared REST budget is low the backfill
    // SKIPS this 30-min tick and hands the remaining budget to webhooks (which drive timely reviews); the next
    // 30-min tick retries, and after the bucket resets the backfill resumes. Queue depth is deliberately not a
    // suppressor here: unrelated pending work can stay nonzero for long periods, while rate admission on the
    // queued jobs is the precise throttle. repair-data-fidelity (a cheap, local-only D1 scan that only
    // dispatches already-gated jobs) stays unconditional. refresh-installation-health is NOT a single-call job
    // -- refreshInstallationHealthRecords makes one real GitHub REST call (getAppInstallation) per installation,
    // sequentially -- but it is likewise left unconditional here since its calls now yield to the shared budget
    // at dequeue time (GITHUB_BUDGET_BACKGROUND_TYPES, #4505/#4506).
    if (selfHostedReviews && !sweepThrottledUntil) {
      jobs.push({ type: "backfill-registered-repos", requestedBy: "schedule", mode: isFullSyncWindow ? "full" : "light" });
    } else if (selfHostedReviews) {
      console.log(JSON.stringify({ event: "backfill_throttled", resetAt: sweepThrottledUntil }));
    }
    jobs.push({ type: "repair-data-fidelity", requestedBy: "schedule" });
    jobs.push({ type: "refresh-installation-health", requestedBy: "schedule" });
    // #selfhost-backlog-convergence: catches open PRs whose public review surface was never published for their
    // current head — a blind spot the ~2-min re-gate sweep's dispatch-time `lastRegatedAt` stamping can miss (see
    // selfhost/backlog-convergence.ts). Runs on the same conservative 30-min cadence as the other maintenance-band
    // jobs above: it is a backstop for a rare stranding, not the primary convergence path, so it does not need the
    // sweep's ~2-min cadence. Self-host only (mirrors "agent-regate-sweep") — the trigger job itself is maintenance-
    // classified (MAINTENANCE_JOB_TYPES) so it defers under live-work pressure like every other periodic sweep here.
    if (selfHostedReviews) {
      const backlogConvergenceTriggerBacklog = queueSnapshotBacklog(queueSnapshot, BACKLOG_CONVERGENCE_SWEEP_TRIGGER_TYPES);
      if (backlogConvergenceTriggerBacklog > 0) {
        // A fan-out trigger is already pending/processing (#4502) — skip re-arming so a crashed/restarted worker's
        // stuck row (reclaimed only after queueProcessingTimeoutMs(), which coincides with this sweep's own 30-min
        // cadence) cannot go unnoticed by the next tick and duplicate per-repo/per-PR work underneath it.
        console.log(JSON.stringify({ event: "backlog_convergence_sweep_trigger_backlog_deferred", backlog: backlogConvergenceTriggerBacklog }));
      } else {
        jobs.push({ type: "backlog-convergence-sweep", requestedBy: "schedule" });
      }
    }
  }
  // Self-heal (flag LOOPOVER_PR_RECONCILIATION). Every 10 minutes — see isReconciliationWindow above.
  // Enable can ALSO be set as code via the loopover self-repo's `.loopover.yml prReconciliation:` block
  // (config-as-code parity, #6558 / #6275) -- a present manifest block wins over the env var; absent, the
  // env var decides exactly as before. Enqueued ONLY when enabled — flag-OFF (default) this job is never
  // created, so the cron tick does ZERO new work and the enqueued set is byte-identical to today.
  if (selfHostedReviews && isReconciliationWindow) {
    const prReconciliationManifestOverride = await resolvePrReconciliationManifestOverride(env);
    if (isPrReconciliationEnabled(env, prReconciliationManifestOverride)) jobs.push({ type: "reconcile-open-prs", requestedBy: "schedule" });
  }
  // Self-heal (flag LOOPOVER_ACTIVE_REVIEW_RECONCILIATION). Same 10-minute cadence as reconcile-open-prs above
  // — see isReconciliationWindow. Enable can ALSO be set as code via the loopover self-repo's `.loopover.yml
  // activeReviewReconciliation:` block (config-as-code parity, #webhook-reorder-clobber) -- a present manifest
  // block wins over the env var; absent, the env var decides exactly as before. Enqueued ONLY when enabled —
  // flag-OFF (default) this job is never created, so the cron tick does ZERO new work and the enqueued set is
  // byte-identical to today.
  if (selfHostedReviews && isReconciliationWindow) {
    const activeReviewReconciliationManifestOverride = await resolveActiveReviewReconciliationManifestOverride(env);
    if (isActiveReviewReconciliationEnabled(env, activeReviewReconciliationManifestOverride)) {
      jobs.push({ type: "reconcile-active-review-tracking", requestedBy: "schedule" });
    }
  }
  if (isHourly) {
    // Isolation (#experimental-gittensor-plugin): on self-host, refresh-registry both FETCHES from and
    // PERSISTS the whole upstream gittensor-subnet registry (entrius/gittensor has no server-side filtering,
    // and persistRegistrySnapshot's own self-host scoping — see registry/sync.ts — narrows what gets WRITTEN
    // locally but can't narrow what gets fetched). Skip enqueuing the job entirely when this instance has no
    // repo opted into the experimental `gittensor` plugin, so a plain self-host box makes ZERO outbound
    // contact with the subnet registry. Cloud is unaffected — always enqueues, exactly like before this
    // narrowing existed.
    const gittensorOptedIn = selfHostedReviews ? await gittensorEnabledRepoFullNames(env) : null;
    if (!selfHostedReviews || (gittensorOptedIn && gittensorOptedIn.size > 0)) {
      jobs.push({ type: "refresh-registry", requestedBy: "schedule" });
    } else {
      console.log(JSON.stringify({ event: "refresh_registry_skipped_no_gittensor_opt_in" }));
    }
    // Brokered self-host installed-repo sync (#5028): the central Orb relay deliberately does not forward
    // installation/installation_repositories events to brokered containers, so a brokered self-host has no
    // other way to learn its own repo list beyond the first forwarded PR/issue event per repo. Self-host +
    // broker-mode only (isOrbBrokerMode reads ORB_ENROLLMENT_SECRET) — a no-op everywhere else, byte-identical.
    if (selfHostedReviews && isOrbBrokerMode(env)) jobs.push({ type: "sync-brokered-installed-repos", requestedBy: "schedule" });
    jobs.push({ type: "refresh-scoring-model", requestedBy: "schedule" });
    jobs.push({ type: "refresh-upstream-drift", requestedBy: "schedule" });
    jobs.push({ type: "rollup-product-usage", requestedBy: "schedule", days: 7 });
    // Convergence (ops / observability, flag LOOPOVER_REVIEW_OPS). Hourly anomaly scan over loopover's own
    // review-outcome data. Enable can ALSO be set as code via the loopover self-repo's `.loopover.yml ops:`
    // block (config-as-code parity, #6275) -- a present manifest block wins over the env var; absent, the env
    // var decides exactly as before. Enqueued ONLY when enabled — flag-OFF (default) this job is never
    // created, so the cron tick does ZERO new work and the enqueued set is byte-identical to today.
    if (selfHostedReviews) {
      const opsManifestOverride = await resolveOpsManifestOverride(env);
      if (isOpsEnabled(env, opsManifestOverride)) jobs.push({ type: "ops-alerts", requestedBy: "schedule" });
    }
    // Self-heal (flag LOOPOVER_SWEEP_WATCHDOG). Hourly liveness check over the same repo set the scheduled
    // regate sweep covers — re-enqueues a targeted sweep for any repo whose sweep marker has gone stale despite
    // having open PRs to regate. Enable can ALSO be set as code via the loopover self-repo's
    // `.loopover.yml sweepWatchdog:` block (config-as-code parity, #6558 / #6275) -- a present manifest
    // block wins over the env var; absent, the env var decides exactly as before. Enqueued ONLY when
    // enabled — flag-OFF (default) this job is never created, so the cron tick does ZERO new work and the
    // enqueued set is byte-identical to today.
    if (selfHostedReviews) {
      const sweepWatchdogManifestOverride = await resolveSweepWatchdogManifestOverride(env);
      if (isSweepWatchdogEnabled(env, sweepWatchdogManifestOverride)) jobs.push({ type: "sweep-liveness-watchdog", requestedBy: "schedule" });
    }
    // Rent-a-Loop escalation (#6349, flag LOOPOVER_LOOP_ESCALATION). Hourly fleet summary → Discord when
    // needingAttention is non-empty. Enqueued ONLY when the flag is ON — flag-OFF (default) this job is never
    // created, so the cron tick does ZERO new work and the enqueued set is byte-identical to today.
    if (selfHostedReviews && isLoopEscalationSweepEnabled(env)) jobs.push({ type: "loop-escalation-sweep", requestedBy: "schedule" });
    // Convergence (self-improve / auto-tune, flag LOOPOVER_REVIEW_SELFTUNE). Hourly self-improvement tick over
    // loopover's own review-outcome data: compute tuning recommendations, shadow-soak any strictly-tightening
    // one, and auto-promote it to live only after the soak window passes the gate (TIGHTENING-ONLY, audited).
    // Enqueued ONLY when the flag is ON — flag-OFF (default) this job is never created, so the cron tick does
    // ZERO new tuning work and the enqueued set is byte-identical to today.
    if (selfHostedReviews && isSelfTuneEnabled(env)) jobs.push({ type: "selftune", requestedBy: "schedule" });
    // Backtest-gated satisfaction-floor loosening (#8158/#8121, flag SATISFACTION_FLOOR_AUTOTUNE_ENABLED).
    // Hourly evaluation of the one approved loosenable knob; applies at most one candidate step per tick and
    // alerts once on apply. Same runtime gate as its selftune sibling (the acting-autonomy surface). Enqueued
    // ONLY when the flag is ON — flag-OFF (default) this job is never created, so the cron tick does ZERO new
    // work and the enqueued set is byte-identical to today.
    if (selfHostedReviews && isSatisfactionFloorAutotuneEnabled(env)) jobs.push({ type: "satisfaction-floor-loosening", requestedBy: "schedule" });
    // APR repo-transfer acceptance/expiry detection (#7741, flag LOOPOVER_APR_TRANSFER_POLL). Hourly poll that
    // resolves each pending APR transfer (accepted / accepted-and-departed / expired at 7 days) and reconciles
    // the per-repo AMS pause. Enqueued ONLY when the flag is ON — flag-OFF (default) this job is never created,
    // so the cron tick does ZERO new work and the enqueued set is byte-identical to today.
    if (isAprRepoTransferPollEnabled(env)) jobs.push({ type: "poll-apr-repo-transfers", requestedBy: "schedule" });
  }
  if (isHourly && scheduledAt.getUTCDay() === 1 && hour === 12) {
    jobs.push({ type: "generate-weekly-value-report", requestedBy: "schedule", variant: "operator", days: 7 });
  }
  // Prune expired log/snapshot rows once a day (03:00 UTC) per the conservative RETENTION_POLICY.
  if (isHourly && hour === 3) {
    jobs.push({ type: "prune-retention", requestedBy: "schedule" });
  }
  // Repo-doc refresh sweep (#3003, part of #2993) -- once a day (09:00 UTC, distinct from prune-retention's
  // 03:00 and the weekly report's Monday-12:00). The fan-out itself checks each opted-in repo's own
  // repoDocGeneration.refreshIntervalDays (default weekly) before enqueuing a per-repo job, so this daily
  // cadence is just how often eligibility is RE-CHECKED, not how often a repo is actually refreshed.
  if (isHourly && hour === 9 && selfHostedReviews) {
    jobs.push({ type: "repo-doc-refresh-sweep", requestedBy: "schedule" });
  }
  // Maintainer recap digest (#1963, #2248/#2250; flag LOOPOVER_MAINTAINER_RECAP). Cross-repo RecapReport
  // delivered to Discord on a configurable cadence (LOOPOVER_RECAP_CADENCE=daily|weekly, default weekly) at
  // the configured hour/day-of-week (LOOPOVER_RECAP_HOUR / LOOPOVER_RECAP_DAY). Enable/cadence can ALSO be
  // set as code via the loopover self-repo's `.loopover.yml maintainerRecap:` block (config-as-code parity,
  // #2250) -- a present manifest block wins over the env vars; absent, the env vars decide exactly as before.
  // Enqueued ONLY when this tick matches the resolved cadence -- disabled (the default) this job is never
  // created, so the cron tick does ZERO new work and the enqueued set is byte-identical to today.
  if (selfHostedReviews && isHourly) {
    const maintainerRecapOverride = await resolveMaintainerRecapManifestOverride(env);
    if (isRecapEnabled(env, maintainerRecapOverride) && shouldFireMaintainerRecap(env, hour, scheduledAt.getUTCDay(), maintainerRecapOverride)) {
      jobs.push({ type: "generate-maintainer-recap", requestedBy: "schedule" });
    }
  }
  if (isFullSyncWindow) {
    jobs.push({ type: "generate-signal-snapshots", requestedBy: "schedule" });
    jobs.push({ type: "build-burden-forecasts", requestedBy: "schedule" });
    jobs.push({ type: "build-contributor-evidence", requestedBy: "schedule" });
    jobs.push({ type: "build-contributor-decision-packs", requestedBy: "schedule" });
    jobs.push({ type: "file-upstream-drift-issues", requestedBy: "schedule" });
    // Convergence (RAG / codebase index, flag LOOPOVER_REVIEW_RAG). SLOW-CADENCE full re-index: in the six-hourly
    // full-sync window, enqueue the RAG index fan-out (the processor fans out to one per-repo job for every
    // registered + cutover-allowlisted repo, mirroring the signal-snapshot fan-out). Enqueued ONLY when the flag
    // is ON — flag-OFF (default) this job is never created, so the cron does ZERO new RAG work and the enqueued
    // set is byte-identical to today.
    if (selfHostedReviews && isRagEnabled(env)) jobs.push({ type: "rag-index-repo", requestedBy: "schedule" });
  }
  // Phase-spread the enqueue (#1948): flushing every due job with run_after=now made the top-of-hour (and
  // top-of-6h) tick fan out all the heavy per-repo maintenance parents in one instant, draining the shared REST
  // bucket and tripping GitHub's secondary rate limit. Each job type gets a stable deterministic slot across the
  // jitter window (the every-tick sweep/relay stay immediate); the enqueued SET is unchanged, only the timing.
  await Promise.all(
    jobs.map((job) => {
      const delaySeconds = scheduledEnqueueDelaySeconds(job.type);
      return delaySeconds > 0
        ? env.JOBS.send(job, { delaySeconds })
        : env.JOBS.send(job);
    }),
  );
}
