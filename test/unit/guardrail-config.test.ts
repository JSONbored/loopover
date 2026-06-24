import { describe, expect, it, vi } from "vitest";
import { matchesAny } from "../../src/signals/change-guardrail";
import { CONFIG_AS_CODE_GUARDRAIL_GLOBS, DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, FAIL_CLOSED_GUARDRAIL_GLOBS, loadHardGuardrailGlobs } from "../../src/review/guardrail-config";

function envWith(get: (key: string, type: string) => Promise<unknown>): Env {
  return { REVIEW_CONFIG: { get } } as unknown as Env;
}

describe("loadHardGuardrailGlobs", () => {
  it("returns the conservative default plus the config-as-code guards when REVIEW_CONFIG is unbound", async () => {
    expect(await loadHardGuardrailGlobs({} as Env, "JSONbored/gittensory")).toEqual([...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ...CONFIG_AS_CODE_GUARDRAIL_GLOBS]);
  });

  it("reads globs from KV keyed by the repo slug (owner stripped) and always appends the config-as-code guards", async () => {
    const get = vi.fn().mockResolvedValue({ hardGuardrailGlobs: ["src/scoring/**", "scripts/**"] });
    const globs = await loadHardGuardrailGlobs(envWith(get), "JSONbored/gittensory");
    expect(globs).toEqual(["src/scoring/**", "scripts/**", ...CONFIG_AS_CODE_GUARDRAIL_GLOBS]);
    expect(get).toHaveBeenCalledWith("gittensory", "json");
  });

  it("falls back to the default (plus config-as-code guards) when the field is absent, null, or empty", async () => {
    const expected = [...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ...CONFIG_AS_CODE_GUARDRAIL_GLOBS];
    expect(await loadHardGuardrailGlobs(envWith(async () => ({})), "o/r")).toEqual(expected);
    expect(await loadHardGuardrailGlobs(envWith(async () => null), "o/r")).toEqual(expected);
    expect(await loadHardGuardrailGlobs(envWith(async () => ({ hardGuardrailGlobs: [] })), "o/r")).toEqual(expected);
  });

  it("drops non-string entries and keeps the valid globs (plus config-as-code guards)", async () => {
    const globs = await loadHardGuardrailGlobs(envWith(async () => ({ hardGuardrailGlobs: [123, "scripts/**", ""] })), "o/r");
    expect(globs).toEqual(["scripts/**", ...CONFIG_AS_CODE_GUARDRAIL_GLOBS]);
  });

  it("guards the gate's own policy files for every repo (the config-as-code self-weakening hole)", async () => {
    const globs = await loadHardGuardrailGlobs(envWith(async () => ({ hardGuardrailGlobs: ["src/**"] })), "o/r");
    for (const policyFile of [".gittensory.yml", ".github/gittensory.json", "codecov.yml", ".github/codecov.yml"]) {
      expect(matchesAny(policyFile, globs)).toBe(true);
    }
    expect(matchesAny("src/utils/json.ts", globs)).toBe(true); // the repo's own KV glob still applies
    expect(matchesAny("README.md", globs)).toBe(false); // an unrelated file is still auto-mergeable
  });

  it("fails CLOSED (guard everything) when the KV read throws — an outage must never open the gate", async () => {
    const globs = await loadHardGuardrailGlobs(
      envWith(async () => {
        throw new Error("kv down");
      }),
      "o/r",
    );
    expect(globs).toEqual(FAIL_CLOSED_GUARDRAIL_GLOBS); // ["**"] → every path held for human review
    expect(globs).not.toEqual(DEFAULT_CRUCIAL_GUARDRAIL_GLOBS);
  });

  it("uses the whole name as the slug when there is no owner prefix", async () => {
    const get = vi.fn().mockResolvedValue({ hardGuardrailGlobs: ["a/**"] });
    await loadHardGuardrailGlobs(envWith(get), "soloname");
    expect(get).toHaveBeenCalledWith("soloname", "json");
  });
});
