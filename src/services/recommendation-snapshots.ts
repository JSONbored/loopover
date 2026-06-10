import type { AgentActionRecord, AgentContextSnapshotRecord, AgentActionType, JsonValue } from "../types";

export type SnapshotProvenanceConfidence = "high" | "medium" | "low";
export type SnapshotProvenanceFreshness =
  | "fresh"
  | "stale"
  | "rebuilding"
  | "missing"
  | "degraded"
  | "possibly_stale"
  | "unknown";

/**
 * Public-safe provenance for a single evidence source. Only structured
 * identifiers and metadata are exposed — never the raw human-readable summary,
 * which can carry private repo/login/scoreability context.
 */
export type RecommendationSnapshotSourceProvenance = {
  name: string;
  freshness: SnapshotProvenanceFreshness;
  generatedAt: string | null;
};

/**
 * Public-safe provenance attached to a recommendation snapshot. This is the
 * only provenance shape serialized into public GitHub text: it surfaces which
 * evidence was used, how fresh it was, the model confidence, and any known
 * gaps, without leaking private/authenticated evidence detail. Advisory
 * metadata only — never public scoring or reward prediction.
 */
export type RecommendationSnapshotProvenance = {
  confidence: SnapshotProvenanceConfidence;
  freshness: SnapshotProvenanceFreshness;
  generatedAt: string | null;
  scoringModelId: string | null;
  repoSignalSnapshotIds: string[];
  sources: RecommendationSnapshotSourceProvenance[];
  evidenceGaps: string[];
  evidenceComplete: boolean;
};

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
  provenance: RecommendationSnapshotProvenance;
};

const CONFIDENCE_VALUES: ReadonlySet<SnapshotProvenanceConfidence> = new Set(["high", "medium", "low"]);
const FRESHNESS_VALUES: ReadonlySet<SnapshotProvenanceFreshness> = new Set([
  "fresh",
  "stale",
  "rebuilding",
  "missing",
  "degraded",
  "possibly_stale",
  "unknown",
]);

function narrowConfidence(value: JsonValue | undefined): SnapshotProvenanceConfidence {
  return typeof value === "string" && CONFIDENCE_VALUES.has(value as SnapshotProvenanceConfidence)
    ? (value as SnapshotProvenanceConfidence)
    : "low";
}

function narrowFreshness(value: JsonValue | undefined): SnapshotProvenanceFreshness {
  return typeof value === "string" && FRESHNESS_VALUES.has(value as SnapshotProvenanceFreshness)
    ? (value as SnapshotProvenanceFreshness)
    : "unknown";
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defensively read public-safe provenance inputs from the private
 * `recommendationEvidence` blob carried on an action payload. Fails closed:
 * missing or malformed evidence yields low-confidence, unknown-freshness
 * provenance with the gap recorded explicitly rather than silently omitted.
 */
function readEvidenceProvenance(raw: JsonValue | undefined): {
  confidence: SnapshotProvenanceConfidence;
  freshness: SnapshotProvenanceFreshness;
  sources: RecommendationSnapshotSourceProvenance[];
  hasEvidence: boolean;
} {
  if (!isJsonRecord(raw)) {
    return { confidence: "low", freshness: "unknown", sources: [], hasEvidence: false };
  }
  const rawSources = Array.isArray(raw.sources) ? raw.sources : [];
  const sources: RecommendationSnapshotSourceProvenance[] = [];
  for (const entry of rawSources) {
    if (!isJsonRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    sources.push({
      name,
      freshness: narrowFreshness(entry.freshness),
      generatedAt: typeof entry.generatedAt === "string" ? entry.generatedAt : null,
    });
  }
  return {
    confidence: narrowConfidence(raw.confidence),
    freshness: narrowFreshness(raw.freshness),
    sources,
    hasEvidence: true,
  };
}

function snapshotGeneratedAt(context: AgentContextSnapshotRecord): string | null {
  return context.createdAt ?? context.decisionPackVersion ?? null;
}

/**
 * Build the public-safe provenance for a recommendation snapshot from the
 * action's evidence and the durable context snapshot. Stale and missing
 * evidence are represented explicitly via `evidenceGaps`/`evidenceComplete`.
 */
export function recommendationSnapshotProvenance(
  action: AgentActionRecord,
  context: AgentContextSnapshotRecord,
): RecommendationSnapshotProvenance {
  const { confidence, freshness, sources, hasEvidence } = readEvidenceProvenance(action.payload.recommendationEvidence);

  const evidenceGaps: string[] = [];
  if (!hasEvidence) {
    evidenceGaps.push("evidence: missing");
  } else if (sources.length === 0) {
    evidenceGaps.push("evidence_sources: missing");
  } else {
    for (const source of sources) {
      if (source.freshness !== "fresh") evidenceGaps.push(`${source.name}: ${source.freshness}`);
    }
  }

  return {
    confidence,
    freshness,
    generatedAt: snapshotGeneratedAt(context),
    scoringModelId: context.scoringModelId ?? null,
    repoSignalSnapshotIds: [...context.repoSignalSnapshotIds],
    sources,
    evidenceGaps,
    evidenceComplete: hasEvidence && sources.length > 0 && evidenceGaps.length === 0,
  };
}

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
    generatedAt: snapshotGeneratedAt(context),
    publicSafe: true,
    target,
    provenance: recommendationSnapshotProvenance(action, context),
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
