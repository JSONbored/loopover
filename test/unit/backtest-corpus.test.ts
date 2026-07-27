import { describe, expect, it } from "vitest";
// Direct src-path import (not the `@loopover/engine` package barrel, which resolves to dist and is NOT in
// vitest's coverage.include): the engine's own node:test suite runs against dist and is invisible to Codecov
// (only review-enrichment has a c8 dist-remap harvest step; the engine has none), so this vitest test is what
// gives packages/loopover-engine/src/calibration/backtest-corpus.ts its codecov/patch coverage. The companion
// packages/loopover-engine/test/backtest-corpus.test.ts is the issue-required node:test that gates the engine
// workspace's own `npm run test`. Vite resolves the `.js` specifier to the sibling `.ts` on disk.
import { buildBacktestCorpus } from "../../packages/loopover-engine/src/calibration/backtest-corpus";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";
import type { HumanOverrideEvent, RuleFiredEvent } from "../../packages/loopover-engine/src/calibration/signal-tracking";

const RULE = "missing_linked_issue";

function fired(targetKey: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId: RULE, targetKey, outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

function override(targetKey: string, verdict: HumanOverrideEvent["verdict"], overrides: Partial<HumanOverrideEvent> = {}): HumanOverrideEvent {
  return { ruleId: RULE, targetKey, verdict, occurredAt: "2026-07-22T01:00:00.000Z", ...overrides };
}

describe("buildBacktestCorpus (#8083)", () => {
  it("excludes a fired event with no matching override (only decided cases count)", () => {
    const corpus = buildBacktestCorpus(RULE, [fired("a#1"), fired("a#2")], [override("a#1", "confirmed")]);
    expect(corpus.map((c) => c.targetKey)).toEqual(["a#1"]);
  });

  it("produces one correctly-labeled case for a single fired+override pair, carrying metadata through", () => {
    const corpus = buildBacktestCorpus(
      RULE,
      [fired("a#1", { occurredAt: "2026-07-22T00:00:00.000Z", metadata: { pr: 1 } })],
      [override("a#1", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" })],
    );
    expect(corpus).toEqual([
      {
        ruleId: RULE,
        targetKey: "a#1",
        outcome: "block",
        label: "reversed",
        firedAt: "2026-07-22T00:00:00.000Z",
        decidedAt: "2026-07-22T02:00:00.000Z",
        metadata: { pr: 1 },
      } satisfies BacktestCase,
    ]);
  });

  it("omits metadata entirely (never sets it to undefined) when the fired event has none", () => {
    const corpus = buildBacktestCorpus(RULE, [fired("a#1")], [override("a#1", "confirmed")]);
    expect("metadata" in corpus[0]!).toBe(false);
  });

  it("pairs a firing with the nearest override strictly after it when a target was judged multiple times", () => {
    const corpus = buildBacktestCorpus(
      RULE,
      [fired("a#1", { occurredAt: "2026-07-22T00:00:00.000Z" })],
      [
        override("a#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
        override("a#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
        override("a#1", "confirmed", { occurredAt: "2026-07-21T23:00:00.000Z" }),
      ],
    );
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.label).toBe("reversed");
    expect(corpus[0]!.decidedAt).toBe("2026-07-22T01:00:00.000Z");
  });

  it("falls back to the most recent override when none strictly follows the firing", () => {
    const corpus = buildBacktestCorpus(
      RULE,
      [fired("a#1", { occurredAt: "2026-07-22T05:00:00.000Z" })],
      [
        override("a#1", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" }),
        override("a#1", "confirmed", { occurredAt: "2026-07-22T04:00:00.000Z" }),
      ],
    );
    expect(corpus[0]!.label).toBe("confirmed");
    expect(corpus[0]!.decidedAt).toBe("2026-07-22T04:00:00.000Z");
  });

  it("gives each of two firings for the same target its own case (no duplicate for one firing)", () => {
    const corpus = buildBacktestCorpus(
      RULE,
      [fired("a#1", { occurredAt: "2026-07-22T00:00:00.000Z" }), fired("a#1", { occurredAt: "2026-07-22T02:30:00.000Z" })],
      [
        override("a#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
        override("a#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
      ],
    );
    expect(corpus.map((c) => c.decidedAt)).toEqual(["2026-07-22T01:00:00.000Z", "2026-07-22T03:00:00.000Z"]);
  });

  it("ignores fired and override events for a different ruleId", () => {
    const corpus = buildBacktestCorpus(
      RULE,
      [fired("a#1"), { ruleId: "other_rule", targetKey: "a#1", outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z" }],
      [override("a#1", "confirmed"), { ruleId: "other_rule", targetKey: "a#1", verdict: "reversed", occurredAt: "2026-07-22T01:00:00.000Z" }],
    );
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!).toMatchObject({ ruleId: RULE, label: "confirmed" });
  });

  it("returns an empty corpus for empty input arrays", () => {
    expect(buildBacktestCorpus(RULE, [], [])).toEqual([]);
  });
});
