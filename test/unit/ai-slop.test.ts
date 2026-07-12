import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_SLOP_FINDING_CODE,
  __aiSlopInternals,
  runGittensoryAiSlopAdvisory,
  type AiSlopInput,
} from "../../src/services/ai-slop";
import { evaluateGateCheck } from "../../src/rules/advisory";
import { buildAiReviewDiff, runAiSlopForAdvisory } from "../../src/queue/processors";
import { BEST_REVIEW_MODELS, RELIABLE_FALLBACK_MODELS } from "../../src/services/ai-review";
import { getCachedAiSlopAdvisory, putCachedAiSlopAdvisory, recordAiUsageEvent, upsertRepositoryAiKey } from "../../src/db/repositories";
import { aiSlopCacheInputFingerprint } from "../../src/review/ai-slop-cache-input";
import type { Advisory, PullRequestFileRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const { parseSlopOpinion, slopFindingFromOpinion, buildUserPrompt } = __aiSlopInternals;

function slopJson(over: Partial<{ band: string; rationale: string; signals: string[] }> = {}): string {
  return JSON.stringify({
    band: over.band ?? "elevated",
    rationale: over.rationale ?? "The diff is large but adds little substantive logic.",
    signals: over.signals ?? ["Most lines are reformatting", "Comments restate the code"],
  });
}

const baseInput: AiSlopInput = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  title: "Tidy things up",
  body: "General cleanup",
  diff: "### src/a.ts (modified) +80/-2\n@@\n+// set x to one\n+const x = 1;",
  actor: "alice",
  deterministicBand: "elevated",
};

const enabledEnv = (run: unknown) =>
  createTestEnv({
    AI: { run } as unknown as Ai,
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSlopOpinion", () => {
  it("parses a well-formed opinion and caps the signals list", () => {
    const parsed = parseSlopOpinion(slopJson({ signals: ["a", "b", "c", "d", "e", "f"] }));
    expect(parsed).toMatchObject({ band: "elevated" });
    expect(parsed?.signals).toHaveLength(4); // capped at 4
  });

  it("strips a ```json code fence before parsing", () => {
    expect(parseSlopOpinion("```json\n" + slopJson({ band: "high" }) + "\n```")?.band).toBe("high");
  });

  it("rejects an invalid band", () => {
    expect(parseSlopOpinion(JSON.stringify({ band: "toxic", rationale: "x", signals: [] }))).toBeNull();
  });

  it("rejects when there is neither a rationale nor any signal", () => {
    expect(parseSlopOpinion(JSON.stringify({ band: "low", rationale: "", signals: [] }))).toBeNull();
  });

  it("returns null on non-JSON text", () => {
    expect(parseSlopOpinion("the model refused to answer")).toBeNull();
  });

  it("returns null when a brace-shaped blob is not valid JSON (parse throws)", () => {
    // Matches the {…} regex but JSON.parse throws on the unquoted keys → caught → null.
    expect(parseSlopOpinion("{ band: high, rationale: nope }")).toBeNull();
  });

  it("filters non-string signals", () => {
    const parsed = parseSlopOpinion(JSON.stringify({ band: "low", rationale: "ok", signals: ["real", 5, null, "two"] }));
    expect(parsed?.signals).toEqual(["real", "two"]);
  });
});

