import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateInstallationConcurrencyAdmission,
  installationConcurrencyDeferMs,
  InstallationConcurrencyTracker,
  resolveInstallationConcurrencyConfig,
  type InstallationConcurrencyConfig,
} from "../../src/selfhost/installation-concurrency-admission";
import { installationConcurrencyKeyForJob } from "../../src/selfhost/queue-common";
import type { JobMessage } from "../../src/types";

const CONFIG: InstallationConcurrencyConfig = {
  enabled: true,
  maxConcurrentPerInstallation: 2,
  deferMs: 15_000,
};

describe("resolveInstallationConcurrencyConfig", () => {
  const envKeys = [
    "GITHUB_INSTALLATION_CONCURRENCY_ENABLED",
    "GITHUB_INSTALLATION_CONCURRENCY_LIMIT",
    "GITHUB_INSTALLATION_CONCURRENCY_DEFER_MS",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns protective defaults with no env overrides", () => {
    expect(resolveInstallationConcurrencyConfig()).toEqual({
      enabled: true,
      maxConcurrentPerInstallation: 2,
      deferMs: 15_000,
    });
  });

  it("reads every knob from the environment when set", () => {
    process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "5";
    process.env.GITHUB_INSTALLATION_CONCURRENCY_DEFER_MS = "30000";
    const config = resolveInstallationConcurrencyConfig();
    expect(config.maxConcurrentPerInstallation).toBe(5);
    expect(config.deferMs).toBe(30_000);
  });

  it("falls back to the default limit on an invalid (non-numeric) value", () => {
    process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "not-a-number";
    expect(resolveInstallationConcurrencyConfig().maxConcurrentPerInstallation).toBe(2);
  });

  it("falls back to the default limit below the min (1)", () => {
    process.env.GITHUB_INSTALLATION_CONCURRENCY_LIMIT = "0";
    expect(resolveInstallationConcurrencyConfig().maxConcurrentPerInstallation).toBe(2);
  });

  it.each(["0", "false", "off", "no"])("treats GITHUB_INSTALLATION_CONCURRENCY_ENABLED=%s as disabled", (value) => {
    process.env.GITHUB_INSTALLATION_CONCURRENCY_ENABLED = value;
    expect(resolveInstallationConcurrencyConfig().enabled).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "anything-else"])(
    "treats GITHUB_INSTALLATION_CONCURRENCY_ENABLED=%s as enabled",
    (value) => {
      process.env.GITHUB_INSTALLATION_CONCURRENCY_ENABLED = value;
      expect(resolveInstallationConcurrencyConfig().enabled).toBe(true);
    },
  );
});

describe("evaluateInstallationConcurrencyAdmission", () => {
  it("admits unconditionally when disabled, even at/above the limit", () => {
    const decision = evaluateInstallationConcurrencyAdmission({ ...CONFIG, enabled: false }, 99);
    expect(decision).toEqual({ admit: true, reason: "disabled" });
  });

  it("admits when the in-flight count is below the limit", () => {
    expect(evaluateInstallationConcurrencyAdmission(CONFIG, 0)).toEqual({ admit: true, reason: "clear" });
    expect(evaluateInstallationConcurrencyAdmission(CONFIG, 1)).toEqual({ admit: true, reason: "clear" });
  });

  it("denies exactly AT the limit (>=, not >)", () => {
    expect(evaluateInstallationConcurrencyAdmission(CONFIG, 2)).toEqual({ admit: false, reason: "concurrency_high" });
  });

  it("denies above the limit", () => {
    expect(evaluateInstallationConcurrencyAdmission(CONFIG, 5)).toEqual({ admit: false, reason: "concurrency_high" });
  });
});

describe("installationConcurrencyDeferMs", () => {
  it("is deterministic for the same seed", () => {
    expect(installationConcurrencyDeferMs(CONFIG, "seed-a")).toBe(installationConcurrencyDeferMs(CONFIG, "seed-a"));
  });

  it("varies for different seeds", () => {
    const values = new Set([
      installationConcurrencyDeferMs(CONFIG, "seed-a"),
      installationConcurrencyDeferMs(CONFIG, "seed-b"),
      installationConcurrencyDeferMs(CONFIG, "seed-c"),
    ]);
    expect(values.size).toBeGreaterThan(1);
  });

  it("is always >= config.deferMs (jitter only ever adds)", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      expect(installationConcurrencyDeferMs(CONFIG, seed)).toBeGreaterThanOrEqual(CONFIG.deferMs);
    }
  });
});

