import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeFindingSeverityCompositeCalibrationScore,
  ingestFindingSeverityCalibrationSignals,
  renderFindingSeverityCalibrationAuditMarkdown,
  resolveFindingSeverityCalibrationConfig,
  type FindingSeverityCalibrationSignalInput,
  type ObjectiveAnchorScore,
  type PairwiseCalibrationScore,
} from "../dist/index.js";

function signal(
  overrides: Partial<FindingSeverityCalibrationSignalInput> = {},
): FindingSeverityCalibrationSignalInput {
  return {
    repoFullName: "acme/widgets",
    replayRunId: "replay-1",
    reviewRunId: "review-1",
    optedIn: true,
    tiers: [{ tier: "blocker", total: 2, confirmed: 2 }],
    ...overrides,
  };
}

test("barrel: exports structured finding-severity calibration APIs", () => {
  assert.equal(typeof resolveFindingSeverityCalibrationConfig, "function");
  assert.equal(typeof ingestFindingSeverityCalibrationSignals, "function");
  assert.equal(typeof computeFindingSeverityCompositeCalibrationScore, "function");
  assert.equal(typeof renderFindingSeverityCalibrationAuditMarkdown, "function");
});

test("resolveFindingSeverityCalibrationConfig defaults to opted out with the default structured weight", () => {
  assert.deepEqual(resolveFindingSeverityCalibrationConfig(undefined), {
    shareStructuredFindingSeverity: false,
    structuredFindingSeverityWeight: 0.2,
    warnings: [],
  });
  assert.deepEqual(resolveFindingSeverityCalibrationConfig(null), {
    shareStructuredFindingSeverity: false,
    structuredFindingSeverityWeight: 0.2,
    warnings: [],
  });
  // A non-object manifest is treated as absent, not an error.
  assert.deepEqual(resolveFindingSeverityCalibrationConfig("nope" as unknown as Record<string, unknown>), {
    shareStructuredFindingSeverity: false,
    structuredFindingSeverityWeight: 0.2,
    warnings: [],
  });
});

test("resolveFindingSeverityCalibrationConfig reads the preferred miner.calibration path", () => {
  const config = resolveFindingSeverityCalibrationConfig({
    miner: { calibration: { shareStructuredFindingSeverity: true, structuredFindingSeverityWeight: 0.5 } },
  });
  assert.equal(config.shareStructuredFindingSeverity, true);
  assert.equal(config.structuredFindingSeverityWeight, 0.5);
  assert.deepEqual(config.warnings, []);
});

test("resolveFindingSeverityCalibrationConfig accepts the top-level calibration alias and boolean-like strings", () => {
  const config = resolveFindingSeverityCalibrationConfig({
    calibration: { shareStructuredFindingSeverity: "yes" },
  });
  assert.equal(config.shareStructuredFindingSeverity, true);
  // miner.calibration takes precedence over the top-level alias when both are present.
  const both = resolveFindingSeverityCalibrationConfig({
    miner: { calibration: { shareStructuredFindingSeverity: "off" } },
    calibration: { shareStructuredFindingSeverity: "on" },
  });
  assert.equal(both.shareStructuredFindingSeverity, false);
});

test("resolveFindingSeverityCalibrationConfig warns on non-boolean opt-in and invalid weight, falling back safely", () => {
  const config = resolveFindingSeverityCalibrationConfig({
    miner: {
      calibration: { shareStructuredFindingSeverity: "maybe", structuredFindingSeverityWeight: "heavy" },
    },
  });
  assert.equal(config.shareStructuredFindingSeverity, false);
  assert.equal(config.structuredFindingSeverityWeight, 0.2);
  assert.equal(config.warnings.length, 2);
  assert.ok(config.warnings.some((w) => w.includes("shareStructuredFindingSeverity")));
  assert.ok(config.warnings.some((w) => w.includes("structuredFindingSeverityWeight")));
});

test("resolveFindingSeverityCalibrationConfig rejects a negative weight but keeps a zero weight", () => {
  const negative = resolveFindingSeverityCalibrationConfig({
    calibration: { structuredFindingSeverityWeight: -3 },
  });
  assert.equal(negative.structuredFindingSeverityWeight, 0.2);
  assert.equal(negative.warnings.length, 1);
  const zero = resolveFindingSeverityCalibrationConfig({ calibration: { structuredFindingSeverityWeight: 0 } });
  assert.equal(zero.structuredFindingSeverityWeight, 0);
  assert.deepEqual(zero.warnings, []);
});

