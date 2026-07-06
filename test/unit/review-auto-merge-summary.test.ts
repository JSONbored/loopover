import { describe, expect, it } from "vitest";
import { parseFocusManifest, reviewConfigToJson } from "../../src/signals/focus-manifest";
import { buildAutoMergeSummaryCollapsible, type AutoMergeSummarySignals } from "../../src/review/unified-comment";

const reviewOf = (autoMergeSummary: unknown) => parseFocusManifest({ review: { auto_merge_summary: autoMergeSummary } });
const allPass: AutoMergeSummarySignals = { ciGreen: true, gatePassing: true, mergeableClean: true, linkedIssueValid: true };

describe("review.auto_merge_summary config toggle (#2051)", () => {
  it("absent ⇒ null and OMITTED on serialize (byte-identical)", () => {
    const review = parseFocusManifest({ review: { note: "x" } }).review;
    expect(review.autoMergeSummary).toBe(null);
    expect("auto_merge_summary" in (reviewConfigToJson(review) as Record<string, unknown>)).toBe(false);
  });

  it("true / false parse, mark present, and round-trip", () => {
    for (const v of [true, false]) {
      const review = reviewOf(v).review;
      expect(review.autoMergeSummary).toBe(v);
      expect(review.present).toBe(true);
      const json = reviewConfigToJson(review) as Record<string, unknown>;
      expect(json.auto_merge_summary).toBe(v);
      expect(parseFocusManifest({ review: json }).review.autoMergeSummary).toBe(v);
    }
  });

  it("a non-boolean value warns and falls back to null", () => {
    const m = reviewOf("maybe");
    expect(m.review.autoMergeSummary).toBe(null);
    expect(m.warnings.some((w) => /review\.auto_merge_summary/.test(w))).toBe(true);
  });
});

describe("buildAutoMergeSummaryCollapsible read-only render (#2051)", () => {
  it("renders a 4-condition table from injected signals — all passing", () => {
    const c = buildAutoMergeSummaryCollapsible(allPass);
    expect(c.title).toMatch(/read-only/i);
    for (const label of ["CI checks green", "Gate passing", "Branch mergeable (clean)", "Valid linked issue"]) {
      expect(c.body).toContain(label);
    }
    expect(c.body).not.toContain("❌"); // all four pass
    expect((c.body.match(/✅/g) ?? []).length).toBe(4);
  });

  it("reflects EXACTLY the injected signal states (❌ per failing condition), never re-deriving", () => {
    const mixed: AutoMergeSummarySignals = { ciGreen: true, gatePassing: false, mergeableClean: true, linkedIssueValid: false };
    const c = buildAutoMergeSummaryCollapsible(mixed);
    expect((c.body.match(/✅/g) ?? []).length).toBe(2);
    expect((c.body.match(/❌/g) ?? []).length).toBe(2);
    // the failing rows are the two false signals, in order
    expect(c.body).toMatch(/Gate passing \| ❌/);
    expect(c.body).toMatch(/Valid linked issue \| ❌/);
    // read-only framing — never a merge promise/action verb
    expect(c.body).toMatch(/does not decide or trigger a merge/i);
    // deterministic: same input ⇒ identical output
    expect(buildAutoMergeSummaryCollapsible(mixed)).toEqual(c);
  });
});
