import { describe, expect, it } from "vitest";
import {
  GITTENSORY_CONTEXT_CHECK_NAME,
  GITTENSORY_GATE_CHECK_NAME,
  GITTENSORY_LEGACY_GATE_CHECK_NAME,
  shouldPublishReviewCheck,
} from "../../src/review/check-names";

describe("Gittensory GitHub check names", () => {
  it("exports stable, distinct check-run titles", () => {
    const names = [GITTENSORY_CONTEXT_CHECK_NAME, GITTENSORY_GATE_CHECK_NAME, GITTENSORY_LEGACY_GATE_CHECK_NAME];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("keeps the orb review agent as the canonical gate check name", () => {
    expect(GITTENSORY_GATE_CHECK_NAME).toBe("Gittensory Orb Review Agent");
    expect(GITTENSORY_LEGACY_GATE_CHECK_NAME).toBe("Gittensory Gate");
    expect(GITTENSORY_CONTEXT_CHECK_NAME).toBe("Gittensory Context");
  });
});

describe("shouldPublishReviewCheck (#2852)", () => {
  it("publishes for both required and visible modes", () => {
    expect(shouldPublishReviewCheck("required")).toBe(true);
    expect(shouldPublishReviewCheck("visible")).toBe(true);
  });

  it("never publishes for disabled mode", () => {
    expect(shouldPublishReviewCheck("disabled")).toBe(false);
  });
});
