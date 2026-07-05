import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeReviewerConsensusCompositeCalibrationScore,
  ingestReviewerConsensusCalibrationSignals,
  renderReviewerConsensusCalibrationAuditMarkdown,
  resolveReviewerConsensusCalibrationConfig,
  type ObjectiveAnchorScore,
  type PairwiseCalibrationScore,
  type ReviewerConsensusCalibrationSignalInput,
} from "../dist/index.js";

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

test("barrel: exports structured reviewer-consensus calibration APIs", () => {
  assert.equal(typeof resolveReviewerConsensusCalibrationConfig, "function");
  assert.equal(typeof ingestReviewerConsensusCalibrationSignals, "function");
  assert.equal(typeof computeReviewerConsensusCompositeCalibrationScore, "function");
  assert.equal(typeof renderReviewerConsensusCalibrationAuditMarkdown, "function");
});

test("resolveReviewerConsensusCalibrationConfig defaults to opted out with the default structured weight", () => {
  for (const manifest of [undefined, null, "nope" as unknown as Record<string, unknown>]) {
    assert.deepEqual(resolveReviewerConsensusCalibrationConfig(manifest), {
      shareStructuredReviewerConsensus: false,
      structuredReviewerConsensusWeight: 0.2,
      warnings: [],
    });
  }
});

test("resolveReviewerConsensusCalibrationConfig reads the preferred path and the top-level alias with precedence", () => {
  const preferred = resolveReviewerConsensusCalibrationConfig({
    miner: { calibration: { shareStructuredReviewerConsensus: true, structuredReviewerConsensusWeight: 0.5 } },
  });
  assert.equal(preferred.shareStructuredReviewerConsensus, true);
  assert.equal(preferred.structuredReviewerConsensusWeight, 0.5);
  assert.deepEqual(preferred.warnings, []);

  const alias = resolveReviewerConsensusCalibrationConfig({
    calibration: { shareStructuredReviewerConsensus: "yes" },
  });
  assert.equal(alias.shareStructuredReviewerConsensus, true);

  const both = resolveReviewerConsensusCalibrationConfig({
    miner: { calibration: { shareStructuredReviewerConsensus: "off" } },
    calibration: { shareStructuredReviewerConsensus: "on" },
  });
  assert.equal(both.shareStructuredReviewerConsensus, false);
});

test("resolveReviewerConsensusCalibrationConfig warns on non-boolean opt-in and invalid weight, failing closed", () => {
  const config = resolveReviewerConsensusCalibrationConfig({
    miner: {
      calibration: { shareStructuredReviewerConsensus: "maybe", structuredReviewerConsensusWeight: "heavy" },
    },
  });
  assert.equal(config.shareStructuredReviewerConsensus, false);
  assert.equal(config.structuredReviewerConsensusWeight, 0.2);
  assert.equal(config.warnings.length, 2);

  const negative = resolveReviewerConsensusCalibrationConfig({
    calibration: { structuredReviewerConsensusWeight: -3 },
  });
  assert.equal(negative.structuredReviewerConsensusWeight, 0.2);
  assert.equal(negative.warnings.length, 1);
  const zero = resolveReviewerConsensusCalibrationConfig({
    calibration: { structuredReviewerConsensusWeight: 0 },
  });
  assert.equal(zero.structuredReviewerConsensusWeight, 0);
  assert.deepEqual(zero.warnings, []);
});

test("ingest scores a unanimous verdict as full agreement and a split verdict below it", () => {
  const unanimous = ingestReviewerConsensusCalibrationSignals([signal()]);
  assert.equal(unanimous.accepted.length, 1);
  assert.equal(unanimous.accepted[0]!.score, 1);
  assert.deepEqual(unanimous.accepted[0]!.dimensions, [
    { dimension: "correctness", voteCount: 3, majorityOutcome: "pass", agreement: 1, score: 1 },
  ]);

  const split = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "correctness", votes: ["pass", "pass", "fail"] }] }),
  ]).accepted[0]!;
  assert.equal(split.dimensions[0]!.majorityOutcome, "pass");
  assert.equal(split.dimensions[0]!.agreement, Math.round((2 / 3) * 1_000_000) / 1_000_000);
  assert.ok(split.score < unanimous.accepted[0]!.score, "a split verdict must calibrate below a unanimous one");
});

