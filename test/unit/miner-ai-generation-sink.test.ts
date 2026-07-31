import { afterEach, describe, expect, it } from "vitest";

import {
  createCodingAgentDriver,
  emitMinerAiGeneration,
  hasMinerAiGenerationSink,
  resolveCodingAgentTelemetryModel,
  runCodingAgentAttempt,
  setMinerAiGenerationSink,
  withCodingAgentGenerationCapture,
  type CodingAgentDriver,
  type CodingAgentDriverTask,
  type MinerAiGenerationRecord,
} from "../../packages/loopover-engine/src/index";

// Vitest mirror of packages/loopover-engine/test/ai-generation-sink.test.ts (#10200). codecov/patch is computed
// from this app vitest run (vitest.config coverage includes packages/loopover-engine/src/**), so the changed
// engine lines need a vitest test that imports the SRC directly — the engine's own node:test suite is not
// collected here.

const task: CodingAgentDriverTask = {
  attemptId: "attempt-sink-1",
  workingDirectory: "/tmp/worktrees/attempt-sink-1",
  acceptanceCriteriaPath: "/tmp/worktrees/attempt-sink-1/ACCEPTANCE-CRITERIA.md",
  instructions: "Apply the fix described in ACCEPTANCE-CRITERIA.md.",
  maxTurns: 4,
};

/** Registers a recording sink and returns the records array it appends to. */
function recordingSink(): MinerAiGenerationRecord[] {
  const records: MinerAiGenerationRecord[] = [];
  setMinerAiGenerationSink((record) => records.push(record));
  return records;
}

afterEach(() => {
  setMinerAiGenerationSink(undefined);
});

