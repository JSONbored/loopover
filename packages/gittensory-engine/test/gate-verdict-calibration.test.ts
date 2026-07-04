import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeGateVerdictCompositeCalibrationScore,
  computePairwiseCalibrationScore,
  ingestGateVerdictCalibrationSignals,
  renderGateVerdictCalibrationAuditMarkdown,
  resolveGateVerdictCalibrationConfig,
  scoreObjectiveAnchor,
} from "../dist/index.js";

test("barrel: exports structured gate-verdict calibration APIs (#3015)", () => {
  assert.equal(typeof resolveGateVerdictCalibrationConfig, "function");
  assert.equal(typeof ingestGateVerdictCalibrationSignals, "function");
  assert.equal(typeof computeGateVerdictCompositeCalibrationScore, "function");
  assert.equal(typeof renderGateVerdictCalibrationAuditMarkdown, "function");
});

test("resolveGateVerdictCalibrationConfig defaults to opted out with the default structured weight", () => {
  assert.deepEqual(resolveGateVerdictCalibrationConfig(undefined), {
    shareStructuredGateVerdicts: false,
    structuredGateVerdictWeight: 0.2,
    warnings: [],
  });
  assert.deepEqual(resolveGateVerdictCalibrationConfig({}), {
    shareStructuredGateVerdicts: false,
    structuredGateVerdictWeight: 0.2,
    warnings: [],
  });
});

test("resolveGateVerdictCalibrationConfig honors the explicit maintainer opt-in path", () => {
  const result = resolveGateVerdictCalibrationConfig({
    miner: {
      calibration: {
        shareStructuredGateVerdicts: true,
        structuredGateVerdictWeight: 0.4,
      },
    },
  });

  assert.deepEqual(result, {
    shareStructuredGateVerdicts: true,
    structuredGateVerdictWeight: 0.4,
    warnings: [],
  });
});

test("resolveGateVerdictCalibrationConfig accepts boolean-like private-config strings", () => {
  const result = resolveGateVerdictCalibrationConfig({
    miner: {
      calibration: {
        shareStructuredGateVerdicts: "yes",
        structuredGateVerdictWeight: "0.35",
      },
    },
  });

  assert.equal(result.shareStructuredGateVerdicts, true);
  assert.equal(result.structuredGateVerdictWeight, 0.35);
  assert.deepEqual(result.warnings, []);
});

test("resolveGateVerdictCalibrationConfig keeps top-level calibration as an explicit alias", () => {
  const result = resolveGateVerdictCalibrationConfig({
    calibration: {
      shareStructuredGateVerdicts: "on",
      structuredGateVerdictWeight: 0.25,
    },
  });

  assert.deepEqual(result, {
    shareStructuredGateVerdicts: true,
    structuredGateVerdictWeight: 0.25,
    warnings: [],
  });
});

test("resolveGateVerdictCalibrationConfig prefers miner.calibration over the top-level alias", () => {
  const result = resolveGateVerdictCalibrationConfig({
    miner: { calibration: { shareStructuredGateVerdicts: false, structuredGateVerdictWeight: 0.3 } },
    calibration: { shareStructuredGateVerdicts: true, structuredGateVerdictWeight: 0.9 },
  });

  assert.equal(result.shareStructuredGateVerdicts, false);
  assert.equal(result.structuredGateVerdictWeight, 0.3);
});

test("resolveGateVerdictCalibrationConfig warns and fails closed on malformed opt-in values", () => {
  const result = resolveGateVerdictCalibrationConfig({
    miner: {
      calibration: {
        shareStructuredGateVerdicts: "maybe",
        structuredGateVerdictWeight: -1,
      },
    },
  });

  assert.equal(result.shareStructuredGateVerdicts, false);
  assert.equal(result.structuredGateVerdictWeight, 0.2);
  assert.deepEqual(result.warnings, [
    "miner.calibration.shareStructuredGateVerdicts must be a boolean-like value; defaulting to false.",
    "miner.calibration.structuredGateVerdictWeight must be a non-negative finite number; using default.",
  ]);
});

