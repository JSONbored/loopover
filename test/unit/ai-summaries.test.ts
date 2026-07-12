import { describe, expect, it, vi } from "vitest";
import {
  __aiSummaryInternals,
  rewritePublicPrIntelligenceComment,
  rewriteSignalBundleWithAi,
  summarizeAgentBundleWithAi,
} from "../../src/services/ai-summaries";
import type { AgentRunBundle } from "../../src/services/agent-orchestrator";
import { FORBIDDEN_PUBLIC_COMMENT_WORDS } from "../../src/queue-intelligence";
import { recordAiUsageEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const PUBLIC_FORBIDDEN_TEXT =
  /\b(wallets?|hotkeys?|raw trust scores?|trust scores?|payouts?|estimated rewards?|rewards?|reward estimates?|farming|scoreability|reviewability(?: internals?)?|private reviewability|private scoreability|private rankings?|rankings?|public score estimates?)\b/i;
type AiRunRequest = { messages: Array<{ role: string; content: string }> };

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

  it("reports unavailable AI provider when summaries are enabled", async () => {
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true" });

    await expect(summarizeAgentBundleWithAi(env, bundleFixture(), "private")).resolves.toEqual({
      status: "unavailable",
      reason: "AI provider is not configured.",
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
      "",
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.not.stringContaining("source code") })]),
      }),
    );
  });

  it("records the REAL reported model, not the empty-string configured fallback, when the provider reports one (2026-07 fix)", async () => {
    const run = vi.fn(async () => ({ response: "Advisory-routed summary.", usage: { provider: "ollama", model: "qwen3:8b" } }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
    });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    expect(result).toMatchObject({ status: "ok", model: "qwen3:8b" });
    const row = await env.DB.prepare("select model, provider from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("agent_private_summary")
      .first<{ model: string; provider: string | null }>();
    expect(row).toMatchObject({ model: "qwen3:8b", provider: "ollama" });
  });

  it("applies the default daily neuron budget when AI_DAILY_NEURON_BUDGET is unset", async () => {
    const run = vi.fn(async () => ({ response: "Summary within default budget." }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true" });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    expect(result).toMatchObject({ status: "ok" });
    expect(run).toHaveBeenCalled();
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

  it("falls back to the HIGH shared default (10M) when the daily budget is invalid, like ai-review/ai-slop (#1369)", async () => {
    const run = vi.fn(async () => ({ response: "Summary on the default shared budget." }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "on",
      AI_DAILY_NEURON_BUDGET: "not-a-number",
    });

    const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "private");

    // A truthy-but-non-finite budget resolves to the 10M shared default (not the old 10k/zero starvation),
    // matching the sibling AI features that share the same daily neuron counter.
    expect(result).toMatchObject({ status: "ok" });
    expect(run).toHaveBeenCalled();
  });

  it("resolves the SHARED neuron budget like ai-review/ai-slop: default 10M (not 10k) and ceiling 10M (not 1M) (#1369)", async () => {
    // Default HIGH: with the budget unset and ~2M already used on the shared counter, summaries must still
    // run — the old `|| 10000` default would have been quota_exceeded long before 2M.
    const defaultRun = vi.fn(async () => ({ response: "Within the 10M default." }));
    const defaultEnv = createTestEnv({ AI: { run: defaultRun } as unknown as Ai, AI_SUMMARIES_ENABLED: "true" });
    await recordAiUsageEvent(defaultEnv, { feature: "ai_review", model: "m", status: "ok", estimatedNeurons: 2_000_000 });
    expect((await summarizeAgentBundleWithAi(defaultEnv, bundleFixture(), "private")).status).toBe("ok");
    expect(defaultRun).toHaveBeenCalled();

    // Ceiling raised: a configured 2M budget with 1.5M used must NOT be quota_exceeded — the old
    // clamp(2M, 0, 1M) = 1M ceiling would have starved it.
    const ceilingRun = vi.fn(async () => ({ response: "Under the 2M configured budget." }));
    const ceilingEnv = createTestEnv({ AI: { run: ceilingRun } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "2000000" });
    await recordAiUsageEvent(ceilingEnv, { feature: "ai_review", model: "m", status: "ok", estimatedNeurons: 1_500_000 });
    expect((await summarizeAgentBundleWithAi(ceilingEnv, bundleFixture(), "private")).status).not.toBe("quota_exceeded");
    expect(ceilingRun).toHaveBeenCalled();
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

  it.each([
    "wallet",
    "hotkey",
    "raw trust score",
    "payout",
    "reward estimate",
    "estimated reward",
    "rewards",
    "reward",
    "farming",
    "scoreability",
    "reviewability",
    "reviewability internals",
    "private reviewability",
    "private scoreability",
    "public score estimate",
    "private ranking",
    "ranking",
  ])(
    "rejects unsafe public AI output containing %s",
    async (unsafeText) => {
      const run = vi.fn(async () => ({ response: `Do the next action because ${unsafeText} changed.` }));
      const env = createTestEnv({
        AI: { run } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "10000",
      });

      const result = await summarizeAgentBundleWithAi(env, bundleFixture(), "public");

      expect(result).toMatchObject({ status: "unsafe", reason: "public summary failed sanitizer" });
    },
  );

  it("keeps private action facts out of public AI prompt context", async () => {
    const run = vi.fn(async () => ({ response: "Public-safe queue summary." }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
    });

    const publicResult = await summarizeAgentBundleWithAi(env, unsafeBundleFixture(), "public");

    expect(publicResult).toMatchObject({ status: "ok" });
    const publicRequest = (run.mock.calls as unknown as Array<[string, AiRunRequest]>)[0]?.[1];
    const publicPrompt = publicRequest?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(publicPrompt).not.toMatch(PUBLIC_FORBIDDEN_TEXT);

    const privateRun = vi.fn(async () => ({ response: "Private summary with authenticated context." }));
    await expect(
      summarizeAgentBundleWithAi(
        {
          ...env,
          AI: { run: privateRun } as unknown as Ai,
        },
        unsafeBundleFixture(),
        "private",
      ),
    ).resolves.toMatchObject({ status: "ok" });

    const privateRequest = (privateRun.mock.calls as unknown as Array<[string, AiRunRequest]>)[0]?.[1];
    const privatePrompt = privateRequest?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(privatePrompt).toMatch(PUBLIC_FORBIDDEN_TEXT);
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
      reason: "ai_summary_failed",
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

describe("optional deterministic-summary rewrite layer", () => {
  const DETERMINISTIC_BODY = "<!-- gittensory-pr-intelligence -->\n## Gittensory contribution context\n- Queue level: steady";
  const signalBundle = () => ({ queueLevel: "steady", confirmedMiner: true, collisionClusters: 0 });

  function publicEnv(overrides: Partial<Env> = {}, run: (model: string, options: unknown) => Promise<unknown> = async () => ({ response: "Clear, friendly summary." })) {
    return createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
      ...overrides,
    });
  }

  function rewriteReq(overrides: Partial<Parameters<typeof rewriteSignalBundleWithAi>[1]> = {}) {
    return {
      feature: "pr_intelligence_comment",
      visibility: "public" as const,
      bundle: signalBundle(),
      fallbackText: DETERMINISTIC_BODY,
      instructions: "Rewrite clearly.",
      actor: "oktofeesh1",
      route: "github_app.pr_public_surface",
      ...overrides,
    };
  }

  it("stays disabled by default and returns the deterministic fallback without calling AI", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    const result = await rewriteSignalBundleWithAi(env, rewriteReq());
    expect(result).toMatchObject({ status: "disabled", text: DETERMINISTIC_BODY });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps public rewrites disabled unless explicitly enabled, falling back to the template", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "false" });
    const result = await rewriteSignalBundleWithAi(env, rewriteReq());
    expect(result).toMatchObject({ status: "disabled", text: DETERMINISTIC_BODY });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the deterministic template when the AI binding is unavailable", async () => {
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    const result = await rewriteSignalBundleWithAi(env, rewriteReq());
    expect(result).toMatchObject({ status: "unavailable", text: DETERMINISTIC_BODY });
  });

  it("falls back to the deterministic template once the daily neuron quota is exhausted", async () => {
    const run = vi.fn();
    const result = await rewriteSignalBundleWithAi(publicEnv({ AI_DAILY_NEURON_BUDGET: "1" }, run), rewriteReq());
    expect(result).toMatchObject({ status: "quota_exceeded", text: DETERMINISTIC_BODY });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns sanitized AI prose when enabled, in budget, and safe", async () => {
    const result = await rewriteSignalBundleWithAi(publicEnv(), rewriteReq());
    expect(result).toMatchObject({ status: "ok", text: "Clear, friendly summary." });
    expect(result.text).not.toBe(DETERMINISTIC_BODY);
  });

  it("records the REAL reported model, not the empty-string configured fallback, when the provider reports one (2026-07 fix)", async () => {
    const run = vi.fn(async () => ({ response: "Advisory-routed rewrite.", usage: { provider: "ollama", model: "qwen3:8b" } }));
    const env = publicEnv({}, run);
    const result = await rewriteSignalBundleWithAi(env, rewriteReq());
    expect(result).toMatchObject({ status: "ok", model: "qwen3:8b" });
    const row = await env.DB.prepare("select model, provider from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("pr_intelligence_comment")
      .first<{ model: string; provider: string | null }>();
    expect(row).toMatchObject({ model: "qwen3:8b", provider: "ollama" });
  });

  it("applies default model, output-token, and daily-budget configuration when env vars are unset", async () => {
    const run = vi.fn(async () => ({ response: "Default-config summary." }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    const result = await rewriteSignalBundleWithAi(env, rewriteReq());
    expect(result).toMatchObject({ status: "ok", model: "" });
    expect(run).toHaveBeenCalledWith("", expect.objectContaining({ max_tokens: 256 }));
  });

  it("resolves the rewrite path's SHARED neuron budget like ai-review/ai-slop: default 10M, ceiling 10M, invalid → default (#1369)", async () => {
    // Invalid (truthy non-finite) budget → 10M shared default, not the old 10k/zero starvation.
    const invalidRun = vi.fn(async () => ({ response: "Invalid budget falls back to the 10M default." }));
    expect((await rewriteSignalBundleWithAi(publicEnv({ AI_DAILY_NEURON_BUDGET: "not-a-number" }, invalidRun), rewriteReq())).status).toBe("ok");
    expect(invalidRun).toHaveBeenCalled();

    // Ceiling raised: configured 2M budget with 1.5M used must NOT be quota_exceeded (old clamp to 1M would).
    const ceilingRun = vi.fn(async () => ({ response: "Under the 2M configured budget." }));
    const ceilingEnv = publicEnv({ AI_DAILY_NEURON_BUDGET: "2000000" }, ceilingRun);
    await recordAiUsageEvent(ceilingEnv, { feature: "ai_review", model: "m", status: "ok", estimatedNeurons: 1_500_000 });
    expect((await rewriteSignalBundleWithAi(ceilingEnv, rewriteReq())).status).not.toBe("quota_exceeded");
    expect(ceilingRun).toHaveBeenCalled();
  });

  it("honors a custom model and output-token configuration", async () => {
    const run = vi.fn(async () => ({ response: "Custom-config summary." }));
    const env = publicEnv({ WORKERS_AI_SUMMARY_MODEL: "@cf/test/model", AI_MAX_OUTPUT_TOKENS: "128" }, run);
    const result = await rewriteSignalBundleWithAi(env, rewriteReq());
    expect(result).toMatchObject({ status: "ok", model: "@cf/test/model" });
    expect(run).toHaveBeenCalledWith("@cf/test/model", expect.objectContaining({ max_tokens: 128 }));
  });

  it("falls back to the deterministic template when AI rejects with a non-Error value", async () => {
    const throwingRun = async () => Promise.reject("string offline reason");
    await expect(rewriteSignalBundleWithAi(publicEnv({}, throwingRun), rewriteReq())).resolves.toMatchObject({
      status: "error",
      text: DETERMINISTIC_BODY,
      reason: "ai_summary_failed",
    });
  });

  it("never sends source contents in the AI prompt", async () => {
    const run = vi.fn((_model: string, _options: unknown) => Promise.resolve({ response: "Safe summary." }));
    await rewriteSignalBundleWithAi(publicEnv({}, run), rewriteReq());
    const payload = run.mock.calls[0]![1];
    const userPrompt = (payload as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "user")!.content;
    expect(userPrompt).not.toMatch(/source code|diff|function |body/i);
    expect(userPrompt).toContain("steady");
  });

  it("routes every forbidden public term through the canonical sanitizer and falls back when AI is unsafe", async () => {
    for (const word of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
      const run = vi.fn(async () => ({ response: `Looks great, includes ${word} detail.` }));
      const result = await rewriteSignalBundleWithAi(publicEnv({}, run), rewriteReq());
      expect(result, `forbidden word: ${word}`).toMatchObject({ status: "unsafe", text: DETERMINISTIC_BODY });
    }
  });

  it("rejects reward, ranking, scoreability, and reviewability variants in public AI rewrites", async () => {
    const unsafeOutputs = [
      "The estimated reward is high.",
      "Rewards look likely for this PR.",
      "This PR may improve contributor rewards and scoreability.",
      "The private ranking looks strong.",
      "This ranking should improve.",
      "Reviewability internals look healthy.",
    ];

    for (const output of unsafeOutputs) {
      const run = vi.fn(async () => ({ response: output }));
      const result = await rewriteSignalBundleWithAi(publicEnv({}, run), rewriteReq());
      expect(result, `unsafe output: ${output}`).toMatchObject({ status: "unsafe", text: DETERMINISTIC_BODY });
    }
  });

  it("falls back to the deterministic template when AI errors or returns empty output", async () => {
    const emptyRun = async () => ({ unexpected: "shape" });
    await expect(rewriteSignalBundleWithAi(publicEnv({}, emptyRun), rewriteReq())).resolves.toMatchObject({
      status: "error",
      text: DETERMINISTIC_BODY,
      reason: "empty_ai_summary",
    });

    const throwingRun = async () => Promise.reject(new Error("offline"));
    await expect(rewriteSignalBundleWithAi(publicEnv({}, throwingRun), rewriteReq())).resolves.toMatchObject({
      status: "error",
      text: DETERMINISTIC_BODY,
    });
  });

  it("preserves the sticky marker and posts the deterministic body when AI is disabled", async () => {
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai });
    const { body, outcome } = await rewritePublicPrIntelligenceComment(env, { bundle: signalBundle(), deterministicBody: DETERMINISTIC_BODY, actor: "oktofeesh1" });
    expect(outcome.status).toBe("disabled");
    expect(body).toBe(DETERMINISTIC_BODY);
    expect(body).toContain("<!-- gittensory-pr-intelligence -->");
  });

  it("wraps AI prose with the sticky marker when enabled and safe", async () => {
    const env = publicEnv({}, vi.fn(async () => ({ response: "- Confirmed Gittensor miner\n- Queue is steady" })));
    const { body, outcome } = await rewritePublicPrIntelligenceComment(env, { bundle: signalBundle(), deterministicBody: DETERMINISTIC_BODY, actor: "oktofeesh1" });
    expect(outcome.status).toBe("ok");
    expect(body).toContain("<!-- gittensory-pr-intelligence -->");
    expect(body).toContain("Queue is steady");
    expect(body).not.toBe(DETERMINISTIC_BODY);
  });

  it("posts the deterministic body when the AI rewrite is unsafe", async () => {
    const env = publicEnv({}, vi.fn(async () => ({ response: "Great work, your payout will be huge" })));
    const { body, outcome } = await rewritePublicPrIntelligenceComment(env, { bundle: signalBundle(), deterministicBody: DETERMINISTIC_BODY, actor: "oktofeesh1" });
    expect(outcome.status).toBe("unsafe");
    expect(body).toBe(DETERMINISTIC_BODY);
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

function unsafeBundleFixture(): AgentRunBundle {
  const bundle = bundleFixture();
  const action = bundle.actions[0];
  if (!action) throw new Error("missing fixture action");
  return {
    ...bundle,
    actions: [
      {
        ...action,
        recommendation: "Review wallet and hotkey evidence before discussing payout projections.",
        why: ["raw trust score, farming language, and private reviewability are private context."],
        blockedBy: ["private scoreability context and public score estimate are not public-safe."],
        scoreabilityImpact: "Authenticated scoreability can include reward estimate details.",
        riskImpact: "Private users may inspect payout evidence without public rendering.",
        maintainerImpact: "Avoid publishing wallet, hotkey, or reward estimate language.",
        publicSafeSummary: "Public score estimate and private reviewability should stay private.",
      },
    ],
  };
}
