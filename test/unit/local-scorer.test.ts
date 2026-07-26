import { describe, expect, it } from "vitest";
import { computeLocalScorerTokens } from "../../src/signals/local-scorer";
import { DEFAULT_SCORING_CONSTANTS } from "../../packages/loopover-engine/src/scoring/model";
import { buildScorePreview } from "../../src/scoring/preview";
import type { RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

const testWeight = DEFAULT_SCORING_CONSTANTS.TEST_FILE_CONTRIBUTION_WEIGHT;

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
      totalTokenScore: 12 + testWeight * 8 + 6,
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

  it("applies TEST_FILE_CONTRIBUTION_WEIGHT so a test-heavy total agrees with preview.ts (#8875)", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "src/a.ts", additions: 20 },
        { path: "src/a.test.ts", additions: 200 },
        { path: "README.md", additions: 10 },
      ],
    });
    const expectedWeighted = 20 + testWeight * 200 + 10;
    expect(scorer.sourceTokenScore).toBe(20);
    expect(scorer.testTokenScore).toBe(200);
    expect(scorer.nonCodeTokenScore).toBe(10);
    expect(scorer.totalTokenScore).toBe(expectedWeighted);

    const repo = {
      fullName: "acme/widgets",
      registryConfig: { emissionShare: 0.1, issueDiscoveryShare: 0, labelMultipliers: {}, defaultLabelMultiplier: 1 },
    } as RepositoryRecord;
    const snapshot = {
      id: "snap-1",
      activeModel: "pending_saturation_model",
      constants: { ...DEFAULT_SCORING_CONSTANTS },
      fetchedAt: new Date().toISOString(),
      sourceKind: "fallback",
      sourceUrl: "fixture://constants.py",
      programmingLanguages: {},
      warnings: [],
      payload: {},
    } as ScoringModelSnapshotRecord;

    const withExplicitTotal = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: "acme/widgets",
        sourceTokenScore: scorer.sourceTokenScore,
        testTokenScore: scorer.testTokenScore,
        nonCodeTokenScore: scorer.nonCodeTokenScore,
        totalTokenScore: scorer.totalTokenScore,
        sourceLines: scorer.sourceLines,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const derivedTotal = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: "acme/widgets",
        sourceTokenScore: scorer.sourceTokenScore,
        testTokenScore: scorer.testTokenScore,
        nonCodeTokenScore: scorer.nonCodeTokenScore,
        sourceLines: scorer.sourceLines,
        openPrCount: 0,
        credibility: 1,
      },
    });
    expect(withExplicitTotal.scoreEstimate.contributionBonus).toBe(derivedTotal.scoreEstimate.contributionBonus);
    expect(withExplicitTotal.scoreEstimate.estimatedMergedScore).toBe(derivedTotal.scoreEstimate.estimatedMergedScore);
  });
});
