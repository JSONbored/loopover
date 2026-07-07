import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARD_GUARDRAIL_GLOBS,
  resolveHardGuardrailGlobs,
} from "../../src/review/guardrail-config";

describe("resolveHardGuardrailGlobs", () => {
  it("uses invariant guardrails when effective settings omit hardGuardrailGlobs", () => {
    expect(resolveHardGuardrailGlobs(undefined)).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs(null)).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({})).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: null })).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
  });

  it("adds configured guardrail globs without allowing them to replace invariants", () => {
    const configured = ["src/custom/**", ".github/workflows/**"];
    const resolved = resolveHardGuardrailGlobs({ hardGuardrailGlobs: configured });

    expect(resolved).toEqual([...DEFAULT_HARD_GUARDRAIL_GLOBS, "src/custom/**"]);
    expect(resolved).not.toBe(configured);

    resolved.push("mutated/**");
    expect(configured).toEqual(["src/custom/**", ".github/workflows/**"]);
  });

  it("keeps invariant guardrails when configured globs are explicitly empty", () => {
    expect(resolveHardGuardrailGlobs({ hardGuardrailGlobs: [] })).toEqual(DEFAULT_HARD_GUARDRAIL_GLOBS);
  });
});
