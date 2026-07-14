// Decision snapshot replay view model.
//
// Turns a persisted recommendation snapshot envelope (see
// `src/services/recommendation-snapshots.ts`) plus its run's counterfactual
// reasons into a human-readable, inspection-only replay view for the control
// panel (issue #285). It is deterministic and fails closed: malformed or
// missing evidence is represented explicitly rather than silently omitted, and
// private/authenticated detail is withheld for public viewers.
//
// This module is intentionally standalone (no imports) so it can be unit-tested
// directly and reused by the UI without pulling in worker-side types.

export type SnapshotReplayViewer = "public" | "authenticated";
export type SnapshotReplayStatus = "populated" | "stale" | "missing";
export type SnapshotReplayConfidence = "high" | "medium" | "low" | "unknown";
export type SnapshotReplayFreshness =
  | "fresh"
  | "stale"
  | "rebuilding"
  | "missing"
  | "degraded"
  | "possibly_stale"
  | "unknown";

export type SnapshotReplaySource = {
  name: string;
  freshness: SnapshotReplayFreshness;
  generatedAt: string | null;
};

export type SnapshotReplayCounterfactualAlternative = {
  alternative: string;
  group: string;
  publicSummary: string;
  // Private/authenticated-only detail. Always null/empty for public viewers.
  reason: string | null;
  facts: string[];
  assumptions: string[];
};

export type SnapshotReplayCounterfactual = {
  repoFullName: string;
  recommendation: string;
  alternatives: SnapshotReplayCounterfactualAlternative[];
};

export type SnapshotReplayTarget = {
  repoFullName: string | null;
  pullNumber: number | null;
  issueNumber: number | null;
};

export type SnapshotReplayView = {
  status: SnapshotReplayStatus;
  viewer: SnapshotReplayViewer;
  snapshotId: string | null;
  actionType: string | null;
  target: SnapshotReplayTarget;
  generatedAt: string | null;
  scoringModelId: string | null;
  confidence: SnapshotReplayConfidence;
  freshness: SnapshotReplayFreshness;
  sources: SnapshotReplaySource[];
  evidenceGaps: string[];
  evidenceComplete: boolean;
  staleReasons: string[];
  counterfactuals: SnapshotReplayCounterfactual[];
  withheldPrivateFields: string[];
  notice: string;
};

export type BuildSnapshotReplayViewInput = {
  snapshot: unknown;
  counterfactuals?: unknown;
  viewer: SnapshotReplayViewer;
};

