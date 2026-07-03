import { describe, expect, it } from "vitest";
import {
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
} from "../../packages/gittensory-engine/src/opportunity-metadata";
import { DEFAULT_MINER_GOAL_SPEC } from "../../packages/gittensory-engine/src/miner-goal-spec";
import { computeOpportunityCompetition } from "../../packages/gittensory-engine/src/opportunity-competition";
import { computeOpportunityFreshness } from "../../packages/gittensory-engine/src/opportunity-freshness";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

const base = {
  repoFullName: "acme/widgets",
  issueNumber: 10,
  title: "Improve queue retry semantics",
  labels: ["help wanted"],
  commentsCount: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T12:00:00.000Z",
};

describe("opportunity metadata signals", () => {
  it("potential rewards contribution-friendly labels and rejects terminal labels", () => {
    expect(computeMetadataPotential({ labels: ["wontfix"] })).toBe(0);
    expect(computeMetadataPotential({ labels: ["help wanted", "bug"] })).toBeGreaterThan(0.7);
    expect(computeMetadataPotential({ labels: [] })).toBeCloseTo(0.45, 5);
  });

  it("feasibility degrades for noisy or stale metadata", () => {
    const quiet = computeMetadataFeasibility(base, NOW);
    const noisy = computeMetadataFeasibility(
      { ...base, commentsCount: 99, updatedAt: "2023-01-01T00:00:00.000Z", title: "x" },
      NOW,
    );
    expect(quiet).toBeGreaterThan(noisy);
    expect(computeMetadataFeasibility(base, Number.NaN)).toBe(0);
  });

  it("dupRisk only counts same-repo title overlaps and ignores short titles", () => {
    const peers = [
      { ...base, issueNumber: 11, title: "Improve queue retry semantics for pump" },
      { ...base, issueNumber: 12, title: "Docs typo" },
    ];
    expect(computeMetadataDupRisk(base, peers)).toBeGreaterThan(0);
    expect(computeMetadataDupRisk({ ...base, title: "ab" }, peers)).toBe(0);
    expect(computeMetadataDupRisk({ ...base, repoFullName: "acme/other" }, peers)).toBe(0);
  });

  it("buildMetadataRankInput applies repo-specific goal specs case-insensitively", () => {
    const input = buildMetadataRankInput(
      { ...base, labels: ["feature"] },
      [base],
      {
        nowMs: NOW,
        goalSpecsByRepo: {
          "ACME/Widgets": {
            minerEnabled: true,
            wantedPaths: [],
            blockedPaths: [],
            preferredLabels: ["feature"],
            blockedLabels: [],
            maxConcurrentClaims: 1,
            issueDiscoveryPolicy: "encouraged",
          },
        },
      },
    );
    expect(input.laneFit).toBeGreaterThanOrEqual(0.85);
    expect(input.potential).toBeGreaterThan(0);
  });

  it("rankMetadataOpportunities keeps deterministic ordering for ties", () => {
    const tie = { potential: 0.8, feasibility: 0.8, laneFit: 1, freshness: 1, dupRisk: 0 };
    const ranked = rankMetadataOpportunities(
      [
        { ...base, issueNumber: 1, ...tie },
        { ...base, issueNumber: 2, ...tie },
      ],
      { nowMs: NOW },
    );
    expect(ranked.map((entry) => entry.issueNumber)).toEqual([1, 2]);
  });

  it("freshness and competition helpers stay pure with injected clocks and safe inputs", () => {
    expect(computeOpportunityFreshness([{ state: "closed", updatedAt: "2026-07-03T00:00:00.000Z" }], NOW)).toBe(0);
    expect(computeOpportunityCompetition(Number.NaN, 3)).toBe(0);
    expect(computeOpportunityCompetition(1, 0)).toBe(1);
    expect(computeOpportunityFreshness([{ state: "open", updatedAt: "2026-07-03T00:00:00.000Z" }], NOW)).toBeGreaterThan(
      0.8,
    );
    expect(
      computeOpportunityFreshness([{ state: "open", createdAt: "not-a-date", updatedAt: "also-bad" }], NOW),
    ).toBe(0.05);
  });

  it("buildMetadataRankInput uses repo competition when it exceeds batch overlap", () => {
    const input = buildMetadataRankInput(base, [base], {
      nowMs: NOW,
      highRiskDuplicateClusters: 5,
      openPullRequests: 5,
    });
    expect(input.dupRisk).toBe(1);
  });

  it("computeMetadataPotential adds a small bonus for refactor-labeled work", () => {
    const baseline = computeMetadataPotential({ labels: [] });
    const refactor = computeMetadataPotential({ labels: ["refactor"] });
    expect(refactor).toBeGreaterThan(baseline);
  });

  it("covers feasibility title-length branches and invalid issue timestamps", () => {
    expect(
      computeMetadataFeasibility(
        { ...base, title: "abcd", commentsCount: Number.NaN, updatedAt: "not-a-date" },
        NOW,
      ),
    ).toBeGreaterThan(0);
    expect(computeMetadataFeasibility({ ...base, title: "abc" }, NOW)).toBeLessThan(
      computeMetadataFeasibility({ ...base, title: "abcdefgh" }, NOW),
    );
    expect(
      computeMetadataFeasibility({ ...base, updatedAt: null, createdAt: "2026-07-03T00:00:00.000Z" }, NOW),
    ).toBeGreaterThan(0);
    expect(
      computeMetadataFeasibility({ ...base, updatedAt: "not-a-date", createdAt: null }, NOW),
    ).toBeLessThan(computeMetadataFeasibility(base, NOW));
  });

  it("treats blank titles as maximum dup risk and exact title matches as overlaps", () => {
    const peers = [{ ...base, issueNumber: 11, title: base.title }];
    expect(computeMetadataDupRisk({ ...base, title: "   " }, peers)).toBe(1);
    expect(computeMetadataDupRisk(base, peers)).toBeGreaterThan(0);
  });

  it("ignores non-string labels and uses createdAt when updatedAt is absent for freshness", () => {
    const input = buildMetadataRankInput(
      {
        ...base,
        labels: [null as unknown as string, "  BUG  "],
        updatedAt: null,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
      [base],
      { nowMs: NOW },
    );
    expect(input.potential).toBeGreaterThan(0.5);
    expect(input.freshness).toBeGreaterThan(0.8);
    expect(computeOpportunityFreshness([], Number.NaN)).toBe(0);
    expect(
      computeOpportunityFreshness([{ state: "open", createdAt: "2026-07-03T00:00:00.000Z" }], NOW),
    ).toBeGreaterThan(0.8);
  });

  it("only counts substring overlaps when the shared segment is at least 12 characters", () => {
    const shared = "queue retry helper";
    expect(
      computeMetadataDupRisk(
        { ...base, title: `${shared} for worker` },
        [{ ...base, issueNumber: 11, title: shared }],
      ),
    ).toBeGreaterThan(0);
    expect(
      computeMetadataDupRisk(
        { ...base, title: "tiny" },
        [{ ...base, issueNumber: 11, title: "tiny extra" }],
      ),
    ).toBe(0);
  });

  it("combines bug and positive labels without exceeding one", () => {
    expect(computeMetadataPotential({ labels: ["help wanted", "bug"] })).toBeLessThanOrEqual(1);
    expect(buildMetadataRankInput(base, [base], { nowMs: NOW }).dupRisk).toBe(0);
  });

  it("matches duplicate titles case-insensitively within the same repo slug", () => {
    expect(
      computeMetadataDupRisk(
        { ...base, repoFullName: "Acme/Widgets", title: "Queue Retry Helper" },
        [{ ...base, repoFullName: "acme/widgets", issueNumber: 11, title: "queue retry helper" }],
      ),
    ).toBeGreaterThan(0);
  });

  it("uses the higher of batch overlap and repo-level competition for dupRisk", () => {
    const crowded = buildMetadataRankInput(
      { ...base, title: "queue retry helper for workers" },
      [base, { ...base, issueNumber: 2, title: "queue retry helper" }],
      { nowMs: NOW, highRiskDuplicateClusters: 4, openPullRequests: 4 },
    );
    const overlapOnly = buildMetadataRankInput(
      { ...base, title: "queue retry helper for workers" },
      [base, { ...base, issueNumber: 2, title: "queue retry helper" }],
      { nowMs: NOW, highRiskDuplicateClusters: 0, openPullRequests: 10 },
    );
    expect(crowded.dupRisk).toBe(1);
    expect(overlapOnly.dupRisk).toBeGreaterThan(0);
  });

  it("ranks an empty metadata list without error", () => {
    expect(rankMetadataOpportunities([], { nowMs: NOW })).toEqual([]);
  });

  it("covers remaining label, goal-spec, and overlap branches", () => {
    expect(computeMetadataPotential({ labels: ["bug"] })).toBeCloseTo(0.55, 5);
    expect(computeMetadataPotential({ labels: ["documentation"] })).toBeCloseTo(0.8, 5);
    expect(computeMetadataPotential({ labels: ["good first issue"] })).toBeCloseTo(0.8, 5);
    expect(
      computeMetadataDupRisk(
        { ...base, title: "queue retry helper" },
        [{ ...base, issueNumber: 11, title: "queue retry helper for workers" }],
      ),
    ).toBeGreaterThan(0);
    expect(
      computeMetadataDupRisk(
        { ...base, title: "alpha beta gamma" },
        [{ ...base, issueNumber: 11, title: "delta epsilon zeta" }],
      ),
    ).toBe(0);
    expect(computeMetadataFeasibility({ ...base, title: "1234" }, NOW)).toBeGreaterThan(
      computeMetadataFeasibility({ ...base, title: "123" }, NOW),
    );
    expect(
      buildMetadataRankInput(base, [base], {
        nowMs: NOW,
        goalSpecsByRepo: { "other/repo": DEFAULT_MINER_GOAL_SPEC },
      }).laneFit,
    ).toBeGreaterThan(0);
    expect(
      computeMetadataDupRisk(
        { ...base, title: "unique discovery target title" },
        [{ ...base, issueNumber: 11, title: "   " }],
      ),
    ).toBe(0);
    expect(
      computeMetadataDupRisk(
        { ...base, title: "queue retry helper" },
        [
          { ...base, issueNumber: 11, title: "queue retry helper" },
          { ...base, issueNumber: 12, title: "queue retry helper" },
        ],
      ),
    ).toBeGreaterThan(0.5);
  });

  it("potential covers neutral, positive-only, and bonus label branches", () => {
    expect(computeMetadataPotential({ labels: ["enhancement"] })).toBeCloseTo(0.8, 5);
    expect(computeMetadataPotential({ labels: ["feature"] })).toBeCloseTo(0.8, 5);
    expect(computeMetadataPotential({ labels: ["refactor"] })).toBeCloseTo(0.5, 5);
  });
});
