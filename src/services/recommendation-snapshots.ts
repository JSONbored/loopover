import type { AgentActionRecord, AgentContextSnapshotRecord, AgentActionType, JsonValue } from "../types";

export type RecommendationSnapshotEnvelope = {
  kind: "recommendation_snapshot";
  version: 1;
  snapshotId: string;
  contextSnapshotId: string;
  actionId: string;
  runId: string;
  actionType: AgentActionType;
  generatedAt: string | null;
  publicSafe: true;
  target: {
    repoFullName?: string;
    pullNumber?: number;
    issueNumber?: number;
  };
};

export function recommendationSnapshotId(contextSnapshotId: string, actionId: string): string {
  return `recommendation:${contextSnapshotId}:${actionId}`;
}

export function recommendationSnapshotEnvelope(
  action: AgentActionRecord,
  context: AgentContextSnapshotRecord,
): RecommendationSnapshotEnvelope {
  const target: RecommendationSnapshotEnvelope["target"] = {};
  if (action.targetRepoFullName) target.repoFullName = action.targetRepoFullName;
  if (action.targetPullNumber !== null && action.targetPullNumber !== undefined) target.pullNumber = action.targetPullNumber;
  if (action.targetIssueNumber !== null && action.targetIssueNumber !== undefined) target.issueNumber = action.targetIssueNumber;
  return {
    kind: "recommendation_snapshot",
    version: 1,
    snapshotId: recommendationSnapshotId(context.id, action.id),
    contextSnapshotId: context.id,
    actionId: action.id,
    runId: action.runId,
    actionType: action.actionType,
    generatedAt: context.createdAt ?? context.decisionPackVersion ?? null,
    publicSafe: true,
    target,
  };
}

export function attachRecommendationSnapshot(
  action: AgentActionRecord,
  context: AgentContextSnapshotRecord,
): AgentActionRecord {
  const envelope = recommendationSnapshotEnvelope(action, context);
  return {
    ...action,
    payload: {
      ...action.payload,
      recommendationSnapshotId: envelope.snapshotId,
      recommendationSnapshot: envelope as unknown as JsonValue,
    },
  };
}

export function attachRecommendationSnapshots(
  actions: AgentActionRecord[],
  context: AgentContextSnapshotRecord,
): AgentActionRecord[] {
  return actions.map((action) => attachRecommendationSnapshot(action, context));
}
