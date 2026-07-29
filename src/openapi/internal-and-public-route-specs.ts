// Spec entries for the remaining internal, public, and miscellaneous routes (#9531, batch 2).
//
// Completes the ratchet: with these the published document describes every route `createApp()`
// serves, and src/openapi/unspecced-routes-baseline.json is deleted.
//
// The `/run` suffix pattern is the biggest family here and worth naming: nineteen internal job
// routes exist in two forms -- a bare POST that ENQUEUES the job onto the durable queue, and a
// `/run` sibling that executes it inline and returns the result. Both are real, both are called
// (the queue path in production, the inline path by the ops runbook when a queue is wedged), and
// the two answer with different status codes. Registering them from one table keeps that pairing
// visible instead of leaving nineteen near-identical stanzas to drift apart by hand.
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { registerRouteSpec, type RouteAuth, type RouteMethod } from "./define-route";

type SpecEntry = {
  method: RouteMethod;
  path: string;
  operationId: string;
  tags: [string, ...string[]];
  summary: string;
  auth: RouteAuth;
  responses: Record<number, { description: string }>;
};

const INTERNAL_AUTH = { 401: { description: "Invalid internal token" } };
const QUEUED = { 202: { description: "Job queued" }, ...INTERNAL_AUTH };
const RAN = { 200: { description: "Job ran inline and returned its result" }, ...INTERNAL_AUTH };

/** `[path segment, operationId stem, human summary]` for the jobs that have BOTH forms. */
const JOB_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ["refresh-registry", "RefreshRegistry", "refresh the Gittensor registry snapshot"],
  ["refresh-scoring-model", "RefreshScoringModel", "refresh the active scoring model"],
  ["refresh-upstream-drift", "RefreshUpstreamDrift", "recompute upstream ruleset drift"],
  ["file-upstream-drift-issues", "FileUpstreamDriftIssues", "file issues for open upstream drift"],
  ["build-contributor-decision-packs", "BuildContributorDecisionPacks", "rebuild contributor decision packs"],
  ["refresh-contributor-activity", "RefreshContributorActivity", "refresh cached contributor activity"],
  ["generate-signal-snapshots", "GenerateSignalSnapshots", "generate signal snapshots"],
  ["generate-weekly-value-report", "GenerateWeeklyValueReport", "generate the weekly value report"],
  ["generate-review-recap", "GenerateReviewRecap", "generate the maintainer review recap"],
  ["backfill-registered-repos", "BackfillRegisteredRepos", "backfill registered repository records"],
  ["backfill-repo-segment", "BackfillRepoSegment", "backfill repository segment assignments"],
  ["backfill-pr-details", "BackfillPrDetails", "backfill pull-request detail rows"],
  ["rollup-product-usage", "RollupProductUsage", "roll up product usage counters"],
];

/** Jobs that exist only in the bare (enqueue-or-run) form. */
const SINGLE_JOBS: ReadonlyArray<readonly [string, string, string]> = [
  ["rag-index", "RunRagIndex", "index repository content for retrieval"],
  ["regate-pr", "RegatePullRequest", "re-run the gate for one pull request"],
];

/**
 * Jobs that exist ONLY in the `/run` form, with no enqueue sibling.
 *
 * Not an oversight in the routes -- both are operator-triggered repairs with no scheduled trigger,
 * so there is nothing to enqueue them from. Listed separately because assuming the pair was
 * symmetric published two operations no route served, which is precisely what the ratchet's
 * "never publishes an operation for a route the app does not serve" direction caught.
 */
const RUN_ONLY_JOBS: ReadonlyArray<readonly [string, string, string]> = [
  ["backfill-contributor-gate-history", "BackfillContributorGateHistory", "backfill contributor gate history"],
  ["refresh-installation-health", "RefreshInstallationHealth", "refresh GitHub App installation health"],
];