describe("slopFindingFromOpinion", () => {
  it("returns null for a clean band (no advisory noise)", () => {
    expect(slopFindingFromOpinion({ band: "clean", rationale: "looks genuine", signals: [] })).toBeNull();
  });

  it("maps low → info and elevated/high → warning, with the advisory code", () => {
    expect(slopFindingFromOpinion({ band: "low", rationale: "minor", signals: [] })).toMatchObject({
      code: AI_SLOP_FINDING_CODE,
      severity: "info",
    });
    expect(slopFindingFromOpinion({ band: "elevated", rationale: "padding", signals: ["x"] })?.severity).toBe("warning");
    expect(slopFindingFromOpinion({ band: "high", rationale: "generated", signals: ["x"] })?.severity).toBe("warning");
  });

  it("never emits a critical severity (so it can never look like a consensus defect)", () => {
    for (const band of ["low", "elevated", "high"] as const) {
      expect(slopFindingFromOpinion({ band, rationale: "r", signals: [] })?.severity).not.toBe("critical");
    }
  });

  it("composes signals into the public-safe detail", () => {
    const finding = slopFindingFromOpinion({ band: "elevated", rationale: "Large but shallow.", signals: ["reformatting", "restated comments"] });
    expect(finding?.detail).toContain("Large but shallow.");
    expect(finding?.detail).toContain("reformatting");
    expect(finding?.publicText).toContain("AI maintainer-assist");
  });

  it("drops the finding when nothing survives public-safe sanitization", () => {
    // 'reward' / 'farming' are forbidden public terms → sanitizer strips them; with no safe content left, drop.
    const finding = slopFindingFromOpinion({ band: "high", rationale: "reward farming payout", signals: ["reward", "payout"] });
    // Either dropped entirely, or the public text never leaks a forbidden term.
    if (finding) expect(finding.publicText ?? "").not.toMatch(/reward|farming|payout/i);
  });

  it("falls back to a generic detail body when only signals (no rationale) survive", () => {
    const finding = slopFindingFromOpinion({ band: "elevated", rationale: "", signals: ["mostly reformatting"] });
    expect(finding?.detail).toContain("An AI maintainer-assist pass flagged");
    expect(finding?.detail).toContain("mostly reformatting");
  });
});

describe("buildUserPrompt", () => {
  it("omits the description and band lines when they are absent", () => {
    const prompt = buildUserPrompt({ repoFullName: "a/b", prNumber: 1, title: "t", diff: "d" });
    expect(prompt).toContain("Description: (none)");
    expect(prompt).not.toContain("Deterministic slop band");
  });

  it("includes the description and band when provided", () => {
    const prompt = buildUserPrompt({ repoFullName: "a/b", prNumber: 1, title: "t", diff: "d", body: "the body", deterministicBand: "high" });
    expect(prompt).toContain("the body");
    expect(prompt).toContain("Deterministic slop band (for reference): high");
  });
});

