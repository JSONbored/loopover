import { describe, expect, it } from "vitest";
import {
  computeReviewerConsensusCompositeCalibrationScore,
  ingestReviewerConsensusCalibrationSignals,
  renderReviewerConsensusCalibrationAuditMarkdown,
  resolveReviewerConsensusCalibrationConfig,
  type ObjectiveAnchorScore,
  type PairwiseCalibrationScore,
  type ReviewerConsensusCalibrationSignalInput,
  type ReviewerConsensusCompositeCalibrationScore,
} from "../../packages/loopover-engine/src/index";

// Root vitest mirror of packages/loopover-engine/test/reviewer-consensus-calibration.test.ts (#8349).
// The engine package's node:test suite already exercises this module; Codecov's codecov/patch gate only
// reads root vitest coverage, so this file makes the same scenarios (plus branch-complete edges) visible.

function signal(
  overrides: Partial<ReviewerConsensusCalibrationSignalInput> = {},
): ReviewerConsensusCalibrationSignalInput {
  return {
    repoFullName: "acme/widgets",
    replayRunId: "replay-1",
    reviewRunId: "review-1",
    optedIn: true,
    dimensions: [{ dimension: "correctness", votes: ["pass", "pass", "pass"] }],
    ...overrides,
  };
}

describe("barrel: structured reviewer-consensus calibration APIs (#8349)", () => {
  it("exports the four public functions", () => {
    expect(typeof resolveReviewerConsensusCalibrationConfig).toBe("function");
    expect(typeof ingestReviewerConsensusCalibrationSignals).toBe("function");
    expect(typeof computeReviewerConsensusCompositeCalibrationScore).toBe("function");
    expect(typeof renderReviewerConsensusCalibrationAuditMarkdown).toBe("function");
  });
});

