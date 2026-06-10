import { describe, expect, it } from "vitest";

import { buildSnapshotReplayView } from "../../apps/gittensory-ui/src/lib/snapshot-replay";

describe("buildSnapshotReplayView", () => {
  it("renders a populated replay from fresh, complete provenance", () => {
    const view = buildSnapshotReplayView({ snapshot: snapshot(), viewer: "authenticated" });
    expect(view.status).toBe("populated");
    expect(view.notice).toBe("All replayed evidence is fresh and complete.");
    expect(view.snapshotId).toBe("recommendation:context-1:run-1:00:choose_next_work");
    expect(view.actionType).toBe("choose_next_work");
    expect(view.confidence).toBe("high");
    expect(view.freshness).toBe("fresh");
    expect(view.scoringModelId).toBe("scoring-1");
    expect(view.target).toEqual({ repoFullName: "JSONbored/gittensory", pullNumber: 12, issueNumber: null });
    expect(view.sources).toEqual([
      { name: "contributor_decision_pack", freshness: "fresh", generatedAt: "2026-06-08T00:00:00.000Z" },
    ]);
    expect(view.evidenceComplete).toBe(true);
    expect(view.staleReasons).toEqual([]);
  });

  it("marks stale freshness, incomplete evidence, and gaps as explicit caveats", () => {
    const view = buildSnapshotReplayView({
      snapshot: snapshot({
        provenance: provenance({
          freshness: "stale",
          evidenceComplete: false,
          evidenceGaps: ["official_contributor_stats: missing"],
          sources: [{ name: "official_contributor_stats", freshness: "missing", generatedAt: null }],
        }),
      }),
      viewer: "authenticated",
    });
    expect(view.status).toBe("stale");
    expect(view.staleReasons).toEqual([
      "Snapshot freshness is stale.",
      "Evidence is incomplete.",
      "Evidence gap — official_contributor_stats: missing.",
    ]);
    expect(view.notice).toBe("Replaying with 3 evidence caveats.");
  });

  it("returns a missing view when the snapshot is absent or malformed", () => {
    for (const bad of [null, undefined, "nope", 42, []] as unknown[]) {
      const view = buildSnapshotReplayView({ snapshot: bad, viewer: "authenticated" });
      expect(view.status).toBe("missing");
      expect(view.notice).toBe("No decision snapshot is available to replay.");
    }
  });

  it("returns a missing view but preserves identity when provenance is absent", () => {
    const view = buildSnapshotReplayView({
      snapshot: snapshot({ provenance: undefined }),
      viewer: "authenticated",
    });
    expect(view.status).toBe("missing");
    expect(view.notice).toBe("This snapshot has no provenance to replay.");
    expect(view.snapshotId).toBe("recommendation:context-1:run-1:00:choose_next_work");
    expect(view.actionType).toBe("choose_next_work");
    expect(view.target.repoFullName).toBe("JSONbored/gittensory");
  });

  it("shows private counterfactual detail for authenticated viewers", () => {
    const view = buildSnapshotReplayView({
      snapshot: snapshot(),
      counterfactuals: counterfactuals(),
      viewer: "authenticated",
    });
    expect(view.counterfactuals).toEqual([
      {
        repoFullName: "JSONbored/gittensory",
        recommendation: "contribute_now",
        alternatives: [
          {
            alternative: "cleanup_existing",
            group: "cleanup",
            publicSummary: "Cleanup was lower priority than new work.",
            reason: "Open PR pressure is below the spam threshold.",
            facts: ["2 open PRs"],
            assumptions: ["threshold is 5"],
          },
        ],
      },
    ]);
    expect(view.withheldPrivateFields).toEqual([]);
  });

  it("withholds private counterfactual detail for public viewers", () => {
    const view = buildSnapshotReplayView({
      snapshot: snapshot(),
      counterfactuals: counterfactuals(),
      viewer: "public",
    });
    const alt = view.counterfactuals[0]?.alternatives[0];
    expect(alt?.publicSummary).toBe("Cleanup was lower priority than new work.");
    expect(alt?.reason).toBeNull();
    expect(alt?.facts).toEqual([]);
    expect(alt?.assumptions).toEqual([]);
    expect(view.withheldPrivateFields).toEqual(["counterfactual_detail"]);
    expect(JSON.stringify(view)).not.toMatch(/Open PR pressure is below|2 open PRs|threshold is 5/);
  });

  it("only includes counterfactuals for the snapshot's target repo", () => {
    const view = buildSnapshotReplayView({
      snapshot: snapshot(),
      counterfactuals: [
        ...counterfactuals(),
        { repoFullName: "other/repo", recommendation: "skip", rejectedAlternatives: [{ publicSummary: "Other repo alt." }] },
      ],
      viewer: "authenticated",
    });
    expect(view.counterfactuals).toHaveLength(1);
    expect(view.counterfactuals[0]?.repoFullName).toBe("JSONbored/gittensory");
  });

  it("narrows unknown confidence/freshness and skips malformed sources and alternatives", () => {
    const view = buildSnapshotReplayView({
      snapshot: snapshot({
        provenance: provenance({
          confidence: "stellar",
          freshness: "ancient",
          sources: ["nope", {}, { name: "" }, { name: "repo_decision", freshness: "weird" }] as unknown[],
        }),
      }),
      counterfactuals: [
        { repoFullName: "JSONbored/gittensory", recommendation: "contribute_now", rejectedAlternatives: ["x", {}, { facts: [] }] },
      ],
      viewer: "authenticated",
    });
    expect(view.confidence).toBe("unknown");
    expect(view.freshness).toBe("unknown");
    expect(view.sources).toEqual([{ name: "repo_decision", freshness: "unknown", generatedAt: null }]);
    expect(view.counterfactuals).toEqual([]);
  });
});

function provenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confidence: "high",
    freshness: "fresh",
    generatedAt: "2026-06-08T00:00:00.000Z",
    scoringModelId: "scoring-1",
    repoSignalSnapshotIds: [],
    sources: [{ name: "contributor_decision_pack", freshness: "fresh", generatedAt: "2026-06-08T00:00:00.000Z" }],
    evidenceGaps: [],
    evidenceComplete: true,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: "recommendation_snapshot",
    version: 1,
    snapshotId: "recommendation:context-1:run-1:00:choose_next_work",
    contextSnapshotId: "context-1",
    actionId: "run-1:00:choose_next_work",
    runId: "run-1",
    actionType: "choose_next_work",
    generatedAt: "2026-06-08T00:00:00.000Z",
    publicSafe: true,
    target: { repoFullName: "JSONbored/gittensory", pullNumber: 12 },
    provenance: provenance(),
  };
  const merged = { ...base, ...overrides };
  if ("provenance" in overrides && overrides.provenance === undefined) delete merged.provenance;
  return merged;
}

function counterfactuals(): Array<Record<string, unknown>> {
  return [
    {
      repoFullName: "JSONbored/gittensory",
      recommendation: "contribute_now",
      rejectedAlternatives: [
        {
          alternative: "cleanup_existing",
          group: "cleanup",
          rank: 1,
          reason: "Open PR pressure is below the spam threshold.",
          facts: ["2 open PRs"],
          assumptions: ["threshold is 5"],
          publicSummary: "Cleanup was lower priority than new work.",
        },
      ],
    },
  ];
}
