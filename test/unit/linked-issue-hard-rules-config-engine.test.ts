// Engine-owned coverage for the linked-issue hard-rules normalizer (#2280).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINKED_ISSUE_HARD_RULES,
  isLinkedIssueHardRuleMode,
  normalizeLinkedIssueHardRulesConfig,
} from "../../packages/gittensory-engine/src/review/linked-issue-hard-rules-config";

describe("isLinkedIssueHardRuleMode [engine]", () => {
  it("accepts the valid modes and rejects everything else", () => {
    expect(isLinkedIssueHardRuleMode("block")).toBe(true);
    expect(isLinkedIssueHardRuleMode("off")).toBe(true);
    expect(isLinkedIssueHardRuleMode("warn")).toBe(false);
    expect(isLinkedIssueHardRuleMode(123)).toBe(false);
    expect(isLinkedIssueHardRuleMode(undefined)).toBe(false);
  });
});

describe("normalizeLinkedIssueHardRulesConfig [engine]", () => {
  it("returns the all-off default for undefined input", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueHardRulesConfig(undefined, warnings)).toEqual({
      ...DEFAULT_LINKED_ISSUE_HARD_RULES,
      pointBearingLabels: [],
      maintainerOnlyLabels: [],
    });
    expect(warnings).toEqual([]);
  });

  it("warns and falls back to default for non-object / null / array input", () => {
    for (const bad of ["nope", null, [] as unknown]) {
      const warnings: string[] = [];
      expect(normalizeLinkedIssueHardRulesConfig(bad, warnings)).toEqual({
        ...DEFAULT_LINKED_ISSUE_HARD_RULES,
        pointBearingLabels: [],
        maintainerOnlyLabels: [],
      });
      expect(warnings.some((w) => w.includes("must be an object"))).toBe(true);
    }
  });

  it("parses a fully valid object", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueHardRulesConfig(
      {
        ownerAssignedClose: "block",
        assignedIssueClose: "off",
        missingPointLabelClose: "block",
        maintainerOnlyLabelClose: "block",
        pointBearingLabels: ["  points  ", "size"],
        maintainerOnlyLabels: ["maintainer"],
        defaultLabelRepo: true,
        verifyBeforeClose: false,
        closeDelaySeconds: 90,
      },
      warnings,
    );
    expect(result).toEqual({
      ownerAssignedClose: "block",
      assignedIssueClose: "off",
      missingPointLabelClose: "block",
      maintainerOnlyLabelClose: "block",
      pointBearingLabels: ["points", "size"],
      maintainerOnlyLabels: ["maintainer"],
      defaultLabelRepo: true,
      verifyBeforeClose: false,
      closeDelaySeconds: 90,
    });
    expect(warnings).toEqual([]);
  });

  it("warns on an invalid mode and falls back to the field default", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueHardRulesConfig({ ownerAssignedClose: "sometimes" }, warnings);
    expect(result.ownerAssignedClose).toBe("off");
    expect(warnings.some((w) => w.includes("ownerAssignedClose"))).toBe(true);
  });

  it("warns on a non-array label list and drops invalid entries within a valid list", () => {
    const nonArray: string[] = [];
    expect(normalizeLinkedIssueHardRulesConfig({ pointBearingLabels: "points" }, nonArray).pointBearingLabels).toEqual([]);
    expect(nonArray.some((w) => w.includes("pointBearingLabels must be an array"))).toBe(true);

    const withEntries: string[] = [];
    const result = normalizeLinkedIssueHardRulesConfig({ maintainerOnlyLabels: ["keep", "", 5, "   "] }, withEntries);
    expect(result.maintainerOnlyLabels).toEqual(["keep"]);
    expect(withEntries.some((w) => w.includes("must be a non-empty string"))).toBe(true);
  });

  it("warns on a non-boolean flag and falls back to the field default", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueHardRulesConfig({ defaultLabelRepo: "yes", verifyBeforeClose: 0 }, warnings);
    expect(result.defaultLabelRepo).toBe(false);
    expect(result.verifyBeforeClose).toBe(true);
    expect(warnings.filter((w) => w.includes("must be a boolean")).length).toBe(2);
  });

  it("clamps closeDelaySeconds and warns on invalid values", () => {
    expect(normalizeLinkedIssueHardRulesConfig({ closeDelaySeconds: 10.9 }, []).closeDelaySeconds).toBe(10);
    expect(normalizeLinkedIssueHardRulesConfig({ closeDelaySeconds: 5000 }, []).closeDelaySeconds).toBe(300);

    const warnings: string[] = [];
    const result = normalizeLinkedIssueHardRulesConfig({ closeDelaySeconds: -1 }, warnings);
    expect(result.closeDelaySeconds).toBe(30);
    expect(warnings.some((w) => w.includes("closeDelaySeconds"))).toBe(true);

    const nan: string[] = [];
    expect(normalizeLinkedIssueHardRulesConfig({ closeDelaySeconds: Number.NaN }, nan).closeDelaySeconds).toBe(30);
    expect(nan.some((w) => w.includes("closeDelaySeconds"))).toBe(true);
  });
});
