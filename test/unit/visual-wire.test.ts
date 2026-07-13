import { describe, expect, it } from "vitest";
import { isScreenshotsEnabled } from "../../src/review/visual-wire";
import { resolveConvergedFeature } from "../../src/review/feature-activation";
import type { FocusManifest } from "../../src/signals/focus-manifest";

describe("isScreenshotsEnabled", () => {
  it("is OFF by default (unset / empty / false)", () => {
    expect(isScreenshotsEnabled({})).toBe(false);
    expect(isScreenshotsEnabled({ LOOPOVER_REVIEW_SCREENSHOTS: undefined })).toBe(false);
    expect(isScreenshotsEnabled({ LOOPOVER_REVIEW_SCREENSHOTS: "" })).toBe(false);
    expect(isScreenshotsEnabled({ LOOPOVER_REVIEW_SCREENSHOTS: "false" })).toBe(false);
    expect(isScreenshotsEnabled({ LOOPOVER_REVIEW_SCREENSHOTS: "0" })).toBe(false);
    expect(isScreenshotsEnabled({ LOOPOVER_REVIEW_SCREENSHOTS: "off" })).toBe(false);
  });

  it("accepts the codebase truthy vocabulary (1/true/yes/on, case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes", "on", "ON"]) {
      expect(isScreenshotsEnabled({ LOOPOVER_REVIEW_SCREENSHOTS: v }), v).toBe(true);
    }
  });
});

// #4616: screenshots is a `ConvergedFeatureKey`, but browser rendering remains allowlist-bound:
// `features.screenshots` may opt an allowlisted repo out, but it must not let an unallowlisted repo bypass the
// operator-controlled LOOPOVER_REVIEW_REPOS rollout boundary.
describe("screenshots converged-feature activation (env flag AND repo cutover allowlist, with manifest opt-out)", () => {
  const repo = "JSONbored/gittensory";
  const noOverride: Pick<FocusManifest, "features"> = {
    features: { present: false, rag: null, reputation: null, unifiedComment: null, safety: null, grounding: null, e2eTests: null, screenshots: null, improvementSignal: null },
  };

  it("requires BOTH the global flag and the repo allowlist when no override is set", () => {
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: repo } as Env, noOverride, "screenshots", repo)).toBe(true);
  });

  it("is false when the global flag is OFF even if the repo is allowlisted (master kill-switch)", () => {
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "false", LOOPOVER_REVIEW_REPOS: repo } as Env, noOverride, "screenshots", repo)).toBe(false);
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_REPOS: repo } as Env, noOverride, "screenshots", repo)).toBe(false);
  });

  it("is false when the repo is NOT allowlisted and no override is set, even if the global flag is ON (dormant default)", () => {
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true" } as Env, noOverride, "screenshots", repo)).toBe(false);
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: "" } as Env, noOverride, "screenshots", repo)).toBe(false);
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: "JSONbored/other" } as Env, noOverride, "screenshots", repo)).toBe(false);
  });

  it("matches the repo case-insensitively within the allowlist", () => {
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "on", LOOPOVER_REVIEW_REPOS: "jsonbored/GITTENSORY" } as Env, noOverride, "screenshots", repo)).toBe(true);
  });

  it("does not let a `features.screenshots` override bypass the repo allowlist", () => {
    const forcedOn: Pick<FocusManifest, "features"> = { features: { ...noOverride.features, present: true, screenshots: true } };
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true" } as Env, forcedOn, "screenshots", "not/allowlisted")).toBe(false);
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: "JSONbored/other" } as Env, forcedOn, "screenshots", repo)).toBe(false);
  });

  it("allows an allowlisted repo to enable screenshots by default and force it OFF per repo", () => {
    const forcedOn: Pick<FocusManifest, "features"> = { features: { ...noOverride.features, present: true, screenshots: true } };
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: repo } as Env, forcedOn, "screenshots", repo)).toBe(true);
    const forcedOff: Pick<FocusManifest, "features"> = { features: { ...noOverride.features, present: true, screenshots: false } };
    expect(resolveConvergedFeature({ LOOPOVER_REVIEW_SCREENSHOTS: "true", LOOPOVER_REVIEW_REPOS: repo } as Env, forcedOff, "screenshots", repo)).toBe(false);
  });
});
