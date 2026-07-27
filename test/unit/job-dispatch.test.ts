import { afterEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../../src/queue/job-dispatch";
import { createTestEnv } from "../helpers/d1";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { clearFederatedIntelligenceManifestOverrideCacheForTest } from "../../src/orb/federated-benchmark";
import type { JobMessage } from "../../src/types";

describe("processJob unknown job type (#5836)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a structured unknown_job_type_ignored warning and does not throw for an unrecognized type", async () => {
    const warnLogs: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLogs.push(String(args[0]));
    });

    const env = createTestEnv();
    // A type outside the discriminated union — a stale/renamed job or a producer/consumer skew at runtime.
    const message = { type: "totally-unknown-job-type" } as unknown as JobMessage;

    await expect(processJob(env, message)).resolves.toBeUndefined();

    expect(warnLogs).toHaveLength(1);
    const log = JSON.parse(warnLogs[0] ?? "{}") as Record<string, unknown>;
    expect(log).toMatchObject({ level: "warn", event: "unknown_job_type_ignored", jobType: "totally-unknown-job-type" });
  });

  it("does not log the unknown-type warning for a recognized job type", async () => {
    const warnLogs: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLogs.push(String(args[0]));
    });

    const env = createTestEnv();
    // A recognized type that no-ops safely without external I/O: retryFailedRelays fails open on an empty table.
    await processJob(env, { type: "retry-orb-relay" } as JobMessage);

    expect(warnLogs.some((line) => line.includes("unknown_job_type_ignored"))).toBe(false);
  });
});

describe("processJob federated-peer-sync (#9148/#9166)", () => {
  afterEach(() => {
    clearFederatedIntelligenceManifestOverrideCacheForTest();
    vi.unstubAllGlobals();
  });

  it("is a no-op — never writes the peer-benchmark cache — when the loopover self-repo manifest has not opted in", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: "JSONbored/loopover" });
    // The manifest override lookup itself may still fall through to a network read when nothing is cached
    // (the same "config-as-code override" pattern every sibling scheduled job uses, e.g. resolveOpsManifestOverride)
    // — stub it to a harmless empty response so this test exercises the GATE, not GitHub reachability.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })));
    await expect(processJob(env, { type: "federated-peer-sync", requestedBy: "schedule" } as JobMessage)).resolves.toBeUndefined();
    const row = await env.DB.prepare("SELECT 1 AS x FROM system_flags WHERE key = 'orb:federated_benchmark_cache'").first();
    expect(row ?? null).toBeNull();
  });

  it("re-checks the FULL manifest at dispatch time and runs the sync tick when opted in, defense-in-depth against a stale enqueue", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: "JSONbored/loopover" });
    // No collectorUrl configured, so both push and pull resolve to a no-op with zero fetch calls — this proves
    // the job runs the real tick (which writes the peer cache) without needing a live network mock.
    await upsertRepoFocusManifest(env, "JSONbored/loopover", { federatedIntelligence: { enabled: true } });
    await expect(processJob(env, { type: "federated-peer-sync", requestedBy: "schedule" } as JobMessage)).resolves.toBeUndefined();
    const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = 'orb:federated_benchmark_cache'").first<{ value: string }>();
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({ peerCount: 0, peerMedianMergePrecision: null });
  });
});

describe("processJob backfill-registered-repos fan-out isolation (#8355)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attempts every OTHER repo's send even when one repo's send rejects, and throws after the settle", async () => {
    const sentTo: string[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          const repoFullName = (message as { repoFullName?: string }).repoFullName;
          if (repoFullName) sentTo.push(repoFullName);
          if (repoFullName === "owner/fails") throw new Error("simulated transient queue-send failure");
          return undefined;
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "ok-1", full_name: "owner/ok-1", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositoryFromGitHub(env, { name: "fails", full_name: "owner/fails", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositoryFromGitHub(env, { name: "ok-2", full_name: "owner/ok-2", private: false, owner: { login: "owner" } }, 9001);

    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(String(args[0]));
    });

    await expect(processJob(env, { type: "backfill-registered-repos", requestedBy: "schedule" } as JobMessage)).rejects.toThrow(
      /backfill-registered-repos fan-out: 1\/3 repo send\(s\) failed: owner\/fails/,
    );

    // Every repo was attempted exactly once, regardless of the middle one's rejection.
    expect(sentTo.sort()).toEqual(["owner/fails", "owner/ok-1", "owner/ok-2"]);

    const failureLog = errorLogs.map((line) => JSON.parse(line) as Record<string, unknown>).find((log) => log.event === "backfill_registered_repos_fanout_send_failed");
    expect(failureLog).toMatchObject({ level: "error", event: "backfill_registered_repos_fanout_send_failed", repoFullName: "owner/fails" });
  });

  it("does not throw or log a failure when every repo's send succeeds", async () => {
    const sentTo: string[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          const repoFullName = (message as { repoFullName?: string }).repoFullName;
          if (repoFullName) sentTo.push(repoFullName);
          return undefined;
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9002, account: { login: "owner2", id: 2, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "ok-1", full_name: "owner2/ok-1", private: false, owner: { login: "owner2" } }, 9002);
    await upsertRepositoryFromGitHub(env, { name: "ok-2", full_name: "owner2/ok-2", private: false, owner: { login: "owner2" } }, 9002);

    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(String(args[0]));
    });

    await expect(processJob(env, { type: "backfill-registered-repos", requestedBy: "schedule" } as JobMessage)).resolves.toBeUndefined();
    expect(sentTo.sort()).toEqual(["owner2/ok-1", "owner2/ok-2"]);
    expect(errorLogs.some((line) => line.includes("backfill_registered_repos_fanout_send_failed"))).toBe(false);
  });
});

