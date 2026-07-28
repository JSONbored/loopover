import { describe, expect, it } from "vitest";
import { classifyModelResponse, recordedJudgmentClass, runRequery } from "../../src/review/decision-requery";
import { parseRequeryBundle, requeryClientFromEnv } from "../../scripts/replay-decision";
import { persistDecisionReplayPrompt, DECISION_REPLAY_PROMPT_MAX_CHARS } from "../../src/review/decision-replay";
import { createTestEnv } from "../helpers/d1";

/** A model response in the exact JSON shape parseModelReview accepts — the live pipeline's own contract
 *  (blockers are plain strings, per its `typeof x === "string"` filter). */
function modelResponse(blockers: string[]): string {
  return JSON.stringify({ assessment: "Looked at the change.", blockers, nits: [], suggestions: [] });
}

// #9028 (Replay v2): everything downstream of the model is pinned bit-exactly by the replay harness — the
// model call is the ONE stage that cannot be, because hosted inference is not bit-deterministic even at
// temperature 0. The honest metric is the ACTION-MATCH RATE: across fresh runs, how often the model's verdict
// lands in the same CLASS the recorded decision acted on. These tests pin that the classes are the live
// pipeline's own boundaries, and that the denominator can never be quietly shrunk.
describe("decision re-query action matching (#9028)", () => {
  it("classifies through the LIVE parser: blockers ⇒ defect, none ⇒ clean, unparseable ⇒ unusable", () => {
    expect(classifyModelResponse(modelResponse(["Null deref: src/a.ts crashes on empty input"]))).toBe("defect");
    expect(classifyModelResponse(modelResponse([]))).toBe("clean");
    expect(classifyModelResponse("I am not JSON at all")).toBe("unusable");
  });

  it("derives the recorded class from the SAME finding codes the gate acts on — both codes, and the clean arm", () => {
    expect(recordedJudgmentClass({ findings: [{ code: "ai_consensus_defect" }] as never })).toBe("defect");
    expect(recordedJudgmentClass({ findings: [{ code: "ai_review_split" }] as never })).toBe("defect");
    expect(recordedJudgmentClass({ findings: [{ code: "missing_linked_issue" }] as never })).toBe("clean");
    expect(recordedJudgmentClass({ findings: [] as never })).toBe("clean");
  });

  it("reports the match rate across runs, labeled as action-match and never reproducibility", async () => {
    const responses = [
      modelResponse(["Bug: same class, different phrasing"]),
      modelResponse(["Other bug: still a defect — phrasing must not matter"]),
      modelResponse([]),
    ];
    let call = 0;
    const report = await runRequery({
      systemPrompt: "the exact persisted prompt",
      userPrompt: "the exact persisted diff",
      runs: 3,
      recordedClass: "defect",
      callModel: async () => responses[call++] ?? "",
    });
    expect(report).toMatchObject({ mode: "requery", recordedClass: "defect", runs: 3, matches: 2, actionMatchRate: 0.667 });
    expect(report.perRun).toEqual(["defect", "defect", "clean"]);
    // The caveat travels IN the artifact, so a pasted report cannot shed it.
    expect(report.metric).toBe("action-match-rate (NOT reproducibility)");
    expect(JSON.stringify(report)).not.toMatch(/reproducib(?!ility\)")/);
  });

  it("INVARIANT: a transport failure is an UNUSABLE run in the denominator — never a silently skipped one", async () => {
    // Shrinking the denominator would inflate the rate exactly when the provider is flakiest.
    const report = await runRequery({
      systemPrompt: "p",
      userPrompt: "u",
      runs: 2,
      recordedClass: "clean",
      callModel: async (systemPrompt, userPrompt) => {
        if (systemPrompt !== "p" || userPrompt !== "u") throw new Error("both turns must pass through verbatim");
        throw new Error("provider down");
      },
    });
    expect(report).toMatchObject({ runs: 2, matches: 0, actionMatchRate: 0, perRun: ["unusable", "unusable"] });
  });

  it("INVARIANT: `unusable` matches NEITHER recorded class — the live pipeline routes it fail-closed, not to a verdict", async () => {
    const report = await runRequery({ systemPrompt: "p", userPrompt: "u", runs: 1, recordedClass: "clean", callModel: async () => "garbage" });
    expect(report.matches).toBe(0);
  });

  it("zero runs yields a 0 rate rather than NaN (the degenerate-denominator arm)", async () => {
    const report = await runRequery({ systemPrompt: "p", userPrompt: "u", runs: 0, recordedClass: "clean", callModel: async () => "" });
    expect(report.actionMatchRate).toBe(0);
  });
});

describe("requery bundle + provider parsing (CLI seams)", () => {
  const goodBundle = JSON.stringify({
    replayInput: { findings: [{ code: "ai_consensus_defect" }] },
    prompt: { systemPrompt: "the exact prompt sent", userPrompt: "the exact diff sent" },
  });

  it("accepts a bundle carrying the prompt and derives the recorded class", () => {
    const parsed = parseRequeryBundle(goodBundle);
    expect(parsed).toEqual({ systemPrompt: "the exact prompt sent", userPrompt: "the exact diff sent", recordedClass: "defect" });
  });

  it("names each missing piece: bad JSON, absent prompt (with the 30-day retention hint), absent findings", () => {
    expect(parseRequeryBundle("{nope")).toMatchObject({ error: expect.stringContaining("unparseable") });
    const noPrompt = parseRequeryBundle(JSON.stringify({ replayInput: { findings: [] } }));
    expect(noPrompt).toMatchObject({ error: expect.stringContaining("30 days") });
    // BOTH turns are required: the system prompt alone would ask the model to review nothing.
    const systemOnly = parseRequeryBundle(JSON.stringify({ replayInput: { findings: [] }, prompt: { systemPrompt: "p" } }));
    expect(systemOnly).toMatchObject({ error: expect.stringContaining("userPrompt") });
    const noFindings = parseRequeryBundle(JSON.stringify({ prompt: { systemPrompt: "p", userPrompt: "u" } }));
    expect(noFindings).toMatchObject({ error: expect.stringContaining("findings") });
  });

  it("builds the provider from explicit env only — model always required, then base-url, then anthropic, else a named error", () => {
    expect(requeryClientFromEnv({})).toMatchObject({ error: expect.stringContaining("REPLAY_AI_MODEL") });
    expect(requeryClientFromEnv({ REPLAY_AI_MODEL: "m" })).toMatchObject({ error: expect.stringContaining("REPLAY_AI_BASE_URL") });
    const openai = requeryClientFromEnv({ REPLAY_AI_MODEL: "m", REPLAY_AI_BASE_URL: "http://localhost:11434", REPLAY_AI_API_KEY: "k" });
    expect("ai" in openai && typeof openai.ai.run).toBe("function");
    const anthropic = requeryClientFromEnv({ REPLAY_AI_MODEL: "m", ANTHROPIC_API_KEY: "k" });
    expect("ai" in anthropic && typeof anthropic.ai.run).toBe("function");
  });
});

describe("decision replay prompt capture (#9028)", () => {
  it("persists the exact prompt keyed by the BASE record id, and upserts (last writer wins)", async () => {
    const env = createTestEnv();
    await persistDecisionReplayPrompt(env, { repoFullName: "o/r", pullNumber: 7, headSha: "sha7", systemPrompt: "first", userPrompt: "diff-a" });
    await persistDecisionReplayPrompt(env, { repoFullName: "o/r", pullNumber: 7, headSha: "sha7", systemPrompt: "second", userPrompt: "diff-b" });
    const row = await env.DB.prepare("select record_id, prompt_json from decision_replay_prompts")
      .first<{ record_id: string; prompt_json: string }>();
    expect(row?.record_id).toBe("record:o/r#7@sha7");
    expect(JSON.parse(row?.prompt_json ?? "{}")).toEqual({ systemPrompt: "second", userPrompt: "diff-b" });
  });

  it("INVARIANT: an oversize prompt is SKIPPED, never truncated — a truncated prompt re-queried would report a rate for a prompt that was never sent", async () => {
    const env = createTestEnv();
    await persistDecisionReplayPrompt(env, {
      repoFullName: "o/r",
      pullNumber: 8,
      headSha: "sha8",
      // COMBINED size is the cap -- the two turns land in one row.
      systemPrompt: "x".repeat(DECISION_REPLAY_PROMPT_MAX_CHARS - 5),
      userPrompt: "y".repeat(10),
    });
    const row = await env.DB.prepare("select count(*) as n from decision_replay_prompts").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("INVARIANT: a persist failure is swallowed — prompt capture must never break the review pass", async () => {
    const env = createTestEnv();
    (env.DB as unknown as { prepare: () => never }).prepare = () => {
      throw new Error("d1 down");
    };
    await expect(
      persistDecisionReplayPrompt(env, { repoFullName: "o/r", pullNumber: 9, headSha: "sha9", systemPrompt: "p", userPrompt: "u" }),
    ).resolves.toBeUndefined();
  });
});