describe("runGittensoryAiSlopAdvisory gating + fail-safe", () => {
  it("is disabled until both AI flags are on, and never calls the model", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true" });
    await expect(runGittensoryAiSlopAdvisory(env, baseInput)).resolves.toMatchObject({ status: "disabled" });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unavailable when the Workers AI binding is missing", async () => {
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    await expect(runGittensoryAiSlopAdvisory(env, baseInput)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("enforces the shared daily neuron budget before calling the model", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1" });
    await expect(runGittensoryAiSlopAdvisory(env, baseInput)).resolves.toMatchObject({ status: "quota_exceeded" });
    expect(run).not.toHaveBeenCalled();
  });

  it("budgets Workers AI slop retry and fallback attempts before calling the model", async () => {
    const run = vi.fn(async () => ({ response: "not json" }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "1",
    });

    const result = await runGittensoryAiSlopAdvisory(env, baseInput);

    expect(result).toMatchObject({ status: "quota_exceeded" });
    expect(run).not.toHaveBeenCalled();
    if (result.status !== "quota_exceeded") throw new Error("unreachable");
    expect(result.estimatedNeurons).toBeGreaterThan(result.remainingBudget);
  });

  it("uses the full 10M shared budget, not the old 1M ceiling — slop survives heavy review spend (#review-audit)", async () => {
    const run = vi.fn(async () => ({ response: "not json" }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "2000000" });
    // Prior shared spend of 1.5M neurons — OVER the old 1M ceiling, well under the 2M shared budget.
    await recordAiUsageEvent(env, { feature: "ai_review", model: "m", status: "ok", estimatedNeurons: 1_500_000 });
    const result = await runGittensoryAiSlopAdvisory(env, baseInput);
    expect(result.status).not.toBe("quota_exceeded"); // the old clamp(2M, 0, 1M) = 1M budget → quota_exceeded at 1.5M used
    expect(run).toHaveBeenCalled();
  });

  it("defaults the budget HIGH (10M) when AI_DAILY_NEURON_BUDGET is unset/invalid — no 10k starvation (#review-audit)", async () => {
    const run = vi.fn(async () => ({ response: "not json" }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "" });
    // 2M prior spend — OVER the old 10k default, under the 10M default the fix uses.
    await recordAiUsageEvent(env, { feature: "ai_review", model: "m", status: "ok", estimatedNeurons: 2_000_000 });
    const result = await runGittensoryAiSlopAdvisory(env, baseInput);
    expect(result.status).not.toBe("quota_exceeded"); // the old `|| 10000` default → quota_exceeded at 2M used
    expect(run).toHaveBeenCalled();
  });

  it("records the pre-budgeted retry and fallback estimate when all Workers AI outputs are unusable", async () => {
    const run = vi.fn(async () => ({ response: "not json" }));
    const env = enabledEnv(run);
    const result = await runGittensoryAiSlopAdvisory(env, baseInput);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(run).toHaveBeenCalledTimes(6);

    const row = await env.DB.prepare("select estimated_neurons from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("ai_slop_pr")
      .first<{ estimated_neurons: number }>();
    expect(row?.estimated_neurons).toBe(result.estimatedNeurons);
    expect(result.estimatedNeurons).toBeGreaterThanOrEqual(6);
  });

  it("degrades to no finding when env.AI is present but not a valid runner (no .run function)", async () => {
    const env = createTestEnv({
      AI: {} as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    const result = await runGittensoryAiSlopAdvisory(env, baseInput);
    expect(result).toMatchObject({ status: "ok", finding: null, band: null });
  });

  it("returns an advisory finding when the model flags an elevated band", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
    const result = await runGittensoryAiSlopAdvisory(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.band).toBe("elevated");
    expect(result.finding).toMatchObject({ code: AI_SLOP_FINDING_CODE, severity: "warning" });
  });

  it("records the REAL reported model, not the hardcoded fallback label, when the provider reports one (2026-07 fix)", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }), usage: { provider: "ollama", model: "qwen3:8b" } }));
    const env = enabledEnv(run);
    const result = await runGittensoryAiSlopAdvisory(env, baseInput);
    expect(result.status).toBe("ok");

    const row = await env.DB.prepare("select model, provider from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("ai_slop_pr")
      .first<{ model: string; provider: string | null }>();
    expect(row).toMatchObject({ model: "qwen3:8b", provider: "ollama" });
  });

  it("falls back to the hardcoded model label when the provider reports no usage/model at all", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
    const env = enabledEnv(run);
    const result = await runGittensoryAiSlopAdvisory(env, baseInput);
    expect(result.status).toBe("ok");

    const row = await env.DB.prepare("select model from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("ai_slop_pr")
      .first<{ model: string }>();
    expect(row?.model).toBe([BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]].join("+"));
  });

  it("returns no finding when the model judges the change clean", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "clean", rationale: "genuine effort", signals: [] }) }));
    const result = await runGittensoryAiSlopAdvisory(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.band).toBe("clean");
    expect(result.finding).toBeNull();
  });

  it("is fail-safe: a throwing model yields ok with no finding (never throws, never blocks)", async () => {
    const run = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const result = await runGittensoryAiSlopAdvisory(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.finding).toBeNull();
    expect(run).toHaveBeenCalled(); // it tried (3× primary + fallback) and gave up cleanly
  });

  it("falls back to the reliable model when the primary keeps returning garbage", async () => {
    const run = vi.fn(async (model: string) => ({ response: model.includes("gpt-oss") ? "not json" : slopJson({ band: "low" }) }));
    const result = await runGittensoryAiSlopAdvisory(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.band).toBe("low");
  });

  it("enforces the shared BYOK daily repo cap before any provider call (BYOK does not draw on the free budget)", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1", AI_BYOK_DAILY_REPO_LIMIT: "1" });
    // Seed one prior BYOK event for this repo so the cap (1) is already reached.
    await recordAiUsageEvent(env, { feature: "ai_review_pr", actor: null, route: "x", model: "byok:anthropic", status: "ok", estimatedNeurons: 1, detail: "seed", metadata: { repoFullName: baseInput.repoFullName } });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Free budget is exhausted (1 neuron) but BYOK skips it; the BYOK cap is what stops the call.
    const result = await runGittensoryAiSlopAdvisory(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-x" } });
    expect(result.status).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("records real BYOK usage (tokens + cost) on the durable audit row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: slopJson({ band: "elevated" }) }],
              usage: { input_tokens: 500, output_tokens: 50 },
            }),
            { status: 200 },
          ),
      ),
    );
    const env = enabledEnv(vi.fn());
    const result = await runGittensoryAiSlopAdvisory(env, {
      ...baseInput,
      providerKey: { provider: "anthropic", key: "sk-ant-x", model: "claude-sonnet-5" },
    });
    expect(result.status).toBe("ok");
    const row = await env.DB.prepare(
      `select provider, input_tokens, output_tokens, total_tokens, cost_usd
       from ai_usage_events where feature = ? order by rowid desc limit 1`,
    )
      .bind("ai_slop_pr")
      .first<{
        provider: string | null;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        cost_usd: number;
      }>();
    expect(row).toMatchObject({
      provider: "anthropic",
      input_tokens: 500,
      output_tokens: 50,
      total_tokens: 550,
      cost_usd: 0.00225,
    });
  });
});

