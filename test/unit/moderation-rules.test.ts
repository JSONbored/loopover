import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_MODERATION_CONFIG,
  DEFAULT_MODERATION_BANNED_LABEL,
  DEFAULT_MODERATION_BAN_THRESHOLD,
  DEFAULT_MODERATION_WARNING_LABEL,
  MODERATION_VIOLATION_EVENT_TYPE,
  moderationTierForViolationCount,
  normalizeModerationLabel,
  normalizeModerationRules,
  resolveEffectiveModerationRules,
  resolveModerationGateEnabled,
} from "../../src/settings/moderation-rules";

describe("normalizeModerationRules (#selfhost-mod-engine)", () => {
  it("returns [] for null/undefined and a non-array (with a warning)", () => {
    expect(normalizeModerationRules(undefined).rules).toEqual([]);
    expect(normalizeModerationRules(null).rules).toEqual([]);
    const notArray = normalizeModerationRules("contributor_cap");
    expect(notArray.rules).toEqual([]);
    expect(notArray.warnings[0]).toMatch(/must be a list/);
  });

  it("accepts every known rule type", () => {
    const { rules, warnings } = normalizeModerationRules(["contributor_cap", "blacklist", "review_nag"]);
    expect(rules).toEqual(["contributor_cap", "blacklist", "review_nag"]);
    expect(warnings).toEqual([]);
  });

  it("drops unrecognized entries with a warning, keeping the valid ones", () => {
    const { rules, warnings } = normalizeModerationRules(["contributor_cap", "not-a-rule", 42, null]);
    expect(rules).toEqual(["contributor_cap"]);
    expect(warnings.length).toBe(3);
  });

  it("de-duplicates repeated rule types", () => {
    const { rules } = normalizeModerationRules(["blacklist", "blacklist", "review_nag"]);
    expect(rules).toEqual(["blacklist", "review_nag"]);
  });

  it("returns [] (not the default rule set) for an intentional empty array — an explicit opt-out-of-everything must survive, not be coerced back to a default", () => {
    expect(normalizeModerationRules([]).rules).toEqual([]);
  });
});

describe("normalizeModerationLabel (#selfhost-mod-engine)", () => {
  it("returns undefined for a non-string, empty, or whitespace-only value", () => {
    expect(normalizeModerationLabel(undefined)).toBeUndefined();
    expect(normalizeModerationLabel(null)).toBeUndefined();
    expect(normalizeModerationLabel(42)).toBeUndefined();
    expect(normalizeModerationLabel("")).toBeUndefined();
    expect(normalizeModerationLabel("   ")).toBeUndefined();
  });

  it("trims and returns a valid label", () => {
    expect(normalizeModerationLabel("  mod:custom  ")).toBe("mod:custom");
  });

  it("truncates an overlong label", () => {
    const long = "x".repeat(200);
    expect(normalizeModerationLabel(long)?.length).toBe(100);
  });
});

describe("resolveEffectiveModerationRules (#selfhost-mod-engine)", () => {
  const globalRules = ["contributor_cap", "blacklist", "review_nag"] as const;

  it("inherits the global list when no per-repo override is given", () => {
    expect(resolveEffectiveModerationRules(globalRules, undefined)).toEqual([...globalRules]);
    expect(resolveEffectiveModerationRules(globalRules, null)).toEqual([...globalRules]);
  });

  it("REPLACES (not unions) the global list with an explicit per-repo override", () => {
    expect(resolveEffectiveModerationRules(globalRules, ["blacklist"])).toEqual(["blacklist"]);
  });

  it("an explicit EMPTY per-repo override opts this repo out of every rule, distinct from 'inherit'", () => {
    expect(resolveEffectiveModerationRules(globalRules, [])).toEqual([]);
  });
});

describe("resolveModerationGateEnabled (#selfhost-mod-engine)", () => {
  it("'off' force-disables regardless of the global default", () => {
    expect(resolveModerationGateEnabled(true, "off")).toBe(false);
    expect(resolveModerationGateEnabled(false, "off")).toBe(false);
  });

  it("'enabled' still requires the global master switch", () => {
    expect(resolveModerationGateEnabled(true, "enabled")).toBe(true);
    expect(resolveModerationGateEnabled(false, "enabled")).toBe(false);
  });

  it("'inherit' defers to the global default", () => {
    expect(resolveModerationGateEnabled(true, "inherit")).toBe(true);
    expect(resolveModerationGateEnabled(false, "inherit")).toBe(false);
  });
});

describe("moderationTierForViolationCount (#selfhost-mod-engine)", () => {
  it("returns 'none' for a non-positive count", () => {
    expect(moderationTierForViolationCount(0, 5)).toBe("none");
    expect(moderationTierForViolationCount(-1, 5)).toBe("none");
  });

  it("returns 'warning' for 1..threshold-1", () => {
    expect(moderationTierForViolationCount(1, 5)).toBe("warning");
    expect(moderationTierForViolationCount(4, 5)).toBe("warning");
  });

  it("returns 'banned' at and above the threshold", () => {
    expect(moderationTierForViolationCount(5, 5)).toBe("banned");
    expect(moderationTierForViolationCount(6, 5)).toBe("banned");
  });

  it("degrades a malformed non-positive threshold to 'always banned once any violation exists' rather than throwing", () => {
    expect(moderationTierForViolationCount(1, 0)).toBe("banned");
    expect(moderationTierForViolationCount(1, -1)).toBe("banned");
  });
});

describe("constants + event-type map (#selfhost-mod-engine)", () => {
  it("default labels/threshold match the documented defaults", () => {
    expect(DEFAULT_MODERATION_WARNING_LABEL).toBe("mod:warning");
    expect(DEFAULT_MODERATION_BANNED_LABEL).toBe("mod:banned");
    expect(DEFAULT_MODERATION_BAN_THRESHOLD).toBe(5);
    expect(DEFAULT_GLOBAL_MODERATION_CONFIG.enabled).toBe(false);
    expect(DEFAULT_GLOBAL_MODERATION_CONFIG.violationDecayDays).toBeNull();
    expect(DEFAULT_GLOBAL_MODERATION_CONFIG.autoBlacklistOnBan).toBe(true);
  });

  it("every rule type has a distinct, namespaced event type", () => {
    const values = Object.values(MODERATION_VIOLATION_EVENT_TYPE);
    expect(new Set(values).size).toBe(values.length);
    for (const eventType of values) expect(eventType).toMatch(/^moderation\.violation\./);
  });
});