test("ingestGateVerdictCalibrationSignals accepts only currently opted-in structured dimensions", () => {
  const ingestion = ingestGateVerdictCalibrationSignals([
    {
      repoFullName: "JSONbored/Gittensory",
      replayRunId: "replay-1",
      gateRunId: "gate-1",
      optedIn: true,
      observedAt: "2026-07-04T17:00:00.000Z",
      dimensions: [
        { dimension: "correctness", outcome: "pass", confidence: 1 },
        { dimension: "tests", outcome: "warn", confidence: 0.8 },
        { dimension: "security", outcome: "fail", confidence: 0.9 },
      ],
    },
  ]);

  assert.deepEqual(ingestion.rejected, []);
  assert.equal(ingestion.accepted.length, 1);
  assert.equal(ingestion.accepted[0]!.repoFullName, "jsonbored/gittensory");
  assert.equal(ingestion.accepted[0]!.score, 0.466667);
  assert.deepEqual(ingestion.accepted[0]!.dimensions, [
    { dimension: "correctness", outcome: "pass", confidence: 1, score: 1 },
    { dimension: "tests", outcome: "warn", confidence: 0.8, score: 0.4 },
    { dimension: "security", outcome: "fail", confidence: 0.9, score: 0 },
  ]);
});

test("ingestGateVerdictCalibrationSignals rejects a mid-flight opt-out at ingestion time", () => {
  const ingestion = ingestGateVerdictCalibrationSignals([
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-2",
      gateRunId: "gate-2",
      optedIn: false,
      dimensions: [{ dimension: "correctness", outcome: "pass" }],
    },
  ]);

  assert.deepEqual(ingestion.accepted, []);
  assert.deepEqual(ingestion.rejected, [
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-2",
      gateRunId: "gate-2",
      reason: "not_opted_in",
    },
  ]);
});

test("ingestGateVerdictCalibrationSignals rejects malformed repo and run identifiers", () => {
  const ingestion = ingestGateVerdictCalibrationSignals([
    {
      repoFullName: "not a repo",
      replayRunId: "replay-3",
      gateRunId: "gate-3",
      optedIn: true,
      dimensions: [{ dimension: "correctness", outcome: "pass" }],
    },
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "",
      gateRunId: "gate\nbad",
      optedIn: true,
      dimensions: [{ dimension: "correctness", outcome: "pass" }],
    },
  ]);

  assert.deepEqual(ingestion.accepted, []);
  assert.deepEqual(ingestion.rejected, [
    { repoFullName: "not a repo", replayRunId: "replay-3", gateRunId: "gate-3", reason: "invalid_repo" },
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "",
      gateRunId: "gate\nbad",
      reason: "invalid_run_id",
    },
  ]);
});

test("ingestGateVerdictCalibrationSignals drops unknown dimensions/outcomes and rejects empty structured rows", () => {
  const ingestion = ingestGateVerdictCalibrationSignals([
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-4",
      gateRunId: "gate-4",
      optedIn: true,
      dimensions: [
        { dimension: "raw-review-text", outcome: "looks good" },
        { dimension: "trust_score", outcome: "private" },
      ],
    },
  ]);

  assert.deepEqual(ingestion.accepted, []);
  assert.deepEqual(ingestion.rejected, [
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-4",
      gateRunId: "gate-4",
      reason: "empty_dimensions",
    },
  ]);
});

