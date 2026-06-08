import { describe, expect, it } from "vitest";
import {
  attachRecommendationSnapshot,
  attachRecommendationSnapshots,
  recommendationSnapshotEnvelope,
  recommendationSnapshotId,
  recommendationSnapshotProvenance,
} from "../../src/services/recommendation-snapshots";
import type { AgentActionRecord, AgentContextSnapshotRecord, JsonValue } from "../../src/types";

describe("recommendation snapshot envelopes", () => {
  it("creates stable ids from the durable context snapshot and action ids", () => {
    expect(recommendationSnapshotId("context-123", "run-1:00:choose_next_work")).toBe(
      "recommendation:context-123:run-1:00:choose_next_work",
    );
  });

  it("serializes only public-safe envelope fields", () => {
    const envelope = recommendationSnapshotEnvelope(action(), context());
    expect(envelope).toEqual({
      kind: "recommendation_snapshot",
      version: 1,
      snapshotId: "recommendation:context-123:run-1:00:choose_next_work",
      contextSnapshotId: "context-123",
      actionId: "run-1:00:choose_next_work",
      runId: "run-1",
      actionType: "choose_next_work",
      generatedAt: "2026-06-01T00:00:00.000Z",
      publicSafe: true,
      target: {
        repoFullName: "JSONbored/gittensory",
        pullNumber: 12,
      },
      provenance: {
        confidence: "low",
        freshness: "unknown",
        generatedAt: "2026-06-01T00:00:00.000Z",
        scoringModelId: "scoring-1",
        repoSignalSnapshotIds: [],
        sources: [],
        evidenceGaps: ["evidence: missing"],
        evidenceComplete: false,
      },
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /wallet|hotkey|coldkey|raw trust|private reviewability|private scoreability|reward estimate|payload|recommendationEvidence/i,
    );
  });

  it("attaches the id and envelope without removing existing action payload", () => {
    const attached = attachRecommendationSnapshot(
      action({ payload: { decision: { repoFullName: "JSONbored/gittensory" } } }),
      context(),
    );
    expect(attached.payload.decision).toEqual({ repoFullName: "JSONbored/gittensory" });
    expect(attached.payload.recommendationSnapshotId).toBe("recommendation:context-123:run-1:00:choose_next_work");
    expect(attached.payload.recommendationSnapshot).toMatchObject({
      snapshotId: "recommendation:context-123:run-1:00:choose_next_work",
      publicSafe: true,
      provenance: { evidenceComplete: false },
    });
  });

  it("attaches ids to every action in a packet", () => {
    const attached = attachRecommendationSnapshots(
      [
        action({ id: "run-1:00:choose_next_work" }),
        action({ id: "run-1:01:explain_repo_fit", actionType: "explain_repo_fit", targetPullNumber: null, targetIssueNumber: 7 }),
      ],
      context(),
    );
    expect(attached.map((item) => item.payload.recommendationSnapshotId)).toEqual([
      "recommendation:context-123:run-1:00:choose_next_work",
      "recommendation:context-123:run-1:01:explain_repo_fit",
    ]);
    expect(attached[1]?.payload.recommendationSnapshot).toMatchObject({
      actionType: "explain_repo_fit",
      target: { repoFullName: "JSONbored/gittensory", issueNumber: 7 },
    });
  });

  it("falls back to context createdAt when no decision-pack version exists", () => {
    expect(
      recommendationSnapshotEnvelope(action({ targetRepoFullName: null, targetPullNumber: null }), {
        ...context(),
        decisionPackVersion: null,
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    ).toMatchObject({
      generatedAt: "2026-06-02T00:00:00.000Z",
      target: {},
    });
  });
});

describe("recommendation snapshot provenance", () => {
  it("derives confidence, freshness, and complete evidence from fresh sources", () => {
    const provenance = recommendationSnapshotProvenance(
      actionWithEvidence({
        confidence: "high",
        freshness: "fresh",
        sources: [
          { name: "contributor_decision_pack", freshness: "fresh", generatedAt: "2026-06-01T00:00:00.000Z" },
          { name: "repo_decision", freshness: "fresh" },
        ],
      }),
      context({ repoSignalSnapshotIds: ["sig-1", "sig-2"] }),
    );
    expect(provenance).toEqual({
      confidence: "high",
      freshness: "fresh",
      generatedAt: "2026-06-01T00:00:00.000Z",
      scoringModelId: "scoring-1",
      repoSignalSnapshotIds: ["sig-1", "sig-2"],
      sources: [
        { name: "contributor_decision_pack", freshness: "fresh", generatedAt: "2026-06-01T00:00:00.000Z" },
        { name: "repo_decision", freshness: "fresh", generatedAt: null },
      ],
      evidenceGaps: [],
      evidenceComplete: true,
    });
  });

  it("records stale and missing sources as explicit gaps instead of omitting them", () => {
    const provenance = recommendationSnapshotProvenance(
      actionWithEvidence({
        confidence: "medium",
        freshness: "stale",
        sources: [
          { name: "contributor_decision_pack", freshness: "fresh" },
          { name: "official_contributor_stats", freshness: "missing" },
          { name: "repo_outcome_patterns", freshness: "possibly_stale" },
        ],
      }),
      context(),
    );
    expect(provenance.freshness).toBe("stale");
    expect(provenance.evidenceGaps).toEqual([
      "official_contributor_stats: missing",
      "repo_outcome_patterns: possibly_stale",
    ]);
    expect(provenance.evidenceComplete).toBe(false);
  });

  it("fails closed when the action carries no evidence", () => {
    const provenance = recommendationSnapshotProvenance(action({ payload: {} }), context());
    expect(provenance).toMatchObject({
      confidence: "low",
      freshness: "unknown",
      sources: [],
      evidenceGaps: ["evidence: missing"],
      evidenceComplete: false,
    });
  });

  it("flags evidence that exists but exposes no sources", () => {
    const provenance = recommendationSnapshotProvenance(
      actionWithEvidence({ confidence: "medium", freshness: "degraded" }),
      context(),
    );
    expect(provenance.evidenceGaps).toEqual(["evidence_sources: missing"]);
    expect(provenance.evidenceComplete).toBe(false);
  });

  it("narrows unknown confidence and freshness values and skips malformed sources", () => {
    const provenance = recommendationSnapshotProvenance(
      actionWithEvidence({
        confidence: "superb",
        freshness: "ancient",
        sources: [
          "not-an-object",
          {},
          { name: "  " },
          { name: "repo_decision", freshness: "weird" },
        ],
      } as unknown as Record<string, JsonValue>),
      context(),
    );
    expect(provenance.confidence).toBe("low");
    expect(provenance.freshness).toBe("unknown");
    expect(provenance.sources).toEqual([{ name: "repo_decision", freshness: "unknown", generatedAt: null }]);
    expect(provenance.evidenceGaps).toEqual(["repo_decision: unknown"]);
  });

  it("uses createdAt over decisionPackVersion and null when neither exists", () => {
    expect(
      recommendationSnapshotProvenance(action({ payload: {} }), context({ createdAt: "2026-06-03T00:00:00.000Z" })).generatedAt,
    ).toBe("2026-06-03T00:00:00.000Z");
    expect(
      recommendationSnapshotProvenance(action({ payload: {} }), {
        ...context(),
        decisionPackVersion: null,
        scoringModelId: null,
      }).generatedAt,
    ).toBeNull();
  });

  it("never serializes private evidence summaries, assumptions, or warnings into the envelope", () => {
    const envelope = recommendationSnapshotEnvelope(
      actionWithEvidence({
        confidence: "high",
        freshness: "fresh",
        sourceSummary: "private reviewability and raw trust score detail",
        assumptions: ["wallet hotkey coldkey assumption"],
        warnings: ["reward estimate leak"],
        sources: [
          {
            name: "contributor_decision_pack",
            freshness: "fresh",
            generatedAt: "2026-06-01T00:00:00.000Z",
            source: "cache",
            summary: "jsonbored reward estimate private reviewability",
          },
        ],
      }),
      context(),
    );
    expect(envelope.provenance.sources[0]).toEqual({
      name: "contributor_decision_pack",
      freshness: "fresh",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /wallet|hotkey|coldkey|raw trust|private reviewability|reward estimate|summary/i,
    );
  });
});

function action(overrides: Partial<AgentActionRecord> = {}): AgentActionRecord {
  return {
    id: "run-1:00:choose_next_work",
    runId: "run-1",
    actionType: "choose_next_work",
    targetRepoFullName: "JSONbored/gittensory",
    targetPullNumber: 12,
    status: "recommended",
    recommendation: "Pick narrow work.",
    why: ["A durable recommendation snapshot can explain this later."],
    blockedBy: [],
    publicSafeSummary: "Pick narrow public work.",
    approvalRequired: true,
    safetyClass: "private",
    payload: {},
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function actionWithEvidence(
  evidence: Record<string, JsonValue>,
  overrides: Partial<AgentActionRecord> = {},
): AgentActionRecord {
  return action({ payload: { recommendationEvidence: evidence as unknown as JsonValue }, ...overrides });
}

function context(overrides: Partial<AgentContextSnapshotRecord> = {}): AgentContextSnapshotRecord {
  return {
    id: "context-123",
    runId: "run-1",
    decisionPackVersion: "2026-06-01T00:00:00.000Z",
    repoSignalSnapshotIds: [],
    scoringModelId: "scoring-1",
    freshnessWarnings: [],
    payload: {
      privateScoreability: "must-not-copy",
      recommendationEvidence: { raw: "must-not-copy" },
    },
    ...overrides,
  };
}
