import { describe, expect, it } from "vitest";
import {
  attachRecommendationSnapshot,
  attachRecommendationSnapshots,
  recommendationSnapshotEnvelope,
  recommendationSnapshotId,
} from "../../src/services/recommendation-snapshots";
import type { AgentActionRecord, AgentContextSnapshotRecord } from "../../src/types";

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