const CONFIDENCE_VALUES: ReadonlySet<SnapshotReplayConfidence> = new Set([
  "high",
  "medium",
  "low",
  "unknown",
]);
const FRESHNESS_VALUES: ReadonlySet<SnapshotReplayFreshness> = new Set([
  "fresh",
  "stale",
  "rebuilding",
  "missing",
  "degraded",
  "possibly_stale",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function narrowConfidence(value: unknown): SnapshotReplayConfidence {
  return typeof value === "string" && CONFIDENCE_VALUES.has(value as SnapshotReplayConfidence)
    ? (value as SnapshotReplayConfidence)
    : "unknown";
}

function narrowFreshness(value: unknown): SnapshotReplayFreshness {
  return typeof value === "string" && FRESHNESS_VALUES.has(value as SnapshotReplayFreshness)
    ? (value as SnapshotReplayFreshness)
    : "unknown";
}

function readTarget(value: unknown): SnapshotReplayTarget {
  if (!isRecord(value)) return { repoFullName: null, pullNumber: null, issueNumber: null };
  return {
    repoFullName: asString(value.repoFullName),
    pullNumber: asNumber(value.pullNumber),
    issueNumber: asNumber(value.issueNumber),
  };
}

function readSources(value: unknown): SnapshotReplaySource[] {
  if (!Array.isArray(value)) return [];
  const sources: SnapshotReplaySource[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name);
    if (!name) continue;
    sources.push({
      name,
      freshness: narrowFreshness(entry.freshness),
      generatedAt: asString(entry.generatedAt),
    });
  }
  return sources;
}

function sameRepo(a: string | null, b: string | null): boolean {
  return Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase();
}

function readCounterfactuals(
  value: unknown,
  targetRepoFullName: string | null,
): SnapshotReplayCounterfactual[] {
  if (!Array.isArray(value)) return [];
  const result: SnapshotReplayCounterfactual[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const repoFullName = asString(entry.repoFullName);
    if (targetRepoFullName && repoFullName && !sameRepo(repoFullName, targetRepoFullName)) continue;
    const alternatives = readAlternatives(entry.rejectedAlternatives);
    if (alternatives.length === 0) continue;
    result.push({
      repoFullName: repoFullName ?? "unknown",
      recommendation: asString(entry.recommendation) ?? "unknown",
      alternatives,
    });
  }
  return result;
}

function readAlternatives(value: unknown): SnapshotReplayCounterfactualAlternative[] {
  if (!Array.isArray(value)) return [];
  const alternatives: SnapshotReplayCounterfactualAlternative[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const publicSummary = asString(entry.publicSummary);
    const reason = asString(entry.reason);
    // Skip entries that carry neither a public summary nor a private reason.
    if (!publicSummary && !reason) continue;
    alternatives.push({
      alternative: asString(entry.alternative) ?? "alternative",
      group: asString(entry.group) ?? "other",
      publicSummary: publicSummary ?? "Alternative considered.",
      reason,
      facts: asStringList(entry.facts),
      assumptions: asStringList(entry.assumptions),
    });
  }
  return alternatives;
}

/**
 * Project counterfactuals for the viewer. Public viewers keep only the
 * public-safe summary; the private reason/facts/assumptions are withheld and
 * the withholding is recorded explicitly.
 */
function projectCounterfactuals(
  counterfactuals: SnapshotReplayCounterfactual[],
  viewer: SnapshotReplayViewer,
): { counterfactuals: SnapshotReplayCounterfactual[]; withheldPrivateFields: string[] } {
  if (viewer === "authenticated") return { counterfactuals, withheldPrivateFields: [] };

  let withheldPrivate = false;
  const projected = counterfactuals.map((cf) => ({
    ...cf,
    alternatives: cf.alternatives.map((alt) => {
      if (alt.reason || alt.facts.length > 0 || alt.assumptions.length > 0) withheldPrivate = true;
      return { ...alt, reason: null, facts: [], assumptions: [] };
    }),
  }));
  return {
    counterfactuals: projected,
    withheldPrivateFields: withheldPrivate ? ["counterfactual_detail"] : [],
  };
}

function missingView(
  viewer: SnapshotReplayViewer,
  notice: string,
  partial?: Partial<SnapshotReplayView>,
): SnapshotReplayView {
  return {
    status: "missing",
    viewer,
    snapshotId: null,
    actionType: null,
    target: { repoFullName: null, pullNumber: null, issueNumber: null },
    generatedAt: null,
    scoringModelId: null,
    confidence: "unknown",
    freshness: "missing",
    sources: [],
    evidenceGaps: [],
    evidenceComplete: false,
    staleReasons: [],
    counterfactuals: [],
    withheldPrivateFields: [],
    notice,
    ...partial,
  };
}

/**
 * Build a public-safe-aware, inspection-only replay view for a single decision
 * snapshot. Returns a `missing` view when no snapshot/provenance is present.
 */
export function buildSnapshotReplayView(input: BuildSnapshotReplayViewInput): SnapshotReplayView {
  const { viewer, snapshot } = input;
  if (!isRecord(snapshot)) {
    return missingView(viewer, "No decision snapshot is available to replay.");
  }

  const snapshotId = asString(snapshot.snapshotId);
  const actionType = asString(snapshot.actionType);
  const target = readTarget(snapshot.target);
  const generatedAt = asString(snapshot.generatedAt);

  const provenance = isRecord(snapshot.provenance) ? snapshot.provenance : null;
  if (!provenance) {
    return missingView(viewer, "This snapshot has no provenance to replay.", {
      snapshotId,
      actionType,
      target,
      generatedAt,
    });
  }

  const confidence = narrowConfidence(provenance.confidence);
  const freshness = narrowFreshness(provenance.freshness);
  const scoringModelId = asString(provenance.scoringModelId);
  const sources = readSources(provenance.sources);
  const evidenceGaps = asStringList(provenance.evidenceGaps);
  const evidenceComplete = provenance.evidenceComplete === true;

  const matchedCounterfactuals = readCounterfactuals(input.counterfactuals, target.repoFullName);
  const { counterfactuals, withheldPrivateFields } = projectCounterfactuals(
    matchedCounterfactuals,
    viewer,
  );

  const staleReasons: string[] = [];
  if (freshness !== "fresh") staleReasons.push(`Snapshot freshness is ${freshness}.`);
  if (!evidenceComplete) staleReasons.push("Evidence is incomplete.");
  for (const gap of evidenceGaps) staleReasons.push(`Evidence gap — ${gap}.`);

  const status: SnapshotReplayStatus = staleReasons.length > 0 ? "stale" : "populated";
  const notice =
    status === "populated"
      ? "All replayed evidence is fresh and complete."
      : `Replaying with ${staleReasons.length} evidence caveat${staleReasons.length === 1 ? "" : "s"}.`;

  return {
    status,
    viewer,
    snapshotId,
    actionType,
    target,
    generatedAt,
    scoringModelId,
    confidence,
    freshness,
    sources,
    evidenceGaps,
    evidenceComplete,
    staleReasons,
    counterfactuals,
    withheldPrivateFields,
    notice,
  };
}
