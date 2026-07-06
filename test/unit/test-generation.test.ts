import { describe, expect, it } from "vitest";
import { isTestGenerationEnabled, shouldOfferTestGenerationSpec } from "../../src/review/test-generation";

describe("isTestGenerationEnabled (#2189)", () => {
  it("is truthy-string gated and OFF by default", () => {
    expect(isTestGenerationEnabled({})).toBe(false);
    expect(isTestGenerationEnabled({ GITTENSORY_REVIEW_TEST_GENERATION: "true" })).toBe(true);
    expect(isTestGenerationEnabled({ GITTENSORY_REVIEW_TEST_GENERATION: "on" })).toBe(true);
    expect(isTestGenerationEnabled({ GITTENSORY_REVIEW_TEST_GENERATION: "false" })).toBe(false);
  });
});

describe("shouldOfferTestGenerationSpec (#2189)", () => {
  const on = { GITTENSORY_REVIEW_TEST_GENERATION: "true" };
  it("requires BOTH gates: the per-repo manifest toggle AND the operator flag", () => {
    expect(shouldOfferTestGenerationSpec(on, true)).toBe(true);
    expect(shouldOfferTestGenerationSpec(on, false)).toBe(false); // manifest toggle off
    expect(shouldOfferTestGenerationSpec(on, undefined)).toBe(false); // manifest toggle absent
    expect(shouldOfferTestGenerationSpec({}, true)).toBe(false); // operator flag off
    expect(shouldOfferTestGenerationSpec({}, false)).toBe(false); // both off
  });
});
