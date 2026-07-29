import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MINER_GOAL_SPEC,
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "../dist/index.js";
import { opportunityMetadataInternals } from "../dist/opportunity-metadata.js";

// #9616: direct unit tests for every branch the file's blanket `v8 ignore` directives used to hide.
// The scoring formulas themselves are untouched -- these tests pin the thresholds, label bonuses, and
// filters so a future change to any of them fails a test instead of vanishing behind a suppression.

const NOW_ISO = "2026-07-29T00:00:00Z";
const NOW = Date.parse(NOW_ISO);

function issueFor(overrides: Partial<MetadataCandidateIssue> = {}): MetadataCandidateIssue {
  return {
    repoFullName: "acme/widgets",
    issueNumber: 1,
    title: "improve the flaky retry logic in ci",
    labels: [],
    commentsCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !~ ${expected}`);
}

test("computeMetadataPotential: label tiers -- negative collapse, positive/bug/refactor bonuses, neutral baseline", () => {
  // A negative label collapses to 0, even alongside positive ones (short-circuit).
  assert.equal(computeMetadataPotential({ labels: ["blocked"] }), 0);
  assert.equal(computeMetadataPotential({ labels: ["help wanted", "wontfix"] }), 0);
  // Neutral-only labels keep the 0.45 baseline.
  assertClose(computeMetadataPotential({ labels: ["chore"] }), 0.45);
  assertClose(computeMetadataPotential({ labels: [] }), 0.45);
  // Positive label bonus.
  assertClose(computeMetadataPotential({ labels: ["help wanted"] }), 0.8);
  // Bug and refactor bonuses, separately and together.
  assertClose(computeMetadataPotential({ labels: ["bug"] }), 0.55);
  assertClose(computeMetadataPotential({ labels: ["refactor"] }), 0.5);
  assertClose(computeMetadataPotential({ labels: ["bug", "refactor"] }), 0.6);
  assertClose(computeMetadataPotential({ labels: ["good first issue", "bug", "refactor"] }), 0.95);
});

test("computeMetadataPotential: labels are normalized -- trims, lowercases, drops non-strings and blanks", () => {
  assertClose(computeMetadataPotential({ labels: ["  BUG  "] }), 0.55);
  assertClose(computeMetadataPotential({ labels: ["", "   ", 7, null] as never }), 0.45);
});

test("computeMetadataFeasibility: a non-finite clock degrades to zero feasibility", () => {
  assert.equal(computeMetadataFeasibility(issueFor(), Number.NaN), 0);
  assert.equal(computeMetadataFeasibility(issueFor(), Number.POSITIVE_INFINITY), 0);
});

test("computeMetadataFeasibility: title-length tiers at >= 8, 4-7, and < 4 (normalized length)", () => {
  // Fresh issue, zero comments: commentScore 1 and ageScore 1, so the tier is the only variable.
  assertClose(computeMetadataFeasibility(issueFor({ title: "abcdefgh" }), NOW), 1);
  assertClose(computeMetadataFeasibility(issueFor({ title: "abcd" }), NOW), 0.94);
  assertClose(computeMetadataFeasibility(issueFor({ title: "abc" }), NOW), 0.88);
  // normalizeTitle collapses interior whitespace before measuring: "  a   b  " -> "a b" (length 3).
  assertClose(computeMetadataFeasibility(issueFor({ title: "  a   b  " }), NOW), 0.88);
});

test("computeMetadataFeasibility: comment load and timestamp fallbacks", () => {
  // 25+ comments zero out the comment score.
  assertClose(computeMetadataFeasibility(issueFor({ commentsCount: 25 }), NOW), 0.35 + 0.2);
  // A non-finite comment count is normalized to 0, not propagated.
  assert.equal(
    computeMetadataFeasibility(issueFor({ commentsCount: Number.NaN }), NOW),
    computeMetadataFeasibility(issueFor({ commentsCount: 0 }), NOW),
  );
  assert.equal(
    computeMetadataFeasibility(issueFor({ commentsCount: -3 }), NOW),
    computeMetadataFeasibility(issueFor({ commentsCount: 0 }), NOW),
  );
  // No parseable timestamp at all: the stale-age sentinel zeroes the age term.
  assertClose(computeMetadataFeasibility(issueFor({ updatedAt: null, createdAt: null }), NOW), 0.65);
  // An unparseable updatedAt falls back to a valid createdAt instead of shadowing it.
  assertClose(computeMetadataFeasibility(issueFor({ updatedAt: "not a date", createdAt: NOW_ISO }), NOW), 1);
});

test("computeMetadataFeasibility: a validated timestamp that later fails to re-parse hits the stale sentinel (defensive guard)", () => {
  // pickMetadataTimestamp validates with the same parser issueAgeDays re-parses with, so the re-parse
  // guard can only be exercised by making the parser itself disagree between the two calls.
  const realParse = Date.parse;
  let calls = 0;
  Date.parse = ((value: string) => {
    calls += 1;
    return calls === 1 ? realParse(value) : Number.NaN;
  }) as typeof Date.parse;
  try {
    const reparseFailed = computeMetadataFeasibility(issueFor(), NOW);
    const noTimestamps = computeMetadataFeasibility(issueFor({ updatedAt: null, createdAt: null }), NOW);
    assert.equal(reparseFailed, noTimestamps);
    assert.equal(calls, 2);
  } finally {
    Date.parse = realParse;
  }
});

test("computeMetadataFeasibility: a non-finite intermediate score clamps to zero (clamp01 defensive guard)", () => {
  // Every natural input reaching clamp01 is finite, so the guard is exercised by making the age
  // exponential itself misbehave.
  const realExp = Math.exp;
  Math.exp = (() => Number.NaN) as typeof Math.exp;
  try {
    assertClose(computeMetadataFeasibility(issueFor(), NOW), 0.45 + 0.2);
  } finally {
    Math.exp = realExp;
  }
});

test("titlesOverlap: emptiness, equality, containment threshold, and swap arms", () => {
  const { titlesOverlap } = opportunityMetadataInternals;
  assert.equal(titlesOverlap("", "anything"), false);
  assert.equal(titlesOverlap("anything", ""), false);
  assert.equal(titlesOverlap("same words", "same words"), true);
  // Containment counts only when the shorter title is >= 12 chars.
  assert.equal(titlesOverlap("fix the retry logic", "please fix the retry logic now"), true);
  assert.equal(titlesOverlap("short one", "short one plus context"), false);
  // Swap arm: left longer than right.
  assert.equal(titlesOverlap("please fix the retry logic now", "fix the retry logic"), true);
  // Long enough on both sides but no containment.
  assert.equal(titlesOverlap("abcdefghijklmnop", "qrstuvwxyz0123456789"), false);
});

test("normalizeLabels / pickMetadataTimestamp / resolveGoalSpec internals cover their normalization arms", () => {
  const { normalizeLabels, pickMetadataTimestamp, resolveGoalSpec } = opportunityMetadataInternals;
  assert.deepEqual(normalizeLabels(["  Bug ", "", 7, null] as never), ["bug"]);

  assert.equal(pickMetadataTimestamp(issueFor()), NOW_ISO);
  assert.equal(pickMetadataTimestamp(issueFor({ updatedAt: `  ${NOW_ISO}  ` })), NOW_ISO);
  assert.equal(pickMetadataTimestamp(issueFor({ updatedAt: "not a date", createdAt: NOW_ISO })), NOW_ISO);
  assert.equal(pickMetadataTimestamp(issueFor({ updatedAt: "   ", createdAt: "   " })), "");
  assert.equal(pickMetadataTimestamp(issueFor({ updatedAt: null, createdAt: "garbage" })), "");
  assert.equal(pickMetadataTimestamp(issueFor({ updatedAt: null, createdAt: null })), "");

  const custom = { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false };
  const context: MetadataRankContext = { nowMs: NOW, goalSpecsByRepo: { "  ACME/Widgets  ": custom } };
  assert.equal(resolveGoalSpec("acme/widgets", context), custom);
  assert.equal(resolveGoalSpec("other/repo", context), DEFAULT_MINER_GOAL_SPEC);
  assert.equal(resolveGoalSpec("acme/widgets", { nowMs: NOW }), DEFAULT_MINER_GOAL_SPEC);
});

test("computeMetadataDupRisk: blank titles, peer filters, and overlap accumulation", () => {
  // A blank (or whitespace-only) title is maximum dup risk.
  assert.equal(computeMetadataDupRisk(issueFor({ title: "" }), []), 1);
  assert.equal(computeMetadataDupRisk(issueFor({ title: "   " }), []), 1);
  // The issue's own batch row is skipped, including with repo-name case/whitespace variance.
  assert.equal(computeMetadataDupRisk(issueFor(), [issueFor({ repoFullName: "  ACME/Widgets  " })]), 0);
  // Same issue number in a DIFFERENT repo is not self -- it falls through to the cross-repo skip.
  assert.equal(computeMetadataDupRisk(issueFor(), [issueFor({ repoFullName: "other/repo" })]), 0);
  // Cross-repo peers never count, even with identical titles.
  assert.equal(computeMetadataDupRisk(issueFor(), [issueFor({ repoFullName: "other/repo", issueNumber: 9 })]), 0);
  // A same-repo peer with an overlapping title raises the risk: 1 overlap -> 1/2.
  const overlapping = issueFor({ issueNumber: 2, title: "Improve the flaky retry logic in CI for the queue" });
  assertClose(computeMetadataDupRisk(issueFor(), [overlapping]), 0.5);
  // Two overlapping peers -> 2/3.
  const second = issueFor({ issueNumber: 3, title: "improve the flaky retry logic in ci again" });
  assertClose(computeMetadataDupRisk(issueFor(), [overlapping, second]), 2 / 3);
  // Same-repo peers with unrelated titles keep the risk at zero.
  assert.equal(computeMetadataDupRisk(issueFor(), [issueFor({ issueNumber: 4, title: "completely unrelated words" })]), 0);
});

test("buildMetadataRankInput: competition context present and absent, timestamps present and absent", () => {
  const withContext = buildMetadataRankInput(issueFor({ labels: ["bug"] }), [], {
    nowMs: NOW,
    highRiskDuplicateClusters: 2,
    openPullRequests: 4,
  });
  assertClose(withContext.potential, 0.55);
  assertClose(withContext.feasibility, 1);
  // dupRisk = max(batch 0, competition 2/4).
  assertClose(withContext.dupRisk, 0.5);
  assert.ok(withContext.laneFit >= 0 && withContext.laneFit <= 1);
  assert.ok(withContext.freshness >= 0 && withContext.freshness <= 1);

  const bare = buildMetadataRankInput(issueFor({ updatedAt: null, createdAt: null }), [], { nowMs: NOW });
  assert.equal(bare.dupRisk, 0);
  assert.ok(bare.freshness >= 0 && bare.freshness <= 1);
});

test("rankMetadataOpportunities: ranks targetable candidates and drops repos whose goal spec opts out", () => {
  const strong = issueFor({ issueNumber: 10, title: "add retry backoff to the queue worker", labels: ["help wanted", "bug"] });
  const weak = issueFor({ issueNumber: 11, title: "abc", labels: ["chore"], commentsCount: 40, updatedAt: null, createdAt: null });
  const ranked = rankMetadataOpportunities([strong, weak], { nowMs: NOW });
  assert.equal(ranked.length, 2);
  assert.equal(typeof ranked[0]?.rankScore, "number");
  assert.ok((ranked[0]?.rankScore ?? 0) >= (ranked[1]?.rankScore ?? 0));
  assert.equal(ranked[0]?.issueNumber, 10);

  const optedOut = rankMetadataOpportunities([strong, issueFor({ repoFullName: "other/repo", issueNumber: 12 })], {
    nowMs: NOW,
    goalSpecsByRepo: { "acme/widgets": { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false } },
  });
  assert.deepEqual(optedOut.map((candidate) => candidate.issueNumber), [12]);
});
