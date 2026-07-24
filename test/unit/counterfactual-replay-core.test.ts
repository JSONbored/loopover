import { describe, expect, it } from "vitest";
import type { BacktestCase, CounterfactualVerdict } from "@loopover/engine";
import { REVIEW_PROMPT_VERSION, buildCanonicalJudgePrompt } from "../../src/services/ai-review";
import {
  artifactKey,
  extractWorkersAiResponse,
  buildCounterfactualAuditInsertSql,
  compareReplays,
  COUNTERFACTUAL_BACKTEST_EVENT_TYPE,
  COUNTERFACTUAL_COMMENT_MARKER,
  COUNTERFACTUAL_RULE_ID,
  renderCounterfactualComment,
  estimateFixtureNeurons,
  isRunAccountingValid,
  parseVariantVerdict,
  planReplay,
  scoreReplay,
} from "../../scripts/counterfactual-replay-core.js";

// #8221: the harness's pure core. Provider IO lives in the wrapper; every mapping/aggregation arm is here.

function replayCase(id: number, label: "confirmed" | "reversed", diff: string | null = "diff --git a/x b/x"): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey: `acme/widgets#${id}`,
    outcome: "close",
    label,
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    ...(diff !== null ? { metadata: { diff } } : {}),
  };
}

const SAMPLING = { seed: "counterfactual-replay-v1:test", maxFixtures: 100 };
const VARIANT = { promptVersion: "v1", modelSpec: "llama3.1:8b" };

describe("parseVariantVerdict (#8219 scoring contract)", () => {
  it("maps a parseable blockers array to would_flag/would_not_flag by emptiness", () => {
    expect(parseVariantVerdict('{"blockers": ["race condition"], "confidence": 0.9}')).toBe("would_flag");
    expect(parseVariantVerdict('{"blockers": [], "confidence": 0.7}')).toBe("would_not_flag");
  });

  it("tolerates fences and surrounding prose by extracting the first balanced object (string-aware)", () => {
    expect(parseVariantVerdict('Sure! Here is my review:\n```json\n{"blockers": ["a \\"quoted\\" {brace} issue"]}\n```\nHope that helps.')).toBe(
      "would_flag",
    );
    expect(parseVariantVerdict('prefix {"blockers": []} suffix {"blockers": ["x"]}')).toBe("would_not_flag"); // FIRST object wins
  });

  it("ABSTAINS on everything else — never coerced: no JSON, unbalanced, invalid JSON, missing/non-array blockers, empty", () => {
    for (const raw of ["I think it looks fine.", "{\"blockers\": [", '{"blockers": "none"}', '{"confidence": 1}', "", "{not json}"]) {
      expect(parseVariantVerdict(raw)).toBe("abstained");
    }
    expect(parseVariantVerdict(undefined as unknown as string)).toBe("abstained");
  });
});

