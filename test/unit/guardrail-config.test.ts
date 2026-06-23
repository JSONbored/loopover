import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, loadHardGuardrailGlobs } from "../../src/review/guardrail-config";

function envWith(get: (key: string, type: string) => Promise<unknown>): Env {
  return { REVIEW_CONFIG: { get } } as unknown as Env;
}

describe("loadHardGuardrailGlobs", () => {
  it("returns the conservative default when REVIEW_CONFIG is unbound", async () => {
    expect(await loadHardGuardrailGlobs({} as Env, "JSONbored/gittensory")).toEqual(DEFAULT_CRUCIAL_GUARDRAIL_GLOBS);
  });

  it("uses the legacy full-name key before the slug fallback when no installation-scoped key exists", async () => {
    const get = vi.fn().mockResolvedValue({ hardGuardrailGlobs: ["src/scoring/**", "scripts/**"] });
    const globs = await loadHardGuardrailGlobs(envWith(get), "JSONbored/gittensory");
    expect(globs).toEqual(["src/scoring/**", "scripts/**"]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenNthCalledWith(1, "jsonbored/gittensory", "json");
  });

  it("prefers the installation-scoped key to avoid cross-tenant bleed on same-slug repos", async () => {
    const get = vi.fn(async (key: string) => {
      if (key === "installation:42:gittensory") return { hardGuardrailGlobs: ["tenant-a/**"] };
      if (key === "gittensory") return { hardGuardrailGlobs: ["legacy-shared/**"] };
      return null;
    });
    const globs = await loadHardGuardrailGlobs(envWith(get), "JSONbored/gittensory", 42);
    expect(globs).toEqual(["tenant-a/**"]);
    expect(get).toHaveBeenNthCalledWith(1, "installation:42:jsonbored/gittensory", "json");
    expect(get).toHaveBeenNthCalledWith(2, "installation:42:gittensory", "json");
  });

  it("falls back to the default when the field is absent, null, or empty", async () => {
    expect(await loadHardGuardrailGlobs(envWith(async () => ({})), "o/r")).toEqual(DEFAULT_CRUCIAL_GUARDRAIL_GLOBS);
    expect(await loadHardGuardrailGlobs(envWith(async () => null), "o/r")).toEqual(DEFAULT_CRUCIAL_GUARDRAIL_GLOBS);
    expect(await loadHardGuardrailGlobs(envWith(async () => ({ hardGuardrailGlobs: [] })), "o/r")).toEqual(DEFAULT_CRUCIAL_GUARDRAIL_GLOBS);
  });

  it("drops non-string entries and keeps the valid globs", async () => {
    const globs = await loadHardGuardrailGlobs(envWith(async () => ({ hardGuardrailGlobs: [123, "scripts/**", ""] })), "o/r");
    expect(globs).toEqual(["scripts/**"]);
  });

  it("fails safe to the default when the KV read throws", async () => {
    const globs = await loadHardGuardrailGlobs(
      envWith(async () => {
        throw new Error("kv down");
      }),
      "o/r",
    );
    expect(globs).toEqual(DEFAULT_CRUCIAL_GUARDRAIL_GLOBS);
  });

  it("uses the whole name as the slug when there is no owner prefix", async () => {
    const get = vi.fn().mockResolvedValue({ hardGuardrailGlobs: ["a/**"] });
    await loadHardGuardrailGlobs(envWith(get), "soloname");
    expect(get).toHaveBeenCalledWith("soloname", "json");
  });
});
