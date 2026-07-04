// Per-installation GitHub-fetch concurrency admission (#selfhost-installation-concurrency). The queue's own
// QUEUE_BACKGROUND_CONCURRENCY caps how many background jobs run AT ALL, globally -- it has no notion of WHICH
// installation those jobs belong to, so once an operator raises that cap above its default of 1, one
// installation's background sweep/backfill can claim every available background slot at once and starve every
// OTHER installation's background work, even though GitHub's rate-limit admission (queue-common.ts) is nowhere
// near exhausted for either installation. This module adds an ORTHOGONAL signal, checked at claim time
// alongside GitHub rate-limit admission and maintenance-lane pressure admission: is THIS installation already
// running its share of concurrent GitHub-fetching background jobs right now? A denied job is pushed back to
// 'pending' with a jittered future run_after, same as the other two admission layers -- never dropped.
//
// Deliberately in-process, not DB-backed: the queue's existing `active`/`activeBackground` counters (pg-queue.ts
// / sqlite-queue.ts) are already per-process scalars with no cross-process aggregation, and maintenance-
// admission.ts's own hostLoadAvg1PerCore() is inherently per-box too -- single-process-per-deployment is already
// the supported topology for the whole admission system (the SQLite backend structurally cannot share state
// across processes at all). A DB-backed live COUNT(*) query would need a new indexed installation column on
// every job row just to answer a question this in-process tracker answers for free in that topology.
//
// Deliberately NEVER applied to foreground jobs (github-webhook, agent-regate-pr): this policy only ever runs
// for a job where isGitHubBudgetBackgroundJob() is true, mirroring exactly how maintenance-admission.ts's
// evaluateMaintenanceAdmission is only invoked for a background-priority job -- "reserve headroom for live PR
// work" is satisfied structurally, not via a headroom calculation.
import { deterministicJitterMs, parsePositiveIntEnv } from "./queue-common";

const DEFAULT_MAX_CONCURRENT_PER_INSTALLATION = 2;
const DEFAULT_DEFER_MS = 15_000;

export interface InstallationConcurrencyConfig {
  enabled: boolean;
  maxConcurrentPerInstallation: number;
  deferMs: number;
}

function installationConcurrencyEnabled(): boolean {
  const raw = (process.env.GITHUB_INSTALLATION_CONCURRENCY_ENABLED ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/** Reads every GITHUB_INSTALLATION_CONCURRENCY_* knob from process.env, each with a sane, protective default.
 *  Resolved ONCE per queue instance (mirrors resolveMaintenanceAdmissionConfig) rather than per job. */
export function resolveInstallationConcurrencyConfig(): InstallationConcurrencyConfig {
  return {
    enabled: installationConcurrencyEnabled(),
    maxConcurrentPerInstallation: parsePositiveIntEnv("GITHUB_INSTALLATION_CONCURRENCY_LIMIT", {
      min: 1,
      fallback: DEFAULT_MAX_CONCURRENT_PER_INSTALLATION,
    }),
    deferMs: parsePositiveIntEnv("GITHUB_INSTALLATION_CONCURRENCY_DEFER_MS", {
      min: 1_000,
      fallback: DEFAULT_DEFER_MS,
    }),
  };
}

export type InstallationConcurrencyReason = "disabled" | "concurrency_high" | "clear";

export interface InstallationConcurrencyDecision {
  admit: boolean;
  reason: InstallationConcurrencyReason;
}

/** PURE policy decision: is this installation allowed one more concurrent GitHub-budget-background job right
 *  now? `currentInFlightCount` is the caller's own live read of the InstallationConcurrencyTracker below for
 *  this exact admission key, taken immediately before this call. */
export function evaluateInstallationConcurrencyAdmission(
  config: InstallationConcurrencyConfig,
  currentInFlightCount: number,
): InstallationConcurrencyDecision {
  if (!config.enabled) return { admit: true, reason: "disabled" };
  if (currentInFlightCount >= config.maxConcurrentPerInstallation) {
    return { admit: false, reason: "concurrency_high" };
  }
  return { admit: true, reason: "clear" };
}

/** Jittered defer duration for a denied background job -- the base `deferMs` plus up to another `deferMs` of
 *  deterministic jitter (seeded by the job's own identity) so a cohort of denied jobs for the same installation
 *  doesn't wake up on the same tick and immediately re-trip this same check (mirrors
 *  maintenanceAdmissionDeferMs). Its own, shorter default (15s vs. maintenance's 3min) reflects that a
 *  background-fetch burst for one installation settles on the order of seconds, not minutes. */
export function installationConcurrencyDeferMs(config: InstallationConcurrencyConfig, jitterSeed: string): number {
  return config.deferMs + deterministicJitterMs(jitterSeed, config.deferMs);
}

/** The ONLY stateful piece in this module -- a plain in-process in-flight counter keyed by GitHub rate-limit
 *  admission key (installation:<id>). Constructed once per queue backend at module scope, mirroring how
 *  `active`/`activeBackground` are module-scope scalars in pg-queue.ts/sqlite-queue.ts -- never exported as a
 *  shared singleton, so it can only be mutated from the claim path that owns it. */
export class InstallationConcurrencyTracker {
  private readonly counts = new Map<string, number>();

  currentCount(admissionKey: string): number {
    return this.counts.get(admissionKey) ?? 0;
  }

  increment(admissionKey: string): void {
    this.counts.set(admissionKey, this.currentCount(admissionKey) + 1);
  }

  /** Floors at 0 and deletes the key once it reaches 0, so a busy deployment with many distinct installations
   *  never grows this Map unboundedly with stale zero entries. */
  decrement(admissionKey: string): void {
    const next = Math.max(0, this.currentCount(admissionKey) - 1);
    if (next === 0) {
      this.counts.delete(admissionKey);
    } else {
      this.counts.set(admissionKey, next);
    }
  }
}