describe("planReplay + scoreReplay (#8221)", () => {
  it("scores verdicts against labels with scoreBacktest unchanged: would_flag ⇒ predicted reversed", () => {
    const plan = planReplay([replayCase(1, "reversed"), replayCase(2, "confirmed"), replayCase(3, "reversed")], SAMPLING);
    const verdicts = new Map<string, CounterfactualVerdict>([
      ["acme/widgets#1", "would_flag"], // true positive
      ["acme/widgets#2", "would_flag"], // false positive
      ["acme/widgets#3", "would_not_flag"], // false negative
    ]);
    const { report, summary } = scoreReplay(plan, VARIANT, SAMPLING, verdicts, 1234);
    expect(report.ruleId).toBe(COUNTERFACTUAL_RULE_ID);
    expect(report.truePositive).toBe(1);
    expect(report.falsePositive).toBe(1);
    expect(report.falseNegative).toBe(1);
    expect(report.precision).toBe(0.5);
    expect(report.recall).toBe(0.5);
    expect(summary).toMatchObject({ scored: 3, abstained: 0, neuronsSpent: 1234, resumeFrom: null, variant: VARIANT });
    expect(isRunAccountingValid(plan, summary)).toBe(true);
  });

  it("abstentions are counted and EXCLUDED from the matrix; a missing verdict sets the resume cursor at the first gap", () => {
    const plan = planReplay([replayCase(1, "reversed"), replayCase(2, "confirmed"), replayCase(3, "confirmed")], SAMPLING);
    const verdicts = new Map<string, CounterfactualVerdict>([
      ["acme/widgets#1", "abstained"],
      // #2 unreached (budget), #3 unreached
    ]);
    const { report, summary } = scoreReplay(plan, VARIANT, SAMPLING, verdicts, 99);
    expect(report.caseCount).toBe(0); // the abstention never entered the matrix
    expect(summary.abstained).toBe(1);
    expect(summary.resumeFrom).toBe("acme/widgets#2");
    expect(isRunAccountingValid(plan, summary)).toBe(true);
  });

  it("skip accounting flows from the assembler: non-replayable cases count no_raw_context and the invariant still holds", () => {
    const plan = planReplay([replayCase(1, "reversed"), replayCase(2, "confirmed", ""), replayCase(3, "confirmed", null)], SAMPLING);
    expect(plan.fixtures).toHaveLength(1);
    expect(plan.skipped.no_raw_context).toBe(2);
    const { summary } = scoreReplay(plan, VARIANT, SAMPLING, new Map([["acme/widgets#1", "would_flag" as const]]), 5);
    expect(isRunAccountingValid(plan, summary)).toBe(true);
    // A summary that lies about its universe fails the invariant.
    expect(isRunAccountingValid(plan, { ...summary, scored: summary.scored + 1 })).toBe(false);
  });

  it("compareReplays is the unchanged Pareto floor over two runs of the same plan", () => {
    const plan = planReplay([replayCase(1, "reversed"), replayCase(2, "confirmed")], SAMPLING);
    const flagAll = scoreReplay(plan, VARIANT, SAMPLING, new Map([["acme/widgets#1", "would_flag" as const], ["acme/widgets#2", "would_flag" as const]]), 1);
    const perfect = scoreReplay(plan, VARIANT, SAMPLING, new Map([["acme/widgets#1", "would_flag" as const], ["acme/widgets#2", "would_not_flag" as const]]), 1);
    const comparison = compareReplays(flagAll.report, perfect.report);
    expect(comparison.verdict).toBe("improved"); // precision up, recall held
  });
});

describe("budget + artifacts helpers (#8221)", () => {
  it("estimateFixtureNeurons is deterministic, diff-proportional, and never zero", () => {
    const small = planReplay([replayCase(1, "confirmed", "x")], SAMPLING).fixtures[0]!;
    const large = planReplay([replayCase(2, "confirmed", "y".repeat(8000))], SAMPLING).fixtures[0]!;
    expect(estimateFixtureNeurons(small, 100)).toBeGreaterThan(0);
    expect(estimateFixtureNeurons(large, 100)).toBeGreaterThan(estimateFixtureNeurons(small, 100));
    expect(estimateFixtureNeurons(small, 100)).toBe(estimateFixtureNeurons(small, 100));
  });

  it("artifactKey is stable per (variant, fixture) and distinct across either changing", () => {
    const key = artifactKey(VARIANT, "acme/widgets#1");
    expect(key).toBe(artifactKey(VARIANT, "acme/widgets#1"));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(artifactKey(VARIANT, "acme/widgets#2")).not.toBe(key);
    expect(artifactKey({ ...VARIANT, promptVersion: "v2" }, "acme/widgets#1")).not.toBe(key);
  });
});