test("ingest scores a confirmed blocker as fully calibrated and an unconfirmed one as zero", () => {
  const confirmed = ingestFindingSeverityCalibrationSignals([signal()]);
  assert.equal(confirmed.accepted.length, 1);
  assert.equal(confirmed.accepted[0]!.score, 1);
  assert.deepEqual(confirmed.accepted[0]!.tiers, [
    { tier: "blocker", total: 2, confirmed: 2, confirmationRate: 1, weight: 1, score: 1 },
  ]);

  const dismissed = ingestFindingSeverityCalibrationSignals([
    signal({ tiers: [{ tier: "blocker", total: 2, confirmed: 0 }] }),
  ]);
  assert.equal(dismissed.accepted[0]!.score, 0);
  assert.equal(dismissed.accepted[0]!.tiers[0]!.confirmationRate, 0);
});

test("ingest weights severity and volume so a confirmed blocker outscores many confirmed nits", () => {
  const blockerHeavy = ingestFindingSeverityCalibrationSignals([
    signal({
      tiers: [
        { tier: "blocker", total: 2, confirmed: 2 },
        { tier: "nit", total: 10, confirmed: 0 },
      ],
    }),
  ]).accepted[0]!;
  // weightedRate = (1*2)*1 + (0.1*10)*0 = 2 ; weightSum = 2 + 1 = 3 ; score = 2/3.
  assert.equal(blockerHeavy.score, Math.round((2 / 3) * 1_000_000) / 1_000_000);
  // Output preserves TIER_ORDER (blocker before nit).
  assert.deepEqual(
    blockerHeavy.tiers.map((tier) => tier.tier),
    ["blocker", "nit"],
  );

  const nitHeavy = ingestFindingSeverityCalibrationSignals([
    signal({
      tiers: [
        { tier: "blocker", total: 2, confirmed: 0 },
        { tier: "nit", total: 10, confirmed: 10 },
      ],
    }),
  ]).accepted[0]!;
  // weightedRate = (1*2)*0 + (0.1*10)*1 = 1 ; weightSum = 3 ; score = 1/3.
  assert.equal(nitHeavy.score, Math.round((1 / 3) * 1_000_000) / 1_000_000);
  assert.ok(blockerHeavy.score > nitHeavy.score, "confirmed blockers must calibrate higher than confirmed nits");
});

test("ingest clamps confirmed to total and discounts by confidence", () => {
  const clamped = ingestFindingSeverityCalibrationSignals([
    signal({ tiers: [{ tier: "blocker", total: 2, confirmed: 9 }] }),
  ]).accepted[0]!;
  assert.equal(clamped.tiers[0]!.confirmed, 2);
  assert.equal(clamped.tiers[0]!.confirmationRate, 1);

  const discounted = ingestFindingSeverityCalibrationSignals([
    signal({ tiers: [{ tier: "warning", total: 4, confirmed: 4, confidence: 0.5 }] }),
  ]).accepted[0]!;
  // confirmed = min(4, round(4 * 0.5)) = 2 ; rate = 0.5.
  assert.equal(discounted.tiers[0]!.confirmed, 2);
  assert.equal(discounted.tiers[0]!.confirmationRate, 0.5);

  // Confidence 0 credits no confirmations regardless of the raw count.
  const zeroConfidence = ingestFindingSeverityCalibrationSignals([
    signal({ tiers: [{ tier: "warning", total: 4, confirmed: 4, confidence: 0 }] }),
  ]).accepted[0]!;
  assert.equal(zeroConfidence.tiers[0]!.confirmed, 0);
});

