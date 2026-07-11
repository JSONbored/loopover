// Mirror of the app suite pointed at the gittensory-engine copy so the extracted module owns its branch coverage (#2280).
import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISORY_AI_ROUTING, normalizeAdvisoryAiRoutingConfig } from "../../packages/gittensory-engine/src/review/advisory-ai-routing-config";

describe("normalizeAdvisoryAiRoutingConfig", () => {
  it("returns the all-off default when input is undefined (no warnings)", () => {
    const warnings: string[] = [];
    expect(normalizeAdvisoryAiRoutingConfig(undefined, warnings)).toEqual(DEFAULT_ADVISORY_AI_ROUTING);
    expect(warnings).toEqual([]);
  });

  it("normalizes a fully-valid config", () => {
    const warnings: string[] = [];
    expect(normalizeAdvisoryAiRoutingConfig({ slop: true, e2eTestGen: true, planner: true, summaries: true, chatQa: true }, warnings)).toEqual({
      slop: true,
      e2eTestGen: true,
      planner: true,
      summaries: true,
      chatQa: true,
    });
    expect(warnings).toEqual([]);
  });

  it.each(["slop", "e2eTestGen", "planner", "summaries", "chatQa"] as const)("defaults %s to false when omitted", (field) => {
    const warnings: string[] = [];
    expect(normalizeAdvisoryAiRoutingConfig({}, warnings)[field]).toBe(false);
    expect(warnings).toEqual([]);
  });

  it.each(["slop", "e2eTestGen", "planner", "summaries", "chatQa"] as const)("falls back to false and warns on a non-boolean %s", (field) => {
    const warnings: string[] = [];
    const cfg = normalizeAdvisoryAiRoutingConfig({ [field]: "yes" }, warnings);
    expect(cfg[field]).toBe(false);
    expect(warnings).toEqual([`settings.advisoryAiRouting.${field} must be a boolean; using the default "false".`]);
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "on"],
    ["a number", 1],
  ])("normalizes a malformed top-level value (%s) back to the all-off default", (_label, badInput) => {
    const warnings: string[] = [];
    expect(normalizeAdvisoryAiRoutingConfig(badInput, warnings)).toEqual(DEFAULT_ADVISORY_AI_ROUTING);
    expect(warnings).toEqual(["settings.advisoryAiRouting must be an object; using the default (every capability off)."]);
  });
});