// #9032: the approval-queue staleness pass rides the re-gate sweep's own fan-out tick rather than adding a job
// type and a cron entry for a bounded DB scan. It must be best-effort and must run BEFORE the fan-out — a
// failure sweeping the queue cannot be allowed to cost the tick its actual re-gate work.
describe("agent-regate-sweep also sweeps the stale approval queue (#9032)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs what it swept when a pending row was reminded or expired", async () => {
    const env = createTestEnv();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
    const approvalQueue = await import("../../src/services/agent-approval-queue");
    vi.spyOn(approvalQueue, "sweepStaleApprovalQueue").mockResolvedValue({ reminded: 2, expired: 1 });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    const swept = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((log) => log.event === "approval_queue_staleness_swept");
    expect(swept).toMatchObject({ reminded: 2, expired: 1 });
  });

  it("stays quiet when there was nothing to sweep", async () => {
    const env = createTestEnv();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>).some((log) => log.event === "approval_queue_staleness_swept")).toBe(false);
  });

  it("still fans out the re-gate work when the approval sweep throws", async () => {
    const env = createTestEnv();
    const approvalQueue = await import("../../src/services/agent-approval-queue");
    vi.spyOn(approvalQueue, "sweepStaleApprovalQueue").mockRejectedValue(new Error("db down"));

    await expect(processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" })).resolves.toBeUndefined();
  });
});

// #9026 / #9031 / #8997: three bounded repair scans ride the sweep's own fan-out tick rather than each earning
// a job type and a cron entry. All must be best-effort — none may cost the tick its re-gate work, which is the
// sweep's actual job — and all must be quiet when there is nothing to repair.
describe("agent-regate-sweep runs the durability repair scans (#9026, #9031, #8997)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function sweepWith(stubs: {
    outcomes?: unknown;
    stranded?: unknown;
    orphaned?: unknown;
    outcomesThrows?: boolean;
    strandedThrows?: boolean;
    orphanedThrows?: boolean;
  }): Promise<Record<string, unknown>[]> {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
    const reconciler = await import("../../src/review/pr-outcome-reconciler");
    const watchdog = await import("../../src/review/pending-closure-watchdog");
    const surfaceReconciler = await import("../../src/review/surface-disposition-reconciler");
    const outcomeSpy = vi.spyOn(reconciler, "reconcileMissingPrOutcomes");
    const strandedSpy = vi.spyOn(watchdog, "sweepStrandedPendingClosures");
    const orphanedSpy = vi.spyOn(surfaceReconciler, "reconcileSurfaceWithoutDisposition");
    if (stubs.outcomesThrows) outcomeSpy.mockRejectedValue(new Error("db down"));
    else outcomeSpy.mockResolvedValue((stubs.outcomes ?? { scanned: 0, backfilled: 0 }) as never);
    if (stubs.strandedThrows) strandedSpy.mockRejectedValue(new Error("db down"));
    else strandedSpy.mockResolvedValue((stubs.stranded ?? { scanned: 0, requeued: 0 }) as never);
    if (stubs.orphanedThrows) orphanedSpy.mockRejectedValue(new Error("db down"));
    else orphanedSpy.mockResolvedValue((stubs.orphaned ?? { scanned: 0, requeued: 0 }) as never);

    await processJob(createTestEnv(), { type: "agent-regate-sweep", requestedBy: "schedule" });
    return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("reports what each scan repaired", async () => {
    const logs = await sweepWith({ outcomes: { scanned: 5, backfilled: 3 }, stranded: { scanned: 2, requeued: 1 }, orphaned: { scanned: 3, requeued: 2 } });
    expect(logs.find((log) => log.event === "pr_outcomes_reconciled")).toMatchObject({ scanned: 5, backfilled: 3 });
    expect(logs.find((log) => log.event === "pending_closure_verifications_requeued")).toMatchObject({ scanned: 2, requeued: 1 });
    expect(logs.find((log) => log.event === "surface_without_disposition_reconciled")).toMatchObject({ scanned: 3, requeued: 2 });
  });

  it("stays quiet when a scan looked but repaired nothing", async () => {
    const logs = await sweepWith({ outcomes: { scanned: 9, backfilled: 0 }, stranded: { scanned: 4, requeued: 0 }, orphaned: { scanned: 6, requeued: 0 } });
    expect(logs.some((log) => log.event === "pr_outcomes_reconciled")).toBe(false);
    expect(logs.some((log) => log.event === "pending_closure_verifications_requeued")).toBe(false);
    expect(logs.some((log) => log.event === "surface_without_disposition_reconciled")).toBe(false);
  });

  it("completes the tick even when all three scans throw", async () => {
    const logs = await sweepWith({ outcomesThrows: true, strandedThrows: true, orphanedThrows: true });
    expect(logs.some((log) => log.event === "pr_outcomes_reconciled")).toBe(false);
    expect(logs.some((log) => log.event === "pending_closure_verifications_requeued")).toBe(false);
    expect(logs.some((log) => log.event === "surface_without_disposition_reconciled")).toBe(false);
  });
});