test("ingest breaks a plurality tie toward the more severe outcome", () => {
  const tie = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "security", votes: ["pass", "fail"] }] }),
  ]).accepted[0]!;
  assert.equal(tie.dimensions[0]!.majorityOutcome, "fail");
  assert.equal(tie.dimensions[0]!.agreement, 0.5);

  const warnVsPass = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "security", votes: ["warn", "pass"] }] }),
  ]).accepted[0]!;
  assert.equal(warnVsPass.dimensions[0]!.majorityOutcome, "warn");
});

test("ingest normalizes vote aliases and drops unrecognized/abstention votes", () => {
  const aliased = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "ci", votes: ["success", "approve", "reject"] }] }),
  ]).accepted[0]!;
  // success/approve -> pass (2), reject -> fail (1) : majority pass, agreement 2/3
  assert.equal(aliased.dimensions[0]!.majorityOutcome, "pass");
  assert.equal(aliased.dimensions[0]!.voteCount, 3);

  const withAbstentions = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "ci", votes: ["pass", "unknown", "???", "pass"] }] }),
  ]).accepted[0]!;
  // Only the two definite "pass" votes count.
  assert.equal(withAbstentions.dimensions[0]!.voteCount, 2);
  assert.equal(withAbstentions.dimensions[0]!.agreement, 1);
});

test("ingest aggregates repeated dimensions, normalizes dimension aliases, and preserves order", () => {
  const aggregated = ingestReviewerConsensusCalibrationSignals([
    signal({
      dimensions: [
        { dimension: "coverage", votes: ["pass"] }, // alias -> tests
        { dimension: "tests", votes: ["fail"] },
        { dimension: "correctness", votes: ["pass", "pass"] },
      ],
    }),
  ]).accepted[0]!;
  assert.deepEqual(
    aggregated.dimensions.map((dimension) => dimension.dimension),
    ["correctness", "tests"],
  );
  const tests = aggregated.dimensions.find((dimension) => dimension.dimension === "tests")!;
  assert.equal(tests.voteCount, 2);
  assert.equal(tests.agreement, 0.5); // one pass + one fail
});

test("ingest weights per-dimension agreement by vote count", () => {
  const result = ingestReviewerConsensusCalibrationSignals([
    signal({
      dimensions: [
        { dimension: "correctness", votes: ["pass", "pass", "pass", "fail"] }, // 4 votes, agreement 3/4
        { dimension: "tests", votes: ["pass", "fail"] }, // 2 votes, agreement 1/2
      ],
    }),
  ]).accepted[0]!;
  // weighted = (4 * 3/4 + 2 * 1/2) / 6 = (3 + 1) / 6 = 2/3
  assert.equal(result.score, Math.round((2 / 3) * 1_000_000) / 1_000_000);
});

test("ingest handles a three-way split and a single-reviewer dimension", () => {
  // A fully three-way split (pass/warn/fail) has a plurality of 1 out of 3 definite votes → agreement 1/3, with the
  // tie broken toward the most severe outcome.
  const threeWay = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "correctness", votes: ["pass", "warn", "fail"] }] }),
  ]).accepted[0]!;
  assert.equal(threeWay.dimensions[0]!.voteCount, 3);
  assert.equal(threeWay.dimensions[0]!.majorityOutcome, "fail");
  assert.equal(threeWay.dimensions[0]!.agreement, Math.round((1 / 3) * 1_000_000) / 1_000_000);

  // A single reviewer trivially agrees with itself: one definite vote → agreement 1.
  const single = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "policy", votes: ["warn"] }] }),
  ]).accepted[0]!;
  assert.deepEqual(single.dimensions, [
    { dimension: "policy", voteCount: 1, majorityOutcome: "warn", agreement: 1, score: 1 },
  ]);
  assert.equal(single.score, 1);
});