describe("resolveReviewerConsensusCalibrationConfig", () => {
  it("defaults to opted out with the default structured weight", () => {
    for (const manifest of [undefined, null, "nope" as unknown as Record<string, unknown>]) {
      expect(resolveReviewerConsensusCalibrationConfig(manifest)).toEqual({
        shareStructuredReviewerConsensus: false,
        structuredReviewerConsensusWeight: 0.2,
        warnings: [],
      });
    }
  });

  it("reads the preferred path and the top-level alias with precedence", () => {
    const preferred = resolveReviewerConsensusCalibrationConfig({
      miner: { calibration: { shareStructuredReviewerConsensus: true, structuredReviewerConsensusWeight: 0.5 } },
    });
    expect(preferred.shareStructuredReviewerConsensus).toBe(true);
    expect(preferred.structuredReviewerConsensusWeight).toBe(0.5);
    expect(preferred.warnings).toEqual([]);

    const alias = resolveReviewerConsensusCalibrationConfig({
      calibration: { shareStructuredReviewerConsensus: "yes" },
    });
    expect(alias.shareStructuredReviewerConsensus).toBe(true);

    const both = resolveReviewerConsensusCalibrationConfig({
      miner: { calibration: { shareStructuredReviewerConsensus: "off" } },
      calibration: { shareStructuredReviewerConsensus: "on" },
    });
    expect(both.shareStructuredReviewerConsensus).toBe(false);
  });

  it("warns on non-boolean opt-in and invalid weight, failing closed", () => {
    const config = resolveReviewerConsensusCalibrationConfig({
      miner: {
        calibration: { shareStructuredReviewerConsensus: "maybe", structuredReviewerConsensusWeight: "heavy" },
      },
    });
    expect(config.shareStructuredReviewerConsensus).toBe(false);
    expect(config.structuredReviewerConsensusWeight).toBe(0.2);
    expect(config.warnings).toHaveLength(2);

    const negative = resolveReviewerConsensusCalibrationConfig({
      calibration: { structuredReviewerConsensusWeight: -3 },
    });
    expect(negative.structuredReviewerConsensusWeight).toBe(0.2);
    expect(negative.warnings).toHaveLength(1);

    const zero = resolveReviewerConsensusCalibrationConfig({
      calibration: { structuredReviewerConsensusWeight: 0 },
    });
    expect(zero.structuredReviewerConsensusWeight).toBe(0);
    expect(zero.warnings).toEqual([]);
  });

  it("accepts boolean/string opt-in variants and string/null weight edges", () => {
    expect(
      resolveReviewerConsensusCalibrationConfig({
        miner: { calibration: { shareStructuredReviewerConsensus: false } },
      }).shareStructuredReviewerConsensus,
    ).toBe(false);
    expect(
      resolveReviewerConsensusCalibrationConfig({
        calibration: { shareStructuredReviewerConsensus: "1" },
      }).shareStructuredReviewerConsensus,
    ).toBe(true);
    expect(
      resolveReviewerConsensusCalibrationConfig({
        calibration: { shareStructuredReviewerConsensus: "0" },
      }).shareStructuredReviewerConsensus,
    ).toBe(false);
    expect(
      resolveReviewerConsensusCalibrationConfig({
        calibration: { shareStructuredReviewerConsensus: "true" },
      }).shareStructuredReviewerConsensus,
    ).toBe(true);
    expect(
      resolveReviewerConsensusCalibrationConfig({
        calibration: { shareStructuredReviewerConsensus: "no" },
      }).shareStructuredReviewerConsensus,
    ).toBe(false);
    // Non-string/non-boolean (e.g. number) is not boolean-like → warn + default false.
    const numeric = resolveReviewerConsensusCalibrationConfig({
      calibration: { shareStructuredReviewerConsensus: 1 },
    });
    expect(numeric.shareStructuredReviewerConsensus).toBe(false);
    expect(numeric.warnings).toHaveLength(1);

    // String weight parses; null weight warns and falls back to default.
    expect(
      resolveReviewerConsensusCalibrationConfig({
        calibration: { structuredReviewerConsensusWeight: "0.35" },
      }).structuredReviewerConsensusWeight,
    ).toBe(0.35);
    const nullWeight = resolveReviewerConsensusCalibrationConfig({
      calibration: { structuredReviewerConsensusWeight: null },
    });
    expect(nullWeight.structuredReviewerConsensusWeight).toBe(0.2);
    expect(nullWeight.warnings).toHaveLength(1);
    // Non-number/non-string weight (object) takes the Number.NaN arm of normalizeOptionalWeight.
    const objectWeight = resolveReviewerConsensusCalibrationConfig({
      calibration: { structuredReviewerConsensusWeight: {} },
    });
    expect(objectWeight.structuredReviewerConsensusWeight).toBe(0.2);
    expect(objectWeight.warnings).toHaveLength(1);

    // Preferred path missing weight falls through to top-level alias weight.
    expect(
      resolveReviewerConsensusCalibrationConfig({
        miner: { calibration: { shareStructuredReviewerConsensus: true } },
        calibration: { structuredReviewerConsensusWeight: 0.7 },
      }).structuredReviewerConsensusWeight,
    ).toBe(0.7);

    // Non-record miner/calibration containers are treated as empty (isRecord false branches).
    expect(
      resolveReviewerConsensusCalibrationConfig({
        miner: null,
        calibration: [],
      } as never),
    ).toEqual({
      shareStructuredReviewerConsensus: false,
      structuredReviewerConsensusWeight: 0.2,
      warnings: [],
    });
  });
});

