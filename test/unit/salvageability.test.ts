import { describe, expect, it } from "vitest";
import { classifyDefectFixability, computeSalvageability } from "../../src/review/salvageability";
import { computeSalvageabilityForTarget } from "../../src/review/salvageability-wire";
import { resolveAiReviewSalvageableHold, type GateCheckEvaluation } from "../../src/rules/advisory";
import { createTestEnv } from "../helpers/d1";

// #8962: the second axis of the close decision. Contracts: deterministic classification (structural wins),
// every score point named in factors, knob-unset = never changes a disposition, wire fails OPEN.

describe("classifyDefectFixability", () => {
  it("mechanical classes: encoding, dead imports, stale artifacts, coverage, version mismatches", () => {
    for (const text of [
      "renders mojibake for em dash",
      "unused import join from node:path",
      "stale generated contract bundle for this route",
      "codecov/patch failing at 86% with zero test lines",
      "version bump to 1.21.0 is a downgrade vs main",
      "blank-cell guard missing on stake_tao",
    ]) {
      expect(classifyDefectFixability(text)).toBe("mechanical");
    }
  });

  it("structural classes: fabrication, scope, duplication, bundling, policy — and structural WINS over mechanical", () => {
    for (const text of [
      "the test manufactures a payload the code never emits",
      "bundles an unrelated feature into a migration PR",
      "duplicates the existing module",
      "no linked eligible issue is provided",
      "deletes working code with no replacement",
    ]) {
      expect(classifyDefectFixability(text)).toBe("structural");
    }
    expect(classifyDefectFixability("unused import inside an unrelated refactor bundled into this PR")).toBe("structural");
  });

  it("unknown when neither taxonomy matches", () => {
    expect(classifyDefectFixability("computes top_pair_share from the returned page only")).toBe("unknown");
  });
});

describe("computeSalvageability", () => {
  it("every point is named: mechanical + veteran author + iterating = 100, each factor listed", () => {
    const s = computeSalvageability({ findingText: "unused import x", authorPriorMergedCount: 5, priorReviewCycles: 3 });
    expect(s.score).toBe(100);
    expect(s.fixability).toBe("mechanical");
    expect(s.factors).toHaveLength(3);
    expect(s.factors.join(" ")).toContain("+45");
    expect(s.factors.join(" ")).toContain("+40");
    expect(s.factors.join(" ")).toContain("+15");
  });

  it("tier arms: unknown class +15; single merged PR +25; no history and no iteration contribute 0 with named zero-factors", () => {
    const s = computeSalvageability({ findingText: "misreads the pagination shape", authorPriorMergedCount: 1, priorReviewCycles: 1 });
    expect(s.score).toBe(40); // 15 + 25
    const zero = computeSalvageability({ findingText: "fabricates a test payload", authorPriorMergedCount: 0, priorReviewCycles: 0 });
    expect(zero.score).toBe(0);
    expect(zero.fixability).toBe("structural");
    expect(zero.factors).toEqual(["structural defect class (+0)", "no merged history in this repo (+0)"]);
  });
});

const aiEval = (confidence: number, code = "ai_consensus_defect"): GateCheckEvaluation =>
  ({
    enabled: true,
    conclusion: "failure",
    title: "t",
    summary: "s",
    blockers: [{ code, title: "defect", severity: "critical", detail: "d", confidence }],
    warnings: [],
  }) as never;