test("ingest drops dimensions with no definite votes, rejecting a signal left empty", () => {
  const mixed = ingestReviewerConsensusCalibrationSignals([
    signal({
      dimensions: [
        { dimension: "correctness", votes: ["unknown", "???"] }, // dropped (no definite votes)
        { dimension: "nonsense", votes: ["pass"] }, // dropped (unknown dimension)
        { dimension: "security", votes: ["fail", "fail"] },
      ],
    }),
  ]);
  assert.equal(mixed.accepted.length, 1);
  assert.deepEqual(
    mixed.accepted[0]!.dimensions.map((dimension) => dimension.dimension),
    ["security"],
  );

  const empty = ingestReviewerConsensusCalibrationSignals([
    signal({ dimensions: [{ dimension: "correctness", votes: ["abstain"] }] }),
  ]);
  assert.equal(empty.accepted.length, 0);
  assert.equal(empty.rejected[0]!.reason, "empty_dimensions");
});

test("ingest rejects invalid repos, run ids, and non-opted-in signals with specific reasons", () => {
  const result = ingestReviewerConsensusCalibrationSignals([
    signal({ repoFullName: "not-a-repo" }),
    signal({ replayRunId: "  " }),
    signal({ reviewRunId: "bad\nid" }),
    signal({ optedIn: false }),
    signal(),
  ]);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(
    result.rejected.map((row) => row.reason),
    ["invalid_repo", "invalid_run_id", "invalid_run_id", "not_opted_in"],
  );
  assert.equal(result.rejected[0]!.repoFullName, "not-a-repo");
});

test("ingest normalizes repo casing and observedAt to ISO, or null for an unparseable timestamp", () => {
  const result = ingestReviewerConsensusCalibrationSignals([
    signal({ repoFullName: "ACME/Widgets", observedAt: "2026-07-04T00:00:00Z" }),
    signal({ observedAt: "not-a-date" }),
  ]);
  assert.equal(result.accepted[0]!.repoFullName, "acme/widgets");
  assert.equal(result.accepted[0]!.observedAt, "2026-07-04T00:00:00.000Z");
  assert.equal(result.accepted[1]!.observedAt, null);
});

test("composite blends objective-anchor, pairwise, and reviewer-consensus, accepting numbers or score objects", () => {
  const ingestion = ingestReviewerConsensusCalibrationSignals([signal()]); // structured score 1
  const withNumbers = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: 0.6,
    reviewerConsensus: ingestion,
  });
  const expected = Math.round((0.8 * 0.45 + 0.6 * 0.35 + 1 * 0.2) * 1_000_000) / 1_000_000;
  assert.equal(withNumbers.compositeScore, expected);
  assert.equal(withNumbers.structuredReviewerConsensusScore, 1);
  assert.equal(withNumbers.audit.contributingRepos.length, 1);

  const inline = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: 0.6,
    reviewerConsensus: [signal()],
  });
  assert.equal(inline.compositeScore, withNumbers.compositeScore);

  const anchor = { score: 0.7 } as unknown as ObjectiveAnchorScore;
  const pairwise = { pairwiseJudgeScore: 0.4 } as unknown as PairwiseCalibrationScore;
  const withObjects = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: anchor,
    pairwise,
    reviewerConsensus: ingestion,
  });
  assert.equal(withObjects.objectiveAnchorScore, 0.7);
  assert.equal(withObjects.pairwiseJudgeScore, 0.4);
});

test("composite drops the pairwise weight when pairwise is null and redistributes it", () => {
  const ingestion = ingestReviewerConsensusCalibrationSignals([signal()]);
  const result = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: null,
    reviewerConsensus: ingestion,
  });
  assert.equal(result.pairwiseJudgeScore, null);
  assert.equal(result.weights.pairwiseJudge, 0);
  const sum =
    result.weights.objectiveAnchor + result.weights.pairwiseJudge + result.weights.structuredReviewerConsensus;
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const expected = Math.round((0.8 * (0.45 / 0.65) + 1 * (0.2 / 0.65)) * 1_000_000) / 1_000_000;
  assert.equal(result.compositeScore, expected);
});

