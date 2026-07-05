import { describe, expect, it } from "vitest";
import { parseFocusManifest, reviewConfigToJson } from "../../src/signals/focus-manifest";
import { resolveLabelingRules } from "../../src/review/labeling-rules";

const rulesOf = (labeling_rules: unknown) => parseFocusManifest({ review: { labeling_rules } });
const facts = (over: Partial<{ changedPaths: string[]; title: string; description: string }> = {}) => ({
  changedPaths: [],
  title: "",
  description: "",
  ...over,
});

describe("review.labeling_rules parse + round-trip (#2045)", () => {
  it("absent ⇒ empty and OMITTED on serialize (byte-identical)", () => {
    const review = parseFocusManifest({ review: { note: "x" } }).review;
    expect(review.labelingRules).toEqual([]);
    expect("labeling_rules" in (reviewConfigToJson(review) as Record<string, unknown>)).toBe(false);
  });

  it("a full rule round-trips parse → serialize → parse identically", () => {
    const review = rulesOf([
      { label: "area:docs", when_paths: ["docs/**"], title_contains: "doc", description_contains: "readme" },
    ]).review;
    expect(review.labelingRules).toEqual([
      { label: "area:docs", whenPaths: ["docs/**"], titleContains: "doc", descriptionContains: "readme" },
    ]);
    const json = reviewConfigToJson(review) as Record<string, unknown>;
    expect(json.labeling_rules).toEqual([
      { label: "area:docs", when_paths: ["docs/**"], title_contains: "doc", description_contains: "readme" },
    ]);
    expect(parseFocusManifest({ review: json }).review.labelingRules).toEqual(review.labelingRules);
  });

  it("serializes only the criteria that are set (a path-only rule omits title/description keys)", () => {
    const review = rulesOf([{ label: "area:ci", when_paths: [".github/**"] }]).review;
    expect((reviewConfigToJson(review) as Record<string, unknown>).labeling_rules).toEqual([
      { label: "area:ci", when_paths: [".github/**"] },
    ]);
  });

  it("refuses a reserved gittensor: label and warns", () => {
    const m = rulesOf([{ label: "gittensor:feature", when_paths: ["src/**"] }]);
    expect(m.review.labelingRules).toEqual([]);
    expect(m.warnings.some((w) => /reserved "gittensor:" namespace/.test(w))).toBe(true);
  });

  it("drops a rule with no when-criterion, a rule with no label, and a non-mapping entry (each warns)", () => {
    const m = rulesOf([{ label: "area:x" }, { when_paths: ["a/**"] }, "nope"]);
    expect(m.review.labelingRules).toEqual([]);
    expect(m.warnings.some((w) => /needs at least one of when_paths/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /\.label" is required/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /\[2\]" must be a mapping/.test(w))).toBe(true);
  });

  it("a present-but-invalid (non-string) label is dropped and warned by the text validator (not 'required')", () => {
    const m = rulesOf([{ label: 123, when_paths: ["src/**"] }]);
    expect(m.review.labelingRules).toEqual([]);
    expect(m.warnings.some((w) => /labeling_rules\[0\]\.label/.test(w))).toBe(true);
  });

  it("a title-only rule round-trips with when_paths omitted", () => {
    const review = rulesOf([{ label: "type:wip", title_contains: "WIP" }]).review;
    expect(review.labelingRules).toEqual([
      { label: "type:wip", whenPaths: [], titleContains: "WIP", descriptionContains: null },
    ]);
    expect((reviewConfigToJson(review) as Record<string, unknown>).labeling_rules).toEqual([
      { label: "type:wip", title_contains: "WIP" },
    ]);
  });

  it("a non-list labeling_rules warns and is ignored", () => {
    const m = rulesOf("nope");
    expect(m.review.labelingRules).toEqual([]);
    expect(m.warnings.some((w) => /"review\.labeling_rules" must be a list/.test(w))).toBe(true);
  });

  it("caps at 50 rules", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ label: `area:${i}`, when_paths: ["src/**"] }));
    const m = rulesOf(many);
    expect(m.review.labelingRules.length).toBe(50);
    expect(m.warnings.some((w) => /capped at 50/.test(w))).toBe(true);
  });
});

describe("resolveLabelingRules deterministic evaluation (#2045)", () => {
  const rules = [
    { label: "area:docs", whenPaths: ["docs/**"], titleContains: null, descriptionContains: null },
    { label: "type:wip", whenPaths: [], titleContains: "WIP", descriptionContains: null },
    { label: "needs:migration", whenPaths: ["migrations/**"], titleContains: null, descriptionContains: "schema" },
  ];

  it("fires a path rule only when a changed path matches", () => {
    expect(resolveLabelingRules({ rules, facts: facts({ changedPaths: ["docs/readme.md"] }), autoLabelEnabled: false }).suggest).toEqual(["area:docs"]);
    expect(resolveLabelingRules({ rules, facts: facts({ changedPaths: ["src/a.ts"] }), autoLabelEnabled: false }).suggest).toEqual([]);
  });

  it("title match is case-insensitive; a multi-criterion rule needs ALL criteria", () => {
    expect(resolveLabelingRules({ rules, facts: facts({ title: "wip: draft" }), autoLabelEnabled: false }).suggest).toEqual(["type:wip"]);
    // needs:migration requires BOTH a migrations/** path AND "schema" in the description
    expect(resolveLabelingRules({ rules, facts: facts({ changedPaths: ["migrations/001.sql"] }), autoLabelEnabled: false }).suggest).toEqual([]);
    expect(resolveLabelingRules({ rules, facts: facts({ changedPaths: ["migrations/001.sql"], description: "adds a schema column" }), autoLabelEnabled: false }).suggest).toEqual(["needs:migration"]);
  });

  it("apply is empty unless autoLabelEnabled, then mirrors suggest", () => {
    const f = facts({ changedPaths: ["docs/x.md"], title: "WIP" });
    expect(resolveLabelingRules({ rules, facts: f, autoLabelEnabled: false })).toEqual({ suggest: ["area:docs", "type:wip"], apply: [] });
    expect(resolveLabelingRules({ rules, facts: f, autoLabelEnabled: true })).toEqual({ suggest: ["area:docs", "type:wip"], apply: ["area:docs", "type:wip"] });
  });

  it("dedupes a label shared by two firing rules, preserving first-seen order", () => {
    const dup = [
      { label: "area:x", whenPaths: ["a/**"], titleContains: null, descriptionContains: null },
      { label: "area:x", whenPaths: ["b/**"], titleContains: null, descriptionContains: null },
    ];
    expect(resolveLabelingRules({ rules: dup, facts: facts({ changedPaths: ["a/1", "b/2"] }), autoLabelEnabled: true }).suggest).toEqual(["area:x"]);
  });
});
