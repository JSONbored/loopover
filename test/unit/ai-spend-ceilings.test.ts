import { describe, expect, it, vi } from "vitest";
import { estimateEmbeddingNeurons } from "../../src/review/adapters";
import { aiReviewAttemptFailedResult } from "../../src/queue/ai-review-orchestration";
import { DEFAULT_DAILY_REPO_AI_CALL_LIMIT, isAiDailyBudgetExhausted, isRepoDailyAiLimitReached } from "../../src/services/ai-review";
import { recordAiUsageEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #9060: both failure exits returned `undefined`, and the caller only writes a cache row for a DEFINED result.
// So a pass that threw inside the try, or came back non-ok, wrote nothing — and the next tick, two minutes
// later, missed the cache and re-ran the entire prologue: list files, up to 96k chars of grounding content
// fetched from GitHub, RAG embeddings, impact-map embeddings, culture profile, the external enrichment POST.
// Forever. That is the shape and cadence of the known 259-calls-in-24h incident.
describe("a failed AI review attempt carries a cooldown (#9060)", () => {
  it("is written but never served as a verdict", () => {
    const advisory = { findings: [] as unknown[] };
    const result = aiReviewAttemptFailedResult(advisory as never, "the review attempt threw");

    // cacheable:false — not a verdict, so the PR is re-reviewed properly next time.
    // persistable:true — but the ROW is written, so the non-cacheable retry cooldown bounds the prologue.
    expect({ cacheable: result.cacheable, persistable: result.persistable }).toEqual({ cacheable: false, persistable: true });
  });

  it("holds the PR for a human rather than letting it pass on deterministic checks alone", () => {
    const advisory = { findings: [] as unknown[] };
    const result = aiReviewAttemptFailedResult(advisory as never, "status=quota_exceeded");

    expect(result.findings).toEqual([expect.objectContaining({ code: "ai_review_inconclusive", severity: "warning" })]);
    expect(advisory.findings).toHaveLength(1);
    expect(result.reviewerCount).toBe(0);
  });

  it("names the reason so an operator can tell a crash from an exhausted budget", () => {
    const advisory = { findings: [] as unknown[] };
    expect(aiReviewAttemptFailedResult(advisory as never, "the daily AI budget is exhausted").findings[0]?.detail).toContain("budget is exhausted");
  });

  it("differs from the lock-contention placeholder in exactly the way that matters", async () => {
    const { aiReviewLockContendedResult } = await import("../../src/queue/ai-review-orchestration");
    // Lock contention is persistable:false because a concurrent pass writes the real result within seconds.
    // A failed attempt is persistable:true because nothing else is coming — which is why it needs the cooldown.
    expect(aiReviewLockContendedResult({ findings: [] } as never)?.persistable).toBe(false);
    expect(aiReviewAttemptFailedResult({ findings: [] } as never, "x").persistable).toBe(true);
  });
});

describe("the daily budget is checked before the expensive prologue (#9060)", () => {
  it("reports exhausted once the day's recorded spend reaches the budget", async () => {
    const env = createTestEnv({ AI_DAILY_NEURON_BUDGET: "100" });
    expect(await isAiDailyBudgetExhausted(env)).toBe(false);

    await recordAiUsageEvent(env, { feature: "review", route: "r", model: "m", status: "ok", estimatedNeurons: 100 });
    expect(await isAiDailyBudgetExhausted(env)).toBe(true);
  });

  it("treats a budget of exactly 0 as exhausted — an operator disabling AI spend should not pay for context either", async () => {
    expect(await isAiDailyBudgetExhausted(createTestEnv({ AI_DAILY_NEURON_BUDGET: "0" }))).toBe(true);
  });

  it("does not bind when the budget is unset — the #budget-no-starve fail-safe is unchanged", async () => {
    expect(await isAiDailyBudgetExhausted(createTestEnv())).toBe(false);
  });

  it("fails OPEN on an unreadable usage ledger — the full gate downstream still re-checks", async () => {
    const env = createTestEnv({ AI_DAILY_NEURON_BUDGET: "100" });
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("db unavailable");
    });
    expect(await isAiDailyBudgetExhausted(env)).toBe(false);
    vi.restoreAllMocks();
  });
});