describe("#8222: prompt version + CI comment/persist helpers", () => {
  it("the canonical judge prompt is a stable pure function of source and the version constant is pinned", () => {
    expect(REVIEW_PROMPT_VERSION).toBe("review-prompt-v1");
    const prompt = buildCanonicalJudgePrompt();
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toBe(buildCanonicalJudgePrompt()); // no clock, no env, no input
  });

  it("renders the marker comment with both prompt versions, the seed, and the advisory line", () => {
    const plan = planReplay([replayCase(1, "reversed"), replayCase(2, "confirmed")], SAMPLING);
    const base = scoreReplay(plan, { promptVersion: "review-prompt-v1", modelSpec: "m" }, SAMPLING, new Map([["acme/widgets#1", "would_flag" as const], ["acme/widgets#2", "would_flag" as const]]), 1);
    const head = scoreReplay(plan, { promptVersion: "review-prompt-v2", modelSpec: "m" }, SAMPLING, new Map([["acme/widgets#1", "would_flag" as const], ["acme/widgets#2", "would_not_flag" as const]]), 1);
    const comment = renderCounterfactualComment(compareReplays(base.report, head.report), {
      promptVersionBase: "review-prompt-v1",
      promptVersionHead: "review-prompt-v2",
      modelSpec: "llama3.1:8b",
      headSha: "abcdef1234567",
      baseSha: "1234567abcdef",
      scored: 2,
      abstainedBase: 0,
      abstainedHead: 1,
      skippedNoRawContext: 3,
      sampledOut: 0,
      seed: SAMPLING.seed,
    });
    expect(comment).toContain(COUNTERFACTUAL_COMMENT_MARKER);
    expect(comment).toContain("review-prompt-v1");
    expect(comment).toContain("review-prompt-v2");
    expect(comment).toContain("abcdef1"); // short shas
    expect(comment).toContain("Verdict");
    expect(comment).toContain("never blocks merge");
    expect(comment).toContain("3 case(s) lacked raw context");
  });

  it("builds the audit INSERT with the shared metadata.comparison shape and escaped literals", () => {
    const plan = planReplay([replayCase(1, "reversed")], SAMPLING);
    const run = scoreReplay(plan, VARIANT, SAMPLING, new Map([["acme/widgets#1", "would_flag" as const]]), 1);
    const sql = buildCounterfactualAuditInsertSql({
      id: "id-1",
      targetKey: "acme/o'widgets#9",
      comparison: compareReplays(run.report, run.report),
      headSha: "h",
      baseSha: "b",
      promptVersionBase: "review-prompt-v1",
      promptVersionHead: "review-prompt-v2",
      modelSpec: "m",
      scored: 1,
      createdAt: "2026-07-23T00:00:00.000Z",
    });
    expect(sql).toContain(`'${COUNTERFACTUAL_BACKTEST_EVENT_TYPE}'`);
    expect(sql).toContain("INSERT INTO audit_events");
    expect(sql).toContain("acme/o''widgets#9"); // single-quote escaping
    expect(sql).toContain('\"comparison\":'); // the field the shared track-record reader looks for
    const metadataLiteral = sql.match(/'(\{.*\})'/)?.[1] ?? "";
    expect(JSON.parse(metadataLiteral.replace(/''/g, "'")) as Record<string, unknown>).toMatchObject({
      promptVersionBase: "review-prompt-v1",
      promptVersionHead: "review-prompt-v2",
      scored: 1,
    });
  });
});

describe("extractWorkersAiResponse (#8279)", () => {
  it("extracts result.response; every malformed envelope yields \"\" so the parser abstains rather than throwing", () => {
    expect(extractWorkersAiResponse({ result: { response: '{"blockers": []}' } })).toBe('{"blockers": []}');
    for (const bad of [null, undefined, {}, { result: {} }, { result: { response: 42 } }, "text"]) {
      expect(extractWorkersAiResponse(bad)).toBe("");
    }
    expect(parseVariantVerdict(extractWorkersAiResponse({ result: {} }))).toBe("abstained"); // the composed fail-safe
  });
});
