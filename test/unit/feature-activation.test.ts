import { describe, expect, it } from "vitest";
import { convergedFeatureActive, resolveConvergedFeature, resolveFeatureActivation, resolveManifestOnlyFeature, type FeatureActivationMode } from "../../src/review/feature-activation";
import { CONVERGED_FEATURE_KEYS, type ConvergedFeatureKey, type FocusManifest } from "../../src/signals/focus-manifest";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const REPO = "JSONbored/gittensory";

// The global env flag (master kill-switch) name for each feature, so a test can flip exactly one feature on.
const FLAG: Record<ConvergedFeatureKey, string> = {
  rag: "LOOPOVER_REVIEW_RAG",
  reputation: "LOOPOVER_REVIEW_REPUTATION",
  unifiedComment: "LOOPOVER_REVIEW_UNIFIED_COMMENT",
  safety: "LOOPOVER_REVIEW_SAFETY",
  grounding: "LOOPOVER_REVIEW_GROUNDING",
  e2eTests: "LOOPOVER_REVIEW_E2E_TESTS",
  screenshots: "LOOPOVER_REVIEW_SCREENSHOTS",
  improvementSignal: "LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL",
};

function env(overrides: Record<string, string | undefined>): Env {
  return overrides as unknown as Env;
}
function manifestWith(features: Partial<Record<ConvergedFeatureKey, boolean>>): Pick<FocusManifest, "features"> {
  const base = {
    present: false,
    rag: null,
    reputation: null,
    unifiedComment: null,
    safety: null,
    grounding: null,
    e2eTests: null,
    screenshots: null,
    improvementSignal: null,
  } as FocusManifest["features"];
  return { features: { ...base, ...features, present: Object.keys(features).length > 0 } };
}

// ── resolveFeatureActivation (#4616) — the single pure core every mode below reduces to ──────────────────────

describe("resolveFeatureActivation — the shared pure core (#4616)", () => {
  it("the master kill-switch wins outright regardless of mode, override, or allowlist", () => {
    const modes: FeatureActivationMode[] = ["standard", "forceOnOnly", "allowlistRequired", "manifestOnly"];
    for (const mode of modes) {
      expect(resolveFeatureActivation(false, true, true, mode)).toBe(false);
      expect(resolveFeatureActivation(false, null, true, mode)).toBe(false);
      expect(resolveFeatureActivation(false, false, false, mode)).toBe(false);
    }
  });

  describe('mode "standard"', () => {
    it("an explicit override fully controls in both directions", () => {
      expect(resolveFeatureActivation(true, true, false, "standard")).toBe(true); // override bypasses a non-allowlisted repo
      expect(resolveFeatureActivation(true, false, true, "standard")).toBe(false); // override forces off an allowlisted repo
    });
    it("falls back to the allowlist when override is unset (null)", () => {
      expect(resolveFeatureActivation(true, null, true, "standard")).toBe(true);
      expect(resolveFeatureActivation(true, null, false, "standard")).toBe(false);
    });
  });

  describe('mode "forceOnOnly" (safety\'s shape, #2269)', () => {
    it("override can force ON even when NOT allowlisted", () => {
      expect(resolveFeatureActivation(true, true, false, "forceOnOnly")).toBe(true);
    });
    it("override=false is downgraded to \"no opinion\" — falls through to the allowlist instead of forcing off", () => {
      expect(resolveFeatureActivation(true, false, true, "forceOnOnly")).toBe(true); // allowlisted wins despite override=false
      expect(resolveFeatureActivation(true, false, false, "forceOnOnly")).toBe(false); // not allowlisted either ⇒ off
    });
    it("unset override falls back to the allowlist, same as standard", () => {
      expect(resolveFeatureActivation(true, null, true, "forceOnOnly")).toBe(true);
      expect(resolveFeatureActivation(true, null, false, "forceOnOnly")).toBe(false);
    });
  });

  describe('mode "allowlistRequired" (grounding\'s shape)', () => {
    it("the allowlist is a hard requirement — override=true can NEVER bypass it", () => {
      expect(resolveFeatureActivation(true, true, false, "allowlistRequired")).toBe(false);
    });
    it("within an allowlisted repo, override may additionally force OFF", () => {
      expect(resolveFeatureActivation(true, false, true, "allowlistRequired")).toBe(false);
      expect(resolveFeatureActivation(true, null, true, "allowlistRequired")).toBe(true);
      expect(resolveFeatureActivation(true, true, true, "allowlistRequired")).toBe(true);
    });
  });

  describe('mode "manifestOnly" (the five review:-block features, #4616)', () => {
    it("there is no allowlist role at all — an allowlisted repo with no override still stays off", () => {
      expect(resolveFeatureActivation(true, null, true, "manifestOnly")).toBe(false);
    });
    it("an explicit override===true is the only way to activate, allowlist status notwithstanding", () => {
      expect(resolveFeatureActivation(true, true, false, "manifestOnly")).toBe(true);
      expect(resolveFeatureActivation(true, true, true, "manifestOnly")).toBe(true);
    });
    it("override===false stays off exactly like unset (both are \"not explicitly true\")", () => {
      expect(resolveFeatureActivation(true, false, true, "manifestOnly")).toBe(false);
      expect(resolveFeatureActivation(true, false, false, "manifestOnly")).toBe(false);
    });
  });
});