// #9061: a per-repo daily ceiling existed ONLY for BYOK. On the self-host, where reviews run on the free/default
// chain, one runaway repo could consume the entire instance-wide allowance with no per-repo limit anywhere.
describe("per-repo daily AI ceiling on the non-BYOK path (#9061)", () => {
  it("binds once the repo reaches its limit, counting non-BYOK calls the BYOK ceiling never saw", async () => {
    const env = createTestEnv({ AI_DAILY_REPO_CALL_LIMIT: "2" });
    expect(await isRepoDailyAiLimitReached(env, "alice/repo")).toBe(false);

    for (let i = 0; i < 2; i += 1) {
      await recordAiUsageEvent(env, { feature: "review", route: "r", model: "free-model", status: "ok", estimatedNeurons: 1, metadata: { repoFullName: "alice/repo" } });
    }
    expect(await isRepoDailyAiLimitReached(env, "alice/repo")).toBe(true);
  });

  it("is scoped per repo — one runaway repo does not throttle its neighbours", async () => {
    const env = createTestEnv({ AI_DAILY_REPO_CALL_LIMIT: "1" });
    await recordAiUsageEvent(env, { feature: "review", route: "r", model: "m", status: "ok", estimatedNeurons: 1, metadata: { repoFullName: "alice/noisy" } });

    expect(await isRepoDailyAiLimitReached(env, "alice/noisy")).toBe(true);
    expect(await isRepoDailyAiLimitReached(env, "alice/quiet")).toBe(false);
  });

  it("treats 0 as disabling the per-repo ceiling, and ships a bounded default", async () => {
    expect(await isRepoDailyAiLimitReached(createTestEnv({ AI_DAILY_REPO_CALL_LIMIT: "0" }), "alice/repo")).toBe(false);
    expect(DEFAULT_DAILY_REPO_AI_CALL_LIMIT).toBeGreaterThan(0);
  });

  it("fails OPEN on an unreadable ledger", async () => {
    const env = createTestEnv({ AI_DAILY_REPO_CALL_LIMIT: "1" });
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("db unavailable");
    });
    expect(await isRepoDailyAiLimitReached(env, "alice/repo")).toBe(false);
    vi.restoreAllMocks();
  });

  it("reads an empty aggregate result as zero rather than NaN", async () => {
    const env = createTestEnv({ AI_DAILY_REPO_CALL_LIMIT: "1" });
    const original = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("count(*)")) {
        return { bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }) } as never;
      }
      return original(query);
    });
    expect(await isRepoDailyAiLimitReached(env, "alice/repo")).toBe(false);
    vi.restoreAllMocks();
  });
});

// #9060: every embedding was booked at zero, so RAG and impact-map spend was invisible to the governor — which
// is why the ceiling could never converge no matter how many times the loop re-ran.
describe("embeddings are charged a real estimate (#9060)", () => {
  it("scales with the text actually embedded", () => {
    const small = estimateEmbeddingNeurons({ text: "a".repeat(400) });
    const large = estimateEmbeddingNeurons({ text: "a".repeat(400_000) });
    expect(large).toBeGreaterThan(small);
  });

  it("sums a batch", () => {
    expect(estimateEmbeddingNeurons({ text: ["a".repeat(4000), "b".repeat(4000)] })).toBeGreaterThan(estimateEmbeddingNeurons({ text: "a".repeat(4000) }));
  });

  it("is never zero — a round trip is never free, and free is how this spend hid", () => {
    expect(estimateEmbeddingNeurons({ text: "" })).toBeGreaterThan(0);
    expect(estimateEmbeddingNeurons({})).toBeGreaterThan(0);
    expect(estimateEmbeddingNeurons(null)).toBeGreaterThan(0);
    expect(estimateEmbeddingNeurons({ text: [123, null] })).toBeGreaterThan(0);
  });
});
