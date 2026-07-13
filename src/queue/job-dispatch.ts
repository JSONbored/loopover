// #4013 step 10 (final): the top-level job dispatcher, extracted last because it is the single most
// interdependent piece of processors.ts -- a pure switch over JobMessage["type"] that fans out to dozens of
// handlers still defined in processors.ts (and elsewhere), most of which have no other reason to move. This
// file therefore imports heavily FROM processors.ts (one-directional: processors.ts no longer calls
// processJob itself, so there is no cycle) rather than the other way around. processJob is one of only 2
// exports in the original file with a REAL external caller (src/index.ts, src/server.ts), plus the entire
// test suite's `import { processJob } from "../../src/queue/processors"` -- processors.ts keeps a re-export
// shim for it.
import type { DetectedNotificationEvent, JobMessage } from "../types";
import { refreshRegistry } from "../registry/sync";
import { listRepositories, rollupProductUsageDaily } from "../db/repositories";
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  enqueueRepositoryOpenDataBackfill,
  refreshContributorActivity,
  refreshInstallationHealth,
} from "../github/backfill";
import { refreshScoringModelSnapshot } from "../scoring/model";
import { fileUpstreamDriftIssues, refreshUpstreamDrift } from "../upstream/ruleset";
import { generateWeeklyValueReport } from "../services/weekly-value-report";
import { isRecapEnabled, resolveMaintainerRecapManifestOverride, runMaintainerRecapJob } from "../review/maintainer-recap-wire";
import { performRepoDocRefresh } from "../github/repo-doc-refresh-runner";
import { executeAgentRun } from "../services/agent-orchestrator";
import { deliverNotification, evaluateNotificationEvent } from "../notifications/service";
import { isOpsEnabled, runOpsAlerts } from "../review/ops-wire";
import { isSweepWatchdogEnabled, runSweepLivenessWatchdog } from "../review/sweep-watchdog";
import { isPrReconciliationEnabled, runOpenPrReconciliation } from "../review/pr-reconciliation";
import { isSelfTuneEnabled, runSelfTune } from "../review/selftune-wire";
import { runSelfTuneBreaker } from "../review/outcomes-wire";
import { isRagEnabled } from "../review/rag-wire";
import { processSubmitDraft } from "../services/draft";
import { retryFailedRelays } from "../orb/relay";
import { syncBrokeredInstalledRepos } from "../orb/installed-repos-sync";
import { generateSignalSnapshots } from "./signal-snapshot";
import { runRetentionPrune } from "./retention";
// The 15 handlers below have no reason to move -- each is only reachable via this dispatcher (or, for
// mapWithConcurrency, ALSO used by other still-in-processors.ts code), so they stay put and are exported
// there purely for this one-directional import-back (processors.ts itself never calls processJob).
import {
  buildBurdenForecasts,
  buildContributorDecisionPacks,
  buildContributorEvidence,
  fanOutAgentRegateSweepJobs,
  fanOutBacklogConvergenceSweepJobs,
  fanOutRepoDocRefreshSweepJobs,
  fanOutRepoSignalSnapshotJobs,
  mapWithConcurrency,
  processGitHubWebhook,
  regatePullRequest,
  reReviewStoredPullRequest,
  repairDataFidelity,
  runRagIndexJob,
  runReviewRecapJob,
  sweepRepoBacklogConvergence,
  sweepRepoRegate,
} from "./processors";

// A batched notify-evaluate job (#selfhost-maintenance-self-pin) can carry many events from one webhook (a
// popular newly-opened issue can have dozens of watchers) -- an unbounded Promise.all over all of them would
// let a single job spend as many concurrent DB/eval calls as it likes, bypassing the queue's own
// backgroundConcurrency cap (which defaults to 1) entirely from inside one job's execution. Bounded worker-pool
// fan-out, same shape as GLOBAL_OPEN_ITEM_LIVE_CHECK_CONCURRENCY in processors.ts. Moved here (rather than
// imported back) since processJob was its only caller.
const NOTIFY_EVALUATE_EVENT_CONCURRENCY = 5;

