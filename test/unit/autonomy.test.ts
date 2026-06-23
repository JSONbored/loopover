import { describe, expect, it } from "vitest";
import {
  AGENT_ACTION_CLASSES,
  AUTONOMY_LEVELS,
  AUTO_MERGE_METHODS,
  DEFAULT_AUTONOMY_LEVEL,
  DEFAULT_AUTO_MAINTAIN_POLICY,
  autonomyRequiresApproval,
  isActingAutonomyLevel,
  isAgentConfigured,
  normalizeAutoMaintainPolicy,
  normalizeAutonomyPolicy,
  resolveAutonomy,
} from "../../src/settings/autonomy";
import type { AutonomyPolicy } from "../../src/types";

describe("resolveAutonomy (#773 deny-by-default gate)", () => {
  it("returns the configured level for an action class", () => {
    const autonomy: AutonomyPolicy = { merge: "auto_with_approval", label: "auto" };
    expect(resolveAutonomy(autonomy, "merge")).toBe("auto_with_approval");
    expect(resolveAutonomy(autonomy, "label")).toBe("auto");
  });

  it("denies by default — an unset action class resolves to observe", () => {
    expect(resolveAutonomy({ merge: "auto" }, "close")).toBe("observe");
    expect(resolveAutonomy({}, "merge")).toBe(DEFAULT_AUTONOMY_LEVEL);
    expect(DEFAULT_AUTONOMY_LEVEL).toBe("observe");
  });

  it("denies by default for a null/undefined policy (no config at all)", () => {
    expect(resolveAutonomy(null, "merge")).toBe("observe");
    expect(resolveAutonomy(undefined, "review")).toBe("observe");
  });

  it("every action class resolves to observe under an empty policy", () => {
    for (const actionClass of AGENT_ACTION_CLASSES) {
      expect(resolveAutonomy({}, actionClass)).toBe("observe");
    }
  });
});

describe("autonomy level predicates", () => {
  it("isActingAutonomyLevel is true only for auto / auto_with_approval", () => {
    expect(isActingAutonomyLevel("auto")).toBe(true);
    expect(isActingAutonomyLevel("auto_with_approval")).toBe(true);
    expect(isActingAutonomyLevel("propose")).toBe(false);
    expect(isActingAutonomyLevel("suggest")).toBe(false);
    expect(isActingAutonomyLevel("observe")).toBe(false);
  });

  it("autonomyRequiresApproval is true only for auto_with_approval", () => {
    expect(autonomyRequiresApproval("auto_with_approval")).toBe(true);
    expect(autonomyRequiresApproval("auto")).toBe(false);
    expect(autonomyRequiresApproval("observe")).toBe(false);
  });

  it("the level ladder is ordered observe → … → auto with observe at the floor", () => {
    expect(AUTONOMY_LEVELS[0]).toBe("observe");
    expect(AUTONOMY_LEVELS[AUTONOMY_LEVELS.length - 1]).toBe("auto");
    expect(AUTONOMY_LEVELS).toEqual(["observe", "suggest", "propose", "auto_with_approval", "auto"]);
  });
});

describe("normalizeAutonomyPolicy", () => {
  it("keeps only known action classes mapped to known levels", () => {
    expect(normalizeAutonomyPolicy({ merge: "auto", review: "suggest" })).toEqual({ merge: "auto", review: "suggest" });
  });

  it("drops unknown action classes and unknown levels (deny-by-omission)", () => {
    expect(
      normalizeAutonomyPolicy({ merge: "auto", deploy: "auto", close: "rampage", label: 7 }),
    ).toEqual({ merge: "auto" });
  });

  it("returns an empty policy for non-object / array / null input", () => {
    expect(normalizeAutonomyPolicy(null)).toEqual({});
    expect(normalizeAutonomyPolicy("auto")).toEqual({});
    expect(normalizeAutonomyPolicy(["merge"])).toEqual({});
    expect(normalizeAutonomyPolicy(undefined)).toEqual({});
  });

  it("round-trips a valid policy through normalization", () => {
    const policy: AutonomyPolicy = { review: "propose", request_changes: "auto_with_approval", merge: "observe" };
    expect(normalizeAutonomyPolicy(policy)).toEqual(policy);
  });
});

describe("normalizeAutoMaintainPolicy (#774)", () => {
  it("fills conservative defaults (squash / 1 approval) for missing or non-object input", () => {
    expect(normalizeAutoMaintainPolicy({})).toEqual({ requireApprovals: 1, mergeMethod: "squash" });
    expect(normalizeAutoMaintainPolicy(null)).toEqual(DEFAULT_AUTO_MAINTAIN_POLICY);
    expect(normalizeAutoMaintainPolicy("nope")).toEqual(DEFAULT_AUTO_MAINTAIN_POLICY);
    expect(normalizeAutoMaintainPolicy([1])).toEqual(DEFAULT_AUTO_MAINTAIN_POLICY);
  });

  it("keeps valid fields and round-trips a full policy", () => {
    expect(normalizeAutoMaintainPolicy({ requireApprovals: 2, mergeMethod: "rebase" })).toEqual({ requireApprovals: 2, mergeMethod: "rebase" });
  });

  it("clamps requireApprovals to [0,10] and truncates, and rejects an invalid merge method", () => {
    expect(normalizeAutoMaintainPolicy({ requireApprovals: -3, mergeMethod: "foo" })).toEqual({ requireApprovals: 0, mergeMethod: "squash" });
    expect(normalizeAutoMaintainPolicy({ requireApprovals: 99 }).requireApprovals).toBe(10);
    expect(normalizeAutoMaintainPolicy({ requireApprovals: 2.9 }).requireApprovals).toBe(2);
    expect(normalizeAutoMaintainPolicy({ requireApprovals: "two" }).requireApprovals).toBe(1); // non-number → default
  });

  it("AUTO_MERGE_METHODS is the closed set merge/squash/rebase", () => {
    expect(AUTO_MERGE_METHODS).toEqual(["merge", "squash", "rebase"]);
  });
});

describe("isAgentConfigured (#777 opt-in detection)", () => {
  it("is true when any action class has an acting level", () => {
    expect(isAgentConfigured({ merge: "auto" })).toBe(true);
    expect(isAgentConfigured({ label: "auto_with_approval" })).toBe(true);
    expect(isAgentConfigured({ review: "suggest", close: "auto" })).toBe(true);
  });

  it("is false for the deny-by-default floor (all observe / non-acting / empty / null)", () => {
    expect(isAgentConfigured({ merge: "observe", review: "suggest", approve: "propose" })).toBe(false);
    expect(isAgentConfigured({})).toBe(false);
    expect(isAgentConfigured(null)).toBe(false);
    expect(isAgentConfigured(undefined)).toBe(false);
  });
});
