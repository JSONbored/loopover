import { describe, expect, it, vi } from "vitest";
import { __aiSummaryInternals, summarizeAgentBundleWithAi } from "../../src/services/ai-summaries";
import type { AgentRunBundle } from "../../src/services/agent-orchestrator";
import { createTestEnv } from "../helpers/d1";

describe("Workers AI summaries", () => {
  it("stays disabled by default and does not call Workers AI", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });

    await expect(summarizeAgentBundleWithAi(env, bundleFixture(), "private")).resolves.toEqual({
      status: "disabled",
      reason: "AI summaries are disabled.",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("enforces a daily neuron budget before calling Workers AI", async () => {
    const run = vi.fn();
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "1",
    });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    expect(result).toMatchObject({ status: "quota_exceeded" });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unavailable Workers AI bindings when summaries are enabled", async () => {
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true" });

    await expect(summarizeAgentBundleWithAi(env, bundleFixture(), "private")).resolves.toEqual({
      status: "unavailable",
      reason: "Workers AI binding is not configured.",
    });
  });

  it("generates sanitized private summaries from compact deterministic context", async () => {
    const run = vi.fn(async () => ({ response: "Use cleanup-first guidance. Do not mention wallet or payout." }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
      AI_MAX_OUTPUT_TOKENS: "128",
    });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    expect(result).toMatchObject({ status: "ok" });
    expect(result.status === "ok" ? result.text : "").not.toMatch(/wallet|payout/i);
    expect(run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.not.stringContaining("source code") })]),
      }),
    );
  });

  it("honors custom model and clamps output token configuration", async () => {
    const run = vi.fn(async () => ({ response: "Custom model summary." }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "yes",
      WORKERS_AI_SUMMARY_MODEL: "@cf/test/model",
      AI_DAILY_NEURON_BUDGET: "10000",
      AI_MAX_OUTPUT_TOKENS: "99999",
    });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    expect(result).toMatchObject({ status: "ok", model: "@cf/test/model" });
    expect(run).toHaveBeenCalledWith("@cf/test/model", expect.objectContaining({ max_tokens: 512 }));

    const lowTokenRun = vi.fn(async () => ({ response: "Low token summary." }));
    await summarizeAgentBundleWithAi(
      {
        ...env,
        AI: { run: lowTokenRun } as unknown as Ai,
        AI_MAX_OUTPUT_TOKENS: "12",
      },
      bundleFixture(),
      "private",
    );
    expect(lowTokenRun).toHaveBeenCalledWith("@cf/test/model", expect.objectContaining({ max_tokens: 64 }));
  });

  it("treats invalid daily budget as zero budget", async () => {
    const run = vi.fn();
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "on",
      AI_DAILY_NEURON_BUDGET: "not-a-number",
    });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    expect(result).toMatchObject({ status: "quota_exceeded", remainingBudget: 0 });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps public summaries disabled unless explicitly enabled and rejects unsafe public text", async () => {
    const run = vi.fn(async () => ({ response: "estimated score and wallet detail" }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "false",
    });

    await expect(summarizeAgentBundleWithAi(env, bundleFixture(), "public")).resolves.toEqual({
      status: "disabled",
      reason: "Public AI summaries are disabled.",
    });

    const unsafe = await summarizeAgentBundleWithAi(
      { ...env, AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "10000" },
      bundleFixture(),
      "public",
    );
    expect(unsafe).toMatchObject({ status: "unsafe", reason: "public summary failed sanitizer" });
  });

  it("falls back when Workers AI returns malformed output or throws non-Error values", async () => {
    const malformed = createTestEnv({
      AI: { run: vi.fn(async () => ({ unknown: "shape" })) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
    });
    await expect(summarizeAgentBundleWithAi(malformed, bundleFixture(), "private")).resolves.toMatchObject({
      status: "error",
      reason: "empty_ai_summary",
    });

    const thrown = createTestEnv({
      AI: { run: vi.fn(async () => Promise.reject("offline")) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
    });
    await expect(summarizeAgentBundleWithAi(thrown, bundleFixture(), "private")).resolves.toMatchObject({
      status: "error",
      reason: "workers_ai_failed",
    });
  });

  it("covers pure extraction and sanitizer helpers", () => {
    expect(__aiSummaryInternals.extractAiText("plain")).toBe("plain");
    expect(__aiSummaryInternals.extractAiText({ text: "text" })).toBe("text");
    expect(__aiSummaryInternals.extractAiText({ result: "result" })).toBe("result");
    expect(__aiSummaryInternals.extractAiText({ nope: 1 })).toBe("");
    expect(__aiSummaryInternals.extractAiText(null)).toBe("");
    expect(__aiSummaryInternals.estimateNeurons("abcd".repeat(100), 128)).toBeGreaterThan(0);
    expect(__aiSummaryInternals.sanitizeAiText("wallet hotkey payout", "public")).not.toMatch(/wallet|hotkey|payout/i);
    expect(__aiSummaryInternals.containsPublicForbiddenText("raw trust score")).toBe(true);
    expect(__aiSummaryInternals.compactAgentSignalBundle(bundleFixture(), "public").actions).toHaveLength(1);
    expect(__aiSummaryInternals.auditOutcomeForAiStatus("ok")).toBe("success");
    expect(__aiSummaryInternals.auditOutcomeForAiStatus("unsafe")).toBe("denied");
    expect(__aiSummaryInternals.auditOutcomeForAiStatus("error")).toBe("error");
    expect(__aiSummaryInternals.auditOutcomeForAiStatus("disabled")).toBe("completed");
  });
});

function bundleFixture(): AgentRunBundle {
  return {
    run: {
      id: "run-ai",
      objective: "Plan next work",
      actorLogin: "oktofeesh1",
      surface: "mcp",
      mode: "copilot",
      status: "completed",
      dataQualityStatus: "complete",
      payload: {},
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    },
    actions: [
      {
        id: "action-ai",
        runId: "run-ai",
        actionType: "cleanup_existing_prs",
        targetRepoFullName: "we-promise/sure",
        status: "recommended",
        recommendation: "Clean up open PR pressure before opening new work.",
        why: ["Open PR pressure blocks current scoreability."],
        blockedBy: ["open_pr_pressure"],
        scoreabilityImpact: "Cleanup can restore scoreability.",
        riskImpact: "Lower review friction.",
        maintainerImpact: "Less queue pressure.",
        publicSafeSummary: "Clean up open PR pressure before opening new work.",
        approvalRequired: true,
        safetyClass: "private",
        payload: {},
        createdAt: "2026-05-28T00:00:00.000Z",
      },
    ],
    contextSnapshots: [
      {
        id: "ctx-ai",
        runId: "run-ai",
        decisionPackVersion: "2026-05-28T00:00:00.000Z",
        scoringModelId: "scoring-ai",
        repoSignalSnapshotIds: [],
        freshnessWarnings: ["fresh enough"],
        payload: {},
        createdAt: "2026-05-28T00:00:00.000Z",
      },
    ],
    summary: "done",
  };
}