test("composite drops the structured weight when no signal contributes", () => {
  const result = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.9,
    reviewerConsensus: [signal({ optedIn: false })],
  });
  assert.equal(result.structuredReviewerConsensusScore, null);
  assert.equal(result.weights.structuredReviewerConsensus, 0);
  const expected = Math.round((0.5 * (0.45 / 0.8) + 0.9 * (0.35 / 0.8)) * 1_000_000) / 1_000_000;
  assert.equal(result.compositeScore, expected);
  assert.equal(result.audit.rejected.length, 1);
});

test("composite honors custom weights and falls back to objective-only when all weights are zero", () => {
  const ingestion = ingestReviewerConsensusCalibrationSignals([signal()]);
  const weighted = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: 0.4,
    pairwise: 0.4,
    reviewerConsensus: ingestion,
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredReviewerConsensus: 1 },
  });
  assert.equal(weighted.compositeScore, 1);

  const allZero = computeReviewerConsensusCompositeCalibrationScore({
    objectiveAnchor: 0.4,
    pairwise: 0.4,
    reviewerConsensus: ingestion,
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredReviewerConsensus: 0 },
  });
  // Explicitly zeroing every component falls back to objective-only — NOT the default 45/35/20 blend.
  assert.deepEqual(allZero.weights, { objectiveAnchor: 1, pairwiseJudge: 0, structuredReviewerConsensus: 0 });
  assert.equal(allZero.compositeScore, 0.4);
});

test("composite sanitizes pre-ingested reviewer-consensus rows before auditing", () => {
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

  assert.equal(result.structuredReviewerConsensusScore, 1);
  assert.deepEqual(result.audit.contributingRepos, [
    {
      repoFullName: "acme/widgets",
      replayRunId: "replay-1",
      reviewRunId: "review-1",
      observedAt: "2026-07-04T00:00:00.000Z",
      score: 1,
      dimensions: [{ dimension: "tests", voteCount: 2, majorityOutcome: "pass", agreement: 1, score: 1 }],
    },
  ]);
  assert.deepEqual(result.audit.rejected, [
    { repoFullName: "acme/widgets", replayRunId: "replay-2", reviewRunId: "review-2", reason: "not_opted_in" },
    { repoFullName: "bad", replayRunId: "replay-3", reviewRunId: "review-3", reason: "invalid_repo" },
  ]);
  assert.ok(!JSON.stringify(result).includes("do-not-leak"));
});

test("composite drops malformed pre-ingested rows instead of rendering invalid dimensions", () => {
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

  assert.equal(result.structuredReviewerConsensusScore, null);
  assert.deepEqual(result.audit.contributingRepos, []);
  assert.deepEqual(result.audit.rejected, []);
  assert.doesNotThrow(() => renderReviewerConsensusCalibrationAuditMarkdown(result));
});

test("renderAuditMarkdown is deterministic, public-safe, and reports contributors and rejections", () => {
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
  assert.equal(markdown, renderReviewerConsensusCalibrationAuditMarkdown(result), "render must be deterministic");
  assert.ok(markdown.startsWith("# Structured Reviewer-Consensus Calibration\n"));
  assert.ok(markdown.includes("### acme/widgets"));
  assert.ok(markdown.includes("| correctness | 3 | pass |"));
  assert.ok(markdown.includes("- pairwiseJudge: n/a"));
  assert.ok(markdown.includes("invalid\\_repo"));
  assert.ok(markdown.endsWith("\n"));
});

test("renderAuditMarkdown escapes markdown metacharacters in identifiers and handles the empty case", () => {
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
  assert.ok(escaped.includes("run\\|with\\*meta\\_"));
  assert.ok(!escaped.includes("run|with*meta_"));

  const empty = renderReviewerConsensusCalibrationAuditMarkdown(
    computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: null,
      reviewerConsensus: [],
    }),
  );
  assert.ok(empty.includes("_No opted-in structured reviewer-consensus signals contributed._"));
  assert.ok(empty.includes("## Rejected Rows\n\n- none"));
  assert.ok(empty.includes("## Contributing Repo Summary\n\n- none"));
});
