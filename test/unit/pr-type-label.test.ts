import { describe, expect, it } from "vitest";
import { DEFAULT_TYPE_LABELS, deriveKindFromTitle, normalizeTypeLabelSet, resolvePrTypeLabel } from "../../src/settings/pr-type-label";
import type { LinkedIssueLabelPropagationConfig } from "../../src/types";

describe("deriveKindFromTitle", () => {
  it("maps substantial feat/feature titles to feature and keeps small feat-style work as bug", () => {
    expect(deriveKindFromTitle("feat: add provider fallback")).toBe("feature");
    expect(deriveKindFromTitle("feature(api): support board exports")).toBe("feature");
    expect(deriveKindFromTitle("feat(signals): recognize Conan dependency manifests")).toBe("bug");
    expect(deriveKindFromTitle("feature(api): boards")).toBe("bug");
    expect(deriveKindFromTitle("fix: bug")).toBe("bug");
    expect(deriveKindFromTitle("test: add coverage")).toBe("bug");
    expect(deriveKindFromTitle("docs: readme")).toBe("bug");
    expect(deriveKindFromTitle("chore: deps")).toBe("bug");
    expect(deriveKindFromTitle("refactor: cleanup")).toBe("bug");
    expect(deriveKindFromTitle(undefined)).toBe("bug");
    expect(deriveKindFromTitle("")).toBe("bug");
  });
});

function propagation(overrides: Partial<LinkedIssueLabelPropagationConfig> = {}): LinkedIssueLabelPropagationConfig {
  return { enabled: true, mode: "exclusive_type_label", mappings: [], ...overrides };
}

