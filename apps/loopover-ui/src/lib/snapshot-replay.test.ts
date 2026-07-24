import { describe, expect, it } from "vitest";

import { buildSnapshotReplayView, type SnapshotReplayView } from "@/lib/snapshot-replay";

// (#8386) Regression coverage for the public/authenticated privacy boundary in the decision snapshot
// replay view model — the module is intentionally standalone so these tests exercise it directly.

const PRIVATE_REASON = "PRIVATE_REASON_DO_NOT_LEAK";
const PRIVATE_FACT = "PRIVATE_FACT_DO_NOT_LEAK";
const PRIVATE_ASSUMPTION = "PRIVATE_ASSUMPTION_DO_NOT_LEAK";

function freshProvenance(overrides: Record<string, unknown> = {}) {
  return {
    confidence: "high",
    freshness: "fresh",
    scoringModelId: "model-1",
    evidenceComplete: true,
    evidenceGaps: [],
    sources: [{ name: "signals", freshness: "fresh", generatedAt: "2026-01-01T00:00:00.000Z" }],
    ...overrides,
  };
}

function baseSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: "snap-1",
    actionType: "comment",
    target: { repoFullName: "Acme/Widget", pullNumber: 7, issueNumber: null },
    generatedAt: "2026-06-01T12:00:00.000Z",
    provenance: freshProvenance(),
    ...overrides,
  };
}

function counterfactualFixture(overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: "Acme/Widget",
    recommendation: "approve",
    rejectedAlternatives: [
      {
        alternative: "request_changes",
        group: "verdict",
        publicSummary: "Public-safe summary only.",
        reason: PRIVATE_REASON,
        facts: [PRIVATE_FACT],
        assumptions: [PRIVATE_ASSUMPTION],
      },
    ],
    ...overrides,
  };
}

function expectNoPrivateLeak(view: SnapshotReplayView) {
  const serialized = JSON.stringify(view);
  expect(serialized).not.toContain(PRIVATE_REASON);
  expect(serialized).not.toContain(PRIVATE_FACT);
  expect(serialized).not.toContain(PRIVATE_ASSUMPTION);
  for (const cf of view.counterfactuals) {
    for (const alt of cf.alternatives) {
      expect(alt.reason).toBeNull();
      expect(alt.facts).toEqual([]);
      expect(alt.assumptions).toEqual([]);
    }
  }
}

describe("buildSnapshotReplayView privacy boundary (#8386)", () => {
  it("strips reason/facts/assumptions for public viewers and records withheldPrivateFields", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot(),
      counterfactuals: [counterfactualFixture()],
    });

    expect(view.viewer).toBe("public");
    expect(view.withheldPrivateFields).toEqual(["counterfactual_detail"]);
    expect(view.counterfactuals).toHaveLength(1);
    expect(view.counterfactuals[0]!.alternatives[0]).toMatchObject({
      publicSummary: "Public-safe summary only.",
      reason: null,
      facts: [],
      assumptions: [],
    });
    expectNoPrivateLeak(view);
  });

  it("sets withheldPrivateFields to [] for public viewers when alternatives carry no private detail", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot(),
      counterfactuals: [
        {
          repoFullName: "Acme/Widget",
          recommendation: "approve",
          rejectedAlternatives: [
            {
              alternative: "comment",
              group: "verdict",
              publicSummary: "Only public summary.",
              reason: null,
              facts: [],
              assumptions: [],
            },
          ],
        },
      ],
    });

    expect(view.withheldPrivateFields).toEqual([]);
    expect(view.counterfactuals[0]!.alternatives[0]!.reason).toBeNull();
  });

  it("passes counterfactuals through unchanged for authenticated viewers", () => {
    const view = buildSnapshotReplayView({
      viewer: "authenticated",
      snapshot: baseSnapshot(),
      counterfactuals: [counterfactualFixture()],
    });

    expect(view.viewer).toBe("authenticated");
    expect(view.withheldPrivateFields).toEqual([]);
    expect(view.counterfactuals[0]!.alternatives[0]).toMatchObject({
      reason: PRIVATE_REASON,
      facts: [PRIVATE_FACT],
      assumptions: [PRIVATE_ASSUMPTION],
    });
  });
});

