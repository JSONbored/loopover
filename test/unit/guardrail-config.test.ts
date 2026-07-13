import { describe, expect, it } from "vitest";
import {
  CONFIG_AS_CODE_GUARDRAIL_GLOBS,
  DEFAULT_HARD_GUARDRAIL_GLOBS,
  resolveHardGuardrailGlobs,
} from "../../src/review/guardrail-config";

describe("CONFIG_AS_CODE_GUARDRAIL_GLOBS (#4773 — dual-brand config filenames)", () => {
  it("guards both the new-brand .loopover.* config files and the legacy .gittensory.* ones", () => {
    for (const ext of ["yml", "yaml", "json"]) {
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.loopover.${ext}`);
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.github/loopover.${ext}`);
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.gittensory.${ext}`);
      expect(CONFIG_AS_CODE_GUARDRAIL_GLOBS).toContain(`.github/gittensory.${ext}`);
    }
  });
});

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