function jobRoutes(): SpecEntry[] {
  const entries: SpecEntry[] = [];
  for (const [segment, stem, summary] of JOB_PAIRS) {
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}`,
      operationId: `queue${stem}Job`,
      tags: ["Internal", "Jobs"],
      summary: `Queue a job to ${summary}`,
      auth: "internal",
      responses: QUEUED,
    });
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}/run`,
      operationId: `run${stem}Job`,
      tags: ["Internal", "Jobs"],
      summary: `Run the job to ${summary} inline, bypassing the queue`,
      auth: "internal",
      responses: RAN,
    });
  }
  for (const [segment, stem, summary] of RUN_ONLY_JOBS) {
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}/run`,
      operationId: `run${stem}Job`,
      tags: ["Internal", "Jobs"],
      summary: `Run the job to ${summary}`,
      auth: "internal",
      responses: RAN,
    });
  }
  for (const [segment, operationId, summary] of SINGLE_JOBS) {
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}`,
      operationId,
      tags: ["Internal", "Jobs"],
      summary: `Run the job to ${summary}`,
      auth: "internal",
      responses: { ...RAN, 400: { description: "Malformed job request" } },
    });
  }
  return entries;
}

const INTERNAL_READS: SpecEntry[] = [
  ["/v1/internal/status", "getInternalStatus", "Return the control plane's own status"],
  ["/v1/internal/decision", "getInternalDecision", "Return one recorded gate decision"],
  ["/v1/internal/parity", "getInternalParity", "Return native-vs-live gate parity measurements"],
  ["/v1/internal/predicted-agreement", "getInternalPredictedAgreement", "Return predicted-gate agreement measurements"],
  ["/v1/internal/calibration", "getInternalCalibration", "Return gate calibration measurements"],
  ["/v1/internal/calibration-trend", "getInternalCalibrationTrend", "Return the calibration trend over time"],
  ["/v1/internal/calibration/knobs", "getInternalCalibrationKnobs", "Return the tunable calibration knobs and their live values"],
  ["/v1/internal/calibration/satisfaction-floor", "getInternalSatisfactionFloor", "Return the current satisfaction floor"],
  ["/v1/internal/audit-labels", "listInternalAuditLabels", "List adjudication labels for the audit corpus"],
  ["/v1/internal/fairness/contributors", "listInternalFairnessContributors", "List contributor fairness measurements"],
  ["/v1/internal/fleet/analytics", "getInternalFleetAnalytics", "Return fleet-wide analytics"],
  ["/v1/internal/ops/stats", "getInternalOpsStats", "Return operational statistics"],
  ["/v1/internal/retention/preview", "getInternalRetentionPreview", "Preview what a retention sweep would delete"],
].map(([path, operationId, summary]) => ({
  method: "get" as const,
  path: path!,
  operationId: operationId!,
  tags: ["Internal"] as [string, ...string[]],
  summary: summary!,
  auth: "internal" as const,
  responses: { 200: { description: "Measurement payload" }, ...INTERNAL_AUTH },
}));

