import { describe, expect, it } from "vitest";
import { buildBacktestCorpus, type HumanOverrideEvent, type RuleFiredEvent } from "@loopover/engine";
import {
  BACKFILL_PROVENANCE,
  BACKFILL_RULE_ID,
  buildBackfillInsertStatements,
  renderBackfillReport,
  sqlStringLiteral,
  synthesizeBackfillRows,
  type ReviewTargetDecisionRow,
} from "../../scripts/backfill-calibration-corpus-core.js";

function decisionRow(overrides: Partial<ReviewTargetDecisionRow> = {}): ReviewTargetDecisionRow {
  return {
    repo: "acme/widgets",
    number: 7,
    verdict: "close",
    status: "closed",
    confidence: 0.82,
    terminalAt: "2026-06-15 10:00:00",
    ...overrides,
  };
}

describe("synthesizeBackfillRows (#8157)", () => {
  it("synthesizes an idempotent fired+override pair for a confirmed close decision, tagged with provenance", () => {
    const report = synthesizeBackfillRows([decisionRow()]);
    expect(report.eligible).toBe(1);
    expect(report.confirmed).toBe(1);
    expect(report.reversed).toBe(0);
    expect(report.rows).toHaveLength(2);

    const [fired, override] = report.rows;
    expect(fired!.id).toBe(`backfill:${BACKFILL_RULE_ID}:acme/widgets#7:fired`);
    expect(fired!.eventType).toBe(`signal.rule_fired:${BACKFILL_RULE_ID}`);
    expect(fired!.actor).toBe("loopover");
    expect(fired!.createdAt).toBe("2026-06-15T10:00:00.000Z"); // SQLite timestamp normalized to UTC ISO
    expect(JSON.parse(fired!.metadataJson)).toEqual({ outcome: "close", confidence: 0.82, backfilled: true, provenance: BACKFILL_PROVENANCE });

    expect(override!.id).toBe(`backfill:${BACKFILL_RULE_ID}:acme/widgets#7:override`);
    expect(override!.eventType).toBe(`signal.human_override:${BACKFILL_RULE_ID}`);
    expect(override!.actor).toBe("human");
    expect(override!.createdAt).toBe("2026-06-15T10:00:01.000Z"); // strictly after the firing, for pairing
    expect(JSON.parse(override!.metadataJson)).toEqual({ verdict: "confirmed", backfilled: true, provenance: BACKFILL_PROVENANCE });
  });

  it("labels a close-verdict decision whose PR ended MERGED as reversed — the decision was wrong", () => {
    const report = synthesizeBackfillRows([decisionRow({ status: "merged" })]);
    expect(report.reversed).toBe(1);
    expect(report.confirmed).toBe(0);
    expect(JSON.parse(report.rows[1]!.metadataJson).verdict).toBe("reversed");
  });

  it("never fabricates: wrong verdict, missing/NaN confidence, missing/garbled terminal time, and non-terminal status are skipped and counted", () => {
    const report = synthesizeBackfillRows([
      decisionRow({ verdict: "merge" }),
      decisionRow({ verdict: null }),
      decisionRow({ confidence: null }),
      decisionRow({ confidence: Number.NaN }),
      decisionRow({ terminalAt: null }),
      decisionRow({ terminalAt: "not a time" }),
      decisionRow({ status: "manual" }),
      decisionRow({ status: null }),
    ]);
    expect(report.eligible).toBe(0);
    expect(report.rows).toEqual([]);
    expect(report.skippedWrongVerdict).toBe(2);
    expect(report.skippedNoConfidence).toBe(2);
    expect(report.skippedNotTerminal).toBe(4);
  });

  it("keeps only the LATEST terminal decision per target and counts earlier ones as duplicates", () => {
    const report = synthesizeBackfillRows([
      decisionRow({ terminalAt: "2026-06-10 09:00:00", confidence: 0.5 }),
      decisionRow({ terminalAt: "2026-06-20T09:00:00.000Z", confidence: 0.9 }),
    ]);
    expect(report.eligible).toBe(1);
    expect(report.skippedDuplicateTarget).toBe(1);
    expect(JSON.parse(report.rows[0]!.metadataJson).confidence).toBe(0.9);
  });

  it("orders deterministically when two targets share an identical terminal timestamp (comparator's equal arm)", () => {
    const report = synthesizeBackfillRows([
      decisionRow({ number: 21, terminalAt: "2026-06-15 10:00:00" }),
      decisionRow({ number: 22, terminalAt: "2026-06-15 10:00:00" }),
      // Shuffled distinct timestamps around the pair force BOTH direction arms of the sort comparator.
      decisionRow({ number: 23, terminalAt: "2026-06-15 09:00:00" }),
      decisionRow({ number: 24, terminalAt: "2026-06-15 11:00:00" }),
    ]);
    expect(report.eligible).toBe(4);
    expect(report.skippedDuplicateTarget).toBe(0);
  });

  it("passes an already-ISO terminal timestamp through unchanged (both timestamp eras)", () => {
    const report = synthesizeBackfillRows([decisionRow({ terminalAt: "2026-06-15T10:00:00.000Z" })]);
    expect(report.rows[0]!.createdAt).toBe("2026-06-15T10:00:00.000Z");
  });

  it("round-trips into buildBacktestCorpus: synthesized pairs become labeled BacktestCases with the confidence metadata", () => {
    const report = synthesizeBackfillRows([decisionRow(), decisionRow({ number: 8, status: "merged", confidence: 0.4 })]);
    const fired: RuleFiredEvent[] = [];
    const overrides: HumanOverrideEvent[] = [];
    for (const row of report.rows) {
      const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
      if (row.eventType.startsWith("signal.rule_fired:")) {
        const { outcome, ...extra } = metadata;
        fired.push({ ruleId: BACKFILL_RULE_ID, targetKey: row.targetKey, outcome: String(outcome), occurredAt: row.createdAt, metadata: extra });
      } else {
        const { verdict } = metadata;
        overrides.push({ ruleId: BACKFILL_RULE_ID, targetKey: row.targetKey, verdict: verdict as "confirmed" | "reversed", occurredAt: row.createdAt });
      }
    }
    const cases = buildBacktestCorpus(BACKFILL_RULE_ID, fired, overrides);
    expect(cases).toHaveLength(2);
    expect(cases.find((c) => c.targetKey === "acme/widgets#7")!.label).toBe("confirmed");
    const wrongCall = cases.find((c) => c.targetKey === "acme/widgets#8")!;
    expect(wrongCall.label).toBe("reversed");
    expect(wrongCall.metadata).toMatchObject({ confidence: 0.4, backfilled: true });
  });
});

