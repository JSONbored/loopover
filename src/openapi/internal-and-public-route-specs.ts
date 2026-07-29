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
import { z } from "zod";
import { registerRouteSpec, type RouteAuth, type RouteMethod } from "./define-route";

type SpecEntry = {
  method: RouteMethod;
  path: string;
  operationId: string;
  tags: [string, ...string[]];
  summary: string;
  auth: RouteAuth;
  /** Narrower path parameters than the derived string ones; only for a closed-set segment (#9707). */
  request?: { params?: z.ZodObject };
  /** `schema` is optional: most entries here describe a status and nothing more, but an operation that
   *  already published a response body must not lose it on the way through the seam (#9707). */
  responses: Record<number, { description: string; schema?: z.ZodTypeAny }>;
};

const INTERNAL_AUTH = { 401: { description: "Invalid internal token" } };
const QUEUED = { 202: { description: "Job queued" }, ...INTERNAL_AUTH };
const RAN = { 200: { description: "Job ran inline and returned its result" }, ...INTERNAL_AUTH };
/** Attached PER ENTRY, never folded into QUEUED/RAN: only some job routes validate a body, and widening
 *  the shared constants would attach a 400 to every route that happily accepts any body (#9706). */
const MALFORMED = { 400: { description: "Malformed job request" } };

/**
 * A job that exists in BOTH forms: a bare POST that ENQUEUES onto the durable queue, and a `/run` sibling
 * that executes inline. `queueValidates`/`runValidates` say which form rejects a malformed body -- the two
 * are genuinely independent (build-contributor-decision-packs validates `login` only on `/run`), so a
 * single flag would have published a 400 the bare form never returns.
 */
type JobPair = { segment: string; stem: string; summary: string; queueValidates?: boolean; runValidates?: boolean };

const JOB_PAIRS: readonly JobPair[] = [
  { segment: "refresh-registry", stem: "RefreshRegistry", summary: "refresh the Gittensor registry snapshot" },
  { segment: "refresh-scoring-model", stem: "RefreshScoringModel", summary: "refresh the active scoring model" },
  { segment: "refresh-upstream-drift", stem: "RefreshUpstreamDrift", summary: "recompute upstream ruleset drift" },
  { segment: "file-upstream-drift-issues", stem: "FileUpstreamDriftIssues", summary: "file issues for open upstream drift" },
  { segment: "build-contributor-decision-packs", stem: "BuildContributorDecisionPacks", summary: "rebuild contributor decision packs", runValidates: true },
  { segment: "refresh-contributor-activity", stem: "RefreshContributorActivity", summary: "refresh cached contributor activity", queueValidates: true, runValidates: true },
  { segment: "generate-signal-snapshots", stem: "GenerateSignalSnapshots", summary: "generate signal snapshots" },
  { segment: "generate-weekly-value-report", stem: "GenerateWeeklyValueReport", summary: "generate the weekly value report" },
  { segment: "generate-review-recap", stem: "GenerateReviewRecap", summary: "generate the maintainer review recap", queueValidates: true, runValidates: true },
  { segment: "backfill-registered-repos", stem: "BackfillRegisteredRepos", summary: "backfill registered repository records" },
  { segment: "backfill-repo-segment", stem: "BackfillRepoSegment", summary: "backfill repository segment assignments", queueValidates: true, runValidates: true },
  { segment: "backfill-pr-details", stem: "BackfillPrDetails", summary: "backfill pull-request detail rows", queueValidates: true, runValidates: true },
  { segment: "rollup-product-usage", stem: "RollupProductUsage", summary: "roll up product usage counters" },
];

/**
 * Jobs that exist only in the bare form.
 *
 * Every one of them ENQUEUES and answers 202 -- so the summary reads "Queue a job to", and the success
 * status is 202 rather than the 200 this table used to publish, which was unreachable for all five.
 * Responses vary per entry because the handlers do: rag-index 404s when retrieval is disabled and never
 * validates a body at all (an unparseable one becomes `{}`), while regate-pr does both.
 */
type SingleJob = { segment: string; operationId: string; summary: string; responses: Record<number, { description: string }> };