describe("buildSnapshotReplayView missing / partial snapshots (#8386)", () => {
  it("returns missing status when snapshot is not a record", () => {
    for (const snapshot of [null, undefined, "snap", 12, []]) {
      const view = buildSnapshotReplayView({ viewer: "public", snapshot });
      expect(view.status).toBe("missing");
      expect(view.notice).toContain("No decision snapshot");
      expect(view.snapshotId).toBeNull();
    }
  });

  it("returns missing when provenance is absent but still carries through top-level snapshot fields", () => {
    const view = buildSnapshotReplayView({
      viewer: "authenticated",
      snapshot: {
        snapshotId: "snap-partial",
        actionType: "approve",
        target: { repoFullName: "Org/Repo", pullNumber: 3, issueNumber: 9 },
        generatedAt: "2026-07-01T00:00:00.000Z",
        provenance: null,
      },
    });

    expect(view.status).toBe("missing");
    expect(view.notice).toContain("no provenance");
    expect(view.snapshotId).toBe("snap-partial");
    expect(view.actionType).toBe("approve");
    expect(view.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(view.target).toEqual({ repoFullName: "Org/Repo", pullNumber: 3, issueNumber: 9 });
  });
});

describe("buildSnapshotReplayView status / freshness (#8386)", () => {
  it("is populated when freshness is fresh, evidence is complete, and gaps are empty", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot(),
    });
    expect(view.status).toBe("populated");
    expect(view.staleReasons).toEqual([]);
    expect(view.notice).toContain("fresh and complete");
  });

  it("is stale when freshness is not fresh", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot({ provenance: freshProvenance({ freshness: "stale" }) }),
    });
    expect(view.status).toBe("stale");
    expect(view.staleReasons).toContain("Snapshot freshness is stale.");
  });

  it("is stale when evidenceComplete is false", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot({ provenance: freshProvenance({ evidenceComplete: false }) }),
    });
    expect(view.status).toBe("stale");
    expect(view.staleReasons).toContain("Evidence is incomplete.");
  });

  it("is stale when evidenceGaps is non-empty", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot({
        provenance: freshProvenance({ evidenceGaps: ["missing_diff"] }),
      }),
    });
    expect(view.status).toBe("stale");
    expect(view.staleReasons).toContain("Evidence gap — missing_diff.");
    expect(view.notice).toMatch(/1 evidence caveat[^s]/);
  });

  it("pluralizes the stale notice when multiple caveats apply", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot({
        provenance: freshProvenance({
          freshness: "degraded",
          evidenceComplete: false,
          evidenceGaps: ["a", "b"],
        }),
      }),
    });
    expect(view.status).toBe("stale");
    expect(view.staleReasons.length).toBeGreaterThan(1);
    expect(view.notice).toMatch(/evidence caveats/);
  });
});

describe("buildSnapshotReplayView counterfactual filtering + narrowing (#8386)", () => {
  it("filters counterfactuals to the matching target repo case-insensitively", () => {
    const view = buildSnapshotReplayView({
      viewer: "authenticated",
      snapshot: baseSnapshot({
        target: { repoFullName: "acme/widget", pullNumber: null, issueNumber: null },
      }),
      counterfactuals: [
        counterfactualFixture({ repoFullName: "ACME/WIDGET" }),
        counterfactualFixture({
          repoFullName: "Other/Repo",
          rejectedAlternatives: [
            {
              alternative: "other",
              group: "verdict",
              publicSummary: "Other repo alternative",
              reason: "x",
              facts: [],
              assumptions: [],
            },
          ],
        }),
      ],
    });

    expect(view.counterfactuals).toHaveLength(1);
    expect(view.counterfactuals[0]!.repoFullName).toBe("ACME/WIDGET");
  });

  it("keeps all counterfactual entries when target repoFullName is null", () => {
    const view = buildSnapshotReplayView({
      viewer: "authenticated",
      snapshot: baseSnapshot({
        target: { repoFullName: null, pullNumber: null, issueNumber: null },
      }),
      counterfactuals: [
        counterfactualFixture({ repoFullName: "One/Repo" }),
        counterfactualFixture({
          repoFullName: "Two/Repo",
          rejectedAlternatives: [
            {
              alternative: "other",
              group: "verdict",
              publicSummary: "Second",
              reason: "y",
              facts: [],
              assumptions: [],
            },
          ],
        }),
      ],
    });

    expect(view.counterfactuals.map((cf) => cf.repoFullName).sort()).toEqual([
      "One/Repo",
      "Two/Repo",
    ]);
  });

  it("narrows unknown confidence and freshness strings to unknown", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot({
        provenance: freshProvenance({
          confidence: "super-high",
          freshness: "brand-new",
          // Keep status populated/stale deterministic: unknown freshness is not "fresh", so stale.
          evidenceComplete: true,
          evidenceGaps: [],
        }),
      }),
    });

    expect(view.confidence).toBe("unknown");
    expect(view.freshness).toBe("unknown");
    expect(view.status).toBe("stale");
  });

  it("accepts known confidence/freshness values without rewriting them", () => {
    const view = buildSnapshotReplayView({
      viewer: "public",
      snapshot: baseSnapshot({
        provenance: freshProvenance({ confidence: "medium", freshness: "fresh" }),
      }),
    });
    expect(view.confidence).toBe("medium");
    expect(view.freshness).toBe("fresh");
    expect(view.status).toBe("populated");
  });
});
