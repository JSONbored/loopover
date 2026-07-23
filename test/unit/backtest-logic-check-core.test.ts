import { describe, expect, it } from "vitest";
import type { BacktestCase } from "@loopover/engine";
import {
  buildLogicBacktestAuditInsertSql,
  buildLogicClassifier,
  filterReplayableCases,
  KNOWN_LOGIC_RULES,
  LOGIC_BACKTEST_COMMENT_MARKER,
  LOGIC_BACKTEST_EVENT_TYPE,
  LOGIC_BACKTEST_EXCLUDED_RULE_IDS,
  renderLogicBacktestComment,
  resolveKnownLogicRule,
  runLogicBacktest,
  sqlStringLiteral,
  type LogicDetectionFn,
} from "../../scripts/backtest-logic-check-core.js";

const RULE_ID = "linked_issue_scope_mismatch";

function sampleCase(overrides: Partial<BacktestCase> = {}): BacktestCase {
  return {
    ruleId: RULE_ID,
    targetKey: "owner/repo#1",
    outcome: "unaddressed",
    label: "confirmed",
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
    metadata: {
      issueText: "fix the flaky retry in the queue consumer",
      modelResponseText: '{"status":"unaddressed","rationale":"the diff never touches the queue consumer","confidence":0.9}',
    },
    ...overrides,
  };
}

/** A detection double that fires (status "unaddressed") exactly when the model response contains `needle`. */
function detectWhenResponseContains(needle: string): LogicDetectionFn {
  return (_issueText, modelResponseText) =>
    modelResponseText.includes(needle) ? { status: "unaddressed" } : null;
}

