import { describe, expect, it } from "vitest";
import {
  GITTENSORY_LEGACY_CONTEXT_CHECK_NAME,
  GITTENSORY_LEGACY_GATE_CHECK_NAME,
  GITTENSORY_LEGACY_ORB_GATE_CHECK_NAME,
  LOOPOVER_CONTEXT_CHECK_NAME,
  LOOPOVER_GATE_CHECK_NAME,
  shouldPublishReviewCheck,
} from "../../src/review/check-names";

describe("LoopOver GitHub check names", () => {
  it("exports stable, distinct check-run titles", () => {
    const names = [
      LOOPOVER_CONTEXT_CHECK_NAME,
      LOOPOVER_GATE_CHECK_NAME,
      GITTENSORY_LEGACY_GATE_CHECK_NAME,
      GITTENSORY_LEGACY_ORB_GATE_CHECK_NAME,
      GITTENSORY_LEGACY_CONTEXT_CHECK_NAME,
    ];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("keeps the orb review agent as the canonical gate check name", () => {
    expect(LOOPOVER_GATE_CHECK_NAME).toBe("LoopOver Orb Review Agent");
    expect(LOOPOVER_CONTEXT_CHECK_NAME).toBe("LoopOver Context");
    expect(GITTENSORY_LEGACY_GATE_CHECK_NAME).toBe("Gittensory Gate");
    expect(GITTENSORY_LEGACY_ORB_GATE_CHECK_NAME).toBe("Gittensory Orb Review Agent");
    expect(GITTENSORY_LEGACY_CONTEXT_CHECK_NAME).toBe("Gittensory Context");
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
