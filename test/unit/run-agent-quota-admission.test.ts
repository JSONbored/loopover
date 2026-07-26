import { describe, expect, it, vi } from "vitest";

import { createAgentRun, getAgentRun, updateAgentRun } from "../../src/db/repositories";
import {
  admitRunAgentJob,
  decideRunAgentQuotaAdmission,
  type RunAgentQuotaAdmissionDeps,
} from "../../src/queue/run-agent-quota-admission";
import { createTestEnv } from "../helpers/d1";
import type { AgentRunRecord } from "../../src/types";

const QUOTA = { computeUnits: 100, wallClockMs: 60_000, maxConcurrentLoops: 3 };

function runRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-quota-1",
    objective: "plan",
    actorLogin: "miner",
    surface: "api",
    mode: "copilot",
    status: "queued",
    dataQualityStatus: "unknown",
    payload: {},
    ...overrides,
  };
}

describe("decideRunAgentQuotaAdmission (#7647 / #7662)", () => {
  it("admits with soft-warning events when still within quota but low on headroom", () => {
    const decision = decideRunAgentQuotaAdmission({
      actorLogin: "miner",
      usage: { computeUnitsUsed: 85, wallClockMsUsed: 0, activeLoops: 0 },
      quota: QUOTA,
      detectedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(decision.admitted).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.warningEvents).toHaveLength(1);
    expect(decision.warningEvents[0]).toMatchObject({
      eventType: "tenant_quota_warning",
      recipientLogin: "miner",
      dedupKey: "tenant_quota_warning:miner:compute:low:15:100",
    });
  });

  it("hard-blocks without soft warnings once quota is exhausted", () => {
    const decision = decideRunAgentQuotaAdmission({
      actorLogin: "miner",
      usage: { computeUnitsUsed: 100, wallClockMsUsed: 0, activeLoops: 0 },
      quota: QUOTA,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("compute units");
    expect(decision.warningEvents).toEqual([]);
  });

  it("admits cleanly when headroom is above the soft-warning thresholds", () => {
    const decision = decideRunAgentQuotaAdmission({
      actorLogin: "miner",
      usage: { computeUnitsUsed: 50, wallClockMsUsed: 10_000, activeLoops: 1 },
      quota: QUOTA,
    });
    expect(decision).toEqual({ admitted: true, reason: null, warningEvents: [] });
  });
});

describe("admitRunAgentJob", () => {
  it("fail-opens when the run record is missing", async () => {
    const env = createTestEnv();
    const decision = await admitRunAgentJob(env, "missing-run");
    expect(decision).toEqual({ admitted: true, reason: null, warningEvents: [] });
  });

  it("fail-opens when no rental-ledger context is available", async () => {
    const env = createTestEnv();
    await createAgentRun(env, runRecord());
    const decision = await admitRunAgentJob(env, "run-quota-1");
    expect(decision).toEqual({ admitted: true, reason: null, warningEvents: [] });
  });

  it("delivers warnings then admits when quota context is still within limits", async () => {
    const env = createTestEnv();
    await createAgentRun(env, runRecord());
    const deps: RunAgentQuotaAdmissionDeps = {
      loadQuotaContext: async () => ({
        usage: { computeUnitsUsed: 90, wallClockMsUsed: 0, activeLoops: 0 },
        quota: QUOTA,
      }),
      getRun: getAgentRun,
      failRun: vi.fn(),
      detectedAt: () => "2026-07-26T00:00:00.000Z",
    };

    const decision = await admitRunAgentJob(env, "run-quota-1", deps);
    expect(decision.admitted).toBe(true);
    expect(decision.warningEvents[0]?.eventType).toBe("tenant_quota_warning");
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it("fails the run and skips warnings when quota is exhausted", async () => {
    const env = createTestEnv();
    await createAgentRun(env, runRecord());
    const failRun = vi.fn();
    const deps: RunAgentQuotaAdmissionDeps = {
      loadQuotaContext: async () => ({
        usage: { computeUnitsUsed: 100, wallClockMsUsed: 0, activeLoops: 0 },
        quota: QUOTA,
      }),
      getRun: getAgentRun,
      failRun,
    };

    const decision = await admitRunAgentJob(env, "run-quota-1", deps);
    expect(decision.admitted).toBe(false);
    expect(decision.warningEvents).toEqual([]);
    expect(failRun).toHaveBeenCalledOnce();
    expect((await getAgentRun(env, "run-quota-1"))?.status).toBe("queued");
  });

  it("marks the run failed through the default failRun hook when quota is exhausted", async () => {
    const env = createTestEnv();
    await createAgentRun(env, runRecord());
    const deps: RunAgentQuotaAdmissionDeps = {
      loadQuotaContext: async () => ({
        usage: { computeUnitsUsed: 100, wallClockMsUsed: 0, activeLoops: 0 },
        quota: QUOTA,
      }),
      getRun: getAgentRun,
      failRun: async (failEnv, runId, reason) => {
        await updateAgentRun(failEnv, runId, { status: "failed", errorSummary: reason });
      },
    };

    const decision = await admitRunAgentJob(env, "run-quota-1", deps);
    expect(decision.admitted).toBe(false);
    expect((await getAgentRun(env, "run-quota-1"))?.status).toBe("failed");
  });
});
