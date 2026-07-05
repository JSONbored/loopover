import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNLINKED_ISSUE_GUARDRAIL,
  isUnlinkedIssueGuardrailMode,
  normalizeUnlinkedIssueGuardrailConfig,
} from "../../src/review/unlinked-issue-guardrail-config";

describe("isUnlinkedIssueGuardrailMode", () => {
  it("accepts the two valid modes", () => {
    expect(isUnlinkedIssueGuardrailMode("hold")).toBe(true);
    expect(isUnlinkedIssueGuardrailMode("off")).toBe(true);
  });

  it("rejects an invalid string and a non-string value", () => {
    expect(isUnlinkedIssueGuardrailMode("block")).toBe(false);
    expect(isUnlinkedIssueGuardrailMode(1)).toBe(false);
  });
});

describe("normalizeUnlinkedIssueGuardrailConfig", () => {
  it("returns the all-off default when input is undefined (no warnings)", () => {
    const warnings: string[] = [];
    expect(normalizeUnlinkedIssueGuardrailConfig(undefined, warnings)).toEqual(DEFAULT_UNLINKED_ISSUE_GUARDRAIL);
    expect(warnings).toEqual([]);
  });

  it("normalizes a fully-valid config", () => {
    const warnings: string[] = [];
    expect(normalizeUnlinkedIssueGuardrailConfig({ mode: "hold", minConfidence: 0.9 }, warnings)).toEqual({
      mode: "hold",
      minConfidence: 0.9,
    });
    expect(warnings).toEqual([]);
  });

  it("defaults mode when omitted", () => {
    const warnings: string[] = [];
    expect(normalizeUnlinkedIssueGuardrailConfig({ minConfidence: 0.5 }, warnings).mode).toBe("off");
    expect(warnings).toEqual([]);
  });

  it("falls back to the default mode and warns on an invalid mode value", () => {
    const warnings: string[] = [];
    const cfg = normalizeUnlinkedIssueGuardrailConfig({ mode: "block" }, warnings);
    expect(cfg.mode).toBe("off");
    expect(warnings).toEqual([`settings.unlinkedIssueGuardrail.mode must be one of hold, off; using the default "off".`]);
  });

  it("defaults minConfidence when omitted", () => {
    const warnings: string[] = [];
    expect(normalizeUnlinkedIssueGuardrailConfig({ mode: "hold" }, warnings).minConfidence).toBe(0.85);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["a non-number", "not-a-number"],
    ["a negative number", -0.1],
    ["a number above 1", 1.5],
    ["NaN", Number.NaN],
  ])("falls back to the default minConfidence and warns on %s", (_label, badValue) => {
    const warnings: string[] = [];
    const cfg = normalizeUnlinkedIssueGuardrailConfig({ minConfidence: badValue }, warnings);
    expect(cfg.minConfidence).toBe(0.85);
    expect(warnings).toEqual([`settings.unlinkedIssueGuardrail.minConfidence must be a number between 0 and 1; using the default "0.85".`]);
  });

  it("accepts the minConfidence boundary values 0 and 1", () => {
    const warnings: string[] = [];
    expect(normalizeUnlinkedIssueGuardrailConfig({ minConfidence: 0 }, warnings).minConfidence).toBe(0);
    expect(normalizeUnlinkedIssueGuardrailConfig({ minConfidence: 1 }, warnings).minConfidence).toBe(1);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "hold"],
    ["a number", 1],
  ])("normalizes a malformed top-level value (%s) back to the all-off default", (_label, badInput) => {
    const warnings: string[] = [];
    expect(normalizeUnlinkedIssueGuardrailConfig(badInput, warnings)).toEqual(DEFAULT_UNLINKED_ISSUE_GUARDRAIL);
    expect(warnings).toEqual(["settings.unlinkedIssueGuardrail must be an object; using the default off policy."]);
  });
});
