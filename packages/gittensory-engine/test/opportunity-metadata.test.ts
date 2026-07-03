import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  computeOpportunityCompetition,
  computeOpportunityFreshness,
  rankMetadataOpportunities,
} from "../dist/index.js";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: "acme/widgets",
    issueNumber: 1,
    title: "Add retry helper",
    labels: ["help wanted"],
    commentsCount: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

test("barrel: metadata ranker exports are reachable", () => {
  assert.equal(typeof computeMetadataPotential, "function");
  assert.equal(typeof rankMetadataOpportunities, "function");
  assert.equal(typeof computeOpportunityFreshness, "function");
  assert.equal(typeof computeOpportunityCompetition, "function");
});

test("computeMetadataPotential: negative labels collapse to zero", () => {
  assert.equal(computeMetadataPotential({ labels: ["duplicate"] }), 0);
  assert.ok(computeMetadataPotential({ labels: ["help wanted"] }) > 0.7);
});

test("computeMetadataFeasibility: fresher, quieter issues score higher", () => {
  const fresh = computeMetadataFeasibility(candidate(), NOW);
  const stale = computeMetadataFeasibility(
    candidate({
      commentsCount: 40,
      updatedAt: "2024-01-01T00:00:00.000Z",
      title: "x",
    }),
    NOW,
  );
  assert.ok(fresh > stale);
});

test("computeMetadataDupRisk: overlapping titles in the same repo raise risk", () => {
  const peers = [
    candidate({ issueNumber: 2, title: "Add retry helper for queue pump" }),
    candidate({ issueNumber: 3, title: "Unrelated docs cleanup" }),
  ];
  assert.ok(computeMetadataDupRisk(candidate(), peers) > 0);
  assert.equal(computeMetadataDupRisk(candidate({ repoFullName: "acme/other" }), peers), 0);
});

test("buildMetadataRankInput: blocked labels zero lane fit and therefore rank score inputs", () => {
  const input = buildMetadataRankInput(
    candidate({ labels: ["blocked", "help wanted"] }),
    [candidate()],
    {
      nowMs: NOW,
      goalSpecsByRepo: {
        "acme/widgets": {
          minerEnabled: true,
          wantedPaths: [],
          blockedPaths: [],
          preferredLabels: [],
          blockedLabels: ["blocked"],
          maxConcurrentClaims: 1,
          issueDiscoveryPolicy: "neutral",
        },
      },
    },
  );
  assert.equal(input.laneFit, 0);
  assert.ok(input.freshness > 0.5);
});

test("rankMetadataOpportunities: sorts candidates by descending rankScore", () => {
  const ranked = rankMetadataOpportunities(
    [
      candidate({ issueNumber: 1, labels: ["question"] }),
      candidate({ issueNumber: 2, labels: ["help wanted", "good first issue"] }),
      candidate({ issueNumber: 3, labels: ["enhancement"] }),
    ],
    { nowMs: NOW },
  );
  assert.equal(ranked[0]?.issueNumber, 2);
  assert.ok((ranked[0]?.rankScore ?? 0) >= (ranked[1]?.rankScore ?? 0));
});

test("computeOpportunityFreshness and computeOpportunityCompetition mirror hosted decay curves", () => {
  assert.equal(computeOpportunityFreshness([], NOW), 0);
  assert.ok(
    computeOpportunityFreshness(
      [{ state: "open", updatedAt: "2026-07-03T00:00:00.000Z" }],
      NOW,
    ) > 0.8,
  );
  assert.equal(computeOpportunityCompetition(2, 4), 0.5);
});
