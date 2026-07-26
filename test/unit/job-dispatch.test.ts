import { afterEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../../src/queue/job-dispatch";
import { createTestEnv } from "../helpers/d1";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { JobMessage } from "../../src/types";
import * as agentOrchestrator from "../../src/services/agent-orchestrator";
import * as runAgentQuotaAdmission from "../../src/queue/run-agent-quota-admission";

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

describe("processJob run-agent quota admission (#7647 / #7662)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues quota-warning deliveries before executeAgentRun and skips execution on hard block", async () => {
    const sent: Array<{ type: string; deliveryId?: string; requestedBy?: string }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: { type: string; deliveryId?: string; requestedBy?: string }) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const executeAgentRun = vi.spyOn(agentOrchestrator, "executeAgentRun").mockResolvedValue({
      run: {
        id: "run-quota-dispatch",
        objective: "plan",
        actorLogin: "miner",
        surface: "api",
        mode: "copilot",
        status: "completed",
        dataQualityStatus: "complete",
        payload: {},
      },
      actions: [],
      contextSnapshots: [],
      summary: "done",
    });
    vi.spyOn(runAgentQuotaAdmission, "admitRunAgentJob").mockResolvedValueOnce({
      admitted: true,
      reason: null,
      warningEvents: [
        {
          eventType: "tenant_quota_warning",
          recipientLogin: "miner",
          repoFullName: "rent-a-loop/quota",
          pullNumber: 0,
          dedupKey: "tenant_quota_warning:miner:compute:low:15:100",
          deeplink: "https://github.com/JSONbored/loopover",
          actorLogin: "miner",
          detectedAt: "2026-07-26T00:00:00.000Z",
        },
      ],
    });

    await processJob(env, { type: "run-agent", requestedBy: "api", runId: "run-quota-dispatch" } as JobMessage);

    expect(sent.some((message) => message.type === "notify-deliver")).toBe(true);
    expect(executeAgentRun).toHaveBeenCalledWith(env, "run-quota-dispatch");
  });

  it("does not call executeAgentRun when admission hard-blocks", async () => {
    const env = createTestEnv();
    const executeAgentRun = vi.spyOn(agentOrchestrator, "executeAgentRun");
    vi.spyOn(runAgentQuotaAdmission, "admitRunAgentJob").mockResolvedValueOnce({
      admitted: false,
      reason: "Quota exceeded",
      warningEvents: [],
    });

    await processJob(env, { type: "run-agent", requestedBy: "api", runId: "blocked-run" } as JobMessage);
    expect(executeAgentRun).not.toHaveBeenCalled();
  });
});