test("ingestGateVerdictCalibrationSignals maps aliases and keeps the stricter duplicate dimension outcome", () => {
  const ingestion = ingestGateVerdictCalibrationSignals([
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-5",
      gateRunId: "gate-5",
      optedIn: true,
      dimensions: [
        { dimension: "code_quality", outcome: "success" },
        { dimension: "correctness", outcome: "warning", confidence: 0.5 },
        { dimension: "workflow", outcome: "ok" },
        { dimension: "up-to-date", outcome: "advisory" },
      ],
    },
  ]);

  assert.deepEqual(
    ingestion.accepted[0]!.dimensions.map((dimension) => dimension.dimension),
    ["correctness", "freshness", "ci"],
  );
  assert.deepEqual(ingestion.accepted[0]!.dimensions[0], {
    dimension: "correctness",
    outcome: "warn",
    confidence: 0.5,
    score: 0.25,
  });
});

test("ingestGateVerdictCalibrationSignals normalizes malformed dates to null", () => {
  const ingestion = ingestGateVerdictCalibrationSignals([
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-6",
      gateRunId: "gate-6",
      optedIn: true,
      observedAt: "not a date",
      dimensions: [{ dimension: "correctness", outcome: "pass" }],
    },
  ]);

  assert.equal(ingestion.accepted[0]!.observedAt, null);
});

test("computeGateVerdictCompositeCalibrationScore combines objective-anchor, pairwise, and structured gate scores", () => {
  const objectiveAnchor = scoreObjectiveAnchor({
    replayed: { paths: ["src/review/a.ts"], labels: ["feature"] },
    revealed: { paths: ["src/review/b.ts"], labels: ["feature"] },
  });
  const pairwise = computePairwiseCalibrationScore({
    objectiveAnchor,
    samples: [{ attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] }],
  });
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor,
    pairwise,
    gateVerdicts: [
      {
        repoFullName: "JSONbored/Gittensory",
        replayRunId: "replay-7",
        gateRunId: "gate-7",
        optedIn: true,
        dimensions: [
          { dimension: "correctness", outcome: "pass" },
          { dimension: "tests", outcome: "warn" },
        ],
      },
    ],
    weights: { objectiveAnchor: 2, pairwiseJudge: 1, structuredGateVerdict: 1 },
  });

  assert.equal(objectiveAnchor.score, 0.55);
  assert.equal(pairwise.pairwiseJudgeScore, 1);
  assert.equal(result.structuredGateVerdictScore, 0.75);
  assert.deepEqual(result.weights, { objectiveAnchor: 0.5, pairwiseJudge: 0.25, structuredGateVerdict: 0.25 });
  assert.equal(result.compositeScore, 0.7125);
  assert.deepEqual(result.audit.contributingRepos.map((repo) => repo.repoFullName), ["jsonbored/gittensory"]);
});

test("computeGateVerdictCompositeCalibrationScore renormalizes when pairwise or structured signals are unavailable", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.6,
    pairwise: null,
    gateVerdicts: [],
    weights: { objectiveAnchor: 1, pairwiseJudge: 1, structuredGateVerdict: 1 },
  });

  assert.equal(result.compositeScore, 0.6);
  assert.deepEqual(result.weights, { objectiveAnchor: 1, pairwiseJudge: 0, structuredGateVerdict: 0 });
  assert.equal(result.pairwiseJudgeScore, null);
  assert.equal(result.structuredGateVerdictScore, null);
});

test("computeGateVerdictCompositeCalibrationScore carries rejected rows into the audit trail", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    gateVerdicts: [
      {
        repoFullName: "jsonbored/gittensory",
        replayRunId: "replay-8",
        gateRunId: "gate-8",
        optedIn: false,
        dimensions: [{ dimension: "correctness", outcome: "pass" }],
      },
    ],
  });

  assert.deepEqual(result.audit.contributingRepos, []);
  assert.deepEqual(result.audit.rejected, [
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-8",
      gateRunId: "gate-8",
      reason: "not_opted_in",
    },
  ]);
});