describe("resolveAiReviewSalvageableHold", () => {
  const salv = { score: 70, factors: ["mechanical defect class (+45)", "author has 3 merged PRs here (+25)"] };

  it("fires ONLY when: knob set, score clears it, AI-judgment-only failure, every blocker at/above the floor", () => {
    const hold = resolveAiReviewSalvageableHold(aiEval(0.95), { aiReviewCloseConfidence: 0.9, aiReviewSalvageabilityMinScore: 60 }, salv);
    expect(hold).toBeDefined();
    expect(hold!.reason).toContain("70 ≥ 60");
    expect(hold!.reason).toContain("mechanical defect class");
    expect(hold!.comment).toContain("HELD with guidance");
  });

  // #9085 (landed via #9237): an absent confidence used to degrade to 1.0 -- maximum certainty -- so "the
  // model said nothing" silently cleared even the default floor here. It now degrades to
  // CONFIDENCE_WHEN_UNSTATED (0.5), which is sub-floor against the 0.93 gate default, so the low-confidence
  // hold owns that case and this resolver stands down. #9085 renamed both sibling assertions in
  // rules.test.ts but missed this third consumption site, leaving it asserting the pre-change semantics.
  // Both calls are load-bearing for coverage: the first is the ONLY case in this file that exercises the
  // `aiReviewCloseConfidence ?? DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE` default arm (every other case passes an
  // explicit floor), and the second is the only one exercising the `confidence ?? CONFIDENCE_WHEN_UNSTATED`
  // nullish arm.
  it("defaults: no configured floor uses the gate default (0.93), and a confidence-less blocker is sub-floor", () => {
    expect(resolveAiReviewSalvageableHold(aiEval(0.99), { aiReviewSalvageabilityMinScore: 60 }, salv)).toBeDefined();

    const noConfidence = aiEval(0.99);
    delete (noConfidence.blockers[0] as { confidence?: number }).confidence;
    expect(resolveAiReviewSalvageableHold(noConfidence, { aiReviewSalvageabilityMinScore: 60 }, salv)).toBeUndefined();
  });

  it("knob unset (the default) or no score: never changes a disposition", () => {
    expect(resolveAiReviewSalvageableHold(aiEval(0.95), { aiReviewCloseConfidence: 0.9 }, salv)).toBeUndefined();
    expect(resolveAiReviewSalvageableHold(aiEval(0.95), { aiReviewCloseConfidence: 0.9, aiReviewSalvageabilityMinScore: 60 }, null)).toBeUndefined();
  });

  it("below-floor blockers belong to the low-confidence hold — this resolver stands down", () => {
    expect(resolveAiReviewSalvageableHold(aiEval(0.7), { aiReviewCloseConfidence: 0.9, aiReviewSalvageabilityMinScore: 60 }, salv)).toBeUndefined();
  });

  it("stands down on: sub-threshold score, non-hold disposition, and mixed (non-AI) failures", () => {
    expect(resolveAiReviewSalvageableHold(aiEval(0.95), { aiReviewCloseConfidence: 0.9, aiReviewSalvageabilityMinScore: 80 }, salv)).toBeUndefined();
    expect(
      resolveAiReviewSalvageableHold(aiEval(0.95), { aiReviewCloseConfidence: 0.9, aiReviewSalvageabilityMinScore: 60, aiReviewLowConfidenceDisposition: "one_shot" }, salv),
    ).toBeUndefined();
    const mixed = aiEval(0.95);
    (mixed.blockers as unknown[]).push({ code: "secret_leak", title: "s", severity: "critical", detail: "d" });
    expect(resolveAiReviewSalvageableHold(mixed, { aiReviewCloseConfidence: 0.9, aiReviewSalvageabilityMinScore: 60 }, salv)).toBeUndefined();
  });
});

describe("computeSalvageabilityForTarget (wire)", () => {
  it("counts the author's realized MERGED outcomes and this PR's review cycles; no AI blocker = null (no IO)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(`INSERT INTO pull_requests (repo_full_name, number, author_login, title, state) VALUES ('o/r', 1, 'alice', 't', 'closed'), ('o/r', 2, 'alice', 't', 'closed'), ('o/r', 3, 'alice', 't', 'open'), ('o/r', 9, 'alice', 't', 'closed')`).run();
    for (const [target, decision] of [["o/r#1", "merged"], ["o/r#2", "merged"], ["o/r#9", "closed"]] as const) {
      await env.DB.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, created_at) VALUES (?, 'o/r', ?, 'pr_outcome', ?, ?)`)
        .bind(`ra-${target}`, target, decision, new Date().toISOString())
        .run();
    }
    for (const sha of ["s1", "s2"]) {
      await env.DB.prepare(`INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at) VALUES (?, 'o/r', 3, ?, 'hold', 'r', 'd', '{}', ?)`)
        .bind(`record:o/r#3@${sha}`, sha, new Date().toISOString())
        .run();
    }
    const gate = aiEval(0.95);
    const score = await computeSalvageabilityForTarget(env, "o/r", 3, "ALICE", gate);
    expect(score).not.toBeNull();
    // 2 merged (not the closed one, not the open PR) => +25 tier; unknown class 'defect d' => +15; 2 cycles => +15.
    expect(score!.score).toBe(55);
    expect(score!.factors.join(" ")).toContain("2 merged");
    expect(await computeSalvageabilityForTarget(env, "o/r", 3, "alice", { blockers: [] })).toBeNull();
  });

  it("fails OPEN on a read error and when the author is unknown the merged tier is zero", async () => {
    const env = createTestEnv();
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = createTestEnv();
    vi.spyOn(broken.DB, "prepare").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await computeSalvageabilityForTarget(broken, "o/r", 1, "alice", aiEval(0.9))).toBeNull();
    expect(warn).toHaveBeenCalled();
    const anon = await computeSalvageabilityForTarget(env, "o/r", 1, null, aiEval(0.9));
    expect(anon).not.toBeNull();
    expect(anon!.factors.join(" ")).toContain("no merged history");
    vi.restoreAllMocks();
  });
});