describe("ingestReviewerConsensusCalibrationSignals", () => {
  it("scores a unanimous verdict as full agreement and a split verdict below it", () => {
    const unanimous = ingestReviewerConsensusCalibrationSignals([signal()]);
    expect(unanimous.accepted).toHaveLength(1);
    expect(unanimous.accepted[0]!.score).toBe(1);
    expect(unanimous.accepted[0]!.dimensions).toEqual([
      { dimension: "correctness", voteCount: 3, majorityOutcome: "pass", agreement: 1, score: 1 },
    ]);

    const split = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "correctness", votes: ["pass", "pass", "fail"] }] }),
    ]).accepted[0]!;
    expect(split.dimensions[0]!.majorityOutcome).toBe("pass");
    expect(split.dimensions[0]!.agreement).toBe(Math.round((2 / 3) * 1_000_000) / 1_000_000);
    expect(split.score).toBeLessThan(unanimous.accepted[0]!.score);
  });

  it("breaks a plurality tie toward the more severe outcome", () => {
    const tie = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "security", votes: ["pass", "fail"] }] }),
    ]).accepted[0]!;
    expect(tie.dimensions[0]!.majorityOutcome).toBe("fail");
    expect(tie.dimensions[0]!.agreement).toBe(0.5);

    const warnVsPass = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "security", votes: ["warn", "pass"] }] }),
    ]).accepted[0]!;
    expect(warnVsPass.dimensions[0]!.majorityOutcome).toBe("warn");

    // fail vs warn at equal count: fail is more severe.
    const failVsWarn = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "security", votes: ["fail", "warn"] }] }),
    ]).accepted[0]!;
    expect(failVsWarn.dimensions[0]!.majorityOutcome).toBe("fail");
  });

  it("normalizes vote aliases and drops unrecognized/abstention votes", () => {
    const aliased = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "ci", votes: ["success", "approve", "reject"] }] }),
    ]).accepted[0]!;
    expect(aliased.dimensions[0]!.majorityOutcome).toBe("pass");
    expect(aliased.dimensions[0]!.voteCount).toBe(3);

    const withAbstentions = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "ci", votes: ["pass", "unknown", "???", "pass"] }] }),
    ]).accepted[0]!;
    expect(withAbstentions.dimensions[0]!.voteCount).toBe(2);
    expect(withAbstentions.dimensions[0]!.agreement).toBe(1);

    // Additional vote-alias branches: ok/passed→pass, warning/advisory/hold/comment→warn, block/blocked/failed→fail.
    const moreAliases = ingestReviewerConsensusCalibrationSignals([
      signal({
        dimensions: [
          {
            dimension: "ci",
            votes: ["ok", "passed", "warning", "advisory", "hold", "comment", "block", "blocked", "failed"],
          },
        ],
      }),
    ]).accepted[0]!;
    expect(moreAliases.dimensions[0]!.voteCount).toBe(9);
    expect(moreAliases.dimensions[0]!.majorityOutcome).toBe("warn");
  });

  it("aggregates repeated dimensions, normalizes dimension aliases, and preserves order", () => {
    const aggregated = ingestReviewerConsensusCalibrationSignals([
      signal({
        dimensions: [
          { dimension: "coverage", votes: ["pass"] }, // alias -> tests
          { dimension: "tests", votes: ["fail"] },
          { dimension: "correctness", votes: ["pass", "pass"] },
        ],
      }),
    ]).accepted[0]!;
    expect(aggregated.dimensions.map((dimension) => dimension.dimension)).toEqual(["correctness", "tests"]);
    const tests = aggregated.dimensions.find((dimension) => dimension.dimension === "tests")!;
    expect(tests.voteCount).toBe(2);
    expect(tests.agreement).toBe(0.5);

    // Remaining dimension-alias branches.
    const aliases = ingestReviewerConsensusCalibrationSignals([
      signal({
        dimensions: [
          { dimension: "quality", votes: ["pass"] },
          { dimension: "code_quality", votes: ["pass"] },
          { dimension: "test", votes: ["pass"] },
          { dimension: "maintenance", votes: ["pass"] },
          { dimension: "size", votes: ["pass"] },
          { dimension: "blast_radius", votes: ["pass"] },
          { dimension: "rebase", votes: ["pass"] },
          { dimension: "up_to_date", votes: ["pass"] },
          { dimension: "workflow", votes: ["pass"] },
          { dimension: "checks", votes: ["pass"] },
          { dimension: "Maintainability", votes: ["pass"] },
          { dimension: "Scope", votes: ["pass"] },
          { dimension: "Freshness", votes: ["pass"] },
          { dimension: "Policy", votes: ["pass"] },
        ],
      }),
    ]).accepted[0]!;
    expect(aliases.dimensions.map((d) => d.dimension)).toEqual([
      "correctness",
      "tests",
      "maintainability",
      "scope",
      "freshness",
      "ci",
      "policy",
    ]);
  });

  it("weights per-dimension agreement by vote count", () => {
    const result = ingestReviewerConsensusCalibrationSignals([
      signal({
        dimensions: [
          { dimension: "correctness", votes: ["pass", "pass", "pass", "fail"] },
          { dimension: "tests", votes: ["pass", "fail"] },
        ],
      }),
    ]).accepted[0]!;
    expect(result.score).toBe(Math.round((2 / 3) * 1_000_000) / 1_000_000);
  });

  it("handles a three-way split and a single-reviewer dimension", () => {
    const threeWay = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "correctness", votes: ["pass", "warn", "fail"] }] }),
    ]).accepted[0]!;
    expect(threeWay.dimensions[0]!.voteCount).toBe(3);
    expect(threeWay.dimensions[0]!.majorityOutcome).toBe("fail");
    expect(threeWay.dimensions[0]!.agreement).toBe(Math.round((1 / 3) * 1_000_000) / 1_000_000);

    const single = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "policy", votes: ["warn"] }] }),
    ]).accepted[0]!;
    expect(single.dimensions).toEqual([
      { dimension: "policy", voteCount: 1, majorityOutcome: "warn", agreement: 1, score: 1 },
    ]);
    expect(single.score).toBe(1);
  });

  it("drops dimensions with no definite votes, rejecting a signal left empty", () => {
    const mixed = ingestReviewerConsensusCalibrationSignals([
      signal({
        dimensions: [
          { dimension: "correctness", votes: ["unknown", "???"] },
          { dimension: "nonsense", votes: ["pass"] },
          { dimension: "security", votes: ["fail", "fail"] },
        ],
      }),
    ]);
    expect(mixed.accepted).toHaveLength(1);
    expect(mixed.accepted[0]!.dimensions.map((dimension) => dimension.dimension)).toEqual(["security"]);

    const empty = ingestReviewerConsensusCalibrationSignals([
      signal({ dimensions: [{ dimension: "correctness", votes: ["abstain"] }] }),
    ]);
    expect(empty.accepted).toHaveLength(0);
    expect(empty.rejected[0]!.reason).toBe("empty_dimensions");
  });

  it("rejects invalid repos, run ids, and non-opted-in signals with specific reasons", () => {
    const result = ingestReviewerConsensusCalibrationSignals([
      signal({ repoFullName: "not-a-repo" }),
      signal({ replayRunId: "  " }),
      signal({ reviewRunId: "bad\nid" }),
      signal({ optedIn: false }),
      signal({ reviewRunId: "x".repeat(161) }), // oversized id
      signal({ reviewRunId: "has\0null" }),
      signal(),
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((row) => row.reason)).toEqual([
      "invalid_repo",
      "invalid_run_id",
      "invalid_run_id",
      "not_opted_in",
      "invalid_run_id",
      "invalid_run_id",
    ]);
    expect(result.rejected[0]!.repoFullName).toBe("not-a-repo");
  });

  it("normalizes repo casing and observedAt to ISO, or null for an unparseable/missing timestamp", () => {
    const result = ingestReviewerConsensusCalibrationSignals([
      signal({ repoFullName: "ACME/Widgets", observedAt: "2026-07-04T00:00:00Z" }),
      signal({ observedAt: "not-a-date" }),
      signal({ repoFullName: "acme/other" }), // observedAt omitted → null
    ]);
    expect(result.accepted[0]!.repoFullName).toBe("acme/widgets");
    expect(result.accepted[0]!.observedAt).toBe("2026-07-04T00:00:00.000Z");
    expect(result.accepted[1]!.observedAt).toBeNull();
    expect(result.accepted[2]!.observedAt).toBeNull();
  });
});