const INTERNAL_OTHER: SpecEntry[] = [
  {
    method: "get",
    path: "/v1/internal/fairness/contributors/:login",
    operationId: "getInternalFairnessContributor",
    tags: ["Internal"],
    summary: "Return one contributor's fairness measurements",
    auth: "internal",
    responses: { 200: { description: "Fairness measurements" }, 404: { description: "No such contributor" }, ...INTERNAL_AUTH },
  },
  {
    method: "post",
    path: "/v1/internal/audit-labels/adjudicate",
    operationId: "adjudicateAuditLabel",
    tags: ["Internal"],
    summary: "Record an adjudication for one audit-corpus item",
    auth: "internal",
    responses: { 200: { description: "Adjudication recorded" }, 400: { description: "Malformed adjudication" }, ...INTERNAL_AUTH },
  },
  {
    method: "post",
    path: "/v1/internal/calibration/loosen-satisfaction-floor",
    operationId: "loosenSatisfactionFloor",
    tags: ["Internal"],
    summary: "Loosen the satisfaction floor by one calibrated step",
    auth: "internal",
    responses: { 200: { description: "Floor updated" }, 400: { description: "Malformed request" }, ...INTERNAL_AUTH },
  },
  {
    method: "post",
    path: "/v1/internal/queue-intelligence",
    operationId: "recordQueueIntelligence",
    tags: ["Internal"],
    summary: "Record a queue-intelligence observation",
    auth: "internal",
    responses: { 202: { description: "Observation recorded" }, 400: { description: "Malformed observation" }, ...INTERNAL_AUTH },
  },
  {
    method: "get",
    path: "/v1/internal/repos/:owner/:repo/contribution-policy",
    operationId: "getRepoContributionPolicyInternal",
    tags: ["Internal", "Repositories"],
    summary: "Read a repo's contribution policy from the control plane",
    auth: "internal",
    responses: { 200: { description: "Contribution policy" }, ...INTERNAL_AUTH },
  },
  {
    method: "post",
    path: "/v1/internal/repos/:owner/:repo/contribution-policy",
    operationId: "setRepoContributionPolicyInternal",
    tags: ["Internal", "Repositories"],
    summary: "Write a repo's contribution policy from the control plane",
    auth: "internal",
    responses: { 200: { description: "Policy written" }, 400: { description: "Malformed policy" }, ...INTERNAL_AUTH },
  },
  {
    method: "post",
    path: "/v1/internal/repos/:owner/:repo/settings",
    operationId: "setRepoSettingsInternal",
    tags: ["Internal", "Repositories"],
    summary: "Write a repo's settings from the control plane",
    auth: "internal",
    responses: { 200: { description: "Settings written" }, 400: { description: "Malformed settings" }, ...INTERNAL_AUTH },
  },
];

const PUBLIC_ROUTES: SpecEntry[] = [
  {
    method: "get",
    path: "/openapi.json",
    operationId: "getOpenApiDocument",
    tags: ["Meta"],
    summary: "Return this OpenAPI document",
    auth: "public",
    responses: { 200: { description: "The OpenAPI 3 document" } },
  },
  {
    method: "get",
    path: "/loopover/shot",
    operationId: "getLoopoverShot",
    tags: ["Meta"],
    summary: "Return the LoopOver social preview image",
    auth: "public",
    responses: { 200: { description: "Preview image" } },
  },
  {
    method: "get",
    path: "/v1/public/subnet-interface",
    operationId: "getPublicSubnetInterface",
    tags: ["Public"],
    summary: "Return the public subnet interface description",
    auth: "public",
    responses: { 200: { description: "Subnet interface" } },
  },
  {
    method: "get",
    path: "/v1/public/repos/:owner/:repo/badge.json",
    operationId: "getRepoBadgeJson",
    tags: ["Public"],
    summary: "Return a shields.io-compatible badge payload for a repo",
    auth: "public",
    responses: {
      200: { description: "Badge payload" },
      404: { description: "The repo has no public badge (unknown, private, uninstalled, or badgeEnabled off)" },
      503: { description: "The badge data could not be loaded (a transient loader failure, short-cached)" },
    },
  },
  {
    method: "get",
    path: "/v1/public/repos/:owner/:repo/badge.svg",
    operationId: "getRepoBadgeSvg",
    tags: ["Public"],
    summary: "Return a rendered SVG badge for a repo",
    auth: "public",
    responses: {
      200: { description: "SVG badge" },
      404: { description: "The repo has no public badge (unknown, private, uninstalled, or badgeEnabled off)" },
      503: { description: "The badge data could not be loaded (a transient loader failure, short-cached)" },
    },
  },
  {
    method: "get",
    path: "/v1/mcp/finding-taxonomy",
    operationId: "getMcpFindingTaxonomy",
    tags: ["MCP"],
    summary: "Return the review finding taxonomy the MCP surfaces use",
    auth: "public",
    responses: { 200: { description: "Finding taxonomy" } },
  },
  {
    method: "get",
    path: "/v1/mcp/enrichment-analyzers",
    operationId: "getMcpEnrichmentAnalyzers",
    tags: ["MCP"],
    summary: "Return the review-enrichment analyzers the MCP surfaces expose",
    auth: "public",
    responses: { 200: { description: "Analyzer descriptions" } },
  },
];

