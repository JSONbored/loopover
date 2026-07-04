import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARD_GUARDRAIL_GLOBS,
  resolveHardGuardrailGlobs,
} from "../../src/review/guardrail-config";

describe("resolveHardGuardrailGlobs", () => {
  it("falls back to built-in guardrails when effective settings omit hardGuardrailGlobs", () => {
    expect(resolveHardGuardrailGlobs(undefined)).toEqual(
      DEFAULT_HARD_GUARDRAIL_GLOBS,
    );
    expect(resolveHardGuardrailGlobs(null)).toEqual(
      DEFAULT_HARD_GUARDRAIL_GLOBS,
    );
    expect(resolveHardGuardrailGlobs({})).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: null })).toEqual(
      DEFAULT_HARD_GUARDRAIL_GLOBS,
    );
  });

  it("returns a clone of the built-in guardrail globs", () => {
    const resolved = resolveHardGuardrailGlobs(undefined);

    expect(resolved).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolved).not.toBe(DEFAULT_HARD_GUARDRAIL_GLOBS);

    resolved.push("mutated/**");
    expect(DEFAULT_HARD_GUARDRAIL_GLOBS).not.toContain("mutated/**");
  });

  it("returns a clone of the configured guardrail globs", () => {
    const configured = ["src/settings/**", ".github/workflows/**"];
    const resolved = resolveHardGuardrailGlobs({
      hardGuardrailGlobs: configured,
    });

    expect(resolved).toEqual(configured);
    expect(resolved).not.toBe(configured);

    resolved.push("mutated/**");
    expect(configured).toEqual(["src/settings/**", ".github/workflows/**"]);
  });

  it("preserves an explicit empty list as no path guardrails", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [] })).toEqual([]);
  });
});