describe("backtest-logic-check-core registry (#8139)", () => {
  it("scopes KNOWN_LOGIC_RULES to exactly linked_issue_scope_mismatch's deterministic post-model step", () => {
    expect(Object.keys(KNOWN_LOGIC_RULES)).toEqual([RULE_ID]);
    expect(KNOWN_LOGIC_RULES[RULE_ID]).toEqual({
      filePath: "src/services/linked-issue-satisfaction.ts",
      exportName: "buildLinkedIssueSatisfactionResult",
    });
  });

  it("resolveKnownLogicRule returns the registry entry for a known rule", () => {
    expect(resolveKnownLogicRule(RULE_ID)).toBe(KNOWN_LOGIC_RULES[RULE_ID]);
  });

  it("resolveKnownLogicRule rejects secret_leak permanently, with the #8130 rationale", () => {
    expect(LOGIC_BACKTEST_EXCLUDED_RULE_IDS.has("secret_leak")).toBe(true);
    expect(() => resolveKnownLogicRule("secret_leak")).toThrow(/permanently excluded.*#8130/);
  });

  it("resolveKnownLogicRule rejects an unregistered rule and names the known ones", () => {
    expect(() => resolveKnownLogicRule("missing_linked_issue")).toThrow(/unknown logic-backtest rule missing_linked_issue.*linked_issue_scope_mismatch/);
  });

  it("uses a distinct sibling event type to #8138's threshold runs", () => {
    expect(LOGIC_BACKTEST_EVENT_TYPE).toBe("calibration.logic_backtest_run");
    expect(LOGIC_BACKTEST_EVENT_TYPE).not.toBe("calibration.threshold_backtest_run");
  });
});

describe("backtest-logic-check-core filterReplayableCases (#8139)", () => {
  it("keeps a case carrying both non-empty issueText and non-empty modelResponseText", () => {
    const replayable = sampleCase();
    expect(filterReplayableCases([replayable])).toEqual([replayable]);
  });

  it("drops cases with no metadata at all", () => {
    const bare: BacktestCase = { ruleId: RULE_ID, targetKey: "owner/repo#2", outcome: "unaddressed", label: "reversed", firedAt: "2026-07-22T00:00:00.000Z", decidedAt: "2026-07-22T01:00:00.000Z" };
    expect(filterReplayableCases([bare])).toEqual([]);
  });

  it("drops cases whose issueText is missing, empty/whitespace, or not a string", () => {
    expect(filterReplayableCases([sampleCase({ metadata: { modelResponseText: "{}" } })])).toEqual([]);
    expect(filterReplayableCases([sampleCase({ metadata: { issueText: "   ", modelResponseText: "{}" } })])).toEqual([]);
    expect(filterReplayableCases([sampleCase({ metadata: { issueText: 42, modelResponseText: "{}" } })])).toEqual([]);
  });

  it("drops pre-#8139 cases whose modelResponseText was never captured, empty, or not a string", () => {
    expect(filterReplayableCases([sampleCase({ metadata: { issueText: "fix the bug" } })])).toEqual([]);
    expect(filterReplayableCases([sampleCase({ metadata: { issueText: "fix the bug", modelResponseText: "  " } })])).toEqual([]);
    expect(filterReplayableCases([sampleCase({ metadata: { issueText: "fix the bug", modelResponseText: 7 } })])).toEqual([]);
  });
});

describe("backtest-logic-check-core buildLogicClassifier (#8139)", () => {
  it("predicts confirmed when the detection reproduces the firing (status unaddressed)", () => {
    const classify = buildLogicClassifier(() => ({ status: "unaddressed" }));
    expect(classify(sampleCase())).toBe("confirmed");
  });

  it("predicts reversed when the detection yields no finding (null)", () => {
    const classify = buildLogicClassifier(() => null);
    expect(classify(sampleCase())).toBe("reversed");
  });

  it("predicts reversed for a non-firing verdict (addressed/partial)", () => {
    expect(buildLogicClassifier(() => ({ status: "addressed" }))(sampleCase())).toBe("reversed");
    expect(buildLogicClassifier(() => ({ status: "partial" }))(sampleCase())).toBe("reversed");
  });

  it("predicts reversed when the candidate detection throws — a crashing candidate never fires", () => {
    const classify = buildLogicClassifier(() => {
      throw new Error("candidate bug");
    });
    expect(classify(sampleCase())).toBe("reversed");
  });

  it("feeds the case's captured issueText and modelResponseText to the detection function", () => {
    const seen: Array<[string | null | undefined, string]> = [];
    const classify = buildLogicClassifier((issueText, modelResponseText) => {
      seen.push([issueText, modelResponseText]);
      return null;
    });
    const backtestCase = sampleCase();
    classify(backtestCase);
    expect(seen).toEqual([[backtestCase.metadata!.issueText, backtestCase.metadata!.modelResponseText]]);
  });

  it("degrades absent metadata and non-string context fields to empty strings instead of crashing", () => {
    const seen: Array<[string | null | undefined, string]> = [];
    const classify = buildLogicClassifier((issueText, modelResponseText) => {
      seen.push([issueText, modelResponseText]);
      return null;
    });
    const { metadata: _dropped, ...noMetadata } = sampleCase();
    classify(noMetadata);
    classify(sampleCase({ metadata: { issueText: 42, modelResponseText: 7 } }));
    expect(seen).toEqual([
      ["", ""],
      ["", ""],
    ]);
  });
});

describe("backtest-logic-check-core runLogicBacktest (#8139)", () => {
  const cases: BacktestCase[] = [
    // A confirmed firing whose stored model response fires either version — a shared true negative... for
    // the "reversed"-positive convention this is a case both classifiers should predict "confirmed" on.
    sampleCase({ targetKey: "owner/repo#1", label: "confirmed" }),
    // A reversed firing (the rule was wrong) whose response only trips the OLD logic: the new logic
    // correctly declines to fire, converting a baseline miss into a candidate true positive.
    sampleCase({
      targetKey: "owner/repo#2",
      label: "reversed",
      metadata: { issueText: "tighten the docs wording", modelResponseText: '{"status":"unaddressed","rationale":"OLD_ONLY match","confidence":0.4}' },
    }),
  ];
  const oldDetect = detectWhenResponseContains('"status":"unaddressed"');
  const newDetect: LogicDetectionFn = (issueText, modelResponseText) =>
    modelResponseText.includes("OLD_ONLY") ? null : oldDetect(issueText, modelResponseText);

  it("scores base vs head over the same corpus and reports an improvement when the new logic fixes a reversed case", () => {
    const comparison = runLogicBacktest(RULE_ID, cases, oldDetect, newDetect);
    expect(comparison.ruleId).toBe(RULE_ID);
    // Baseline fires on both cases: the reversed one is a false negative (predicted confirmed, was reversed).
    expect(comparison.baseline.recall).toBe(0);
    // Candidate declines the OLD_ONLY case: true positive, recall 1, precision 1 — improved, nothing regressed.
    expect(comparison.candidate.recall).toBe(1);
    expect(comparison.verdict).toBe("improved");
    expect(comparison.regressedAxes).toEqual([]);
  });

  it("reports regressed when the new logic loses a case the old logic got right", () => {
    const comparison = runLogicBacktest(RULE_ID, cases, newDetect, oldDetect);
    expect(comparison.verdict).toBe("regressed");
    expect(comparison.regressedAxes).toContain("recall");
  });

  it("reports unchanged when both versions classify identically", () => {
    const comparison = runLogicBacktest(RULE_ID, cases, oldDetect, oldDetect);
    expect(comparison.verdict).toBe("unchanged");
  });

  it("refuses secret_leak even when called directly, bypassing the registry", () => {
    expect(() => runLogicBacktest("secret_leak", [], oldDetect, newDetect)).toThrow(/permanently excluded.*#8130/);
  });
});

describe("backtest-logic-check-core renderLogicBacktestComment (#8139)", () => {
  const comparison = runLogicBacktest(RULE_ID, [sampleCase()], detectWhenResponseContains('"status":"unaddressed"'), detectWhenResponseContains('"status":"unaddressed"'));

  it("leads with the update-in-place marker and labels itself, the shas, and the advisory guarantee", () => {
    const comment = renderLogicBacktestComment(comparison, {
      replayableCount: 12,
      skippedCount: 0,
      headSha: "abcdef1234567890",
      baseSha: "1234567890abcdef",
    });
    expect(comment.startsWith(`${LOGIC_BACKTEST_COMMENT_MARKER}\n## Logic backtest`)).toBe(true);
    expect(comment).toContain("Replayed 12 historical case(s) for `linked_issue_scope_mismatch`");
    expect(comment).toContain("base (`1234567`) and head (`abcdef1`)");
    expect(comment).toContain("### Backtest comparison: `linked_issue_scope_mismatch`");
    expect(comment).toContain("never blocks merge (#8105)");
    expect(comment).not.toContain("lacked captured raw context");
  });

  it("reports skipped non-replayable cases only when there are any", () => {
    const comment = renderLogicBacktestComment(comparison, {
      replayableCount: 3,
      skippedCount: 5,
      headSha: "abcdef1234567890",
      baseSha: "1234567890abcdef",
    });
    expect(comment).toContain("5 historical case(s) lacked captured raw context and were skipped.");
  });
});

describe("backtest-logic-check-core buildLogicBacktestAuditInsertSql (#8139)", () => {
  const comparison = runLogicBacktest(RULE_ID, [sampleCase()], detectWhenResponseContains('"status":"unaddressed"'), detectWhenResponseContains('"status":"unaddressed"'));

  it("escapes embedded single quotes SQL-style", () => {
    expect(sqlStringLiteral("it's")).toBe("'it''s'");
    expect(sqlStringLiteral("plain")).toBe("'plain'");
  });

  it("builds a full audit_events INSERT carrying the comparison under metadata.comparison", () => {
    const sql = buildLogicBacktestAuditInsertSql({
      id: "run-id-1",
      targetKey: "JSONbored/loopover#8139",
      comparison,
      headSha: "abcdef1234567890",
      baseSha: "1234567890abcdef",
      replayableCount: 1,
      skippedCount: 2,
      createdAt: "2026-07-22T12:00:00.000Z",
    });
    expect(sql).toMatch(/^INSERT INTO audit_events \(id, event_type, actor, target_key, outcome, detail, metadata_json, created_at\) VALUES \(/);
    expect(sql).toContain(`'${LOGIC_BACKTEST_EVENT_TYPE}'`);
    expect(sql).toContain("'loopover'");
    expect(sql).toContain("'JSONbored/loopover#8139'");
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'logic backtest for linked_issue_scope_mismatch: unchanged'");
    expect(sql).toContain("'2026-07-22T12:00:00.000Z'");
    // The metadata JSON survives the SQL round-trip: undo the '' escaping and parse it back out.
    const literal = /VALUES \(.*'completed', '[^']*', '(.*)', '2026-07-22T12:00:00\.000Z'\)$/.exec(sql)![1]!;
    const metadata = JSON.parse(literal.replace(/''/g, "'")) as Record<string, unknown>;
    expect(metadata.comparison).toEqual(comparison);
    expect(metadata.headSha).toBe("abcdef1234567890");
    expect(metadata.baseSha).toBe("1234567890abcdef");
    expect(metadata.replayableCount).toBe(1);
    expect(metadata.skippedCount).toBe(2);
  });
});

describe("backtest-logic-check-core end-to-end against the real detection module (#8139)", () => {
  it("replays the real buildLinkedIssueSatisfactionResult as both sides and stays unchanged", async () => {
    // The same dynamic-import shape the CLI performs against a checkout root — here the repo itself.
    const imported = (await import("../../src/services/linked-issue-satisfaction")) as Record<string, unknown>;
    const detect = imported[KNOWN_LOGIC_RULES[RULE_ID]!.exportName] as LogicDetectionFn;
    expect(typeof detect).toBe("function");
    const cases = [
      sampleCase({ label: "confirmed" }),
      sampleCase({
        targetKey: "owner/repo#3",
        label: "reversed",
        // Below the 0.5 confidence floor: the real parse/floor step drops this "unaddressed" call, so the
        // replay predicts "reversed" — a true positive under the corpus's own label.
        metadata: { issueText: "fix the bug", modelResponseText: '{"status":"unaddressed","rationale":"weak guess","confidence":0.2}' },
      }),
    ];
    const comparison = runLogicBacktest(RULE_ID, filterReplayableCases(cases), detect, detect);
    expect(comparison.verdict).toBe("unchanged");
    expect(comparison.baseline.caseCount).toBe(2);
    expect(comparison.baseline.truePositive).toBe(1);
    expect(comparison.baseline.trueNegative).toBe(1);
    expect(comparison.baseline.precision).toBe(1);
    expect(comparison.baseline.recall).toBe(1);
  });
});
