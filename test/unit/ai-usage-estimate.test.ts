import { describe, expect, it } from "vitest";

import { estimateNeurons, extractAiText } from "../../src/services/ai-usage-estimate";

// #10169: estimateNeurons existed in four places and extractAiText in three, byte-identical copies that had
// already drifted -- ai-review.ts's grew a `calls` multiplier when it needed one, and the three pasted
// earlier did not follow.
//
// The drift had teeth. `estimatedNeurons` is BOTH the pre-flight budget gate and the value recorded into
// ai_usage_events, which sumAiEstimatedNeuronsSince adds up as the shared daily neuron budget. A service that
// retried its provider call reported one call's neurons for two calls' spend -- hiding usage from the
// backstop whose entire job is to notice runaway usage.

describe("estimateNeurons (#10169)", () => {
  it("matches the formula every caller previously reimplemented", () => {
    // 400 chars -> 100 input tokens; (100 + 256) * 0.035 = 12.46 -> 13.
    expect(estimateNeurons(400, 256)).toBe(13);
  });

  it("never returns 0 — a call that happened must cost something", () => {
    expect(estimateNeurons(0, 0)).toBe(1);
  });

  it("REGRESSION: scales with the number of calls actually made", () => {
    // The parameter the private copies dropped. Without it a retry is invisible to the budget.
    expect(estimateNeurons(400, 256, 2)).toBe(26);
    expect(estimateNeurons(400, 256, 3)).toBe(39);
  });

  it("defaults to a single call, so the un-retried path is unchanged", () => {
    expect(estimateNeurons(400, 256)).toBe(estimateNeurons(400, 256, 1));
  });

  it("treats 0 or negative calls as one — a floor, never a way to report zero spend", () => {
    // Guards the direction that matters: under-reporting is what hides spend.
    expect(estimateNeurons(400, 256, 0)).toBe(13);
    expect(estimateNeurons(400, 256, -5)).toBe(13);
  });
});

describe("extractAiText", () => {
  it("reads the shapes different providers return", () => {
    expect(extractAiText("plain")).toBe("plain");
    expect(extractAiText({ response: "r" })).toBe("r");
    expect(extractAiText({ text: "t" })).toBe("t");
    expect(extractAiText({ result: "x" })).toBe("x");
  });

  it("FAIL-SOFT: anything unrecognised is empty, never a throw", () => {
    // The caller's own empty-answer handling decides; throwing here would turn a odd-shaped response into a
    // failed review.
    for (const value of [null, undefined, 42, {}, { other: "no" }, []]) {
      expect(extractAiText(value), JSON.stringify(value)).toBe("");
    }
  });
});
