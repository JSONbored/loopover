import { describe, expect, it, vi } from "vitest";
import { __chatQaInternals, CHAT_QA_FALLBACK_COMMAND, generateChatQaAnswer } from "../../src/services/ai-chat-qa";
import type { AgentRunBundle } from "../../src/services/agent-orchestrator";
import { createTestEnv } from "../helpers/d1";

const ADVISORY_ON = { slop: false, e2eTestGen: false, planner: false, summaries: false, chatQa: true };
const ADVISORY_OFF = { slop: false, e2eTestGen: false, planner: false, summaries: false, chatQa: false };

function bundleFixture(runOverrides?: Partial<AgentRunBundle["run"]>, actionOverrides?: Partial<AgentRunBundle["actions"][number]>): AgentRunBundle {
  return {
    run: {
      id: "run-chat",
      objective: "Respond to @gittensory chat for owner/repo#1",
      actorLogin: "octofeesh1",
      surface: "github_comment",
      mode: "copilot",
      status: "completed",
      dataQualityStatus: "complete",
      payload: {},
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      ...runOverrides,
    },
    actions: [
      {
        id: "action-chat",
        runId: "run-chat",
        actionType: "cleanup_existing_prs",
        status: "recommended",
        recommendation: "Clean up open PR pressure before opening new work.",
        why: ["Open PR pressure blocks current scoreability.", "  ", "Mentions a wallet that must be redacted."],
        blockedBy: ["open_pr_pressure"],
        publicSafeSummary: "Clean up open PR pressure before opening new work.",
        approvalRequired: true,
        safetyClass: "private",
        payload: {},
        createdAt: "2026-07-11T00:00:00.000Z",
        ...actionOverrides,
      },
    ],
    contextSnapshots: [
      {
        id: "ctx-chat",
        runId: "run-chat",
        repoSignalSnapshotIds: [],
        freshnessWarnings: ["fresh enough"],
        payload: {},
        createdAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    summary: "likely_duplicate of an existing open PR.",
  };
}

describe("generateChatQaAnswer", () => {
  it("declines when chatQa is off (does not call the advisory provider)", async () => {
    const advisoryRun = vi.fn();
    const env = createTestEnv({ AI_ADVISORY: { run: advisoryRun } as unknown as Ai });
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture(),
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_OFF,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result).toEqual({ status: "disabled", reason: "Chat Q&A is not enabled on this instance (settings.advisoryAiRouting.chatQa is off)." });
    expect(advisoryRun).not.toHaveBeenCalled();
  });

  it("declines when advisoryAiRouting is undefined entirely", async () => {
    const env = createTestEnv({});
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture(),
      question: "why is this blocked?",
      advisoryAiRouting: undefined,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result.status).toBe("disabled");
  });

  it("never falls back to the frontier chain: reports unavailable when chatQa is on but AI_ADVISORY is unconfigured", async () => {
    const frontierRun = vi.fn();
    const env = createTestEnv({ AI: { run: frontierRun } as unknown as Ai });
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture(),
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(frontierRun).not.toHaveBeenCalled();
  });

  it("declines when no question is supplied", async () => {
    const advisoryRun = vi.fn();
    const env = createTestEnv({ AI_ADVISORY: { run: advisoryRun } as unknown as Ai });
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture(),
      question: "   ",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result).toMatchObject({ status: "declined", reason: "No question was supplied.", suggestion: expect.stringContaining("@gittensory chat") });
    expect(advisoryRun).not.toHaveBeenCalled();
  });

  it("declines and points at the fallback command when there is no bundle at all", async () => {
    const env = createTestEnv({ AI_ADVISORY: { run: vi.fn() } as unknown as Ai });
    const result = await generateChatQaAnswer(env, {
      bundle: null,
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result).toMatchObject({ status: "declined", reason: "The cached contribution-context snapshot is still refreshing." });
    expect((result as { suggestion: string }).suggestion).toContain(CHAT_QA_FALLBACK_COMMAND);
  });

  it("declines when the cached bundle is still refreshing", async () => {
    const env = createTestEnv({ AI_ADVISORY: { run: vi.fn() } as unknown as Ai });
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture({ status: "needs_snapshot_refresh" }),
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result).toMatchObject({ status: "declined", reason: "The cached contribution-context snapshot is still refreshing." });
  });

  it("declines when the bundle has no actions to ground an answer in", async () => {
    const env = createTestEnv({ AI_ADVISORY: { run: vi.fn() } as unknown as Ai });
    const bundle = bundleFixture();
    bundle.actions = [];
    const result = await generateChatQaAnswer(env, {
      bundle,
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 1,
    });
    expect(result).toMatchObject({ status: "declined", reason: "No cached deterministic facts are available to ground an answer for this PR." });
  });

  it("reports quota_exceeded and never calls the provider when the shared daily neuron budget is exhausted", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "1" });
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture(),
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 1,
      actor: "alice",
    });
    expect(result).toMatchObject({ status: "quota_exceeded" });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the shared 10M default budget when unset, and again when the configured value is non-finite", async () => {
    const run1 = vi.fn(async () => ({ response: "Grounded answer one." }));
    const env1 = createTestEnv({ AI_ADVISORY: { run: run1 } as unknown as Ai });
    const result1 = await generateChatQaAnswer(env1, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result1).toMatchObject({ status: "ok" });

    const run2 = vi.fn(async () => ({ response: "Grounded answer two." }));
    const env2 = createTestEnv({ AI_ADVISORY: { run: run2 } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "not-a-number" });
    const result2 = await generateChatQaAnswer(env2, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result2).toMatchObject({ status: "ok" });
  });

  it("generates a grounded answer, redacting private terms before they ever reach the prompt", async () => {
    const run = vi.fn(async () => ({ response: "Here is the readiness answer." }));
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "10000" });
    const result = await generateChatQaAnswer(env, {
      bundle: bundleFixture(),
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 42,
      actor: "alice",
      route: "github_comment",
    });
    expect(result).toMatchObject({ status: "ok", text: "Here is the readiness answer." });
    expect(run).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        messages: [expect.objectContaining({ role: "system" }), expect.objectContaining({ role: "user", content: expect.stringContaining("why is this blocked?") })],
      }),
    );
    const call = run.mock.calls[0] as unknown as [string, { messages: Array<{ content: string }> }];
    const userMessage = call[1].messages[1]?.content ?? "";
    expect(userMessage).not.toMatch(/\bopen_pr_pressure\b/);
    expect(userMessage).not.toMatch(/\bwallet\b/i);
    expect(userMessage).not.toMatch(/\blikely_duplicate\b/);
  });

  it("honors a custom model override and clamps output tokens", async () => {
    const run = vi.fn(async () => ({ response: "Custom-model answer." }));
    const env = createTestEnv({
      AI_ADVISORY: { run } as unknown as Ai,
      WORKERS_AI_SUMMARY_MODEL: "@cf/test/chat-model",
      AI_DAILY_NEURON_BUDGET: "10000",
      AI_MAX_OUTPUT_TOKENS: "99999",
    });
    const result = await generateChatQaAnswer(env, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result).toMatchObject({ status: "ok", model: "@cf/test/chat-model" });
    expect(run).toHaveBeenCalledWith("@cf/test/chat-model", expect.objectContaining({ max_tokens: 512 }));
  });

  it("clamps max output tokens to the floor when AI_MAX_OUTPUT_TOKENS is non-numeric", async () => {
    const run = vi.fn(async () => ({ response: "Answer within the floor." }));
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_MAX_OUTPUT_TOKENS: "not-a-number", AI_DAILY_NEURON_BUDGET: "10000" });
    const result = await generateChatQaAnswer(env, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result).toMatchObject({ status: "ok" });
    expect(run).toHaveBeenCalledWith("", expect.objectContaining({ max_tokens: 64 }));
  });

  it("withholds an unsafe model answer instead of ever returning it", async () => {
    const run = vi.fn(async () => ({ response: "Mentions a wallet address directly." }));
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "10000" });
    const result = await generateChatQaAnswer(env, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result).toMatchObject({ status: "unsafe" });
  });

  it("reports an error status with the underlying message when the provider throws an Error", async () => {
    const run = vi.fn(async () => {
      throw new Error("provider_down");
    });
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "10000" });
    const result = await generateChatQaAnswer(env, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result).toMatchObject({ status: "error", reason: "provider_down" });
  });

  it("reports a generic error reason when the provider throws a non-Error value", async () => {
    const run = vi.fn(async () => {
      throw "boom";
    });
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "10000" });
    const result = await generateChatQaAnswer(env, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result).toMatchObject({ status: "error", reason: "chat_answer_failed" });
  });

  it("reports an error status when the provider returns an empty/unrecognized response shape", async () => {
    const run = vi.fn(async () => ({ unexpected: "shape" }));
    const env = createTestEnv({ AI_ADVISORY: { run } as unknown as Ai, AI_DAILY_NEURON_BUDGET: "10000" });
    const result = await generateChatQaAnswer(env, { bundle: bundleFixture(), question: "why?", advisoryAiRouting: ADVISORY_ON, repoFullName: "owner/repo", issueNumber: 1 });
    expect(result).toMatchObject({ status: "error", reason: "empty_chat_answer" });
  });
});

