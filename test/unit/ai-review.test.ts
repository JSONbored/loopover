import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __aiReviewInternals,
  AI_CONSENSUS_FLOOR,
  BEST_REVIEW_MODELS,
  runGittensoryAiReview,
  type GittensoryAiReviewInput,
} from "../../src/services/ai-review";
import { createTestEnv } from "../helpers/d1";

const { parseModelReview, coerceAiText, composeAdvisoryNotes, consensusDefectOf, toPublicSafe, runWorkersOpinion } = __aiReviewInternals;

function reviewJson(over: Partial<{ assessment: string; suggestions: string[]; risks: string[]; present: boolean; confidence: number; title: string; detail: string }> = {}): string {
  return JSON.stringify({
    assessment: over.assessment ?? "The change looks reasonable and focused.",
    suggestions: over.suggestions ?? ["Add a unit test for the new branch."],
    risks: over.risks ?? ["Edge case on empty input is untested."],
    criticalDefect: { present: over.present ?? false, confidence: over.confidence ?? 0, title: over.title ?? "", detail: over.detail ?? "" },
  });
}

const baseInput: GittensoryAiReviewInput = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  title: "Fix null deref",
  body: "Closes #1",
  diff: "### src/a.ts (modified) +3/-1\n@@\n+const x = 1;",
  actor: "alice",
  mode: "advisory",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runGittensoryAiReview gating", () => {
  it("is disabled until both AI flags are on", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true" });
    await expect(runGittensoryAiReview(env, baseInput)).resolves.toMatchObject({ status: "disabled" });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unavailable when the Workers AI binding is missing", async () => {
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    await expect(runGittensoryAiReview(env, baseInput)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("enforces the shared daily neuron budget before calling the model", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1" });
    await expect(runGittensoryAiReview(env, baseInput)).resolves.toMatchObject({ status: "quota_exceeded" });
    expect(run).not.toHaveBeenCalled();
  });

  it("clamps a non-numeric AI_MAX_OUTPUT_TOKENS back to the default", async () => {
    const run = vi.fn(async () => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000", AI_MAX_OUTPUT_TOKENS: "not-a-number" });
    const result = await runGittensoryAiReview(env, baseInput);
    expect(result.status).toBe("ok"); // NaN → clamped to the 256 floor, review still runs
  });

  it("does NOT count a BYOK advisory against the free neuron budget (it bills the maintainer)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: reviewJson({ assessment: "BYOK advisory." }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn();
    // Free budget is exhausted (1 neuron), but a BYOK advisory bills the maintainer's account, so it still runs
    // while the separate BYOK repo/day quota has capacity.
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1", AI_BYOK_DAILY_REPO_LIMIT: "1" });
    const result = await runGittensoryAiReview(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-secret" } });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.advisoryNotes).toContain("BYOK advisory.");
    expect(result.status === "ok" && result.estimatedNeurons).toBe(0); // advisory-only BYOK consumes no free budget
    expect(fetchMock).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("enforces a separate per-repo daily quota before BYOK provider calls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: reviewJson({ assessment: "BYOK advisory." }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "0", AI_BYOK_DAILY_REPO_LIMIT: "1" });
    const providerKey = { provider: "anthropic" as const, key: "sk-ant-secret" };

    await expect(runGittensoryAiReview(env, { ...baseInput, providerKey })).resolves.toMatchObject({ status: "ok" });
    await expect(runGittensoryAiReview(env, { ...baseInput, prNumber: 8, providerKey })).resolves.toMatchObject({ status: "quota_exceeded" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("AI Gateway routing for free Workers-AI calls", () => {
  it("routes through the gateway when AI_GATEWAY_ID is set", async () => {
    const run = vi.fn(async () => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000", AI_GATEWAY_ID: "gtsy-gw" });
    await runGittensoryAiReview(env, baseInput);
    expect(run).toHaveBeenCalled();
    expect((run.mock.calls[0] as unknown[] | undefined)?.[2]).toEqual({ gateway: { id: "gtsy-gw" } });
  });

  it("calls the binding directly (no gateway arg) when AI_GATEWAY_ID is unset", async () => {
    const run = vi.fn(async () => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    await runGittensoryAiReview(env, baseInput);
    expect((run.mock.calls[0] as unknown[] | undefined)?.[2]).toBeUndefined();
  });
});

describe("runGittensoryAiReview advisory mode", () => {
  it("produces public-safe advisory notes from one Workers-AI opinion and no defect", async () => {
    const run = vi.fn(async (_model: string) => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.consensusDefect).toBeNull();
    expect(result.advisoryNotes).toContain("Suggestions");
    expect(result.advisoryNotes).toContain("Add a unit test");
    // Advisory mode runs a single opinion (primary model).
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(BEST_REVIEW_MODELS[0]);
  });
});

describe("runGittensoryAiReview block mode (consensus)", () => {
  function envWith(run: (model: string) => Promise<unknown>) {
    return createTestEnv({ AI: { run: vi.fn(run) } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
  }

  it("reports a consensus defect only when BOTH models agree at/above the floor", async () => {
    const env = envWith(async () => ({ response: reviewJson({ present: true, confidence: 0.95, title: "Unhandled null", detail: "Crashes on empty list." }) }));
    const result = await runGittensoryAiReview(env, { ...baseInput, mode: "block" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.consensusDefect).not.toBeNull();
    expect(result.consensusDefect?.title).toContain("Unhandled null");
  });

  it("does NOT report a defect when only one model flags it", async () => {
    const env = envWith(async (model) =>
      model === BEST_REVIEW_MODELS[1]
        ? { response: reviewJson({ present: false }) }
        : { response: reviewJson({ present: true, confidence: 0.99, title: "Race", detail: "Concurrent write." }) },
    );
    const result = await runGittensoryAiReview(env, { ...baseInput, mode: "block" });
    expect(result.status === "ok" && result.consensusDefect).toBeNull();
  });

  it("does NOT report a defect when both agree but below the confidence floor", async () => {
    const env = envWith(async () => ({ response: reviewJson({ present: true, confidence: 0.6, title: "Maybe bug", detail: "Unsure." }) }));
    const result = await runGittensoryAiReview(env, { ...baseInput, mode: "block" });
    expect(result.status === "ok" && result.consensusDefect).toBeNull();
  });

  it("does NOT report a defect when one model's verdict is unparseable (null opinion)", async () => {
    // Only the first slot's primary parses; the second slot's primary AND its reliable fallback fail.
    const env = envWith(async (model) =>
      model === BEST_REVIEW_MODELS[0] ? { response: reviewJson({ present: true, confidence: 0.99, title: "Null deref", detail: "boom" }) } : { response: "garbage" },
    );
    const result = await runGittensoryAiReview(env, { ...baseInput, mode: "block", actor: undefined });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.consensusDefect).toBeNull();
    expect(result.advisoryNotes).not.toBeNull(); // notes still come from the one parseable opinion
  });

  it("block mode with BYOK: provider writes the advisory, the free Workers-AI pair drives consensus", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: reviewJson({ assessment: "Frontier advisory." }) }] }), { status: 200 })));
    const run = vi.fn(async (_model: string) => ({ response: reviewJson({ present: true, confidence: 0.96, title: "Off-by-one", detail: "Loop bound." }) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, { ...baseInput, mode: "block", providerKey: { provider: "anthropic", key: "sk-ant" } });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.consensusDefect?.title).toContain("Off-by-one"); // consensus from Workers AI, not the provider
    expect(result.advisoryNotes).toContain("Frontier advisory."); // advisory from BYOK provider
    expect(run).toHaveBeenCalledTimes(2); // both consensus opinions via Workers AI
  });
});

describe("BYOK provider dispatch", () => {
  it("uses the Anthropic API for the advisory write-up when a key is supplied", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: reviewJson({ assessment: "BYOK review." }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-secret" } });
    expect(result.status === "ok" && result.advisoryNotes).toContain("BYOK review.");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    // The provider fetch must carry a timeout signal so a hung provider can't stall the queue worker.
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    expect(run).not.toHaveBeenCalled(); // advisory mode + BYOK → no Workers AI call
  });

  it("falls back to no notes when the provider returns a non-200 and records the failure reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, { ...baseInput, providerKey: { provider: "openai", key: "sk-secret" } });
    expect(result.status === "ok" && result.advisoryNotes).toBeNull();
    // The audit event names the failure (observability) and NEVER includes key material.
    const row = await env.DB.prepare("select metadata_json from ai_usage_events where feature = ? order by rowid desc limit 1").bind("ai_review_pr").first<{ metadata_json: string }>();
    expect(JSON.parse(row?.metadata_json ?? "{}").byokFailure).toBe("http_error");
    expect(row?.metadata_json ?? "").not.toContain("sk-secret");
  });

  it("records a timeout failure when the provider fetch aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Mirror AbortSignal.timeout's rejection (a TimeoutError DOMException-shaped error).
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }),
    );
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-secret" } });
    expect(result.status === "ok" && result.advisoryNotes).toBeNull();
    const row = await env.DB.prepare("select metadata_json from ai_usage_events where feature = ? order by rowid desc limit 1").bind("ai_review_pr").first<{ metadata_json: string }>();
    expect(JSON.parse(row?.metadata_json ?? "{}").byokFailure).toBe("timeout");
  });

  it("falls back to no notes when the provider fetch throws, and honors a model override", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant", model: "claude-custom" } });
    expect(result.status === "ok" && result.advisoryNotes).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1] && (fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe("claude-custom");
  });
});

