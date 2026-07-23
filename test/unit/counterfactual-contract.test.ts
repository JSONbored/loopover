import { describe, expect, it } from "vitest";
// Direct src-path import per the engine blind-spot rule (the barrel resolves to dist, outside Codecov).
import {
  COUNTERFACTUAL_DEFAULT_NEURON_BUDGET,
  COUNTERFACTUAL_SAMPLE_SEED_PREFIX,
  isReplayableCase,
} from "../../packages/loopover-engine/src/calibration/counterfactual-contract.js";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus.js";

// #8219: the contract module is deliberately types + constants + one shared narrowing helper. These tests
// pin the constants the later sub-issues (#8220/#8221) cite and the replayability rule's every arm.

function backtestCase(metadata?: Record<string, unknown>): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey: "acme/widgets#7",
    outcome: "unaddressed",
    label: "confirmed",
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("counterfactual contract (#8219)", () => {
  it("pins the campaign seed prefix and the default neuron budget the harness must treat as default-not-limit", () => {
    expect(COUNTERFACTUAL_SAMPLE_SEED_PREFIX).toBe("counterfactual-replay-v1");
    expect(COUNTERFACTUAL_DEFAULT_NEURON_BUDGET).toBe(250_000);
  });

  it("isReplayableCase: bounded diff present and non-empty is the whole rule — every arm", () => {
    expect(isReplayableCase(backtestCase({ diff: "diff --git a/x b/x" }))).toBe(true);
    expect(isReplayableCase(backtestCase({ diff: "" }))).toBe(false); // empty diff never replays
    expect(isReplayableCase(backtestCase({ rawSignal: "detail only" }))).toBe(false); // wrong context kind
    expect(isReplayableCase(backtestCase({ diff: 42 }))).toBe(false); // non-string never replays
    expect(isReplayableCase(backtestCase())).toBe(false); // no metadata at all
  });
});