describe("resolvePrTypeLabel (#priority-linked-issue-gate)", () => {
  it("returns the feature label by title when propagation is not configured", () => {
    const result = resolvePrTypeLabel({ title: "feat: add provider fallback" });
    expect(result).toEqual({ applyLabels: [DEFAULT_TYPE_LABELS.feature], removeLabels: [DEFAULT_TYPE_LABELS.bug, DEFAULT_TYPE_LABELS.priority], source: "title" });
  });

  it("returns the bug label by title for any non-feat/feature prefix when propagation is not configured", () => {
    const result = resolvePrTypeLabel({ title: "fix: y" });
    expect(result).toEqual({ applyLabels: [DEFAULT_TYPE_LABELS.bug], removeLabels: [DEFAULT_TYPE_LABELS.feature, DEFAULT_TYPE_LABELS.priority], source: "title" });
  });

  it("applies the configured priority label (exclusive) when a linked issue already carries the configured issue label", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["gittensor:priority"],
      propagation: propagation({ mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }] }),
    });
    expect(result).toEqual({ applyLabels: ["gittensor:priority"], removeLabels: [DEFAULT_TYPE_LABELS.bug, DEFAULT_TYPE_LABELS.feature], source: "propagation_exclusive" });
  });

  it("never invents priority: falls through to the title-based label when no linked issue carries the configured issue label", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["unrelated-label"],
      propagation: propagation({ mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }] }),
    });
    expect(result.applyLabels).toEqual([DEFAULT_TYPE_LABELS.bug]);
    expect(result.source).toBe("title");
  });

  it("never invents priority: falls through to title-based even with matching linked-issue labels when propagation is disabled", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["gittensor:priority"],
      propagation: propagation({ enabled: false, mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }] }),
    });
    expect(result.applyLabels).toEqual([DEFAULT_TYPE_LABELS.bug]);
    expect(result.source).toBe("title");
  });

  it("matches the configured issue label case-insensitively", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["Gittensor:Priority"],
      propagation: propagation({ mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }] }),
    });
    expect(result.applyLabels).toEqual(["gittensor:priority"]);
    expect(result.source).toBe("propagation_exclusive");
  });

  it("supports fully custom, non-gittensor label names (exclusive mapping)", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["customer:vip"],
      propagation: propagation({ mappings: [{ issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: true }] }),
    });
    expect(result).toEqual({ applyLabels: ["triage:vip"], removeLabels: [DEFAULT_TYPE_LABELS.bug, DEFAULT_TYPE_LABELS.feature, DEFAULT_TYPE_LABELS.priority], source: "propagation_exclusive" });
  });

  it("applies an additive mapping alongside the normal title-based label, without removing it", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["customer:vip"],
      propagation: propagation({ mappings: [{ issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false }] }),
    });
    expect(result.applyLabels).toEqual([DEFAULT_TYPE_LABELS.bug, "triage:vip"]);
    expect(result.removeLabels).toEqual([DEFAULT_TYPE_LABELS.feature, DEFAULT_TYPE_LABELS.priority]);
    expect(result.removeLabels).not.toContain(DEFAULT_TYPE_LABELS.bug);
    expect(result.source).toBe("propagation_additive");
  });

  it("does not crash on an empty mappings array and falls through to title-based", () => {
    const result = resolvePrTypeLabel({ title: "feat: add provider fallback", linkedIssueLabels: ["anything"], propagation: propagation({ mappings: [] }) });
    expect(result.applyLabels).toEqual([DEFAULT_TYPE_LABELS.feature]);
    expect(result.source).toBe("title");
  });

  it("does not crash when linkedIssueLabels is omitted entirely (propagation enabled with mappings configured)", () => {
    const result = resolvePrTypeLabel({
      title: "feat: add provider fallback",
      propagation: propagation({ mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }] }),
    });
    expect(result.applyLabels).toEqual([DEFAULT_TYPE_LABELS.feature]);
    expect(result.source).toBe("title");
  });

  it("resolves the FIRST matching mapping when multiple linked-issue labels are present", () => {
    const result = resolvePrTypeLabel({
      title: "fix: y",
      linkedIssueLabels: ["customer:vip", "gittensor:priority"],
      propagation: propagation({
        mappings: [
          { issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: true },
          { issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true },
        ],
      }),
    });
    expect(result.applyLabels).toEqual(["triage:vip"]);
    expect(result.source).toBe("propagation_exclusive");
  });

  it("respects a custom typeLabels set for both the title fallback and the removal set", () => {
    const custom = { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" };
    const result = resolvePrTypeLabel({ title: "feat: add provider fallback", labels: custom });
    expect(result).toEqual({ applyLabels: ["kind:feature"], removeLabels: ["kind:bug", "kind:priority"], source: "title" });
  });

  describe("arbitrary configured categories (#label-modularity)", () => {
    it("includes arbitrary extra categories in the removal set without ever choosing them by title", () => {
      const custom = { bug: "gittensor:bug", feature: "gittensor:feature", priority: "gittensor:priority", security: "area:security", docs: "area:docs" };
      const result = resolvePrTypeLabel({ title: "fix: y", labels: custom });
      expect(result.applyLabels).toEqual(["gittensor:bug"]);
      expect(result.removeLabels.slice().sort()).toEqual(["area:docs", "area:security", "gittensor:feature", "gittensor:priority"]);
    });

    it("never removes a label that isn't part of the configured type-label set (invariant: unrelated maintainer labels are untouched)", () => {
      const result = resolvePrTypeLabel({ title: "fix: y", labels: { bug: "gittensor:bug" } });
      expect(result.removeLabels).toEqual([]);
      expect(result.removeLabels).not.toContain("needs-review");
      expect(result.removeLabels).not.toContain("gittensor");
    });

    it("applies nothing and removes nothing when the configured type-label set is empty", () => {
      const result = resolvePrTypeLabel({ title: "fix: y", labels: {} });
      expect(result).toEqual({ applyLabels: [], removeLabels: [], source: "title" });
    });

    it("still applies a propagated custom-category label additively when the base type-label set is empty", () => {
      const result = resolvePrTypeLabel({
        title: "fix: y",
        labels: {},
        linkedIssueLabels: ["needs-security-review"],
        propagation: propagation({ mappings: [{ issueLabel: "needs-security-review", prLabel: "area:security", removeOtherTypeLabels: false }] }),
      });
      expect(result).toEqual({ applyLabels: ["area:security"], removeLabels: [], source: "propagation_additive" });
    });

    it("only cleans up categories actually configured when a repo drops down to a subset of the built-in triad", () => {
      // A self-hoster who only wants a bug/feature split, no priority category at all.
      const result = resolvePrTypeLabel({ title: "feat: add provider fallback", labels: { bug: "gittensor:bug", feature: "gittensor:feature" } });
      expect(result).toEqual({ applyLabels: ["gittensor:feature"], removeLabels: ["gittensor:bug"], source: "title" });
    });
  });
});