describe("InstallationConcurrencyTracker", () => {
  it("starts at 0 for an unknown key", () => {
    const tracker = new InstallationConcurrencyTracker();
    expect(tracker.currentCount("installation:1")).toBe(0);
  });

  it("increments and decrements round-trip to 0", () => {
    const tracker = new InstallationConcurrencyTracker();
    tracker.increment("installation:1");
    tracker.increment("installation:1");
    expect(tracker.currentCount("installation:1")).toBe(2);
    tracker.decrement("installation:1");
    expect(tracker.currentCount("installation:1")).toBe(1);
    tracker.decrement("installation:1");
    expect(tracker.currentCount("installation:1")).toBe(0);
  });

  it("never goes negative (floors at 0 on a decrement past 0)", () => {
    const tracker = new InstallationConcurrencyTracker();
    tracker.decrement("installation:1");
    expect(tracker.currentCount("installation:1")).toBe(0);
    tracker.increment("installation:1");
    tracker.decrement("installation:1");
    tracker.decrement("installation:1");
    expect(tracker.currentCount("installation:1")).toBe(0);
  });

  it("tracks independent keys without interference", () => {
    const tracker = new InstallationConcurrencyTracker();
    tracker.increment("installation:1");
    tracker.increment("installation:1");
    tracker.increment("installation:2");
    expect(tracker.currentCount("installation:1")).toBe(2);
    expect(tracker.currentCount("installation:2")).toBe(1);
    tracker.decrement("installation:1");
    expect(tracker.currentCount("installation:1")).toBe(1);
    expect(tracker.currentCount("installation:2")).toBe(1);
  });

  it("does not grow unboundedly across many increment/decrement cycles on the same key", () => {
    const tracker = new InstallationConcurrencyTracker();
    for (let i = 0; i < 50; i += 1) {
      tracker.increment("installation:1");
      tracker.decrement("installation:1");
    }
    expect(tracker.currentCount("installation:1")).toBe(0);
    // Internal Map size is not exposed publicly; the public contract (currentCount reads back to 0 after every
    // cycle) is what the decrement-deletes-the-zero-entry implementation is FOR -- this proves the observable
    // behavior a caller actually depends on, without reaching into a private field.
  });
});

describe("installationConcurrencyKeyForJob", () => {
  const foregroundWebhook: JobMessage = {
    type: "github-webhook",
    deliveryId: "d1",
    eventName: "pull_request",
    payload: { installation: { id: 42 } },
  } as unknown as JobMessage;

  const foregroundRegate: JobMessage = {
    type: "agent-regate-pr",
    deliveryId: "d2",
    repoFullName: "owner/repo",
    pullNumber: 1,
    installationId: 42,
  } as unknown as JobMessage;

  const scheduledSweep: JobMessage = {
    type: "agent-regate-sweep",
    installationId: 42,
  } as unknown as JobMessage;

  const backfillRepoSegment: JobMessage = {
    type: "backfill-repo-segment",
    installationId: 42,
  } as unknown as JobMessage;

  const noInstallationIdType: JobMessage = {
    type: "backfill-registered-repos",
    repoFullName: "owner/repo",
  } as unknown as JobMessage;

  it("returns null for a foreground github-webhook job (never a GitHub-budget-background job)", () => {
    expect(installationConcurrencyKeyForJob(foregroundWebhook)).toBeNull();
  });

  // REGRESSION (caught while writing this test): isGitHubBudgetBackgroundJob is true for a live (non-sweep,
  // non-manual) agent-regate-pr job too -- it DOES draw GitHub rate-limit budget under this key -- so this
  // pure resolver correctly returns a non-null key here. The "foreground jobs are never gated by this policy"
  // guarantee lives at the pg-queue.ts/sqlite-queue.ts call site (an explicit !isForegroundJobPriority(...)
  // guard before this function is ever called), NOT inside this key resolver -- see the queue backend tests.
  it("returns the admission key for a foreground agent-regate-pr job (it DOES draw budget under this key -- foreground exclusion happens at the call site, not here)", () => {
    expect(installationConcurrencyKeyForJob(foregroundRegate)).toBe("installation:42");
  });

  it("returns the admission key for a GITHUB_BUDGET_BACKGROUND_TYPES job carrying installationId", () => {
    expect(installationConcurrencyKeyForJob(scheduledSweep)).toBe("installation:42");
    expect(installationConcurrencyKeyForJob(backfillRepoSegment)).toBe("installation:42");
  });

  it("returns null for a GITHUB_BUDGET_BACKGROUND_TYPES job whose payload carries no installationId", () => {
    expect(installationConcurrencyKeyForJob(noInstallationIdType)).toBeNull();
  });

  it("returns null for an unrelated job type not in GITHUB_BUDGET_BACKGROUND_TYPES", () => {
    const other: JobMessage = { type: "notify-deliver" } as unknown as JobMessage;
    expect(installationConcurrencyKeyForJob(other)).toBeNull();
  });
});