describe("computeReviewerConsensusCompositeCalibrationScore", () => {
  it("blends objective-anchor, pairwise, and reviewer-consensus, accepting numbers or score objects", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([signal()]);
    const withNumbers = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.8,
      pairwise: 0.6,
      reviewerConsensus: ingestion,
    });
    const expected = Math.round((0.8 * 0.45 + 0.6 * 0.35 + 1 * 0.2) * 1_000_000) / 1_000_000;
    expect(withNumbers.compositeScore).toBe(expected);
    expect(withNumbers.structuredReviewerConsensusScore).toBe(1);
    expect(withNumbers.audit.contributingRepos).toHaveLength(1);

    const inline = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.8,
      pairwise: 0.6,
      reviewerConsensus: [signal()],
    });
    expect(inline.compositeScore).toBe(withNumbers.compositeScore);

    const anchor = { score: 0.7 } as unknown as ObjectiveAnchorScore;
    const pairwise = { pairwiseJudgeScore: 0.4 } as unknown as PairwiseCalibrationScore;
    const withObjects = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: anchor,
      pairwise,
      reviewerConsensus: ingestion,
    });
    expect(withObjects.objectiveAnchorScore).toBe(0.7);
    expect(withObjects.pairwiseJudgeScore).toBe(0.4);

    // Multiple accepted signals exercise averageSignals' length>1 path.
    const multi = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: 0.5,
      reviewerConsensus: [
        signal({ repoFullName: "acme/a", dimensions: [{ dimension: "correctness", votes: ["pass"] }] }),
        signal({
          repoFullName: "acme/b",
          replayRunId: "replay-2",
          reviewRunId: "review-2",
          dimensions: [{ dimension: "correctness", votes: ["fail"] }],
        }),
      ],
    });
    expect(multi.structuredReviewerConsensusScore).toBe(1); // both score 1 (unanimous within each)
    expect(multi.audit.contributingRepos).toHaveLength(2);
  });

  it("drops the pairwise weight when pairwise is null and redistributes it", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([signal()]);
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.8,
      pairwise: null,
      reviewerConsensus: ingestion,
    });
    expect(result.pairwiseJudgeScore).toBeNull();
    expect(result.weights.pairwiseJudge).toBe(0);
    const sum =
      result.weights.objectiveAnchor + result.weights.pairwiseJudge + result.weights.structuredReviewerConsensus;
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    const expected = Math.round((0.8 * (0.45 / 0.65) + 1 * (0.2 / 0.65)) * 1_000_000) / 1_000_000;
    expect(result.compositeScore).toBe(expected);
  });

  it("drops the structured weight when no signal contributes", () => {
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: 0.9,
      reviewerConsensus: [signal({ optedIn: false })],
    });
    expect(result.structuredReviewerConsensusScore).toBeNull();
    expect(result.weights.structuredReviewerConsensus).toBe(0);
    const expected = Math.round((0.5 * (0.45 / 0.8) + 0.9 * (0.35 / 0.8)) * 1_000_000) / 1_000_000;
    expect(result.compositeScore).toBe(expected);
    expect(result.audit.rejected).toHaveLength(1);
  });

  it("honors custom weights and falls back to objective-only when all weights are zero", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([signal()]);
    const weighted = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      reviewerConsensus: ingestion,
      weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredReviewerConsensus: 1 },
    });
    expect(weighted.compositeScore).toBe(1);

    const allZero = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      reviewerConsensus: ingestion,
      weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredReviewerConsensus: 0 },
    });
    // Explicitly zeroing every component falls back to objective-only — NOT the default 45/35/20 blend (#6170).
    expect(allZero.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0, structuredReviewerConsensus: 0 });
    expect(allZero.compositeScore).toBe(0.4);

    // NaN/negative weight components are treated as 0 via finiteNonNegative (not the default fallback).
    const nanWeights = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      reviewerConsensus: ingestion,
      weights: { objectiveAnchor: Number.NaN, pairwiseJudge: -1, structuredReviewerConsensus: 1 },
    });
    expect(nanWeights.weights.structuredReviewerConsensus).toBe(1);
    expect(nanWeights.compositeScore).toBe(1);

    // Omitted weights object uses defaults (finiteNonNegative undefined → fallback).
    const defaults = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.8,
      pairwise: 0.6,
      reviewerConsensus: ingestion,
    });
    expect(defaults.weights.objectiveAnchor).toBeCloseTo(0.45);
  });

  it("sanitizes pre-ingested reviewer-consensus rows before auditing", () => {
    const poisoned = {
      accepted: [
        {
          repoFullName: "ACME/Widgets",
          replayRunId: " replay-1 ",
          reviewRunId: "review-1",
          observedAt: "2026-07-04T00:00:00Z",
          score: 0,
          privateMetadata: "do-not-leak",
          dimensions: [
            {
              dimension: "coverage",
              voteCount: 2,
              majorityOutcome: "success",
              agreement: 1,
              score: 0,
              rawReviewText: "do-not-leak",
            },
            {
              dimension: "security",
              voteCount: 2,
              majorityOutcome: "fail",
              agreement: "not-a-number",
              rawReviewText: "do-not-leak",
            },
          ],
        },
      ],
      rejected: [
        {
          repoFullName: "ACME/Widgets",
          replayRunId: "replay-2",
          reviewRunId: "review-2",
          reason: "not_opted_in",
          privateMetadata: "do-not-leak",
        },
        {
          repoFullName: "bad",
          replayRunId: "replay-3",
          reviewRunId: "review-3",
          reason: "invalid_repo",
          privateMetadata: "do-not-leak",
        },
        {
          repoFullName: "ACME/Widgets",
          replayRunId: "replay-4",
          reviewRunId: "review-4",
          reason: "private_reason",
          privateMetadata: "do-not-leak",
        },
      ],
    };

    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: null,
      reviewerConsensus: poisoned as never,
    });

    expect(result.structuredReviewerConsensusScore).toBe(1);
    expect(result.audit.contributingRepos).toEqual([
      {
        repoFullName: "acme/widgets",
        replayRunId: "replay-1",
        reviewRunId: "review-1",
        observedAt: "2026-07-04T00:00:00.000Z",
        score: 1,
        dimensions: [{ dimension: "tests", voteCount: 2, majorityOutcome: "pass", agreement: 1, score: 1 }],
      },
    ]);
    expect(result.audit.rejected).toEqual([
      { repoFullName: "acme/widgets", replayRunId: "replay-2", reviewRunId: "review-2", reason: "not_opted_in" },
      { repoFullName: "bad", replayRunId: "replay-3", reviewRunId: "review-3", reason: "invalid_repo" },
    ]);
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it("drops malformed pre-ingested rows instead of rendering invalid dimensions", () => {
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: 0.7,
      reviewerConsensus: {
        accepted: [
          {
            repoFullName: "acme/widgets",
            replayRunId: "replay-1",
            reviewRunId: "review-1",
            observedAt: null,
            score: 1,
            dimensions: [
              { dimension: "correctness", voteCount: 1, majorityOutcome: "pass", agreement: "1", score: 1 },
            ],
          },
        ],
        rejected: [{ repoFullName: "acme/widgets", replayRunId: "replay-2", reviewRunId: "review-2" }],
      } as never,
    });

    expect(result.structuredReviewerConsensusScore).toBeNull();
    expect(result.audit.contributingRepos).toEqual([]);
    expect(result.audit.rejected).toEqual([]);
    expect(() => renderReviewerConsensusCalibrationAuditMarkdown(result)).not.toThrow();
  });

  it("covers remaining sanitize branches: non-records, bad ids, empty/invalid dimensions, empty_dimensions reject", () => {
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: null,
      reviewerConsensus: {
        accepted: [
          null,
          "skip",
          { repoFullName: 123, replayRunId: "r", reviewRunId: "v", dimensions: [] },
          { repoFullName: "acme/widgets", replayRunId: 1, reviewRunId: "v", dimensions: [] },
          { repoFullName: "acme/widgets", replayRunId: "r", reviewRunId: 1, dimensions: [] },
          {
            repoFullName: "acme/widgets",
            replayRunId: "r1",
            reviewRunId: "v1",
            observedAt: 42,
            dimensions: [
              null,
              { dimension: "correctness" },
              { dimension: "nonsense", voteCount: 1, majorityOutcome: "pass", agreement: 1 },
              { dimension: "correctness", voteCount: 0, majorityOutcome: "pass", agreement: 1 },
              { dimension: "correctness", voteCount: 1.5, majorityOutcome: "pass", agreement: 1 },
              { dimension: "correctness", voteCount: Number.NaN, majorityOutcome: "pass", agreement: 1 },
              { dimension: "correctness", voteCount: 1, majorityOutcome: "???", agreement: 1 },
              { dimension: "correctness", voteCount: 2, majorityOutcome: "pass", agreement: 0.5 },
            ],
          },
          {
            // All dimensions invalid → dropped (scoreDimensions null / empty).
            repoFullName: "acme/empty",
            replayRunId: "r2",
            reviewRunId: "v2",
            dimensions: [{ dimension: "correctness", voteCount: 0, majorityOutcome: "pass", agreement: 1 }],
          },
        ],
        rejected: [
          null,
          "skip",
          { repoFullName: 123, replayRunId: "r", reviewRunId: "v", reason: "invalid_repo" },
          { repoFullName: "acme/widgets", replayRunId: 1, reviewRunId: "v", reason: "not_opted_in" },
          { repoFullName: "acme/widgets", replayRunId: "r", reviewRunId: 1, reason: "not_opted_in" },
          {
            repoFullName: "acme/widgets",
            replayRunId: "r3",
            reviewRunId: "v3",
            reason: "empty_dimensions",
          },
          {
            repoFullName: "acme/widgets",
            replayRunId: "r4",
            reviewRunId: "v4",
            reason: "invalid_run_id",
          },
        ],
      } as never,
    });

    expect(result.structuredReviewerConsensusScore).toBe(0.5);
    expect(result.audit.contributingRepos).toEqual([
      {
        repoFullName: "acme/widgets",
        replayRunId: "r1",
        reviewRunId: "v1",
        observedAt: null, // non-string observedAt → null
        score: 0.5,
        dimensions: [{ dimension: "correctness", voteCount: 2, majorityOutcome: "pass", agreement: 0.5, score: 0.5 }],
      },
    ]);
    expect(result.audit.rejected).toEqual([
      { repoFullName: "acme/widgets", replayRunId: "r3", reviewRunId: "v3", reason: "empty_dimensions" },
      { repoFullName: "acme/widgets", replayRunId: "r4", reviewRunId: "v4", reason: "invalid_run_id" },
    ]);
  });
});