test("computeGateVerdictCompositeCalibrationScore averages multiple opted-in repos", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0,
    pairwise: null,
    gateVerdicts: [
      {
        repoFullName: "owner/one",
        replayRunId: "replay-9",
        gateRunId: "gate-9a",
        optedIn: true,
        dimensions: [{ dimension: "correctness", outcome: "pass" }],
      },
      {
        repoFullName: "owner/two",
        replayRunId: "replay-9",
        gateRunId: "gate-9b",
        optedIn: true,
        dimensions: [{ dimension: "correctness", outcome: "fail" }],
      },
    ],
    weights: { objectiveAnchor: 0, structuredGateVerdict: 1 },
  });

  assert.equal(result.structuredGateVerdictScore, 0.5);
  assert.equal(result.compositeScore, 0.5);
  assert.deepEqual(
    result.audit.contributingRepos.map((repo) => [repo.repoFullName, repo.score]),
    [
      ["owner/one", 1],
      ["owner/two", 0],
    ],
  );
});

test("computeGateVerdictCompositeCalibrationScore does not expose raw review text or private score fields", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    gateVerdicts: [
      {
        repoFullName: "jsonbored/gittensory",
        replayRunId: "replay-10",
        gateRunId: "gate-10",
        optedIn: true,
        dimensions: [
          { dimension: "correctness", outcome: "pass" },
          { dimension: "rawReviewText", outcome: "pass" },
          { dimension: "trustScore", outcome: "pass" },
          { dimension: "reward", outcome: "pass" },
        ],
      },
    ],
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("rawReviewText"), false);
  assert.equal(serialized.includes("trustScore"), false);
  assert.equal(serialized.includes("reward"), false);
  assert.equal(serialized.includes("private"), false);
});

test("renderGateVerdictCalibrationAuditMarkdown renders aggregate scores and contributing repo dimensions", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.75,
    gateVerdicts: [
      {
        repoFullName: "jsonbored/gittensory",
        replayRunId: "replay-11",
        gateRunId: "gate-11",
        optedIn: true,
        observedAt: "2026-07-04T17:30:00Z",
        dimensions: [
          { dimension: "correctness", outcome: "pass" },
          { dimension: "tests", outcome: "warn" },
        ],
      },
    ],
  });
  const markdown = renderGateVerdictCalibrationAuditMarkdown(result);

  assert.ok(markdown.startsWith("# Structured Gate-Verdict Calibration\n\nComposite score:"));
  assert.match(markdown, /## Component Scores\n\n- objectiveAnchor: 0\.500000\n- pairwiseJudge: 0\.750000/u);
  assert.match(markdown, /### jsonbored\/gittensory/u);
  assert.match(markdown, /\| correctness \| pass \| 1\.000000 \| 1\.000000 \|/u);
  assert.match(markdown, /\| tests \| warn \| 1\.000000 \| 0\.500000 \|/u);
});

test("renderGateVerdictCalibrationAuditMarkdown reports empty contributors and unavailable optional signals", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.7,
    pairwise: null,
    gateVerdicts: [],
  });
  const markdown = renderGateVerdictCalibrationAuditMarkdown(result);

  assert.match(markdown, /- pairwiseJudge: n\/a/u);
  assert.match(markdown, /- structuredGateVerdict: n\/a/u);
  assert.match(markdown, /_No opted-in structured gate-verdict signals contributed\._/u);
  assert.match(markdown, /## Rejected Rows\n\n- none/u);
});

test("renderGateVerdictCalibrationAuditMarkdown includes rejected rows for auditability", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    gateVerdicts: [
      {
        repoFullName: "jsonbored/gittensory",
        replayRunId: "replay-12",
        gateRunId: "gate-12",
        optedIn: false,
        dimensions: [{ dimension: "correctness", outcome: "pass" }],
      },
    ],
  });
  const markdown = renderGateVerdictCalibrationAuditMarkdown(result);

  assert.match(markdown, /\| Repo \| Replay run \| Gate run \| Reason \|/u);
  assert.match(markdown, /\| jsonbored\/gittensory \| replay-12 \| gate-12 \| not\\_opted\\_in \|/u);
});

