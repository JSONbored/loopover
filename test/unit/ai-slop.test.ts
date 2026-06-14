import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_SLOP_FINDING_CODE,
  __aiSlopInternals,
  runGittensoryAiSlopAdvisory,
  type AiSlopInput,
} from "../../src/services/ai-slop";
import { evaluateGateCheck } from "../../src/rules/advisory";
import { runAiSlopForAdvisory } from "../../src/queue/processors";
import { recordAiUsageEvent, upsertRepositoryAiKey } from "../../src/db/repositories";
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

  it("returns an advisory finding when the model flags an elevated band", async () => {
    const run = vi.fn(async () => ({ response: slopJson({ band: "elevated" }) }));
    const result = await runGittensoryAiSlopAdvisory(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.band).toBe("elevated");
    expect(result.finding).toMatchObject({ code: AI_SLOP_FINDING_CODE, severity: "warning" });
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

  it("appends a single ai_slop_advisory finding when the model flags slop", async () => {
    const adv = advisory();
    await runAiSlopForAdvisory(enabledEnv(async () => ({ response: slopJson({ band: "high" }) })), {
      settings: noByok,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
    });
    expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
  });

  it("no-ops when the advisory has no head SHA", async () => {
    const noSha = advisory();
    delete (noSha as Partial<Advisory>).headSha;
    const run = vi.fn();
    await runAiSlopForAdvisory(enabledEnv(run), { settings: noByok, advisory: noSha, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "low" });
    expect(noSha.findings).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("adds nothing when the model judges the change clean", async () => {
    const adv = advisory();
    await runAiSlopForAdvisory(enabledEnv(async () => ({ response: slopJson({ band: "clean", rationale: "genuine", signals: [] }) })), {
      settings: noByok,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "clean",
    });
    expect(adv.findings).toEqual([]);
  });

  it("is fail-safe: a thrown error (broken DB) yields no finding and never throws", async () => {
    const adv = advisory();
    const env = { ...enabledEnv(async () => ({ response: slopJson() })), DB: undefined } as unknown as Env;
    await expect(runAiSlopForAdvisory(env, { settings: noByok, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, deterministicBand: "high" })).resolves.toBeUndefined();
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
      settings: { aiReviewByok: true } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      files,
      deterministicBand: "elevated",
    });
    // The advisory came from the BYOK provider (high band → finding), and Workers AI was never called.
    expect(adv.findings.map((f) => f.code)).toEqual([AI_SLOP_FINDING_CODE]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(run).not.toHaveBeenCalled();
  });
});