test("ingest aggregates repeated tiers and normalizes tier aliases", () => {
  const aggregated = ingestFindingSeverityCalibrationSignals([
    signal({
      tiers: [
        { tier: "critical", total: 1, confirmed: 1 }, // alias -> blocker
        { tier: "blocker", total: 3, confirmed: 0 },
        { tier: "suggestion", total: 2, confirmed: 1 }, // alias -> advisory
      ],
    }),
  ]).accepted[0]!;
  const blocker = aggregated.tiers.find((tier) => tier.tier === "blocker")!;
  assert.equal(blocker.total, 4);
  assert.equal(blocker.confirmed, 1);
  assert.equal(blocker.confirmationRate, 0.25);
  const advisory = aggregated.tiers.find((tier) => tier.tier === "advisory")!;
  assert.equal(advisory.total, 2);
  assert.equal(advisory.confirmed, 1);
});

test("ingest drops zero-total and unknown tiers, rejecting a signal left with no tiers", () => {
  const mixed = ingestFindingSeverityCalibrationSignals([
    signal({
      tiers: [
        { tier: "blocker", total: 0, confirmed: 0 }, // dropped (zero total)
        { tier: "mystery", total: 5, confirmed: 5 }, // dropped (unknown tier)
        { tier: "warning", total: 3, confirmed: 3 },
      ],
    }),
  ]);
  assert.equal(mixed.accepted.length, 1);
  assert.deepEqual(
    mixed.accepted[0]!.tiers.map((tier) => tier.tier),
    ["warning"],
  );

  const empty = ingestFindingSeverityCalibrationSignals([
    signal({ tiers: [{ tier: "blocker", total: 0 }, { tier: "nope", total: 4, confirmed: 4 }] }),
  ]);
  assert.equal(empty.accepted.length, 0);
  assert.equal(empty.rejected[0]!.reason, "empty_tiers");
});

test("ingest rejects invalid repos, run ids, and non-opted-in signals with specific reasons", () => {
  const result = ingestFindingSeverityCalibrationSignals([
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
  // The invalid-repo rejection preserves the raw (un-normalized) repo string for the audit.
  assert.equal(result.rejected[0]!.repoFullName, "not-a-repo");
});

test("ingest normalizes repo casing and observedAt to ISO, or null for an unparseable timestamp", () => {
  const result = ingestFindingSeverityCalibrationSignals([
    signal({ repoFullName: "ACME/Widgets", observedAt: "2026-07-04T00:00:00Z" }),
    signal({ observedAt: "not-a-date" }),
  ]);
  assert.equal(result.accepted[0]!.repoFullName, "acme/widgets");
  assert.equal(result.accepted[0]!.observedAt, "2026-07-04T00:00:00.000Z");
  assert.equal(result.accepted[1]!.observedAt, null);
});

test("composite blends objective-anchor, pairwise, and finding-severity, accepting numbers or score objects", () => {
  const ingestion = ingestFindingSeverityCalibrationSignals([signal()]); // structured score 1
  const withNumbers = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: 0.6,
    findingSeverity: ingestion,
  });
  // default weights 0.45 / 0.35 / 0.2, structured = 1
  const expected =
    Math.round((0.8 * 0.45 + 0.6 * 0.35 + 1 * 0.2) * 1_000_000) / 1_000_000;
  assert.equal(withNumbers.compositeScore, expected);
  assert.equal(withNumbers.structuredFindingSeverityScore, 1);
  assert.equal(withNumbers.audit.contributingRepos.length, 1);

  // Raw signal inputs are ingested inline when an ingestion object is not supplied.
  const inline = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: 0.6,
    findingSeverity: [signal()],
  });
  assert.equal(inline.compositeScore, withNumbers.compositeScore);

  // Accepts objective-anchor / pairwise score objects: only their `.score` / `.pairwiseJudgeScore` fields are read.
  const anchor = { score: 0.7 } as unknown as ObjectiveAnchorScore;
  const pairwise = { pairwiseJudgeScore: 0.4 } as unknown as PairwiseCalibrationScore;
  const withObjects = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: anchor,
    pairwise,
    findingSeverity: ingestion,
  });
  assert.equal(withObjects.objectiveAnchorScore, 0.7);
  assert.equal(withObjects.pairwiseJudgeScore, 0.4);
});