describe("miner AI generation sink (#10200)", () => {
  it("is unregistered by default, so emitting is a silent no-op", () => {
    expect(hasMinerAiGenerationSink()).toBe(false);
    // The assertion is that this does not throw with no sink registered.
    expect(() => emitMinerAiGeneration({ provider: "agent-sdk", model: "agent-sdk", latencyMs: 1, isError: false })).not.toThrow();
  });

  it("forwards a record to a registered sink, and stops once it is cleared", () => {
    const records = recordingSink();
    expect(hasMinerAiGenerationSink()).toBe(true);
    emitMinerAiGeneration({ provider: "claude-cli", model: "claude-sonnet-5", latencyMs: 7, isError: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("claude-cli");

    setMinerAiGenerationSink(undefined);
    expect(hasMinerAiGenerationSink()).toBe(false);
    emitMinerAiGeneration({ provider: "claude-cli", model: "claude-sonnet-5", latencyMs: 7, isError: false });
    expect(records).toHaveLength(1);
  });

  it("swallows a throwing sink — telemetry must never crash the AI call it instruments", () => {
    setMinerAiGenerationSink(() => {
      throw new Error("posthog exploded");
    });
    expect(() => emitMinerAiGeneration({ provider: "agent-sdk", model: "agent-sdk", latencyMs: 1, isError: true })).not.toThrow();
  });
});

describe("resolveCodingAgentTelemetryModel (#10200)", () => {
  it("reads the provider's own configured model env var when it declares one", () => {
    expect(resolveCodingAgentTelemetryModel("claude-cli", { MINER_CODING_AGENT_CLAUDE_MODEL: "claude-opus-5" })).toBe("claude-opus-5");
    expect(resolveCodingAgentTelemetryModel("codex-cli", { MINER_CODING_AGENT_CODEX_MODEL: "gpt-5-codex" })).toBe("gpt-5-codex");
  });

  it("falls back to the provider name when the provider declares no model key, or the value is blank", () => {
    // agent-sdk declares none — its session uses the account/CLI default.
    expect(resolveCodingAgentTelemetryModel("agent-sdk", {})).toBe("agent-sdk");
    expect(resolveCodingAgentTelemetryModel("claude-cli", {})).toBe("claude-cli");
    // Whitespace-only is not a model id: firstConfiguredEnvValue trims, so it degrades to the provider name
    // rather than reaching PostHog as a blank string.
    expect(resolveCodingAgentTelemetryModel("claude-cli", { MINER_CODING_AGENT_CLAUDE_MODEL: "   " })).toBe("claude-cli");
  });
});

describe("createCodingAgentDriver attaches capture at the single chokepoint (#10200)", () => {
  const spawnOk = async () => ({ stdout: "done", code: 0 });

  it("REGRESSION: captures an attempt built through runCodingAgentAttempt, which bypassed the host wrapper", async () => {
    // The exact bypass #10200 names: runCodingAgentAttempt resolves its driver through createCodingAgentDriver
    // directly, never through constructProductionCodingAgentDriver, so before the move every attempt it ran was
    // uncaptured. Nothing about this call site opts in — the capture is attached inside the factory.
    const records = recordingSink();
    await runCodingAgentAttempt({
      providerName: "claude-cli",
      env: { MINER_CODING_AGENT_MODE: "live", MINER_CODING_AGENT_CLAUDE_MODEL: "claude-opus-5" },
      task,
      spawn: spawnOk,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("claude-cli");
    expect(records[0]?.model).toBe("claude-opus-5");
    expect(records[0]?.isError).toBe(false);
    expect(records[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("captures a driver built straight from the factory, normalizing the provider name", async () => {
    const records = recordingSink();
    const driver = createCodingAgentDriver({ providerName: "  CODEX-CLI  ", env: {}, spawn: spawnOk });
    await driver.run(task);
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("codex-cli");
    expect(records[0]?.model).toBe("codex-cli");
  });

  it("does NOT capture the noop provider — a stub that never reaches a model has no generation to report", async () => {
    const records = recordingSink();
    const driver = createCodingAgentDriver({ providerName: "noop", env: {} });
    await driver.run(task);
    expect(records).toHaveLength(0);
  });

  it("does NOT capture an injected test driver — the seam returns it verbatim", async () => {
    const records = recordingSink();
    const injected: CodingAgentDriver = { run: async () => ({ ok: true, changedFiles: [], summary: "injected", transcript: "" }) };
    expect(createCodingAgentDriver({ providerName: "claude-cli", driver: injected })).toBe(injected);
    await injected.run(task);
    expect(records).toHaveLength(0);
  });

  it("does NOT capture a dry-run attempt — it never calls driver.run()", async () => {
    const records = recordingSink();
    const { mode } = await runCodingAgentAttempt({
      providerName: "claude-cli",
      env: { MINER_CODING_AGENT_MODE: "live" },
      agentDryRun: true,
      task,
    });
    expect(mode).not.toBe("live");
    expect(records).toHaveLength(0);
  });
});

describe("withCodingAgentGenerationCapture record shape (#10200/#10207)", () => {
  it("omits every token/cost field the driver did not report, rather than zeroing them", async () => {
    const records = recordingSink();
    const driver = withCodingAgentGenerationCapture("codex-cli", "gpt-5-codex", {
      run: async () => ({ ok: true, changedFiles: [], summary: "done", transcript: "" }),
    });
    await driver.run(task);
    expect(records[0]?.totalTokens).toBeUndefined();
    expect(records[0]?.inputTokens).toBeUndefined();
    expect(records[0]?.outputTokens).toBeUndefined();
    expect(records[0]?.totalCostUsd).toBeUndefined();
    expect(records[0]?.error).toBeUndefined();
  });

  it("carries the driver's own error string on an ok:false result, without throwing", async () => {
    const records = recordingSink();
    const driver = withCodingAgentGenerationCapture("codex-cli", "gpt-5-codex", {
      run: async () => ({ ok: false, changedFiles: [], summary: "failed", transcript: "", error: "codex_timeout_120000ms" }),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(records[0]?.isError).toBe(true);
    expect(records[0]?.error).toBe("codex_timeout_120000ms");
  });

  it("captures and rethrows when the wrapped driver throws", async () => {
    const records = recordingSink();
    const driver = withCodingAgentGenerationCapture("agent-sdk", "agent-sdk", {
      run: async () => {
        throw new Error("sdk crashed");
      },
    });
    await expect(driver.run(task)).rejects.toThrow("sdk crashed");
    expect(records[0]?.isError).toBe(true);
    expect((records[0]?.error as Error).message).toBe("sdk crashed");
  });
});
