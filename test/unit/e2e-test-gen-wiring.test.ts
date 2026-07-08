import { describe, expect, it } from "vitest";
import { isE2eTestGenerationEnabled } from "../../src/review/e2e-test-gen-wire";

describe("isE2eTestGenerationEnabled — the e2eTests converged-feature master kill-switch", () => {
  it("is off when the env flag is unset (the nullish fallback branch)", () => {
    expect(isE2eTestGenerationEnabled({ GITTENSORY_REVIEW_E2E_TESTS: undefined })).toBe(false);
    expect(isE2eTestGenerationEnabled({})).toBe(false);
  });

  it("is off for an explicit falsy-looking value", () => {
    expect(isE2eTestGenerationEnabled({ GITTENSORY_REVIEW_E2E_TESTS: "false" })).toBe(false);
    expect(isE2eTestGenerationEnabled({ GITTENSORY_REVIEW_E2E_TESTS: "0" })).toBe(false);
  });

  it("is on for every truthy-string spelling, case-insensitively (the present branch)", () => {
    for (const value of ["1", "true", "TRUE", "yes", "YES", "on", "On"]) {
      expect(isE2eTestGenerationEnabled({ GITTENSORY_REVIEW_E2E_TESTS: value })).toBe(true);
    }
  });
});
