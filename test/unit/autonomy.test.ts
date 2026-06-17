import { describe, expect, it } from "vitest";
import {
  AGENT_ACTION_CLASSES,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_LEVEL,
  autonomyRequiresApproval,
  isActingAutonomyLevel,
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