test("composite averages the structured score across multiple accepted signals", () => {
  // Signal A: confirmed blocker -> score 1. Signal B: dismissed blocker -> score 0. Average -> 0.5.
  const ingestion = ingestFindingSeverityCalibrationSignals([
    signal({ repoFullName: "acme/a" }),
    signal({ repoFullName: "acme/b", tiers: [{ tier: "blocker", total: 2, confirmed: 0 }] }),
  ]);
  assert.equal(ingestion.accepted.length, 2);
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0,
    pairwise: null,
    findingSeverity: ingestion,
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 1 },
  });
  assert.equal(result.structuredFindingSeverityScore, 0.5);
  assert.equal(result.compositeScore, 0.5);
  assert.equal(result.audit.contributingRepos.length, 2);
});

test("composite drops the pairwise weight when pairwise is null and redistributes it", () => {
  const ingestion = ingestFindingSeverityCalibrationSignals([signal()]);
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: null,
    findingSeverity: ingestion,
  });
  assert.equal(result.pairwiseJudgeScore, null);
  assert.equal(result.weights.pairwiseJudge, 0);
  // Remaining weights renormalize to sum 1.
  const sum = result.weights.objectiveAnchor + result.weights.pairwiseJudge + result.weights.structuredFindingSeverity;
  assert.ok(Math.abs(sum - 1) < 1e-9);
  // composite = 0.8 * (0.45/0.65) + 1 * (0.2/0.65)
  const expected = Math.round((0.8 * (0.45 / 0.65) + 1 * (0.2 / 0.65)) * 1_000_000) / 1_000_000;
  assert.equal(result.compositeScore, expected);
});

test("composite drops the structured weight when no signal contributes", () => {
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.9,
    findingSeverity: [signal({ optedIn: false })], // all rejected -> structured score null
  });
  assert.equal(result.structuredFindingSeverityScore, null);
  assert.equal(result.weights.structuredFindingSeverity, 0);
  const expected = Math.round((0.5 * (0.45 / 0.8) + 0.9 * (0.35 / 0.8)) * 1_000_000) / 1_000_000;
  assert.equal(result.compositeScore, expected);
  assert.equal(result.audit.rejected.length, 1);
});

test("composite honors custom weights and falls back to objective-only when all weights are zero", () => {
  const ingestion = ingestFindingSeverityCalibrationSignals([signal()]);
  const weighted = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.4,
    pairwise: 0.4,
    findingSeverity: ingestion,
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 1 },
  });
  // Only the structured component is weighted, so the composite equals the structured score (1).
  assert.equal(weighted.compositeScore, 1);

  const allZero = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.4,
    pairwise: 0.4,
    findingSeverity: ingestion,
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 0 },
  });
  // Zero weights fall back to the default distribution, not a divide-by-zero.
  assert.ok(allZero.compositeScore > 0 && allZero.compositeScore <= 1);
});

test("renderAuditMarkdown is deterministic, public-safe, and reports contributors and rejections", () => {
  const ingestion = ingestFindingSeverityCalibrationSignals([
    signal({ repoFullName: "acme/widgets", observedAt: "2026-07-04T00:00:00Z" }),
    signal({ repoFullName: "bad", replayRunId: "r2", reviewRunId: "v2" }),
  ]);
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.8,
    pairwise: null,
    findingSeverity: ingestion,
  });
  const markdown = renderFindingSeverityCalibrationAuditMarkdown(result);
  assert.equal(markdown, renderFindingSeverityCalibrationAuditMarkdown(result), "render must be deterministic");
  assert.ok(markdown.startsWith("# Structured Finding-Severity Calibration\n"));
  assert.ok(markdown.includes("Composite score: "));
  assert.ok(markdown.includes("### acme/widgets"));
  assert.ok(markdown.includes("| blocker | 2 | 2 |"));
  assert.ok(markdown.includes("- pairwiseJudge: n/a"));
  // Rejected rows table is rendered with the specific reason (underscore markdown-escaped).
  assert.ok(markdown.includes("invalid\\_repo"));
  assert.ok(markdown.endsWith("\n"));
});

test("renderAuditMarkdown escapes markdown metacharacters in identifiers", () => {
  const ingestion = ingestFindingSeverityCalibrationSignals([
    signal({ repoFullName: "acme/widgets", replayRunId: "run|with*meta_", reviewRunId: "v1" }),
  ]);
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    findingSeverity: ingestion,
  });
  const markdown = renderFindingSeverityCalibrationAuditMarkdown(result);
  assert.ok(markdown.includes("run\\|with\\*meta\\_"), "pipe/asterisk/underscore must be escaped");
  assert.ok(!markdown.includes("run|with*meta_"));
});