describe("buildBackfillInsertStatements (#8157)", () => {
  const report = synthesizeBackfillRows([decisionRow(), decisionRow({ number: 8 }), decisionRow({ number: 9 })]);

  it("renders latest-decision-wins UPSERTs with the full audit_events column list and SQL-escaped values", () => {
    const escaped = synthesizeBackfillRows([decisionRow({ repo: "o'brien/repo" })]);
    const [statement] = buildBackfillInsertStatements(escaped.rows);
    expect(statement).toMatch(/^INSERT INTO audit_events \(id, event_type, actor, target_key, outcome, detail, metadata_json, created_at\) VALUES /);
    // ORB-review finding: a target whose terminal decision changed between runs must be UPDATED, never
    // silently dropped -- the conflict clause updates exactly the decision-bearing columns.
    expect(statement).toContain("ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, metadata_json = excluded.metadata_json, created_at = excluded.created_at");
    expect(statement).toContain("o''brien/repo#7");
    expect(sqlStringLiteral("it's")).toBe("'it''s'");
  });

  it("chunks rows across statements and clamps a degenerate chunk size to 1", () => {
    expect(buildBackfillInsertStatements(report.rows, 4)).toHaveLength(2); // 6 rows -> 4 + 2
    expect(buildBackfillInsertStatements(report.rows, 0)).toHaveLength(6);
    expect(buildBackfillInsertStatements([])).toEqual([]);
  });
});

describe("renderBackfillReport (#8157)", () => {
  it("summarizes both modes with every counter", () => {
    const report = synthesizeBackfillRows([decisionRow(), decisionRow({ verdict: "merge" })]);
    const text = renderBackfillReport(report, "dry-run");
    expect(text).toContain("dry-run");
    expect(text).toContain(`rule ${BACKFILL_RULE_ID}`);
    expect(text).toContain("eligible decisions: 1 (confirmed 1, reversed 0)");
    expect(text).toContain("wrong-verdict 1");
    expect(renderBackfillReport(report, "apply")).toContain("(apply)");
  });
});
