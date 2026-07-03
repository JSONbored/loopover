import { describe, expect, it } from "vitest";
import {
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
} from "../../packages/gittensory-engine/src/opportunity-metadata";
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
});