// ── resolveManifestOnlyFeature (#4616) — the thin review:-block adapter over the core above ──────────────────

describe("resolveManifestOnlyFeature — env kill-switch AND an explicit manifest opt-in, no allowlist role", () => {
  it("requires BOTH the global flag and an explicit override===true", () => {
    expect(resolveManifestOnlyFeature(true, true)).toBe(true);
  });
  it("is OFF when the flag is on but the override is unset (undefined) or absent (null)", () => {
    expect(resolveManifestOnlyFeature(true, undefined)).toBe(false);
    expect(resolveManifestOnlyFeature(true, null)).toBe(false);
  });
  it("is OFF when the override is explicitly true but the global flag is off (a repo cannot self-enable)", () => {
    expect(resolveManifestOnlyFeature(false, true)).toBe(false);
  });
  it("is OFF when the override is explicitly false", () => {
    expect(resolveManifestOnlyFeature(true, false)).toBe(false);
  });
});

describe("resolveConvergedFeature — env kill-switch → per-repo override → allowlist default", () => {
  it("returns false when the global env flag is off, regardless of a per-repo override or the allowlist", () => {
    // flag off, override true, repo allowlisted → still off (kill-switch wins).
    expect(resolveConvergedFeature(env({ LOOPOVER_REVIEW_REPOS: REPO }), manifestWith({ rag: true }), "rag", REPO)).toBe(false);
  });

  it("honors an explicit per-repo override (true) even when the repo is NOT in the allowlist", () => {
    expect(resolveConvergedFeature(env({ LOOPOVER_REVIEW_RAG: "true" }), manifestWith({ rag: true }), "rag", REPO)).toBe(true);
  });

  it("honors an explicit per-repo override (false) even when the repo IS in the allowlist", () => {
    const e = env({ LOOPOVER_REVIEW_RAG: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(e, manifestWith({ rag: false }), "rag", REPO)).toBe(false);
  });

  it("falls back to the LOOPOVER_REVIEW_REPOS allowlist when the manifest sets nothing (back-compat default)", () => {
    const on = env({ LOOPOVER_REVIEW_RAG: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(on, manifestWith({}), "rag", REPO)).toBe(true); // allowlisted → default on
    expect(resolveConvergedFeature(on, null, "rag", REPO)).toBe(true); // null manifest tolerated
    const off = env({ LOOPOVER_REVIEW_RAG: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(off, manifestWith({}), "rag", REPO)).toBe(false); // not allowlisted → default off
  });

  it("maps every converged feature key to its own global flag (one flag on never activates another feature)", () => {
    for (const key of CONVERGED_FEATURE_KEYS) {
      const e = env({ [FLAG[key]]: "true", LOOPOVER_REVIEW_REPOS: REPO });
      expect(resolveConvergedFeature(e, manifestWith({}), key, REPO)).toBe(true); // its own flag activates it
      // A different feature stays off (its flag is unset), proving no cross-wiring.
      const other = CONVERGED_FEATURE_KEYS.find((k) => k !== key)!;
      expect(resolveConvergedFeature(e, manifestWith({}), other, REPO)).toBe(false);
    }
  });
});

describe("resolveConvergedFeature — safety is force-on-only, never force-off (#2269)", () => {
  it("ignores a repo override that tries to force safety OFF, falling through to the allowlist default", () => {
    // Operator enabled safety globally AND allowlisted this repo — a repo-controlled override must not defeat it.
    const allowlisted = env({ LOOPOVER_REVIEW_SAFETY: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(allowlisted, manifestWith({ safety: false }), "safety", REPO)).toBe(true);

    // Not allowlisted: the override is still ignored (treated as "no opinion"), so the allowlist default (off) applies.
    // This is off for the same reason a bare `manifestWith({})` would be off here — not because the override "worked".
    const notAllowlisted = env({ LOOPOVER_REVIEW_SAFETY: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(notAllowlisted, manifestWith({ safety: false }), "safety", REPO)).toBe(false);
  });

  it("still honors a repo override that forces safety ON, even when the repo is not allowlisted", () => {
    const e = env({ LOOPOVER_REVIEW_SAFETY: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(e, manifestWith({ safety: true }), "safety", REPO)).toBe(true);
  });

  it("still respects the master kill-switch — a true override cannot turn safety on when the global flag is off", () => {
    const e = env({ LOOPOVER_REVIEW_REPOS: REPO }); // LOOPOVER_REVIEW_SAFETY unset
    expect(resolveConvergedFeature(e, manifestWith({ safety: true }), "safety", REPO)).toBe(false);
  });
});

describe("resolveConvergedFeature — grounding remains allowlist-bound", () => {
  it("does not let a repo manifest force grounding ON outside the operator allowlist", () => {
    const e = env({ LOOPOVER_REVIEW_GROUNDING: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(e, manifestWith({ grounding: true }), "grounding", REPO)).toBe(false);
  });

  it("allows an allowlisted repo to enable grounding by default and force it OFF per repo", () => {
    const e = env({ LOOPOVER_REVIEW_GROUNDING: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(e, manifestWith({}), "grounding", REPO)).toBe(true);
    expect(resolveConvergedFeature(e, manifestWith({ grounding: true }), "grounding", REPO)).toBe(true);
    expect(resolveConvergedFeature(e, manifestWith({ grounding: false }), "grounding", REPO)).toBe(false);
  });
});

describe("resolveConvergedFeature — screenshots remain allowlist-bound", () => {
  it("does not let a repo manifest force screenshots ON outside the operator allowlist", () => {
    const e = env({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(e, manifestWith({ screenshots: true }), "screenshots", REPO)).toBe(false);
  });

  it("allows an allowlisted repo to enable screenshots by default and force them OFF per repo", () => {
    const e = env({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(e, manifestWith({}), "screenshots", REPO)).toBe(true);
    expect(resolveConvergedFeature(e, manifestWith({ screenshots: true }), "screenshots", REPO)).toBe(true);
    expect(resolveConvergedFeature(e, manifestWith({ screenshots: false }), "screenshots", REPO)).toBe(false);
  });
});

describe("resolveConvergedFeature — improvementSignal is a plain symmetric override (#4738)", () => {
  // The full resolution matrix the #4738 acceptance criteria calls out explicitly: env off; env on + no
  // override; env on + repo true; env on + repo false. improvementSignal has no safety/grounding-style
  // asymmetry, so this mirrors the generic "standard mode" shape rag/reputation/unifiedComment/e2eTests use.
  it("is off when the global env flag is off, regardless of a per-repo override or the allowlist (env off)", () => {
    const e = env({ LOOPOVER_REVIEW_REPOS: REPO }); // LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL unset
    expect(resolveConvergedFeature(e, manifestWith({ improvementSignal: true }), "improvementSignal", REPO)).toBe(false);
  });

  it("falls back to the LOOPOVER_REVIEW_REPOS allowlist when the flag is on but the manifest sets nothing (env on + no override)", () => {
    const allowlisted = env({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(allowlisted, manifestWith({}), "improvementSignal", REPO)).toBe(true);
    expect(resolveConvergedFeature(allowlisted, null, "improvementSignal", REPO)).toBe(true); // null manifest tolerated

    const notAllowlisted = env({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(notAllowlisted, manifestWith({}), "improvementSignal", REPO)).toBe(false);
  });

  it("honors an explicit per-repo override of true even when the repo is NOT allowlisted (env on + repo true)", () => {
    const e = env({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "true", LOOPOVER_REVIEW_REPOS: "other/repo" });
    expect(resolveConvergedFeature(e, manifestWith({ improvementSignal: true }), "improvementSignal", REPO)).toBe(true);
  });

  it("honors an explicit per-repo override of false even when the repo IS allowlisted (env on + repo false)", () => {
    const e = env({ LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(resolveConvergedFeature(e, manifestWith({ improvementSignal: false }), "improvementSignal", REPO)).toBe(false);
  });
});

describe("convergedFeatureActive — async (loads the cached manifest)", () => {
  it("short-circuits to false WITHOUT loading the manifest when the env flag is off", async () => {
    // DB-less env: if it tried to load the manifest it would throw; returning false proves the short-circuit.
    expect(await convergedFeatureActive({} as Env, REPO, "rag")).toBe(false);
  });

  it("loads the manifest and applies a per-repo override (override beats the allowlist)", async () => {
    const e = createTestEnv({ LOOPOVER_REVIEW_RAG: "true", LOOPOVER_REVIEW_REPOS: REPO });
    // Allowlisted (default would be ON) but the per-repo manifest forces it OFF.
    await upsertRepoFocusManifest(e, REPO, { features: { rag: false } });
    expect(await convergedFeatureActive(e, REPO, "rag")).toBe(false);
  });

  it("falls back to the allowlist default when no manifest is published", async () => {
    const e = createTestEnv({ LOOPOVER_REVIEW_RAG: "true", LOOPOVER_REVIEW_REPOS: REPO });
    expect(await convergedFeatureActive(e, REPO, "rag")).toBe(true);
  });

  it("applies the safety force-on-only exception through the async DB-backed path too (#2269)", async () => {
    const e = createTestEnv({ LOOPOVER_REVIEW_SAFETY: "true", LOOPOVER_REVIEW_REPOS: REPO });
    await upsertRepoFocusManifest(e, REPO, { features: { safety: false } });
    expect(await convergedFeatureActive(e, REPO, "safety")).toBe(true); // override ignored, allowlist wins
  });
});
