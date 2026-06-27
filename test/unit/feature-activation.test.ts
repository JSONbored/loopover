import { describe, expect, it } from "vitest";
import { convergedFeatureActive, resolveConvergedFeature } from "../../src/review/feature-activation";
import { CONVERGED_FEATURE_KEYS, type ConvergedFeatureKey, type FocusManifest } from "../../src/signals/focus-manifest";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const REPO = "JSONbored/gittensory";

// The global env flag (master kill-switch) name for each feature, so a test can flip exactly one feature on.
const FLAG: Record<ConvergedFeatureKey, string> = {
  rag: "GITTENSORY_REVIEW_RAG",
  reputation: "GITTENSORY_REVIEW_REPUTATION",
  unifiedComment: "GITTENSORY_REVIEW_UNIFIED_COMMENT",
  safety: "GITTENSORY_REVIEW_SAFETY",
};

function env(overrides: Record<string, string | undefined>): Env {
  return overrides as unknown as Env;
}
function manifestWith(features: Partial<Record<ConvergedFeatureKey, boolean>>): Pick<FocusManifest, "features"> {
  const base = { present: false, rag: null, reputation: null, unifiedComment: null, safety: null } as FocusManifest["features"];
  return { features: { ...base, ...features, present: Object.keys(features).length > 0 } };
}

describe("resolveConvergedFeature — env kill-switch → per-repo override → allowlist default", () => {
  it("returns false when the global env flag is off, regardless of a per-repo override or the allowlist", () => {
    // flag off, override true, repo allowlisted → still off (kill-switch wins).
    expect(resolveConvergedFeature(env({ GITTENSORY_REVIEW_REPOS: REPO }), manifestWith({ rag: true }), "rag", REPO)).toBe(false);
  });

  it("honors an explicit per-repo override (true) even when the repo is NOT in the allowlist", () => {
    expect(resolveConvergedFeature(env({ GITTENSORY_REVIEW_RAG: "true" }), manifestWith({ rag: true }), "rag", REPO)).toBe(true);
  });

  it("honors an explicit per-repo override (false) even when the repo IS in the allowlist", () => {
    const e = env({ GITTENSORY_REVIEW_RAG: "true", GITTENSORY_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(e, manifestWith({ rag: false }), "rag", REPO)).toBe(false);
  });

  it("falls back to the GITTENSORY_REVIEW_REPOS allowlist when the manifest sets nothing (back-compat default)", () => {
    const on = env({ GITTENSORY_REVIEW_RAG: "true", GITTENSORY_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(on, manifestWith({}), "rag", REPO)).toBe(true); // allowlisted → default on
    expect(resolveConvergedFeature(on, null, "rag", REPO)).toBe(true); // null manifest tolerated
    const off = env({ GITTENSORY_REVIEW_RAG: "true", GITTENSORY_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(off, manifestWith({}), "rag", REPO)).toBe(false); // not allowlisted → default off
  });

  it("maps every converged feature key to its own global flag (one flag on never activates another feature)", () => {
    for (const key of CONVERGED_FEATURE_KEYS) {
      const e = env({ [FLAG[key]]: "true", GITTENSORY_REVIEW_REPOS: REPO });
      expect(resolveConvergedFeature(e, manifestWith({}), key, REPO)).toBe(true); // its own flag activates it
      // A different feature stays off (its flag is unset), proving no cross-wiring.
      const other = CONVERGED_FEATURE_KEYS.find((k) => k !== key)!;
      expect(resolveConvergedFeature(e, manifestWith({}), other, REPO)).toBe(false);
    }
  });
});

describe("convergedFeatureActive — async (loads the cached manifest)", () => {
  it("short-circuits to false WITHOUT loading the manifest when the env flag is off", async () => {
    // DB-less env: if it tried to load the manifest it would throw; returning false proves the short-circuit.
    expect(await convergedFeatureActive({} as Env, REPO, "rag")).toBe(false);
  });

  it("loads the manifest and applies a per-repo override (override beats the allowlist)", async () => {
    const e = createTestEnv({ GITTENSORY_REVIEW_RAG: "true", GITTENSORY_REVIEW_REPOS: REPO });
    // Allowlisted (default would be ON) but the per-repo manifest forces it OFF.
    await upsertRepoFocusManifest(e, REPO, { features: { rag: false } });
    expect(await convergedFeatureActive(e, REPO, "rag")).toBe(false);
  });

  it("falls back to the allowlist default when no manifest is published", async () => {
    const e = createTestEnv({ GITTENSORY_REVIEW_RAG: "true", GITTENSORY_REVIEW_REPOS: REPO });
    expect(await convergedFeatureActive(e, REPO, "rag")).toBe(true);
  });
});