const MISC_ROUTES: SpecEntry[] = [
  {
    method: "post",
    path: "/v1/drafts",
    operationId: "createReviewDraft",
    tags: ["Drafts"],
    // Unauthenticated by design (the OAuth draft-submission flow); the handlers 404 when the
    // LOOPOVER_REVIEW_DRAFT flag is off, so the exemption is inert flag-OFF.
    auth: "public",
    summary: "Submit a review draft",
    responses: { 200: { description: "Draft accepted" }, 400: { description: "Malformed draft" }, 404: { description: "Draft submission is disabled" } },
  },
  {
    method: "get",
    path: "/v1/drafts/:id",
    operationId: "getReviewDraft",
    tags: ["Drafts"],
    auth: "public",
    summary: "Read one submitted review draft",
    responses: { 200: { description: "Draft" }, 404: { description: "No such draft, or draft submission is disabled" } },
  },
  {
    method: "get",
    path: "/v1/drafts/auth/callback",
    operationId: "completeDraftOauth",
    tags: ["Drafts"],
    auth: "public",
    summary: "Complete the draft-submission GitHub OAuth flow",
    responses: { 302: { description: "Redirect back to the draft" }, 400: { description: "Missing or invalid OAuth code" } },
  },
  {
    method: "post",
    path: "/v1/ams/ingest",
    operationId: "ingestAmsTelemetry",
    tags: ["AMS"],
    // Its own shared-secret header, like the ORB ingress -- not a LoopOver bearer.
    auth: "orb",
    summary: "Ingest an AMS miner telemetry batch",
    responses: { 202: { description: "Batch accepted" }, 400: { description: "Malformed batch" }, 401: { description: "Missing or invalid ingest credential" } },
  },
  {
    method: "post",
    path: "/v1/contributors/:login/ams-notifications",
    operationId: "sendAmsNotification",
    tags: ["Contributors", "AMS"],
    summary: "Deliver an AMS notification to a contributor",
    auth: "token",
    responses: { 202: { description: "Notification queued" }, 400: { description: "Malformed notification" }, 401: { description: "Missing or invalid token" } },
  },
  {
    method: "post",
    path: "/v1/local/remediation-plan",
    operationId: "buildLocalRemediationPlan",
    tags: ["Local"],
    summary: "Build a remediation plan from local branch metadata",
    auth: "token",
    responses: { 200: { description: "Remediation plan" }, 400: { description: "Malformed branch metadata" }, 401: { description: "Missing or invalid token" } },
  },
  {
    method: "post",
    path: "/v1/loop/request-apr-transfer",
    operationId: "requestAprTransfer",
    tags: ["Loop"],
    summary: "Request an APR transfer for a rented loop",
    auth: "token",
    responses: { 200: { description: "Transfer requested" }, 400: { description: "Malformed request" }, 401: { description: "Missing or invalid token" } },
  },
  {
    method: "post",
    path: "/v1/repos/:owner/:repo/pulls/:number/chat-qa",
    operationId: "askPullRequestChatQuestion",
    tags: ["Repositories", "Review"],
    summary: "Ask a question about one pull request's review",
    auth: "session",
    responses: { 200: { description: "Answer" }, 400: { description: "Malformed question" }, 401: { description: "Not signed in" }, 404: { description: "No such pull request" } },
  },
];

export function registerInternalAndPublicRouteSpecs(registry: OpenAPIRegistry): void {
  for (const entry of INTERNAL_AND_PUBLIC_ROUTE_SPECS) registerRouteSpec(registry, entry);
}

/** Exported for the auth-parity meta-test. */
export const INTERNAL_AND_PUBLIC_ROUTE_SPECS: readonly SpecEntry[] = [
  ...jobRoutes(),
  ...INTERNAL_READS,
  ...INTERNAL_OTHER,
  ...PUBLIC_ROUTES,
  ...MISC_ROUTES,
];