describe("the AI slop advisory can never become a gate blocker", () => {
  function advisoryWithAiSlop(): Advisory {
    return {
      id: "advisory-aislop",
      targetType: "pull_request",
      targetKey: "owner/repo#7",
      repoFullName: "owner/repo",
      pullNumber: 7,
      headSha: "sha7",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [slopFindingFromOpinion({ band: "high", rationale: "looks low effort", signals: ["padding"] })!],
      generatedAt: "2026-06-14T00:00:00.000Z",
    };
  }

  it("is not a configured blocker even for a confirmed contributor with every gate mode on", () => {
    const gate = evaluateGateCheck(advisoryWithAiSlop(), {
      confirmedContributor: true,
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "block",
      qualityGateMode: "block",
      aiReviewGateMode: "block",
      // slop block mode but a sub-threshold risk → the deterministic slop blocker does NOT fire either.
      slopGateMode: "block",
      slopRisk: 10,
      slopGateMinScore: 60,
    });
    expect(gate.conclusion).toBe("success");
    expect(gate.blockers).toHaveLength(0);
    // It still surfaces as an advisory warning.
    expect(gate.warnings.some((w) => w.code === AI_SLOP_FINDING_CODE)).toBe(true);
  });
});

describe("runAiSlopForAdvisory (processor wiring)", () => {
  function advisory(over: Partial<Advisory> = {}): Advisory {
    return {
      id: "adv-slop",
      targetType: "pull_request",
      targetKey: "acme/widgets#3",
      repoFullName: "acme/widgets",
      pullNumber: 3,
      headSha: "sha3",
      conclusion: "neutral",
      severity: "info",
      title: "Gittensory advisory available",
      summary: "ok",
      findings: [],
      generatedAt: "2026-06-14T00:00:00.000Z",
      ...over,
    };
  }
  const files: PullRequestFileRecord[] = [
    { repoFullName: "acme/widgets", pullNumber: 3, path: "src/a.ts", status: "modified", additions: 80, deletions: 2, changes: 82, payload: { patch: "@@\n+// set x\n+const x = 1;" } },
  ];
  const pr = { number: 3, title: "Tidy", body: "cleanup" };
  const noByok = { aiReviewByok: false } as RepositorySettings;
  const slopFingerprint = (over: Partial<Parameters<typeof aiSlopCacheInputFingerprint>[0]> = {}) =>
    aiSlopCacheInputFingerprint({
      title: pr.title,
      body: pr.body,
      diff: buildAiReviewDiff(files),
      deterministicBand: "high",
      byok: false,
      provider: null,
      model: null,
      ...over,
    });

  it("appends a single ai_slop_advisory finding when the model flags slop", async () => {
    const adv = advisory();
    await runAiSlopForAdvisory(enabledEnv(async () => ({ response: slopJson({ band: "high" }) })), {
      mode: "live",
      settings: noByok,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
  });

  it("no-ops when the advisory has no head SHA", async () => {
    const noSha = advisory();
    delete (noSha as Partial<Advisory>).headSha;
    const run = vi.fn();
    await runAiSlopForAdvisory(enabledEnv(run), { mode: "live",  settings: noByok, advisory: noSha, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "low", confirmedContributor: true, commitThresholdReached: false });
    expect(noSha.findings).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  // REGRESSION (#ai-slop-repeat-spend): before this, a PR the sweep kept re-visiting paid for a fresh slop
  // advisory on EVERY pass (only a headSha+prompt-fingerprint cache guarded re-spend, no cap on how many
  // times a stale, already-well-reviewed PR gets re-attempted). commitThresholdReached mirrors ai_review's
  // own auto_pause_after_reviewed_commits cap so slop stops re-attempting too, once reached.
  it("REGRESSION (#ai-slop-repeat-spend): never calls the model when commitThresholdReached is true, even for a confirmed contributor with a valid head SHA", async () => {
    const adv = advisory();
    const run = vi.fn();
    await runAiSlopForAdvisory(enabledEnv(run), {
      mode: "live",
      settings: noByok,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
      confirmedContributor: true,
      commitThresholdReached: true,
    });
    expect(adv.findings).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("still runs the slop advisory when commitThresholdReached is false (the normal, not-yet-capped case)", async () => {
    const adv = advisory();
    await runAiSlopForAdvisory(enabledEnv(async () => ({ response: slopJson({ band: "high" }) })), {
      mode: "live",
      settings: noByok,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
  });

  it("adds nothing when the model judges the change clean", async () => {
    const adv = advisory();
    await runAiSlopForAdvisory(enabledEnv(async () => ({ response: slopJson({ band: "clean", rationale: "genuine", signals: [] }) })), {
      mode: "live",
      settings: noByok,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "clean",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    expect(adv.findings).toEqual([]);
  });

  it("REGRESSION (#token-bleed-spend-gate): a paused mode never reaches the LLM call, even for a confirmed contributor", async () => {
    const run = vi.fn(async () => ({ response: slopJson() }));
    const adv = advisory();
    await runAiSlopForAdvisory(enabledEnv(run), { mode: "paused", settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "high", confirmedContributor: true, commitThresholdReached: false });
    expect(adv.findings).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("is fail-safe: a thrown error (broken DB) yields no finding and never throws", async () => {
    const adv = advisory();
    const env = { ...enabledEnv(async () => ({ response: slopJson() })), DB: undefined } as unknown as Env;
    await expect(runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "high", confirmedContributor: true, commitThresholdReached: false })).resolves.toBeUndefined();
    expect(adv.findings).toEqual([]);
  });

  it("uses the maintainer's BYOK frontier model (not Workers AI) when aiReviewByok is on and a key is configured", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "clean" }) })); // Workers AI must NOT be used
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      TOKEN_ENCRYPTION_SECRET: "ai-slop-byok-test-encryption-secret-32b",
    });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-slop-9999", model: null });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: slopJson({ band: "high" }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adv = advisory();
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: { aiReviewByok: true } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    // The advisory came from the BYOK provider (high band → finding), and Workers AI was never called.
    expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses BYOK when settings.aiReviewProvider is explicitly set and matches the stored key's provider", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "clean" }) })); // Workers AI must NOT be used
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      TOKEN_ENCRYPTION_SECRET: "ai-slop-byok-test-encryption-secret-32b",
    });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-slop-9999", model: null });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: slopJson({ band: "high" }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adv = advisory();
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: { aiReviewByok: true, aiReviewProvider: "anthropic" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    // A declared provider matching the stored key's provider still authorizes BYOK (same outcome as the
    // no-declared-provider case above) — Workers AI is never called.
    expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to Workers AI when settings.aiReviewProvider is set but does NOT match the stored key's provider", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "clean" }) }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      TOKEN_ENCRYPTION_SECRET: "ai-slop-byok-test-encryption-secret-32b",
    });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-slop-9999", model: null });
    const fetchMock = vi.fn(async () => new Response("should never be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const adv = advisory();
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: { aiReviewByok: true, aiReviewProvider: "openai" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    // Declared provider ("openai") mismatches the stored key's provider ("anthropic") ⇒ BYOK is skipped and
    // the free Workers AI path runs instead (the BYOK fetch endpoint is never hit).
    expect(run).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops entirely for unconfirmed contributors — neither the maintainer BYOK key nor free Workers AI is spent", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "high" }) }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      TOKEN_ENCRYPTION_SECRET: "ai-slop-byok-test-encryption-secret-32b",
    });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-slop-9999", model: null });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: slopJson({ band: "high" }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adv = advisory();
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: { aiReviewByok: true } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "mallory",
      files,
      deterministicBand: "elevated",
      confirmedContributor: false,
      commitThresholdReached: false,
    });

    // Matches the AI review path: an unconfirmed author triggers no AI spend at all, so no finding lands.
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  describe("AI slop advisory cache wiring (#ai-slop-cache)", () => {
    it("reuses a stored advisory for an unchanged head SHA instead of calling the model again", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "high" }) }));
      const env = enabledEnv(run);
      const fingerprint = await slopFingerprint();
      await putCachedAiSlopAdvisory(env, "acme/widgets", 3, "sha3", fingerprint, {
        status: "ok",
        band: "high",
        finding: { code: AI_SLOP_FINDING_CODE, title: "cached finding", severity: "warning", detail: "from cache" },
        estimatedNeurons: 42,
      });
      const adv = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "high", confirmedContributor: true, commitThresholdReached: false });

      expect(run).not.toHaveBeenCalled(); // no LLM call spent on the cache hit
      expect(adv.findings).toEqual([{ code: AI_SLOP_FINDING_CODE, title: "cached finding", severity: "warning", detail: "from cache" }]);
    });

    it("swallows a throwing audit-event write on a cache hit (fail-safe, the finding still reaches the advisory)", async () => {
      const run = vi.fn();
      const env = enabledEnv(run);
      const fingerprint = await slopFingerprint();
      await putCachedAiSlopAdvisory(env, "acme/widgets", 3, "sha3", fingerprint, {
        status: "ok",
        band: "high",
        finding: { code: AI_SLOP_FINDING_CODE, title: "cached finding", severity: "warning", detail: "from cache" },
        estimatedNeurons: 42,
      });
      const repositoriesModule = await import("../../src/db/repositories");
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 audit write error"));
      const adv = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "high", confirmedContributor: true, commitThresholdReached: false });

      expect(run).not.toHaveBeenCalled(); // still a cache hit despite the audit-write failure
      expect(adv.findings).toEqual([{ code: AI_SLOP_FINDING_CODE, title: "cached finding", severity: "warning", detail: "from cache" }]);
      auditSpy.mockRestore();
    });

    it("passes a nullish PR body through as undefined (not null) to the fresh advisory call on a cache miss", async () => {
      const run = vi.fn(async (_model: string, options: { messages: { content: string }[] }) => {
        expect(options.messages[1]?.content).toContain("Description: (none)"); // buildUserPrompt's no-body branch
        return { response: slopJson({ band: "elevated" }) };
      });
      const env = enabledEnv(run);
      const adv = advisory();
      await runAiSlopForAdvisory(env, {
        mode: "live",
        settings: noByok,
        advisory: adv,
        repoFullName: "acme/widgets",
        pr: { number: 3, title: "Tidy" }, // no `body` key at all — exercises the `?? undefined` nullish arm
        author: "alice",
        files,
        deterministicBand: "elevated",
        confirmedContributor: true,
        commitThresholdReached: false,
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
    });

    it("misses the cache and writes back a fresh 'ok' result so the NEXT call at this head is a hit", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
      const env = enabledEnv(run);
      const adv = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });
      expect(run).toHaveBeenCalledTimes(1); // fresh call on the miss

      const fingerprint = await slopFingerprint({ deterministicBand: "elevated" });
      const cached = await getCachedAiSlopAdvisory(env, "acme/widgets", 3, "sha3", fingerprint);
      expect(cached).toMatchObject({ status: "ok", band: "elevated" });

      // A second call for the SAME head must now reuse the cache, not spend another LLM call.
      const adv2 = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv2, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });
      expect(run).toHaveBeenCalledTimes(1); // still 1 — the second pass was a cache hit
      expect(adv2.findings).toEqual(adv.findings);
    });

    it("does not cache a quota_exceeded short-circuit — a later call still tries the model once quota allows", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
      const budgetedEnv = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1" });
      const adv = advisory();
      await runAiSlopForAdvisory(budgetedEnv, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });
      expect(run).not.toHaveBeenCalled(); // quota_exceeded short-circuits before any model call
      expect(adv.findings).toEqual([]);

      const fingerprint = await slopFingerprint({ deterministicBand: "elevated" });
      expect(await getCachedAiSlopAdvisory(budgetedEnv, "acme/widgets", 3, "sha3", fingerprint)).toBeNull(); // nothing was persisted

      // Same head, budget now available — must still attempt the model instead of replaying a quota miss.
      const richEnv = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
      const adv2 = advisory();
      await runAiSlopForAdvisory(richEnv, { mode: "live",  settings: noByok, advisory: adv2, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("misses the cache when BYOK is toggled on since the row was written (fresh reviewer → fresh call)", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "clean", rationale: "genuine", signals: [] }) })); // Workers AI must not be used once BYOK is on
      const env = createTestEnv({
        AI: { run } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        TOKEN_ENCRYPTION_SECRET: "ai-slop-byok-cache-test-encryption-secret-32",
      });
      const freeFingerprint = await slopFingerprint({ deterministicBand: "elevated" });
      await putCachedAiSlopAdvisory(env, "acme/widgets", 3, "sha3", freeFingerprint, {
        status: "ok",
        band: "high",
        finding: { code: AI_SLOP_FINDING_CODE, title: "stale free-tier finding", severity: "warning", detail: "d" },
        estimatedNeurons: 12,
      });
      await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-cache-9999", model: null });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: slopJson({ band: "high" }) }] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const adv = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: { aiReviewByok: true } as RepositorySettings, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });

      // A fresh BYOK call was made (not the stale free-tier cache row, and not Workers AI).
      expect(fetchMock).toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(adv.findings.map((f) => f.title)).not.toContain("stale free-tier finding");
    });

    it("is fail-safe when the cache READ throws — falls through to a fresh model call, never blocks the advisory", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
      const env = enabledEnv(run);
      const repositoriesModule = await import("../../src/db/repositories");
      const readSpy = vi.spyOn(repositoriesModule, "getCachedAiSlopAdvisory").mockRejectedValueOnce(new Error("D1 read error"));
      const adv = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });
      expect(run).toHaveBeenCalledTimes(1); // degraded to a miss instead of throwing
      expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
      readSpy.mockRestore();
    });

    it("is fail-safe when the cache WRITE throws — the fresh finding still reaches the advisory, and the failure is audited", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
      const env = enabledEnv(run);
      const repositoriesModule = await import("../../src/db/repositories");
      const writeSpy = vi.spyOn(repositoriesModule, "putCachedAiSlopAdvisory").mockRejectedValueOnce(new Error("D1 write error"));
      const adv = advisory();
      await runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false });
      expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]); // swallowed, not thrown
      writeSpy.mockRestore();

      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_slop_cache_write_error", "acme/widgets#3")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      expect(audit?.detail).toContain("D1 write error");
    });

    it("is fail-safe when BOTH the cache WRITE and its own error-audit write throw (doubly-nested fail-safe)", async () => {
      const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
      const env = enabledEnv(run);
      const repositoriesModule = await import("../../src/db/repositories");
      const writeSpy = vi.spyOn(repositoriesModule, "putCachedAiSlopAdvisory").mockRejectedValueOnce(new Error("D1 write error"));
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (_env, event) => {
        if (event.eventType === "github_app.ai_slop_cache_write_error") throw new Error("D1 audit write error");
        return undefined;
      });
      const adv = advisory();
      await expect(
        runAiSlopForAdvisory(env, { mode: "live",  settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "elevated", confirmedContributor: true, commitThresholdReached: false }),
      ).resolves.toBeUndefined(); // never throws, even with both the cache write AND its own audit write failing
      expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
      writeSpy.mockRestore();
      auditSpy.mockRestore();
    });
  });
});
