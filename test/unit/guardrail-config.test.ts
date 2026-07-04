import { describe, expect, it } from "vitest";
import { DEFAULT_HARD_GUARDRAIL_GLOBS, resolveHardGuardrailGlobs } from "../../src/review/guardrail-config";

describe("resolveHardGuardrailGlobs", () => {
  it("defaults to built-in safety guardrails when effective settings omit hardGuardrailGlobs", () => {
    expect(resolveHardGuardrailGlobs(undefined)).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs(null)).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({})).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: null })).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
  });

  it("returns a clone of the configured guardrail globs", () => {
    const configured = ["src/settings/**", ".github/workflows/**"];
    const resolved = resolveHardGuardrailGlobs({ hardGuardrailGlobs: configured });

    expect(resolved).toEqual(configured);
    expect(resolved).not.toBe(configured);

    resolved.push("mutated/**");
    expect(configured).toEqual(["src/settings/**", ".github/workflows/**"]);
  });

  it("preserves an explicit empty list as the only no-guardrail opt-out", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [] })).toEqual([]);
  });
});
