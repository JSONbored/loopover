import { describe, expect, it } from "vitest";
import { resolveHardGuardrailGlobs } from "../../src/review/guardrail-config";

describe("resolveHardGuardrailGlobs", () => {
  it("does not invent path guardrails when effective settings omit hardGuardrailGlobs", () => {
    expect(resolveHardGuardrailGlobs(undefined)).toEqual([]);
    expect(resolveHardGuardrailGlobs(null)).toEqual([]);
    expect(resolveHardGuardrailGlobs({})).toEqual([]);
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: null })).toEqual([]);
  });

  it("returns a clone of the configured guardrail globs", () => {
    const configured = ["src/settings/**", ".github/workflows/**"];
    const resolved = resolveHardGuardrailGlobs({ hardGuardrailGlobs: configured });

    expect(resolved).toEqual(configured);
    expect(resolved).not.toBe(configured);

    resolved.push("mutated/**");
    expect(configured).toEqual(["src/settings/**", ".github/workflows/**"]);
  });

  it("preserves an explicit empty list as no path guardrails", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [] })).toEqual([]);
  });
});
