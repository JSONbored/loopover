import { describe, expect, it } from "vitest";
import { parseFocusManifest, reviewConfigToJson } from "../../src/signals/focus-manifest";
import { isFixHandoffEnabled, shouldEmitFixHandoff } from "../../src/review/fix-handoff";

const reviewOf = (fixHandoff: unknown) => parseFocusManifest({ review: { fixHandoff } });
const ON = "acme/widgets";
const ALLOW = { GITTENSORY_REVIEW_FIX_HANDOFF: "1", GITTENSORY_REVIEW_REPOS: ON };

describe("review.fixHandoff config toggle (#2176)", () => {
  it("absent ⇒ null and OMITTED on serialize (byte-identical)", () => {
    const review = parseFocusManifest({ review: { note: "x" } }).review;
    expect(review.fixHandoff).toBe(null);
    expect("fixHandoff" in (reviewConfigToJson(review) as Record<string, unknown>)).toBe(false);
  });

  it("true / false parse, mark present, and round-trip", () => {
    for (const v of [true, false]) {
      const review = reviewOf(v).review;
      expect(review.fixHandoff).toBe(v);
      expect(review.present).toBe(true);
      const json = reviewConfigToJson(review) as Record<string, unknown>;
      expect(json.fixHandoff).toBe(v);
      expect(parseFocusManifest({ review: json }).review.fixHandoff).toBe(v);
    }
  });

  it("a non-boolean value warns and falls back to null", () => {
    const m = reviewOf("maybe");
    expect(m.review.fixHandoff).toBe(null);
    expect(m.warnings.some((w) => /review\.fixHandoff/.test(w))).toBe(true);
  });
});

describe("fix-handoff env kill-switch + resolver (#2176)", () => {
  it("isFixHandoffEnabled: only truthy env values enable", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) expect(isFixHandoffEnabled({ GITTENSORY_REVIEW_FIX_HANDOFF: v })).toBe(true);
    for (const v of ["0", "false", "off", "", undefined]) expect(isFixHandoffEnabled({ GITTENSORY_REVIEW_FIX_HANDOFF: v })).toBe(false);
  });

  it("shouldEmitFixHandoff: true ONLY when manifest toggle AND env flag AND cutover allowlist all pass", () => {
    // all three on
    expect(shouldEmitFixHandoff(ALLOW, ON, true)).toBe(true);
    // manifest toggle off / undefined
    expect(shouldEmitFixHandoff(ALLOW, ON, false)).toBe(false);
    expect(shouldEmitFixHandoff(ALLOW, ON, undefined)).toBe(false);
    // env flag off
    expect(shouldEmitFixHandoff({ GITTENSORY_REVIEW_FIX_HANDOFF: "0", GITTENSORY_REVIEW_REPOS: ON }, ON, true)).toBe(false);
    // repo not on the cutover allowlist
    expect(shouldEmitFixHandoff({ GITTENSORY_REVIEW_FIX_HANDOFF: "1", GITTENSORY_REVIEW_REPOS: "other/repo" }, ON, true)).toBe(false);
  });
});