export async function processJob(env: Env, message: JobMessage): Promise<void> {
  switch (message.type) {
    case "refresh-registry":
      await refreshRegistry(env);
      return;
    case "sync-brokered-installed-repos":
      await syncBrokeredInstalledRepos(env);
      return;
    case "backfill-registered-repos":
      if (!message.repoFullName && message.requestedBy !== "test") {
        const repositories = (await listRepositories(env)).filter(
          (repo) => repo.isRegistered,
        );
        if (repositories.length > 0) {
          const delayStepSeconds =
            message.mode === "full" || message.mode === "resume" ? 45 : 15;
          await Promise.all(
            repositories.map((repo, index) => {
              const repoMessage: JobMessage = {
                type: "backfill-registered-repos",
                requestedBy: message.requestedBy,
                repoFullName: repo.fullName,
                ...(message.force === undefined
                  ? {}
                  : { force: message.force }),
                ...(message.mode === undefined ? {} : { mode: message.mode }),
              };
              const delaySeconds = Math.min(index * delayStepSeconds, 900);
              return delaySeconds > 0
                ? env.JOBS.send(repoMessage, { delaySeconds })
                : env.JOBS.send(repoMessage);
            }),
          );
          return;
        }
      }
      if (message.repoFullName && message.requestedBy !== "test") {
        await enqueueRepositoryOpenDataBackfill(env, {
          repoFullName: message.repoFullName,
          requestedBy: message.requestedBy,
          ...(message.force === undefined ? {} : { force: message.force }),
          ...(message.mode === undefined ? {} : { mode: message.mode }),
        });
        return;
      }
      await backfillRegisteredRepositories(env, {
        ...(message.repoFullName ? { repoFullName: message.repoFullName } : {}),
        requestedBy: message.requestedBy,
        ...(message.force === undefined ? {} : { force: message.force }),
        ...(message.mode === undefined ? {} : { mode: message.mode }),
      });
      return;
    case "backfill-repo-segment":
      await backfillRepositorySegment(env, {
        repoFullName: message.repoFullName,
        segment: message.segment,
        requestedBy: message.requestedBy,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
        ...(message.force === undefined ? {} : { force: message.force }),
      });
      return;
    case "backfill-pr-details":
      await backfillOpenPullRequestDetails(env, {
        repoFullName: message.repoFullName,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
      });
      return;
    case "refresh-installation-health":
      await refreshInstallationHealth(env);
      return;
    case "generate-signal-snapshots":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutRepoSignalSnapshotJobs(env, message.requestedBy);
        return;
      }
      await generateSignalSnapshots(env, message.repoFullName);
      return;
    case "refresh-scoring-model":
      await refreshScoringModelSnapshot(env);
      return;
    case "refresh-upstream-drift":
      await refreshUpstreamDrift(env);
      return;
    case "file-upstream-drift-issues":
      await fileUpstreamDriftIssues(env);
      return;
    case "build-contributor-evidence":
      await buildContributorEvidence(env, message.login, message.logins);
      return;
    case "build-contributor-decision-packs":
      await buildContributorDecisionPacks(env, message.login);
      return;
    case "refresh-contributor-activity":
      await refreshContributorActivity(
        env,
        message.login,
        message.repoFullName ? { repoFullName: message.repoFullName } : {},
      );
      return;
    case "build-burden-forecasts":
      await buildBurdenForecasts(env, message.repoFullName);
      return;
    case "repair-data-fidelity":
      await repairDataFidelity(env, message.requestedBy);
      return;
    case "rollup-product-usage":
      await rollupProductUsageDaily(env, {
        ...(message.day ? { day: message.day } : {}),
        ...(message.days === undefined ? {} : { days: message.days }),
      });
      return;
    case "prune-retention":
      await runRetentionPrune(
        env,
        message.requestedBy,
        message.dryRun ?? false,
      );
      return;
    case "generate-weekly-value-report":
      await generateWeeklyValueReport(env, {
        variant: message.variant ?? "operator",
        ...(message.days === undefined ? {} : { days: message.days }),
      });
      return;
    case "generate-review-recap":
      await runReviewRecapJob(env, message.repoFullName, message.windowDays);
      return;
    case "generate-maintainer-recap": {
      // Convergence (maintainer recap digest, flag GITTENSORY_MAINTAINER_RECAP, #1963/#2248, config-as-code
      // override #2250). Defense-in-depth: the cron only ENQUEUES this when enabled, but a stale in-flight job
      // that lands after a flag-flip (env OR manifest) must still no-op, so disabled does zero work here too.
      const maintainerRecapOverride = await resolveMaintainerRecapManifestOverride(env);
      if (isRecapEnabled(env, maintainerRecapOverride)) await runMaintainerRecapJob(env, message.windowDays, maintainerRecapOverride);
      return;
    }
    case "agent-regate-sweep":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutAgentRegateSweepJobs(env, message.requestedBy);
        return;
      }
      await sweepRepoRegate(env, message.repoFullName, message.requestedBy);
      return;
    case "backlog-convergence-sweep":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutBacklogConvergenceSweepJobs(env, message.requestedBy);
        return;
      }
      await sweepRepoBacklogConvergence(env, message.repoFullName, message.requestedBy);
      return;
    case "repo-doc-refresh-sweep":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutRepoDocRefreshSweepJobs(env, message.requestedBy);
        return;
      }
      if (message.repoFullName) await performRepoDocRefresh(env, message.repoFullName);
      return;
    case "agent-regate-pr":
      // One bounded re-gate unit fanned out by the sweep (#audit-sweep-fanout): re-review + stamp a single PR.
      await regatePullRequest(
        env,
        message.repairHeadSha,
        message.repoFullName,
        message.prNumber,
        message.installationId,
        message.deliveryId,
        message.force,
        message.prCreatedAt,
      );
      return;
    case "run-agent":
      await executeAgentRun(env, message.runId);
      return;
    case "notify-evaluate": {
      // Legacy payload compat: a row enqueued before the batched-events deploy (#selfhost-maintenance-self-pin)
      // still carries the OLD singular `event` field on disk, not `events` -- a rolling deploy can process such
      // a row after the new code ships, so normalize both shapes rather than assuming every persisted payload
      // already matches the current type (which only the type checker, not the durable queue, enforces).
      const legacyMessage = message as unknown as { events?: DetectedNotificationEvent[]; event?: DetectedNotificationEvent };
      const events = Array.isArray(legacyMessage.events) ? legacyMessage.events : legacyMessage.event ? [legacyMessage.event] : [];
      const deliveries = (
        await mapWithConcurrency(events, NOTIFY_EVALUATE_EVENT_CONCURRENCY, (event) => evaluateNotificationEvent(env, event))
      ).flat();
      await Promise.all(
        deliveries.map((delivery) =>
          env.JOBS.send({
            type: "notify-deliver",
            requestedBy: "notify-evaluate",
            deliveryId: delivery.id,
          }),
        ),
      );
      return;
    }
    case "notify-deliver":
      await deliverNotification(env, message.deliveryId);
      return;
    case "ops-alerts":
      // Convergence (ops / observability, flag LOOPOVER_REVIEW_OPS). Defense-in-depth: the cron only ENQUEUES this
      // when the flag is ON, but a stale in-flight job that lands after a flag-flip must still no-op, so
      // flag-OFF does zero work here too. Read-only telemetry — never throws into the queue.
      if (isOpsEnabled(env)) await runOpsAlerts(env);
      return;
    case "sweep-liveness-watchdog":
      // Self-heal (flag GITTENSORY_SWEEP_WATCHDOG). Defense-in-depth: the cron only ENQUEUES this when the flag
      // is ON, but a stale in-flight job that lands after a flag-flip must still no-op, so flag-OFF does zero
      // work here too. Fails safe internally — never throws into the queue.
      if (isSweepWatchdogEnabled(env)) await runSweepLivenessWatchdog(env);
      return;
    case "reconcile-open-prs":
      // Self-heal (flag GITTENSORY_PR_RECONCILIATION). Defense-in-depth: the cron only ENQUEUES this when the
      // flag is ON, but a stale in-flight job that lands after a flag-flip must still no-op, so flag-OFF does
      // zero work here too. Fails safe internally — never throws into the queue.
      if (isPrReconciliationEnabled(env)) await runOpenPrReconciliation(env);
      return;
    case "selftune":
      // Convergence (self-improve / auto-tune, flag LOOPOVER_REVIEW_SELFTUNE). Defense-in-depth: the cron only
      // ENQUEUES this when the flag is ON, but a stale in-flight job that lands after a flag-flip must still
      // no-op, so flag-OFF does zero work here too. TIGHTENING-ONLY + shadow-soak + audited; never throws into
      // the queue (runSelfTune fails safe).
      if (isSelfTuneEnabled(env)) {
        await runSelfTune(env);
        // GAP-4 accuracy circuit-breaker: read the gate-eval confusion matrix over the recorded pr_outcome
        // ground truth and ENGAGE holdonly (would-merge → hold) for any repo whose merge precision dropped
        // below the floor, plus AUTO-CLEAR a recovered breaker. Fail-safe: with no pr_outcome history the eval
        // reads neutral → nothing engages → byte-identical. (applyAutoTune / maybeAutoClearHoldOnly, previously
        // unwired — zero call-sites.)
        await runSelfTuneBreaker(env);
      }
      return;
    case "rag-index-repo":
      // Convergence (RAG / codebase index, flag LOOPOVER_REVIEW_RAG). Defense-in-depth: the cron + webhook only
      // ENQUEUE this when the flag is ON, but a stale in-flight job that lands after a flag-flip must still no-op,
      // so flag-OFF does zero work here too. indexRepo / reindexChangedPaths are fully fail-safe (never throw).
      if (isRagEnabled(env))
        await runRagIndexJob(
          env,
          message.requestedBy,
          message.repoFullName,
          message.paths,
        );
      return;
    case "recapture-preview":
      // Delayed visual self-poll: re-review the PR to re-capture the AFTER preview shot once its deploy is live.
      await reReviewStoredPullRequest(
        env,
        message.deliveryId,
        message.installationId,
        message.repoFullName,
        message.prNumber,
        message.attempt,
      );
      break;
    case "github-webhook":
      await processGitHubWebhook(
        env,
        message.deliveryId,
        message.eventName,
        message.payload,
      );
      return;
    case "submit-draft":
      // Public OAuth draft-submission (LOOPOVER_REVIEW_DRAFT). No-ops internally when the flag is off.
      await processSubmitDraft(env, message.draftId);
      return;
    case "retry-orb-relay":
      // Orb relay retry (#relay-retry): re-attempt events that failed to reach a brokered self-host container
      // (container was temporarily down). Enqueued by the cron ONLY when ORB_BROKER_ENABLED is set; a stale
      // in-flight job that arrives after the flag clears is still safe — retryFailedRelays fails open (no-op on
      // an empty table). Never throws.
      await retryFailedRelays(env);
      return;
  }
}
