// loopover_get_repo_context (#9517 pilot).
//
// Replaces the remote server's placeholder output schema, which declared six of its eight fields
// as bare `z.unknown().optional()` -- structurally advertising nothing a client could rely on.
// Every shape below is modelled from the engine types the handler actually returns:
// LaneAdvice, CollisionReport, QueueHealth, and ConfigQuality in
// packages/loopover-engine/src/signals/engine.ts.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { ownerRepoInput } from "../shared.js";

/** `AdvisorySeverity` / `AdvisoryFinding` (reward-risk-types.ts). The advisory finding shape every
 *  signal surface emits. */
export const advisoryFindingSchema = z.looseObject({
  code: z.string(),
  title: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  detail: z.string(),
  action: z.string().optional(),
  publicText: z.string().optional(),
  confidence: z.number().optional(),
});

/** `ParticipationLane` -- which contribution lane a repo's activity actually follows. */
export const participationLaneSchema = z.enum(["direct_pr", "issue_discovery", "split", "inactive", "unknown"]);

/** `LaneAdvice`. The share fields are genuinely optional: a repo with no measurable activity
 *  yields a lane of "unknown" with neither share computed. */
export const laneAdviceSchema = z.looseObject({
  lane: participationLaneSchema,
  repoFullName: z.string(),
  issueDiscoveryShare: z.number().optional(),
  directPrShare: z.number().optional(),
  summary: z.string(),
  contributorGuidance: z.string(),
  maintainerGuidance: z.string(),
});

/** `CollisionItem`. Nullable-and-optional fields mirror the type exactly: GitHub omits some of
 *  these and explicitly nulls others, and the distinction survives into the payload. */
export const collisionItemSchema = z.looseObject({
  type: z.enum(["issue", "pull_request", "recent_merged_pull_request"]),
  number: z.number(),
  title: z.string(),
  authorLogin: z.string().nullish(),
  htmlUrl: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number()).optional(),
  linkedIssueClaimedAt: z.string().nullish(),
  changedFiles: z.array(z.string()).optional(),
  body: z.string().nullish(),
});

/** `CollisionCluster`. Exported separately because loopover_preflight_pr returns a flat array of
 *  these rather than the full report envelope below. */
export const collisionClusterSchema = z.looseObject({
  id: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  reason: z.string(),
  items: z.array(collisionItemSchema),
});

/** `CollisionReport` -- duplicate-work detection across issues and PRs. */
export const collisionReportSchema = z.looseObject({
  repoFullName: z.string(),
  generatedAt: z.string(),
  summary: z.looseObject({
    clusterCount: z.number(),
    highRiskCount: z.number(),
    itemsReviewed: z.number(),
  }),
  clusters: z.array(collisionClusterSchema),
});

/** `QueueHealth`. `signals` carries the raw counters; the two `*Flagged*` counts are deliberately
 *  public-safe flag counts rather than any scoring detail. */
export const queueHealthSchema = z.looseObject({
  repoFullName: z.string(),
  generatedAt: z.string(),
  burdenScore: z.number(),
  level: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
  signals: z.looseObject({
    openIssues: z.number(),
    openPullRequests: z.number(),
    unlinkedPullRequests: z.number(),
    stalePullRequests: z.number(),
    draftPullRequests: z.number(),
    maintainerAuthoredPullRequests: z.number(),
    collisionClusters: z.number(),
    slopFlaggedPullRequests: z.number(),
    duplicateFlaggedPullRequests: z.number(),
    ageBuckets: z.looseObject({
      under7Days: z.number(),
      days7To30: z.number(),
      over30Days: z.number(),
    }),
    likelyReviewablePullRequests: z.number(),
    cachedOpenPullRequests: z.number().optional(),
    likelyReviewablePullRequestsSource: z.enum(["cache", "sampled_cache", "authoritative"]).optional(),
  }),
  findings: z.array(advisoryFindingSchema),
  rankedPullRequests: z
    .array(
      z.looseObject({
        number: z.number(),
        title: z.string(),
        authorLogin: z.string(),
        recommendation: z.string(),
      }),
    )
    .optional(),
});

/** `ConfigQuality` -- how well a repo's configured labels match what it actually uses. */
export const configQualitySchema = z.looseObject({
  repoFullName: z.string(),
  generatedAt: z.string(),
  score: z.number(),
  level: z.enum(["excellent", "good", "needs_attention", "fragile"]),
  lane: laneAdviceSchema,
  configuredLabels: z.array(z.string()),
  observedLabels: z.array(z.string()),
  notObservedConfiguredLabels: z.array(z.string()),
  findings: z.array(advisoryFindingSchema),
});

export const GetRepoContextInput = ownerRepoInput;

/**
 * KNOWN DIVERGENCE, modelled deliberately rather than papered over.
 *
 * The two servers do not return the same payload for this tool name today:
 *
 *  - The remote server's handler builds eight keys itself (repoFullName, repo, lane, queueHealth,
 *    queueTrends, collisions, configQuality, dataQuality).
 *  - The stdio server proxies GET /v1/repos/:owner/:repo/intelligence, whose response additionally
 *    carries status, source, generatedAt, labelAudit, maintainerLane, maintainerCutReadiness,
 *    contributorIntakeHealth and (optionally) burdenForecast -- and whose snapshot branch omits
 *    `collisions` entirely.
 *
 * So the only fields that can be REQUIRED here are the ones both paths always emit. Everything
 * either side may omit is optional, making this schema the honest union rather than a description
 * of one server that the other would fail. Converging the two payloads is a wire change with its
 * own blast radius and belongs to #9518's batch for this category, not to the keystone -- this
 * schema is what makes the divergence visible in the meantime.
 */
export const GetRepoContextOutput = z.looseObject({
  repoFullName: z.string(),
  // `getRepository` returns null for a repo LoopOver has never synced, and the handler passes that
  // through rather than failing -- the rest of the context is still useful.
  repo: z.looseObject({}).nullable().optional(),
  lane: laneAdviceSchema.optional(),
  queueHealth: queueHealthSchema.nullable().optional(),
  // Either a stored trend snapshot's payload or buildUnavailableQueueTrendReport's stand-in, which
  // is why this stays loose rather than modelling one of the two.
  queueTrends: z.looseObject({}).nullable().optional(),
  // Absent on the REST snapshot branch the stdio server proxies.
  collisions: collisionReportSchema.optional(),
  configQuality: configQualitySchema.nullable().optional(),
  dataQuality: z.looseObject({}).optional(),
  // REST-envelope fields the stdio path carries and the remote path does not.
  status: z.string().optional(),
  source: z.string().optional(),
  generatedAt: z.string().optional(),
  labelAudit: z.looseObject({}).nullable().optional(),
  maintainerLane: z.looseObject({}).nullable().optional(),
  maintainerCutReadiness: z.looseObject({}).nullable().optional(),
  contributorIntakeHealth: z.looseObject({}).nullable().optional(),
});

export type GetRepoContextInput = z.infer<typeof GetRepoContextInput>;
export type GetRepoContextOutput = z.infer<typeof GetRepoContextOutput>;

export const getRepoContextTool = defineTool({
  name: "loopover_get_repo_context",
  title: "Get repo context",
  description:
    "Return LoopOver repo context: registration, lane, queue health, collisions, and config quality.",
  category: "maintainer",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: GetRepoContextInput,
  output: GetRepoContextOutput,
});