describe("normalizeTypeLabelSet (#priority-linked-issue-gate)", () => {
  it("returns the full default set when the input is omitted", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet(undefined, warnings)).toEqual(DEFAULT_TYPE_LABELS);
    expect(warnings).toEqual([]);
  });

  it("warns and returns defaults for a non-object input", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet("gittensor:bug", warnings)).toEqual(DEFAULT_TYPE_LABELS);
    expect(warnings.some((w) => w.includes("settings.typeLabels"))).toBe(true);
  });

  it("warns and returns defaults for an array input", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet(["gittensor:bug"], warnings)).toEqual(DEFAULT_TYPE_LABELS);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("overrides just one label name and keeps the other two at their default", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet({ priority: "custom:priority" }, warnings)).toEqual({
      bug: DEFAULT_TYPE_LABELS.bug,
      feature: DEFAULT_TYPE_LABELS.feature,
      priority: "custom:priority",
    });
    expect(warnings).toEqual([]);
  });

  it("warns and falls back to the default for a non-string field value", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet({ priority: 42 }, warnings)).toEqual(DEFAULT_TYPE_LABELS);
    expect(warnings.some((w) => w.includes("settings.typeLabels.priority"))).toBe(true);
  });

  it("trims whitespace and rejects an empty-string field value", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet({ bug: "  kind:bug  ", feature: "   " }, warnings)).toEqual({
      bug: "kind:bug",
      feature: DEFAULT_TYPE_LABELS.feature,
      priority: DEFAULT_TYPE_LABELS.priority,
    });
  });

  it("returns the full default set for an explicitly empty object, matching an omitted/legacy value (backward compat: legacy type_labels_json rows default to '{}')", () => {
    const warnings: string[] = [];
    expect(normalizeTypeLabelSet({}, warnings)).toEqual(DEFAULT_TYPE_LABELS);
    expect(warnings).toEqual([]);
  });

  describe("arbitrary custom categories (#label-modularity)", () => {
    it("includes an arbitrary custom category alongside the defaults-filled built-in categories", () => {
      const warnings: string[] = [];
      expect(normalizeTypeLabelSet({ security: "area:security" }, warnings)).toEqual({
        bug: DEFAULT_TYPE_LABELS.bug,
        feature: DEFAULT_TYPE_LABELS.feature,
        priority: DEFAULT_TYPE_LABELS.priority,
        security: "area:security",
      });
      expect(warnings).toEqual([]);
    });

    it("trims and keeps multiple custom categories at once", () => {
      const warnings: string[] = [];
      expect(normalizeTypeLabelSet({ security: "  area:security  ", docs: "area:docs" }, warnings)).toEqual({
        bug: DEFAULT_TYPE_LABELS.bug,
        feature: DEFAULT_TYPE_LABELS.feature,
        priority: DEFAULT_TYPE_LABELS.priority,
        security: "area:security",
        docs: "area:docs",
      });
    });

    it("drops an invalid custom category entirely (no built-in default to fall back to) and warns", () => {
      const warnings: string[] = [];
      expect(normalizeTypeLabelSet({ security: 42 }, warnings)).toEqual(DEFAULT_TYPE_LABELS);
      expect(warnings.some((w) => w.includes("settings.typeLabels.security") && w.includes("ignoring"))).toBe(true);
    });

    it("drops an empty-string custom category and warns, without touching the built-in defaults", () => {
      const warnings: string[] = [];
      expect(normalizeTypeLabelSet({ security: "   " }, warnings)).toEqual(DEFAULT_TYPE_LABELS);
      expect(warnings.some((w) => w.includes("settings.typeLabels.security"))).toBe(true);
    });
  });
});