describe("renderReviewerConsensusCalibrationAuditMarkdown", () => {
  it("is deterministic, public-safe, and reports contributors and rejections", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([
      signal({ repoFullName: "acme/widgets", observedAt: "2026-07-04T00:00:00Z" }),
      signal({ repoFullName: "bad", replayRunId: "r2", reviewRunId: "v2" }),
    ]);
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.8,
      pairwise: null,
      reviewerConsensus: ingestion,
    });
    const markdown = renderReviewerConsensusCalibrationAuditMarkdown(result);
    expect(markdown).toBe(renderReviewerConsensusCalibrationAuditMarkdown(result));
    expect(markdown.startsWith("# Structured Reviewer-Consensus Calibration\n")).toBe(true);
    expect(markdown).toContain("### acme/widgets");
    expect(markdown).toContain("| correctness | 3 | pass |");
    expect(markdown).toContain("- pairwiseJudge: n/a");
    expect(markdown).toContain("invalid\\_repo");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("escapes markdown metacharacters and handles empty contributing/rejected branches", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([
      signal({ repoFullName: "acme/widgets", replayRunId: "run|with*meta_", reviewRunId: "v1" }),
    ]);
    const escaped = renderReviewerConsensusCalibrationAuditMarkdown(
      computeReviewerConsensusCompositeCalibrationScore({
        objectiveAnchor: 0.5,
        pairwise: 0.5,
        reviewerConsensus: ingestion,
      }),
    );
    expect(escaped).toContain("run\\|with\\*meta\\_");
    expect(escaped).not.toContain("run|with*meta_");

    const empty = renderReviewerConsensusCalibrationAuditMarkdown(
      computeReviewerConsensusCompositeCalibrationScore({
        objectiveAnchor: 0.5,
        pairwise: null,
        reviewerConsensus: [],
      }),
    );
    expect(empty).toContain("_No opted-in structured reviewer-consensus signals contributed._");
    expect(empty).toContain("## Rejected Rows\n\n- none");
    expect(empty).toContain("## Contributing Repo Summary\n\n- none");
    expect(empty).toContain("- structuredReviewerConsensus: n/a");

    // observedAt null renders as n/a; pairwise/structured present numbers take the non-n/a arm.
    const withNullObserved = renderReviewerConsensusCalibrationAuditMarkdown(
      computeReviewerConsensusCompositeCalibrationScore({
        objectiveAnchor: 0.5,
        pairwise: 0.5,
        reviewerConsensus: [signal({ observedAt: "not-a-date" })],
      }),
    );
    expect(withNullObserved).toContain("- observedAt: n/a");
    expect(withNullObserved).toContain("- pairwiseJudge: 0.500000");
    expect(withNullObserved).toContain("- structuredReviewerConsensus: 1.000000");

    // Empty dimensions table branch is only reachable via a synthetic audit row (public ingest always has dims).
    const emptyDims: ReviewerConsensusCompositeCalibrationScore = {
      compositeScore: 0.5,
      objectiveAnchorScore: 0.5,
      pairwiseJudgeScore: null,
      structuredReviewerConsensusScore: null,
      weights: { objectiveAnchor: 1, pairwiseJudge: 0, structuredReviewerConsensus: 0 },
      audit: {
        contributingRepos: [
          {
            repoFullName: "acme/widgets",
            replayRunId: "r",
            reviewRunId: "v",
            observedAt: null,
            score: 0,
            dimensions: [],
          },
        ],
        rejected: [],
      },
    };
    const emptyDimsMd = renderReviewerConsensusCalibrationAuditMarkdown(emptyDims);
    expect(emptyDimsMd).toContain("| Dimension | Votes | Majority | Agreement |\n| --- | ---: | --- | ---: |\n");
  });
});