describe("__chatQaInternals", () => {
  const { compactChatSignalBundle, redactGroundingText, buildChatPrompt, containsPublicForbiddenText, estimateNeurons, extractAiText, auditOutcomeForAiStatus } = __chatQaInternals;

  it("redacts private decision-pack blocker codes and boundary terms, leaving safe text untouched", () => {
    expect(redactGroundingText("blocked by open_pr_pressure")).toBe("blocked by private readiness context");
    expect(redactGroundingText("do not mention a wallet or hotkey")).toBe("do not mention a private context or private context");
    expect(redactGroundingText("likely_duplicate of #123")).toBe("possible overlap with existing work of #123");
    expect(redactGroundingText("perfectly safe text")).toBe("perfectly safe text");
  });

  it("compacts a bundle to at most 5 actions and filters out blank why/blockedBy lines after redaction", () => {
    const compact = compactChatSignalBundle(bundleFixture());
    expect(compact.actions).toHaveLength(1);
    expect(compact.actions[0]?.why).toHaveLength(2);
    expect(compact.actions[0]?.why.every((line) => line.length > 0)).toBe(true);
    expect(compact.freshnessWarnings).toEqual(["fresh enough"]);
  });

  it("caps compacted actions at 5 even when the bundle has more", () => {
    const bundle = bundleFixture();
    bundle.actions = Array.from({ length: 7 }, (_, i) => ({ ...bundle.actions[0]!, id: `action-${i}` }));
    expect(compactChatSignalBundle(bundle).actions).toHaveLength(5);
  });

  it("builds a prompt embedding the question and the grounding JSON", () => {
    const prompt = buildChatPrompt("why?", { objective: "o", status: "s", dataQualityStatus: "complete", summary: "sum", actions: [], freshnessWarnings: [] });
    expect(prompt).toContain("Contributor question: why?");
    expect(prompt).toContain('"objective":"o"');
  });

  it("flags forbidden public terms via the shared sanitizer and the local near-miss pattern", () => {
    expect(containsPublicForbiddenText("mentions a wallet")).toBe(true);
    expect(containsPublicForbiddenText("perfectly safe prose")).toBe(false);
  });

  it("estimates neurons from prompt length and output tokens, with a floor of 1", () => {
    expect(estimateNeurons("a".repeat(400), 256)).toBe(13);
    expect(estimateNeurons("", 0)).toBe(1);
  });

  it("extracts text from every recognized response shape and falls back to empty otherwise", () => {
    expect(extractAiText("plain string")).toBe("plain string");
    expect(extractAiText({ response: "r" })).toBe("r");
    expect(extractAiText({ text: "t" })).toBe("t");
    expect(extractAiText({ result: "res" })).toBe("res");
    expect(extractAiText({ nothing: "here" })).toBe("");
    expect(extractAiText(null)).toBe("");
  });

  it("maps every ChatQaResult status to its audit outcome, including the unreachable-in-practice default", () => {
    expect(auditOutcomeForAiStatus("ok")).toBe("success");
    expect(auditOutcomeForAiStatus("quota_exceeded")).toBe("denied");
    expect(auditOutcomeForAiStatus("unsafe")).toBe("denied");
    expect(auditOutcomeForAiStatus("error")).toBe("error");
    expect(auditOutcomeForAiStatus("disabled")).toBe("completed");
  });
});
