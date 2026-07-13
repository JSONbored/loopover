import { describe, expect, it } from "vitest";
import { parseFocusManifest, reviewConfigToJson } from "../../src/signals/focus-manifest";
import { isFixHandoffEnabled, shouldEmitFixHandoff } from "../../src/review/fix-handoff";

const reviewOf = (fixHandoff: unknown) => parseFocusManifest({ review: { fixHandoff } });
const ON = "acme/widgets";
const ALLOW = { LOOPOVER_REVIEW_FIX_HANDOFF: "1", LOOPOVER_REVIEW_REPOS: ON };

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

describe("fix-handoff env kill-switch + resolver (#2176 / #4099)", () => {
  it("isFixHandoffEnabled: only truthy env values enable", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) expect(isFixHandoffEnabled({ LOOPOVER_REVIEW_FIX_HANDOFF: v })).toBe(true);
    for (const v of ["0", "false", "off", "", undefined]) expect(isFixHandoffEnabled({ LOOPOVER_REVIEW_FIX_HANDOFF: v })).toBe(false);
  });

  it("operator flag is a master kill-switch — off ⇒ always false regardless of the manifest toggle", () => {
    expect(shouldEmitFixHandoff({ LOOPOVER_REVIEW_FIX_HANDOFF: "0", LOOPOVER_REVIEW_REPOS: ON }, ON, true)).toBe(false);
  });

  it("REGRESSION (#4099): unset manifest toggle stays false regardless of the cutover allowlist — byte-identical to before this change (being allowlisted was never sufficient on its own)", () => {
    expect(shouldEmitFixHandoff(ALLOW, ON, undefined)).toBe(false);
    expect(shouldEmitFixHandoff({ LOOPOVER_REVIEW_FIX_HANDOFF: "1", LOOPOVER_REVIEW_REPOS: "other/repo" }, ON, undefined)).toBe(false);
  });

  it("(#4099) an explicit manifest toggle: true fully controls the feature, even for a repo NOT on the cutover allowlist", () => {
    expect(shouldEmitFixHandoff(ALLOW, ON, true)).toBe(true);
    expect(shouldEmitFixHandoff({ LOOPOVER_REVIEW_FIX_HANDOFF: "1", LOOPOVER_REVIEW_REPOS: "other/repo" }, ON, true)).toBe(true);
  });

  it("(#4099) an explicit manifest toggle: false forces the feature off, even for an allowlisted repo", () => {
    expect(shouldEmitFixHandoff(ALLOW, ON, false)).toBe(false);
  });
});
