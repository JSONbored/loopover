import { describe, expect, it } from "vitest";
import { DEFAULT_COPYCAT_GATE_MODE_FOR_REGISTERED_REPO, resolveEffectiveCopycatGateMode } from "../../src/settings/copycat-gate-mode";

// #9033: copycatGateMode's absent-value fallback used to be a flat "off" for every repo (config-as-code only, no
// DB column), so a reward-eligible repo got zero copycat/reward-farming protection unless it explicitly opted in
// via its own .loopover.yml. resolveEffectiveCopycatGateMode flips the DEFAULT (never an explicit choice) for a
// reward-eligible (subnet-registered) repo.
describe("resolveEffectiveCopycatGateMode (#9033)", () => {
  it("resolves the reward-eligible default (warn) when the mode is undefined and the repo is registered", () => {
    expect(resolveEffectiveCopycatGateMode(undefined, true)).toBe("warn");
    expect(resolveEffectiveCopycatGateMode(undefined, true)).toBe(DEFAULT_COPYCAT_GATE_MODE_FOR_REGISTERED_REPO);
  });

  it("resolves the reward-eligible default (warn) when the mode is null and the repo is registered", () => {
    expect(resolveEffectiveCopycatGateMode(null, true)).toBe("warn");
  });

  it("keeps the legacy off default when the mode is unset and the repo is NOT registered", () => {
    expect(resolveEffectiveCopycatGateMode(undefined, false)).toBe("off");
    expect(resolveEffectiveCopycatGateMode(null, false)).toBe("off");
  });

  it("an explicit off ALWAYS wins over the reward-eligible default -- config-as-code opt-out is never overridden", () => {
    expect(resolveEffectiveCopycatGateMode("off", true)).toBe("off");
    expect(resolveEffectiveCopycatGateMode("off", false)).toBe("off");
  });

  it("an explicit warn/label/block ALWAYS wins regardless of registration status", () => {
    for (const mode of ["warn", "label", "block"] as const) {
      expect(resolveEffectiveCopycatGateMode(mode, true)).toBe(mode);
      expect(resolveEffectiveCopycatGateMode(mode, false)).toBe(mode);
    }
  });
});
