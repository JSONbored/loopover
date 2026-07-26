import { describe, expect, it } from "vitest";
import { computeLocalScorerTokens } from "../../src/signals/local-scorer";
import { buildScorePreview } from "../../src/scoring/preview";
import type { ScoringModelSnapshotRecord } from "../../src/types";

// Minimal snapshot: empty `constants` means every constant (incl. TEST_FILE_CONTRIBUTION_WEIGHT) falls back to
// DEFAULT_SCORING_CONSTANTS, so preview's derived total uses the same 0.05× weight the local scorer applies.
const snapshot: ScoringModelSnapshotRecord = {
  id: "local-scorer-fixture",
  sourceKind: "test",
  sourceUrl: "fixture://constants.py",
  fetchedAt: "2026-05-23T00:00:00.000Z",
  activeModel: "current_density_model",
  constants: {},
  programmingLanguages: {},
  registrySnapshotId: "registry-fixture",
  warnings: [],
  payload: {},
};

describe("computeLocalScorerTokens (#782)", () => {
  it("classifies source / test / non-code from metadata and sums additions + deletions", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "src/foo.ts", additions: 10, deletions: 2 },
        { path: "src/foo.test.ts", additions: 8, deletions: 0 },
        { path: "README.md", additions: 5, deletions: 1 },
      ],
    });
    expect(scorer).toMatchObject({
      mode: "external_command",
      activeModel: "loopover-deterministic",
      sourceTokenScore: 12,
      testTokenScore: 8,
      nonCodeTokenScore: 6,
      totalTokenScore: 18.4, // #8875: 12 source + 0.05 × 8 test + 6 non-code (test lines weighted, not raw-summed)
      sourceLines: 12,
    });
    expect(scorer.warnings).toBeUndefined();
  });

  it("drops binary files; with no source, sourceLines falls back to total (matching buildScorePreview)", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "img.png", additions: 100, binary: true },
        { path: "docs.md", additions: 3 },
      ],
    });
    expect(scorer.totalTokenScore).toBe(3); // the binary file carries no token value
    expect(scorer.sourceTokenScore).toBe(0);
    expect(scorer.nonCodeTokenScore).toBe(3);
    expect(scorer.sourceLines).toBe(3); // no source → falls back to total, floored at 1
  });

  it("floors sourceLines at 1 for a diff with no line counts at all", () => {
    const scorer = computeLocalScorerTokens({ changedFiles: [{ path: "docs.md" }] }); // additions/deletions omitted
    expect(scorer.totalTokenScore).toBe(0);
    expect(scorer.sourceLines).toBe(1);
  });

  it("counts generated Dart part files as non-code in deterministic metadata scoring", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "lib/models/user.g.dart", additions: 4 },
        { path: "lib/models/user.freezed.dart", additions: 5 },
        { path: "lib/api/user.gr.dart", additions: 6 },
        { path: "lib/models/user.dart", additions: 3 },
      ],
    });
    expect(scorer.sourceTokenScore).toBe(3);
    expect(scorer.nonCodeTokenScore).toBe(15);
    expect(scorer.totalTokenScore).toBe(18);
  });

  it("surfaces a warning when local validation reports failures, without changing the scores", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [{ path: "src/a.ts", additions: 4 }],
      validation: [
        { command: "npm test", status: "passed" },
        { command: "npm run typecheck", status: "failed" },
      ],
    });
    expect(scorer.sourceTokenScore).toBe(4);
    expect(scorer.warnings?.[0]).toMatch(/validation reported failures/i);
  });

  it("emits no warning when validation passed or was not supplied", () => {
    expect(computeLocalScorerTokens({ changedFiles: [{ path: "src/a.ts", additions: 1 }], validation: [{ command: "t", status: "passed" }] }).warnings).toBeUndefined();
    expect(computeLocalScorerTokens({ changedFiles: [{ path: "src/a.ts", additions: 1 }] }).warnings).toBeUndefined();
  });

  it("test-heavy diff: totalTokenScore weights test lines and agrees with buildScorePreview's derived total (#8875)", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "src/widget.ts", additions: 20, deletions: 5 }, // source: 25
        { path: "test/widget.test.ts", additions: 180, deletions: 20 }, // test: 200 (test-heavy)
        { path: "docs/widget.md", additions: 10, deletions: 0 }, // non-code: 10
      ],
    });
    expect(scorer).toMatchObject({ sourceTokenScore: 25, testTokenScore: 200, nonCodeTokenScore: 10 });
    // 25 source + 0.05 × 200 test + 10 non-code = 45 — NOT the raw unweighted 235.
    expect(scorer.totalTokenScore).toBe(45);

    const baseInput = {
      repoFullName: "octo/demo",
      sourceTokenScore: scorer.sourceTokenScore,
      testTokenScore: scorer.testTokenScore,
      nonCodeTokenScore: scorer.nonCodeTokenScore,
      sourceLines: scorer.sourceLines,
      openPrCount: 0,
      credibility: 1,
    };
    // Preview deriving its own total from components, vs. being handed the local scorer's explicit total.
    const derived = buildScorePreview({ repo: null, snapshot, input: baseInput });
    const explicit = buildScorePreview({ repo: null, snapshot, input: { ...baseInput, totalTokenScore: scorer.totalTokenScore } });
    // The two now agree — the explicit total no longer bypasses the test-file discount.
    expect(explicit.scoreEstimate.contributionBonus).toBe(derived.scoreEstimate.contributionBonus);
    expect(explicit.scoreEstimate.estimatedMergedScore).toBe(derived.scoreEstimate.estimatedMergedScore);

    // Regression guard: the pre-fix raw unweighted total (25 + 200 + 10 = 235) over-counts test lines in the ramp.
    const rawUnweighted = buildScorePreview({ repo: null, snapshot, input: { ...baseInput, totalTokenScore: 235 } });
    expect(rawUnweighted.scoreEstimate.contributionBonus).toBeGreaterThan(explicit.scoreEstimate.contributionBonus);
  });
});
