import { describe, expect, it } from "vitest";
import {
  computeMetadataLaneFit,
  computeMinerGoalLaneFit,
  DEFAULT_MINER_GOAL_SPEC,
  isMinerRepoTargetable,
} from "../../packages/loopover-engine/src/index";

describe("computeMetadataLaneFit", () => {
  it("falls back to label-only lane fit when candidatePaths are absent or empty", () => {
    const spec = { ...DEFAULT_MINER_GOAL_SPEC, preferredLabels: ["bug"] };
    expect(computeMetadataLaneFit({ labels: ["bug"] }, spec)).toBe(1);
    expect(computeMetadataLaneFit({ labels: ["feature"] }, spec)).toBe(0.25);
    expect(computeMetadataLaneFit({ labels: ["bug"], candidatePaths: [] }, spec)).toBe(1);
    expect(computeMetadataLaneFit({ labels: ["bug"], candidatePaths: ["", "  "] }, spec)).toBe(1);
  });

  it("uses path+label lane fit when candidatePaths are present", () => {
    const spec = {
      ...DEFAULT_MINER_GOAL_SPEC,
      wantedPaths: ["src/**"],
      preferredLabels: ["bug"],
    };
    expect(
      computeMetadataLaneFit({ labels: ["bug"], candidatePaths: ["src/app.ts"] }, spec),
    ).toBe(1);
    expect(
      computeMetadataLaneFit({ labels: ["bug"], candidatePaths: ["docs/readme.md"] }, spec),
    ).toBe(0.5);
  });

  it("returns 0 when candidatePaths hit blockedPaths", () => {
    const spec = {
      ...DEFAULT_MINER_GOAL_SPEC,
      blockedPaths: ["secrets/**"],
      wantedPaths: ["src/**"],
    };
    expect(
      computeMetadataLaneFit(
        { labels: ["bug"], candidatePaths: ["secrets/api-keys.ts"] },
        spec,
      ),
    ).toBe(0);
  });

  it("ignores malformed candidatePaths values before scoring", () => {
    const spec = {
      ...DEFAULT_MINER_GOAL_SPEC,
      blockedPaths: ["src/**"],
      preferredLabels: ["bug"],
      wantedPaths: ["src/**"],
    };
    expect(
      computeMetadataLaneFit(
        { labels: ["bug"], candidatePaths: [42 as unknown as string, ""] },
        spec,
      ),
    ).toBe(1);
    expect(
      computeMetadataLaneFit(
        { labels: ["bug"], candidatePaths: { path: "src/app.ts" } as unknown as string[] },
        spec,
      ),
    ).toBe(1);
    expect(
      computeMetadataLaneFit(
        { labels: ["bug"], candidatePaths: "src/app.ts" as unknown as string[] },
        spec,
      ),
    ).toBe(1);
  });
});

describe("computeMinerGoalLaneFit", () => {
  it("respects minerEnabled opt-out", () => {
    expect(isMinerRepoTargetable(DEFAULT_MINER_GOAL_SPEC)).toBe(true);
    expect(isMinerRepoTargetable({ ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false })).toBe(false);
  });

  it("returns 0 when a blocked label matches case-insensitively", () => {
    const spec = { ...DEFAULT_MINER_GOAL_SPEC, blockedLabels: ["wontfix", "duplicate"] };
    expect(computeMinerGoalLaneFit({ labels: ["WontFix"] }, spec)).toBe(0);
    expect(computeMinerGoalLaneFit({ labels: ["DUPLICATE"] }, spec)).toBe(0);
  });

  it("continues scoring when blocked labels are configured but none match", () => {
    const spec = { ...DEFAULT_MINER_GOAL_SPEC, blockedLabels: ["wontfix"], preferredLabels: ["bug"] };
    expect(computeMinerGoalLaneFit({ labels: ["bug"] }, spec)).toBe(1);
    expect(computeMinerGoalLaneFit({ labels: ["feature"] }, spec)).toBe(0.25);
  });

  it("returns 0.5 when no preferred labels are configured (#8870)", () => {
    // Aligns with computeLaneFit's documented neutral: no preference → 0.5, never 0 or 1.
    expect(computeMinerGoalLaneFit({ labels: ["docs"] }, DEFAULT_MINER_GOAL_SPEC)).toBe(0.5);
    expect(computeMetadataLaneFit({ labels: ["docs"] }, DEFAULT_MINER_GOAL_SPEC)).toBe(0.5);
  });

  it("scores normally when no blocked labels are configured", () => {
    // No preferredLabels → neutral 0.5, matching computeLaneFit (#8870).
    expect(computeMinerGoalLaneFit({ labels: ["docs"] }, DEFAULT_MINER_GOAL_SPEC)).toBe(0.5);
  });
});
