import { describe, expect, it } from "vitest";
import { isGuardrailHit } from "../../src/signals/change-guardrail";
import {
  CONFIG_AS_CODE_GUARDRAIL_GLOBS,
  DEFAULT_HARD_GUARDRAIL_GLOBS,
  ENGINE_DECISION_GUARDRAIL_GLOBS,
  resolveHardGuardrailGlobs,
} from "../../src/review/guardrail-config";

describe("CONFIG_AS_CODE_GUARDRAIL_GLOBS", () => {
  it("guards the .loopover.* config files", () => {
    for (const ext of ["yml", "yaml", "json"]) {
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.loopover.${ext}`);
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.github/loopover.${ext}`);
    }
  });
});

describe("ENGINE_DECISION_GUARDRAIL_GLOBS (#8012)", () => {
  it("guards the real post-#6203 packages/loopover-engine paths, not just the pre-migration src/ shims", () => {
    // The regression this guards against: a PR editing the autonomy deny-by-default dial, or editing
    // ENGINE_DECISION_GUARDRAIL_GLOBS/DEFAULT_HARD_GUARDRAIL_GLOBS itself to quietly remove entries, touches
    // only the real engine-package file and never the 5-line shim -- so it must still trip the guardrail.
    const realPaths = [
      "packages/loopover-engine/src/settings/autonomy.ts",
      "packages/loopover-engine/src/review/guardrail-config.ts",
    ];
    for (const path of realPaths) {
      expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain(path);
      expect(isGuardrailHit([path], DEFAULT_HARD_GUARDRAIL_GLOBS)).toBe(true);
    }
  });

  it("still guards the pre-migration shim paths too (both are listed deliberately, neither replaces the other)", () => {
    expect(isGuardrailHit(["src/settings/autonomy.ts"], DEFAULT_HARD_GUARDRAIL_GLOBS)).toBe(true);
    expect(isGuardrailHit(["src/review/guardrail-config.ts"], DEFAULT_HARD_GUARDRAIL_GLOBS)).toBe(true);
  });
});

describe("resolveHardGuardrailGlobs", () => {
  it("uses invariant guardrails when effective settings omit hardGuardrailGlobs", () => {
    expect(resolveHardGuardrailGlobs(undefined)).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs(null)).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({})).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: null })).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
  });

  it("adds configured guardrail globs without allowing them to replace invariants by default", () => {
    const configured = ["src/custom/**", ".github/workflows/**"];
    const resolved = resolveHardGuardrailGlobs({ hardGuardrailGlobs: configured });

    expect(resolved).toEqual([...DEFAULT_HARD_GUARDRAIL_GLOBS, "src/custom/**"]);
    expect(resolved).not.toBe(configured);

    resolved.push("mutated/**");
    expect(configured).toEqual(["src/custom/**", ".github/workflows/**"]);
  });

  it("keeps invariant guardrails when configured globs are explicitly empty and override is not set", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [] })).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [], hardGuardrailGlobsOverridesInvariants: false })).toEqual(
      DEFAULT_HARD_GUARDRAIL_GLOBS,
    );
  });

  it("REPLACES (not adds to) invariants when hardGuardrailGlobsOverridesInvariants is true", () => {
    const configured = ["src/custom/**"];
    const resolved = resolveHardGuardrailGlobs({ hardGuardrailGlobs: configured, hardGuardrailGlobsOverridesInvariants: true });

    expect(resolved).toEqual(["src/custom/**"]);
    expect(resolved).not.toContain(".github/workflows/**");
    expect(resolved).not.toBe(configured);

    resolved.push("mutated/**");
    expect(configured).toEqual(["src/custom/**"]);
  });

  it("disables path guardrails entirely when override is true and configured globs are explicitly empty", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [], hardGuardrailGlobsOverridesInvariants: true })).toEqual([]);
  });

  it("returns an empty list when override is true but hardGuardrailGlobs itself is unset", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobsOverridesInvariants: true })).toEqual([]);
  });
});