const SINGLE_JOBS: readonly SingleJob[] = [
  {
    segment: "rag-index",
    operationId: "RunRagIndex",
    summary: "index repository content for retrieval",
    responses: { ...QUEUED, 404: { description: "Retrieval is not enabled on this deployment" } },
  },
  {
    segment: "regate-pr",
    operationId: "RegatePullRequest",
    summary: "re-run the gate for one pull request",
    responses: { ...QUEUED, ...MALFORMED, 404: { description: "The repository is not installed" } },
  },
  { segment: "build-contributor-evidence", operationId: "queueBuildContributorEvidenceJob", summary: "build contributor evidence", responses: QUEUED },
  { segment: "build-burden-forecasts", operationId: "queueBuildBurdenForecastsJob", summary: "build burden forecasts", responses: QUEUED },
  { segment: "repair-data-fidelity", operationId: "queueRepairDataFidelityJob", summary: "repair data fidelity", responses: QUEUED },
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
  for (const { segment, stem, summary, queueValidates, runValidates } of JOB_PAIRS) {
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}`,
      operationId: `queue${stem}Job`,
      tags: ["Internal", "Jobs"],
      summary: `Queue a job to ${summary}`,
      auth: "internal",
      responses: queueValidates ? { ...QUEUED, ...MALFORMED } : QUEUED,
    });
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}/run`,
      operationId: `run${stem}Job`,
      tags: ["Internal", "Jobs"],
      summary: `Run the job to ${summary} inline, bypassing the queue`,
      auth: "internal",
      responses: runValidates ? { ...RAN, ...MALFORMED } : RAN,
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
  for (const { segment, operationId, summary, responses } of SINGLE_JOBS) {
    entries.push({
      method: "post",
      path: `/v1/internal/jobs/${segment}`,
      operationId,
      tags: ["Internal", "Jobs"],
      summary: `Queue a job to ${summary}`,
      auth: "internal",
      responses,
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
    // 200, not 202: the handler returns 200 on success, and that is the shipped, client-observed status. 413
    // reflects the readOrbIngestBody 1 MiB (MAX_ORB_INGEST_BODY_BYTES) hard body ceiling.
    responses: {
      200: { description: "Batch accepted" },
      400: { description: "Malformed batch" },
      401: { description: "Missing or invalid ingest credential" },
      413: { description: "Batch exceeds the 1 MiB (MAX_ORB_INGEST_BODY_BYTES) body ceiling" },
    },
  },
  {
    method: "post",
    path: "/v1/orb/ingest",
    operationId: "postOrbIngest",
    tags: ["ORB"],
    // Its own ORB_INGEST_TOKEN shared-secret bearer, not a LoopOver API token -- so auth: "orb", which is
    // what derives the OrbBearer security stanza (the legacy registerPath block had none at all).
    auth: "orb",
    summary: "Ingest a batch of Orb events",
    responses: {
      200: { description: "Batch accepted; returns { accepted: number }" },
      400: { description: "Malformed JSON or invalid payload shape" },
      401: { description: "Missing or invalid ingest credential" },
      403: { description: "Instance not authenticated" },
      413: { description: "Batch exceeds the 1 MiB (MAX_ORB_INGEST_BODY_BYTES) body ceiling" },
    },
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

/**
 * The five operations that declared a 401 while publishing no security scheme at all (#9707).
 *
 * They were legacy `registerPath` calls, and `applySecurityMetadata` only fills a stanza in when
 * `requiresApiToken(path)` is true. That returns false for `/v1/internal/*` and for the anchor-attempt
 * ingest -- not because either is open, but because each carries its OWN credential check. The result
 * was the worst of both: a published 401 with no scheme that could produce it, which a generated client
 * cannot act on and a reader cannot tell apart from a genuinely public route.
 *
 * Declaring `auth` here is the fix, because the stanza then DERIVES from the declaration rather than
 * from a second path-prefix model of the same policy.
 */
const PROVIDER = { params: z.object({ provider: z.enum(["claude-code", "codex"]) }) };
const CREDENTIAL_STATUS = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({ configured: z.literal(true), provider: z.string(), last4: z.string(), updatedBy: z.string().nullable(), updatedAt: z.string() }),
]);

const CREDENTIAL_GATED: SpecEntry[] = [
  {
    method: "get",
    path: "/v1/internal/provider-credentials/:provider",
    operationId: "getInternalProviderCredentialsByProvider",
    tags: ["Internal"],
    summary: "Read the secret-free status of a stored instance subscription credential",
    auth: "internal",
    request: PROVIDER,
    responses: {
      200: { description: "Credential status. Never includes the credential itself.", schema: CREDENTIAL_STATUS },
      400: { description: "Unknown provider" },
      ...INTERNAL_AUTH,
    },
  },
  {
    method: "post",
    path: "/v1/internal/provider-credentials/:provider",
    operationId: "postInternalProviderCredentialsByProvider",
    tags: ["Internal"],
    summary: "Store or replace an instance subscription credential, encrypted at rest",
    auth: "internal",
    request: PROVIDER,
    responses: {
      200: { description: "Credential stored. Returns the secret-free status.", schema: z.record(z.string(), z.unknown()) },
      400: { description: "Unknown provider, or a credential that is empty, padded, or not a single line" },
      ...INTERNAL_AUTH,
      503: { description: "TOKEN_ENCRYPTION_SECRET is not configured, so the credential cannot be stored encrypted" },
    },
  },
  {
    method: "delete",
    path: "/v1/internal/provider-credentials/:provider",
    operationId: "deleteInternalProviderCredentialsByProvider",
    tags: ["Internal"],
    summary: "Clear a stored instance subscription credential, falling back to the secret file or boot env",
    auth: "internal",
    request: PROVIDER,
    responses: {
      200: { description: "Credential cleared", schema: z.object({ configured: z.literal(false) }) },
      400: { description: "Unknown provider" },
      ...INTERNAL_AUTH,
    },
  },
  {
    method: "post",
    path: "/v1/internal/bounties/import",
    operationId: "postInternalBountiesImport",
    tags: ["Internal"],
    summary: "Import a bounty snapshot",
    auth: "internal",
    responses: { 200: { description: "Bounty snapshot imported" }, ...INTERNAL_AUTH },
  },
  {
    method: "post",
    path: "/v1/decision-ledger/anchor-attempts",
    operationId: "reportDecisionLedgerAnchorAttempt",
    tags: ["Public"],
    summary: "Report one off-Worker anchoring attempt (success or failure) into the public attempt log",
    // `orb`, not `token`: the gate is LOOPOVER_LEDGER_ANCHOR_REPORT_TOKEN, an ingest bearer that is not a
    // LoopOver API token -- the same posture the `orb` level already exists for.
    auth: "orb",
    responses: {
      200: { description: "{ recorded: true, status: 'ok' | 'failed' }" },
      400: { description: "Unparseable body, or a report whose named field failed validation" },
      401: { description: "Missing or wrong bearer token; also returned when no report token is configured (fails closed)" },
      413: { description: "Body exceeded the ingest ceiling" },
      422: {
        description:
          "Authenticated but unverifiable: unknown_key, bad_signature, row_not_found, or row_hash_mismatch — an `ok` report must verify against a published key AND match the live chain row",
      },
    },
  },
];

/**
 * The remaining operations that published a 401 with no scheme (#9707).
 *
 * The five above were the credential-gated ones. These are the rest of what the "no operation declares a
 * 401 while stating no credential" assertion turns up, and each needed a different answer:
 *
 *   - The GitHub webhook IS gated, by an HMAC over the raw body, so it declares the signature scheme.
 *   - The three device-flow entry points are how a caller OBTAINS a credential; their 401 is "that code
 *     is not authorized", not "you forgot a token". `public` says that out loud -- an empty security array
 *     is OpenAPI's explicit "needs no credential", which is exactly true and is not the same as silence.
 *   - Logout acts on the caller's own session, so it declares one.
 *   - The three job routes are gated by the /v1/internal/* middleware like every one of their siblings;
 *     they were left behind only because they had no `/run` form to be tabled with. #9706 owns the wider
 *     cleanup of that family (the duplicate registrations and the statuses they misreport); this moves
 *     just the auth declaration, because the assertion above cannot pass while they stay silent.
 */
const AUTH_FLOW_RESPONSES = {
  200: { description: "Auth request completed" },
  201: { description: "Auth session created" },
  400: { description: "Invalid auth request" },
  401: { description: "Unauthorized" },
  429: { description: "Rate limited" },
};

const SILENT_401: SpecEntry[] = [
  {
    method: "post",
    path: "/v1/github/webhook",
    operationId: "postGithubWebhook",
    tags: ["Webhooks"],
    summary: "Receive a GitHub webhook delivery",
    auth: "webhook",
    responses: { 202: { description: "Webhook queued" }, 401: { description: "Invalid webhook signature" } },
  },
  {
    method: "post",
    path: "/v1/auth/github/device/start",
    operationId: "postAuthGithubDeviceStart",
    tags: ["Auth"],
    summary: "Start GitHub device-flow authentication",
    auth: "public",
    responses: AUTH_FLOW_RESPONSES,
  },
  {
    method: "post",
    path: "/v1/auth/github/device/poll",
    operationId: "postAuthGithubDevicePoll",
    tags: ["Auth"],
    summary: "Poll a pending GitHub device-flow authorization",
    auth: "public",
    responses: AUTH_FLOW_RESPONSES,
  },
  {
    method: "post",
    path: "/v1/auth/github/session",
    operationId: "postAuthGithubSession",
    tags: ["Auth"],
    summary: "Exchange a GitHub token for a LoopOver session",
    auth: "public",
    responses: AUTH_FLOW_RESPONSES,
  },
  {
    method: "post",
    path: "/v1/auth/logout",
    operationId: "postAuthLogout",
    tags: ["Auth"],
    summary: "End the current session",
    // `public`, not `session`: the handler revokes whatever identity the request carries and answers 200
    // either way -- it never rejects an anonymous caller, and requiresApiToken exempts the family. Saying
    // `session` would advertise a credential no gate demands.
    auth: "public",
    responses: AUTH_FLOW_RESPONSES,
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
  ...CREDENTIAL_GATED,
  ...SILENT_401,
];