test("renderGateVerdictCalibrationAuditMarkdown escapes markdown controls and collapses newlines", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    gateVerdicts: {
      accepted: [
        {
          repoFullName: "owner/repo_name",
          replayRunId: "replay-*bold*",
          gateRunId: "gate-`code`",
          observedAt: null,
          score: 1,
          dimensions: [{ dimension: "policy", outcome: "pass", confidence: 1, score: 1 }],
        },
      ],
      rejected: [],
    },
  });
  const markdown = renderGateVerdictCalibrationAuditMarkdown(result);

  assert.ok(markdown.includes("### owner/repo\\_name"));
  assert.ok(markdown.includes("- replayRunId: replay-\\*bold\\*"));
  assert.ok(markdown.includes("- gateRunId: gate-\\`code\\`"));
});

test("computeGateVerdictCompositeCalibrationScore sanitizes pre-ingested audit rows", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    gateVerdicts: {
      accepted: [
        {
          repoFullName: "JSONbored/Gittensory",
          replayRunId: " replay-13 ",
          gateRunId: "gate-13",
          observedAt: "not an ISO timestamp",
          score: 1,
          dimensions: [
            { dimension: "correctness", outcome: "pass", confidence: 1, rawReviewText: "private" },
            { dimension: "trustScore", outcome: "pass", confidence: 1, privateMetadata: "private" },
          ],
          rawReviewText: "private",
          trustScore: 99,
        },
      ],
      rejected: [
        {
          repoFullName: "JSONbored/Gittensory",
          replayRunId: "replay-13",
          gateRunId: "gate-13",
          reason: "not_opted_in",
          privateMetadata: "private",
        },
      ],
    },
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.structuredGateVerdictScore, 1);
  assert.deepEqual(result.audit.contributingRepos, [
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-13",
      gateRunId: "gate-13",
      observedAt: null,
      score: 1,
      dimensions: [{ dimension: "correctness", outcome: "pass", confidence: 1, score: 1 }],
    },
  ]);
  assert.deepEqual(result.audit.rejected, [
    {
      repoFullName: "jsonbored/gittensory",
      replayRunId: "replay-13",
      gateRunId: "gate-13",
      reason: "not_opted_in",
    },
  ]);
  assert.equal(serialized.includes("rawReviewText"), false);
  assert.equal(serialized.includes("privateMetadata"), false);
  assert.equal(serialized.includes("trustScore"), false);
  assert.equal(serialized.includes("private"), false);
});

test("computeGateVerdictCompositeCalibrationScore ignores malformed pre-ingested rows", () => {
  const result = computeGateVerdictCompositeCalibrationScore({
    objectiveAnchor: 0.5,
    pairwise: 0.5,
    gateVerdicts: {
      accepted: [
        {
          repoFullName: "not a repo",
          replayRunId: "replay-14",
          gateRunId: "gate-14",
          observedAt: "2026-07-04T17:00:00.000Z",
          score: 1,
          dimensions: [{ dimension: "correctness", outcome: "pass", confidence: 1 }],
        },
        {
          repoFullName: "jsonbored/gittensory",
          replayRunId: "replay-14",
          gateRunId: "gate-14",
          observedAt: "2026-07-04T17:00:00.000Z",
          score: 1,
          dimensions: [{ dimension: "rawReviewText", outcome: "private", confidence: 1 }],
        },
      ],
      rejected: [
        {
          repoFullName: "jsonbored/gittensory",
          replayRunId: "replay-14",
          gateRunId: "gate-14",
          reason: "privateMetadata",
        },
      ],
    },
  });

  assert.equal(result.structuredGateVerdictScore, null);
  assert.deepEqual(result.audit.contributingRepos, []);
  assert.deepEqual(result.audit.rejected, []);
});
