import { describe, expect, it } from "vitest";
import {
  CONFIG_AS_CODE_GUARDRAIL_GLOBS,
  DEFAULT_HARD_GUARDRAIL_GLOBS,
  ENGINE_DECISION_GUARDRAIL_GLOBS,
  resolveHardGuardrailGlobs,
} from "../../src/review/guardrail-config";
import { isGuardrailHit } from "../../src/signals/change-guardrail";

describe("CONFIG_AS_CODE_GUARDRAIL_GLOBS", () => {
  it("guards the .loopover.* config files", () => {
    for (const ext of ["yml", "yaml", "json"]) {
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.loopover.${ext}`);
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.github/loopover.${ext}`);
    }
  });
});

// #8012: src/settings/autonomy.ts and src/review/guardrail-config.ts (the #6203-era migration's pre-migration
// paths, still listed above for their own sake) are now 5-line re-export shims -- the real, substantive logic
// a contributor PR could edit lives at the packages/loopover-engine paths below. A PR touching only the real
// path, never the shim, must still trip the guardrail.
describe("ENGINE_DECISION_GUARDRAIL_GLOBS — post-#6203-migration real paths (#8012)", () => {
  it("lists both the real autonomy.ts and guardrail-config.ts engine-package paths, alongside their src/ shims", () => {
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("packages/loopover-engine/src/settings/autonomy.ts");
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("src/settings/autonomy.ts");
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("packages/loopover-engine/src/review/guardrail-config.ts");
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("src/review/guardrail-config.ts");
  });

  it("a PR touching only the real autonomy.ts path (never its shim) still trips the hard guardrail", () => {
    expect(isGuardrailHit(["packages/loopover-engine/src/settings/autonomy.ts"], DEFAULT_HARD_GUARDRAIL_GLOBS)).toBe(true);
  });

  it("a PR touching only the real guardrail-config.ts path (never its shim) still trips the hard guardrail", () => {
    expect(isGuardrailHit(["packages/loopover-engine/src/review/guardrail-config.ts"], DEFAULT_HARD_GUARDRAIL_GLOBS)).toBe(true);
  });
});

// #8698: the guardrail-matching engine itself (change-guardrail.ts), the gate-decision advisory core
// (gate-advisory.ts), and the predicted-gate orchestrator were never listed -- a self-referential blind spot,
// since a PR weakening exactly those files would not itself trip the hard guardrail. Each must now be a hit.
describe("ENGINE_DECISION_GUARDRAIL_GLOBS — guardrail engine + gate-advisory/predicted-gate self-protection (#8698)", () => {
  it("lists the guardrail-matching engine, the gate-advisory core, and the predicted-gate orchestrator", () => {
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("packages/loopover-engine/src/signals/change-guardrail.ts");
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("packages/loopover-engine/src/advisory/gate-advisory.ts");
    expect(ENGINE_DECISION_GUARDRAIL_GLOBS).toContain("packages/loopover-engine/src/predicted-gate.ts");
  });

  it("a PR touching only the guardrail-matching engine trips the hard guardrail", () => {
    expect(isGuardrailHit(["packages/loopover-engine/src/signals/change-guardrail.ts"], resolveHardGuardrailGlobs(null))).toBe(
      true,
    );
  });

  it("a PR touching only the gate-advisory core trips the hard guardrail", () => {
    expect(isGuardrailHit(["packages/loopover-engine/src/advisory/gate-advisory.ts"], resolveHardGuardrailGlobs(null))).toBe(true);
  });

  it("a PR touching only the predicted-gate orchestrator trips the hard guardrail", () => {
    expect(isGuardrailHit(["packages/loopover-engine/src/predicted-gate.ts"], resolveHardGuardrailGlobs(null))).toBe(true);
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
