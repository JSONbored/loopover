import { describe, expect, it } from "vitest";
import { DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION, normalizeLinkedIssueLabelPropagationConfig } from "../../src/review/linked-issue-label-propagation";

describe("normalizeLinkedIssueLabelPropagationConfig (#priority-linked-issue-gate)", () => {
  it("returns the disabled default when the input is omitted", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueLabelPropagationConfig(undefined, warnings)).toEqual(DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION);
    expect(warnings).toEqual([]);
  });

  it("warns and returns the disabled default for a non-object input", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueLabelPropagationConfig("nope", warnings)).toEqual(DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION);
    expect(warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation"))).toBe(true);
  });

  it("warns and returns the disabled default for an array input", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueLabelPropagationConfig([1, 2], warnings)).toEqual(DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("passes through a full, valid config unchanged", () => {
    const warnings: string[] = [];
    const input = {
      enabled: true,
      mode: "exclusive_type_label",
      mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
    };
    expect(normalizeLinkedIssueLabelPropagationConfig(input, warnings)).toEqual(input);
    expect(warnings).toEqual([]);
  });

  it("warns and falls back to the default mode for an unrecognized mode value", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mode: "something_else", mappings: [] }, warnings);
    expect(result.mode).toBe("exclusive_type_label");
    expect(warnings.some((w) => w.includes("mode"))).toBe(true);
  });

  it("warns and falls back to the disabled default for a non-boolean enabled value", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: "true", mappings: [] }, warnings);
    expect(result.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation.enabled"))).toBe(true);
  });

  it("does not warn when enabled is omitted (a normal, unset default)", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ mappings: [] }, warnings);
    expect(result.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("drops a malformed mapping entry (missing prLabel) with a warning, keeping the other valid entries", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      {
        enabled: true,
        mappings: [
          { issueLabel: "gittensor:priority" },
          { issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false },
        ],
      },
      warnings,
    );
    expect(result.mappings).toEqual([{ issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false }]);
    expect(warnings.some((w) => w.includes("mappings[0]"))).toBe(true);
  });

  it("drops a mapping entry with a non-string issueLabel, with a warning", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: [{ issueLabel: 42, prLabel: "triage:vip" }] }, warnings);
    expect(result.mappings).toEqual([]);
    expect(warnings.some((w) => w.includes("mappings[0]"))).toBe(true);
  });

  it("drops a non-object mapping entry with a warning", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: ["not-an-object"] }, warnings);
    expect(result.mappings).toEqual([]);
    expect(warnings.some((w) => w.includes("mappings[0]"))).toBe(true);
  });

  it("warns and uses no mappings when mappings is not an array", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: "nope" }, warnings);
    expect(result.mappings).toEqual([]);
    expect(warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation.mappings"))).toBe(true);
  });

  it("passes through a mapping's trustMaintainerAuthoredIssue: true unchanged", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      { enabled: true, mappings: [{ issueLabel: "gittensor:feature", prLabel: "gittensor:feature", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true }] },
      warnings,
    );
    expect(result.mappings).toEqual([{ issueLabel: "gittensor:feature", prLabel: "gittensor:feature", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true }]);
    expect(warnings).toEqual([]);
  });

  it("leaves trustMaintainerAuthoredIssue undefined (not defaulted to false) when omitted from a mapping, with no warning", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: [{ issueLabel: "a", prLabel: "b" }] }, warnings);
    expect(result.mappings[0]?.trustMaintainerAuthoredIssue).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns and ignores a non-boolean trustMaintainerAuthoredIssue, keeping the rest of the mapping (never silently defaults to true)", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      { enabled: true, mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", trustMaintainerAuthoredIssue: "true" }] },
      warnings,
    );
    expect(result.mappings).toEqual([{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssue: undefined }]);
    expect(warnings.some((w) => w.includes("mappings[0].trustMaintainerAuthoredIssue"))).toBe(true);
  });

  it("passes through a mapping's trustMaintainerAuthoredIssueForReward: true unchanged (#priority-reward-maintainer-trust)", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      { enabled: true, mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssueForReward: true }] },
      warnings,
    );
    expect(result.mappings).toEqual([{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssueForReward: true }]);
    expect(warnings).toEqual([]);
  });

  it("leaves trustMaintainerAuthoredIssueForReward undefined (not defaulted to false) when omitted from a mapping, with no warning", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: [{ issueLabel: "a", prLabel: "b" }] }, warnings);
    expect(result.mappings[0]?.trustMaintainerAuthoredIssueForReward).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns and ignores a non-boolean trustMaintainerAuthoredIssueForReward, keeping the rest of the mapping (never silently defaults to true)", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      { enabled: true, mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", trustMaintainerAuthoredIssueForReward: "true" }] },
      warnings,
    );
    expect(result.mappings).toEqual([{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssueForReward: undefined }]);
    expect(warnings.some((w) => w.includes("mappings[0].trustMaintainerAuthoredIssueForReward"))).toBe(true);
  });

  it("defaults removeOtherTypeLabels to false when omitted from a mapping", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: [{ issueLabel: "a", prLabel: "b" }] }, warnings);
    expect(result.mappings).toEqual([{ issueLabel: "a", prLabel: "b", removeOtherTypeLabels: false }]);
  });

  it("drops a mapping entry with a non-boolean removeOtherTypeLabels, with a warning, keeping other valid entries", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      {
        enabled: true,
        mappings: [
          { issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: "true" },
          { issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false },
        ],
      },
      warnings,
    );
    // A quoted "true" string must never silently coerce to `false` (flipping an intended-exclusive
    // mapping to additive) -- the whole entry is dropped instead, with the other valid entry kept.
    expect(result.mappings).toEqual([{ issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false }]);
    expect(warnings.some((w) => w.includes("mappings[0].removeOtherTypeLabels"))).toBe(true);
  });
});