test("renderAuditMarkdown handles the fully-empty case without throwing", () => {
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: null,
    findingSeverity: [],
  });
  const markdown = renderFindingSeverityCalibrationAuditMarkdown(result);
  assert.ok(markdown.includes("_No opted-in structured finding-severity signals contributed._"));
  assert.ok(markdown.includes("## Rejected Rows\n\n- none"));
  assert.ok(markdown.includes("## Contributing Repo Summary\n\n- none"));
});

test("composite sanitizes pre-ingested finding-severity rows before scoring or auditing", () => {
  const forgedTier = {
    tier: "blocker",
    total: 2,
    confirmed: 99,
    confirmationRate: 99,
    weight: 99,
    score: 99,
    rawReviewText: "private review details",
  };
  const forged = {
    accepted: [
      {
        repoFullName: "ACME/Widgets",
        replayRunId: " replay-1 ",
        reviewRunId: "review-1",
        observedAt: "2026-07-04T00:00:00Z",
        tiers: [forgedTier, { tier: "mystery", total: 5, confirmed: 5, rawReviewText: "private tier" }],
        score: 999,
        privateMetadata: { rawReviewText: "private accepted" },
      },
      {
        repoFullName: "not-a-repo",
        replayRunId: "bad replay",
        reviewRunId: "review-2",
        tiers: [forgedTier],
        score: 999,
      },
    ],
    rejected: [
      {
        repoFullName: "ACME/Widgets",
        replayRunId: "replay-2",
        reviewRunId: "review-2",
        reason: "not_opted_in",
        privateMetadata: { rawReviewText: "private rejected" },
      },
      {
        repoFullName: "ACME/Widgets",
        replayRunId: "replay-3",
        reviewRunId: "review-3",
        reason: "attacker|reason",
      },
    ],
  };

  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0,
    pairwise: null,
    findingSeverity: forged as never,
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 1 },
  });

  assert.equal(result.structuredFindingSeverityScore, 1);
  assert.equal(result.compositeScore, 1);
  assert.deepEqual(result.audit.contributingRepos, [
    {
      repoFullName: "acme/widgets",
      replayRunId: "replay-1",
      reviewRunId: "review-1",
      observedAt: "2026-07-04T00:00:00.000Z",
      score: 1,
      tiers: [{ tier: "blocker", total: 2, confirmed: 2, confirmationRate: 1, weight: 1, score: 1 }],
    },
  ]);
  assert.deepEqual(result.audit.rejected, [
    { repoFullName: "acme/widgets", replayRunId: "replay-2", reviewRunId: "review-2", reason: "not_opted_in" },
  ]);
  assert.notEqual(result.audit.contributingRepos[0]!.tiers[0], forgedTier);
  assert.ok(!JSON.stringify(result.audit).includes("private"));
});

test("renderAuditMarkdown tolerates malformed pre-ingested rejected rows after sanitizing", () => {
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: null,
    findingSeverity: {
      accepted: [],
      rejected: [
        { repoFullName: 42, replayRunId: "replay-1", reviewRunId: "review-1", reason: "not_opted_in" },
        { repoFullName: "acme/widgets", replayRunId: "replay-2", reviewRunId: "review-2", reason: "surprise" },
      ],
    } as never,
  });

  assert.deepEqual(result.audit.rejected, []);
  assert.doesNotThrow(() => renderFindingSeverityCalibrationAuditMarkdown(result));
});

test("computeFindingSeverityCompositeCalibrationScore falls back to objective-only when all weights are explicitly zero (#6170)", () => {
  const result = computeFindingSeverityCompositeCalibrationScore({
    objectiveAnchor: 0.4,
    pairwise: 0.4,
    findingSeverity: [signal()],
    weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 0 },
  });
  // Explicitly zeroing every component falls back to objective-only -- NOT the default 45/35/20 blend
  // (converges with reviewer-consensus-calibration.ts).
  assert.deepEqual(result.weights, { objectiveAnchor: 1, pairwiseJudge: 0, structuredFindingSeverity: 0 });
  assert.equal(result.compositeScore, 0.4);
});