describe("Workers AI fallback + degraded output", () => {
  it("tries the per-slot fallback model then returns no notes when every opinion is unparseable", async () => {
    const run = vi.fn(async (_model: string) => ({ response: "this is not json at all" }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, baseInput);
    expect(result.status === "ok" && result.advisoryNotes).toBeNull();
    // primary 3× + fallback 3× retries, all unparseable.
    expect(run).toHaveBeenCalledTimes(6);
  });
});

describe("pure helpers", () => {
  it("toPublicSafe drops forbidden public text and neutralizes markdown, mentions, links, and control characters", () => {
    expect(toPublicSafe("This change is solid.")).toBe("This change is solid.");
    expect(toPublicSafe("Boost your reward payout")).toBeNull();
    expect(toPublicSafe("Ping @octo-team about [urgent update](https://evil.example/p) ![pixel](https://evil.example/i.png)\n- injected")).toBe(
      "Ping @\u200Bocto-team about \\[urgent update\\]\\(https:\u200B//evil.example/p\\) \\!\\[pixel\\]\\(https:\u200B//evil.example/i.png\\) - injected",
    );
    expect(toPublicSafe("")).toBeNull();
    expect(toPublicSafe(null)).toBeNull();
    expect(toPublicSafe(undefined)).toBeNull();
  });

  it("coerceAiText handles string, {response}, OpenAI choices, Anthropic content, and output_text shapes", () => {
    expect(coerceAiText("raw")).toBe("raw");
    expect(coerceAiText({ response: "r" })).toBe("r");
    expect(coerceAiText({ choices: [{ message: { content: "c" } }] })).toBe("c");
    expect(coerceAiText({ content: [{ type: "text", text: "a" }] })).toBe("a");
    expect(coerceAiText({ content: [] })).toBe(""); // empty content array
    expect(coerceAiText({ content: [{ type: "image" }], output_text: "fallback" })).toBe("fallback"); // non-text parts → fall through
    expect(coerceAiText({ response: {} })).toBe("{}"); // object response → JSON.stringify
    expect(coerceAiText({ response: "" })).toBe(""); // empty-string response → fall through
    expect(coerceAiText({ choices: [{ text: "t" }] })).toBe("t"); // content via first.text fallback
    expect(coerceAiText({ output_text: "o" })).toBe("o");
    expect(coerceAiText(42)).toBe("");
  });

  it("parseModelReview returns null on junk, on brace-but-invalid JSON, on empty objects, and clamps confidence", () => {
    expect(parseModelReview("not json")).toBeNull();
    expect(parseModelReview("{ not: valid json }")).toBeNull(); // matches the brace regex but JSON.parse throws
    expect(parseModelReview('{"foo":1}')).toBeNull(); // no assessment, no defect, no suggestions
    const parsed = parseModelReview(reviewJson({ present: true, confidence: 5, title: "X", detail: "Y" }));
    expect(parsed?.criticalDefect.confidence).toBe(1);
  });

  it("parseModelReview coerces non-string/non-array fields to safe defaults", () => {
    const parsed = parseModelReview('{"assessment":"ok","suggestions":"not-an-array","risks":7,"criticalDefect":{"present":true,"confidence":0.9,"title":5,"detail":null}}');
    expect(parsed).not.toBeNull();
    expect(parsed?.suggestions).toEqual([]); // non-array → []
    expect(parsed?.risks).toEqual([]);
    expect(parsed?.criticalDefect.title).toBe(""); // non-string → ""
    expect(parsed?.criticalDefect.detail).toBe("");
  });

  it("consensusDefectOf requires both present and at/above the floor and drops unsafe titles", () => {
    const defect = (present: boolean, confidence: number, title = "Null deref", detail = "boom") => ({ assessment: "", suggestions: [], risks: [], criticalDefect: { present, confidence, title, detail } });
    expect(consensusDefectOf(defect(true, 0.95), defect(true, 0.95), AI_CONSENSUS_FLOOR)).not.toBeNull();
    expect(consensusDefectOf(defect(true, 0.8), defect(true, 0.95), AI_CONSENSUS_FLOOR)).toBeNull();
    expect(consensusDefectOf(defect(false, 0.95), defect(true, 0.95), AI_CONSENSUS_FLOOR)).toBeNull(); // one not present
    expect(consensusDefectOf(defect(true, 0.95, "Boost your reward payout"), defect(true, 0.95, "Boost your reward payout"), AI_CONSENSUS_FLOOR)).toBeNull();
  });

  it("consensusDefectOf falls back to b's title and a default detail when a is blank", () => {
    const a = { assessment: "", suggestions: [], risks: [], criticalDefect: { present: true, confidence: 0.95, title: "", detail: "" } };
    const b = { assessment: "", suggestions: [], risks: [], criticalDefect: { present: true, confidence: 0.93, title: "Race condition", detail: "" } };
    const out = consensusDefectOf(a, b, AI_CONSENSUS_FLOOR);
    expect(out?.title).toBe("Race condition");
    expect(out?.detail).toMatch(/independently flagged/);
    // both titles blank → default title string is used
    const blank = { ...a, criticalDefect: { ...a.criticalDefect } };
    expect(consensusDefectOf(blank, { ...blank, criticalDefect: { ...blank.criticalDefect } }, AI_CONSENSUS_FLOOR)?.title).toContain("AI reviewers agree");
  });

  it("runWorkersOpinion returns null without a binding and handles a single-model (no distinct fallback) list", async () => {
    expect(await runWorkersOpinion(createTestEnv({}), "m", "f", "sys", "user", 256)).toBeNull();
    const run = vi.fn(async (_model: string) => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    // fallback === primary exercises the single-element model list branch.
    const parsed = await runWorkersOpinion(env, "@cf/x/model", "@cf/x/model", "sys", "user", 256);
    expect(parsed?.assessment).toContain("reasonable");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("applies the default daily neuron budget when none is configured", async () => {
    const run = vi.fn(async (_model: string) => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    const result = await runGittensoryAiReview(env, baseInput);
    expect(result.status).toBe("ok");
  });

  it("composeAdvisoryNotes returns null when nothing is public-safe", () => {
    expect(composeAdvisoryNotes([{ assessment: "reward payout farming", suggestions: ["payout"], risks: ["reward"], criticalDefect: { present: false, confidence: 0, title: "", detail: "" } }])).toBeNull();
  });

  it("composeAdvisoryNotes renders only the sections that have public-safe content", () => {
    const review = (over: Partial<{ assessment: string; suggestions: string[]; risks: string[] }>) => ({ assessment: over.assessment ?? "", suggestions: over.suggestions ?? [], risks: over.risks ?? [], criticalDefect: { present: false, confidence: 0, title: "", detail: "" } });
    const assessmentOnly = composeAdvisoryNotes([review({ assessment: "Looks good." })]);
    expect(assessmentOnly).toBe("Looks good.");
    const suggestionsOnly = composeAdvisoryNotes([review({ suggestions: ["Add a test."] })]);
    expect(suggestionsOnly).toContain("**Suggestions**");
    expect(suggestionsOnly).not.toContain("**Risks**");
    const risksOnly = composeAdvisoryNotes([review({ risks: ["Edge case."] })]);
    expect(risksOnly).toContain("**Risks**");
    expect(risksOnly).not.toContain("**Suggestions**");
  });

  it("runGittensoryAiReview is disabled when neither flag is set", async () => {
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai });
    await expect(runGittensoryAiReview(env, baseInput)).resolves.toMatchObject({ status: "disabled", reason: "AI summaries are disabled." });
  });

  it("handles a review input with no PR body", async () => {
    const run = vi.fn(async (_model: string, _options: { messages: Array<{ content: string }> }) => ({ response: reviewJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runGittensoryAiReview(env, { ...baseInput, body: undefined });
    expect(result.status).toBe("ok");
    expect(String(run.mock.calls[0]?.[1] && (run.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[1]?.content)).toContain("Description: (none)");
  });
});
