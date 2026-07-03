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

  it("defaults removeOtherTypeLabels to false when omitted from a mapping", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: [{ issueLabel: "a", prLabel: "b" }] }, warnings);
    expect(result.mappings).toEqual([{ issueLabel: "a", prLabel: "b", removeOtherTypeLabels: false }]);
  });
});
