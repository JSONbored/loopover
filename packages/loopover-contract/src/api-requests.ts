// Every request schema the Worker API validates against (#9750).
//
// These were 52 declarations inline in src/api/routes.ts, which meant an MCP tool wrapping the same route
// validated against an independently-authored copy of the same shape. That cost is not theoretical: the
// #9518 migration found FleetRegisterInstallationInput never declaring the `registered` field its route
// accepts, making the opt-out unreachable over MCP. One exported object per payload is what stops that
// recurring -- a tool and its route now accept and reject the same thing by construction.
//
// MOVED, NOT REWRITTEN. Each schema is the declaration that was in routes.ts, verbatim, so a payload the
// API accepted before is accepted now and one it rejected is rejected the same way with the same status.
// The bounds they referenced could not travel with them -- this is a zod-only leaf that cannot import the
// Worker or the engine -- so limits.ts restates them and a meta-test pins each against its original, the
// posture PREFLIGHT_LIMITS already established there.
import { z } from "zod";
import {
  MAX_FOCUS_MANIFEST_BYTES,
  MAX_LOCAL_SCORER_WARNING_CHARS,
  MAX_LOCAL_SCORER_WARNING_COUNT,
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
  PREFLIGHT_LIMITS,
  PUBLIC_SURFACE_SKIP_REASONS,
  SCENARIO_MAX_BRANCH_REF_CHARS,
  SCENARIO_MAX_LINKED_ISSUE_NUMBERS,
  SCENARIO_MAX_REPO_FULL_NAME_CHARS,
} from "./limits.js";

/**
 * Whether a value's JSON encoding fits a byte budget.
 *
 * Moved here with the one schema that refines on it (`focusManifestInputSchema`). Byte length rather than
 * character count because the limit it enforces is a storage limit, and a manifest full of multi-byte
 * characters is larger than its `.length` suggests.
 */
export function isJsonByteLengthWithinLimit(value: unknown, maxBytes: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    // A cyclic structure cannot be serialized at all, which is not "within the limit".
    return false;
  }
}

export const MAX_LOCAL_BRANCH_REF_CHARS = 256;
export const MAX_LOCAL_BRANCH_TEXT_CHARS = 4000;

// #6745: body of POST /v1/contributors/:login/notifications/read. Mirrors markNotificationsReadShape
// (src/mcp/server.ts) minus `login` (which is the path param): `ids` is optional (absent = mark all delivered).
export const markNotificationsReadBodySchema = z.object({
  ids: z.array(z.string().min(1).max(MAX_NOTIFICATION_DELIVERY_ID_LENGTH)).max(MAX_NOTIFICATION_MARK_READ_IDS).optional(),
});

// #7657: AMS miner posts DetectedNotificationEvent-shaped AMS kinds; recipient is forced to the path login.
export const amsNotificationsBodySchema = z.object({
  events: z
    .array(
      z.object({
        eventType: z.enum(["ams_attempt_started", "ams_attempt_failed", "ams_governor_paused", "ams_pr_outcome"]),
        repoFullName: z.string().min(1).max(200),
        pullNumber: z.number().int().min(0),
        dedupKey: z.string().min(1).max(500),
        deeplink: z.string().min(1).max(2000),
        actorLogin: z.string().min(1).max(100),
        detectedAt: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(20),
});

// #6746: body of POST/DELETE /v1/contributors/:login/watches. Mirrors watchIssuesShape (src/mcp/server.ts) minus
// `login` (path param) and `action` (the HTTP verb). `labels` is POST-only (a DELETE ignores it).
export const watchSubscriptionBodySchema = z.object({
  repoFullName: z.string().min(3).max(200),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export const preflightSchema = z.object({
  repoFullName: z.string().min(3).max(PREFLIGHT_LIMITS.repoFullNameChars),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(PREFLIGHT_LIMITS.linkedIssues).optional(),
  tests: z.array(z.string().max(PREFLIGHT_LIMITS.testChars)).max(PREFLIGHT_LIMITS.tests).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
});

export const localDiffPreflightSchema = preflightSchema.extend({
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  commitMessage: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
});

export const validateLinkedIssueSchema = z.object({
  issueNumber: z.number().int().positive(),
  plannedChange: z
    .object({
      title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars).optional(),
      changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
      contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
    })
    .optional(),
});

export const checkBeforeStartSchema = z.object({
  issueNumber: z.number().int().positive().optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars).optional(),
  plannedPaths: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
});

export const lintPrTextSchema = z.object({
  commitMessages: z.array(z.string().max(PREFLIGHT_LIMITS.bodyChars)).max(50).optional(),
  prBody: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  linkedIssue: z.number().int().positive().optional(),
});

export const validateFocusManifestSchema = z.object({
  content: z.string().max(256 * 1024),
  source: z.enum(["repo_file", "api_record", "none"]).optional(),
});

// Pure local-metadata slop self-checks (no repo data, no secrets) — mirror the loopover_check_slop_risk /
// loopover_check_issue_slop MCP tools so the npm package can offer the same agent-native self-check.
// #6754: mirrors the loopover_evaluate_escalation MCP tool's input shape exactly (src/mcp/server.ts) so the
// REST surface can never accept something the tool would reject, or vice versa.
export const evaluateEscalationSchema = z.object({
  runStatus: z.enum(["running", "converged", "abandoned", "error"]),
  healthStatus: z.enum(["healthy", "degraded", "critical"]).optional(),
  customerFlagged: z.boolean().optional(),
  killRequested: z.boolean().optional(),
});

// #7742: customer-facing APR transfer request. Completion is resolved SERVER-SIDE via loadAprIdeaCompletion —
// never accepted from the body (that was the #8000 Superagent P1). `.strict()` rejects any attempt to smuggle
// `ideaComplete` (or other unknown keys). Plan/payment fields are deliberately absent.
export const requestAprTransferSchema = z
  .object({
    installationId: z.number().int().positive(),
    repoFullName: z.string().min(1).max(200),
    newOwner: z.string().min(1).max(100),
    ideaId: z.string().min(1).max(200).optional(),
  })
  .strict();

// #6744: mirrors `ProposeActionInput` in @loopover/contract VERBATIM, minus owner/repo (they are path params), so
// POST /v1/repos/:owner/:repo/agent/pending-actions can never stage an action the loopover_propose_action MCP
// tool would reject, or vice versa. actionClass stays the 7-value propose set (a subset of AgentActionClass).
export const proposePendingActionSchema = z.object({
  pullNumber: z.number().int().positive(),
  actionClass: z.enum(["review", "request_changes", "approve", "merge", "close", "label", "review_state_label"]),
  reason: z.string().max(500).optional(),
  label: z.string().min(1).max(100).optional(),
  reviewBody: z.string().max(60000).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  closeComment: z.string().max(60000).optional(),
});

// #6755: mirrors `IntakeIdeaInput` in @loopover/contract VERBATIM. Fields are deliberately LOOSE here for the same
// reason they are on the tool: the engine's validateIdeaSubmission owns the real bounds/format checks and returns
// the actionable error list, so an empty/malformed submission must reach the handler rather than be rejected
// upstream by the schema.
export const intakeIdeaSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  targetRepo: z.union([z.string(), z.looseObject({})]).optional(),
  constraints: z.array(z.string()).max(50).optional(),
  acceptanceHints: z.array(z.string()).max(50).optional(),
  priority: z.string().optional(),
  decomposition: z
    .array(z.object({ key: z.string(), title: z.string(), body: z.string(), dependsOn: z.array(z.string()).max(50).optional() }))
    .max(50)
    .optional(),
});

// #6752: mirrors `BuildResultsPayloadInput` in @loopover/contract VERBATIM (same bounds, same optionality) so the
// REST surface can never accept an input the MCP tool would reject, or vice versa.
export const resultsPayloadSchema = z.object({
  repoFullName: z.string().min(1),
  prNumber: z.number().int().nullable().optional(),
  title: z.string(),
  changedFiles: z
    .array(z.object({ path: z.string(), additions: z.number().int().optional(), deletions: z.number().int().optional() }))
    .max(5000)
    .optional(),
  status: z.enum(["open", "merged", "closed"]).optional(),
});

// #6753: mirrors `BuildProgressSnapshotInput` in @loopover/contract VERBATIM (same bounds, same optionality) so the
// REST surface can never accept an input the MCP tool would reject, or vice versa.
export const progressSnapshotSchema = z.object({
  iteration: z.number().int(),
  maxIterations: z.number().int().nullable().optional(),
  phase: z.enum(["queued", "claiming", "coding", "reviewing", "submitting", "done"]),
  status: z.enum(["running", "converged", "abandoned", "error"]),
  recentActivity: z
    .array(z.object({ step: z.string(), detail: z.string().optional(), at: z.string().optional() }))
    .max(1000)
    .optional(),
});

// #6749: mirrors checkTestEvidenceShape in src/mcp/server.ts VERBATIM (same bounds, same optionality) so the
// REST surface can never accept an input the MCP tool would reject, or vice versa.
export const testEvidenceSchema = z.object({
  changedPaths: z.array(z.string().min(1).max(400)).max(2000),
  testFiles: z.array(z.string().min(1).max(400)).max(2000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
});

// #6750: mirrors suggestBoundaryTestsShape in src/mcp/server.ts VERBATIM (same bounds, same .strict()
// objects, same optionality) so the REST surface can never accept an input the MCP tool would reject.
export const boundaryTestsSchema = z.object({
  changedFiles: z.array(z.object({ path: z.string().min(1).max(400) }).strict()).max(500),
  boundaryTouches: z
    .array(
      z
        .object({
          path: z.string().min(1).max(400),
          kind: z.enum(["array_index_bounds", "null_or_undefined_branch", "empty_collection_check"]),
        })
        .strict(),
    )
    .max(20)
    .optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
});

export const slopRiskSchema = z.object({
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000)
    .optional(),
  description: z.string().max(20000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  commitMessages: z.array(z.string().max(2000)).max(200).optional(),
  hasLinkedIssue: z.boolean().optional(),
  issueDiscoveryLane: z.boolean().optional(),
});

// #6748: mirrors checkImprovementPotentialShape in src/mcp/server.ts VERBATIM (same bounds, same optionality)
// so the REST surface can never accept an input the MCP tool would reject, or vice versa.
export const improvementPotentialSchema = z.object({
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000)
    .optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  patchCoverageDeltaPercent: z.number().optional(),
  complexityDeltas: z
    .array(
      z.object({
        file: z.string().min(1).max(400),
        line: z.number().int().min(1),
        name: z.string().min(1).max(400),
        before: z.number().int().min(0),
        after: z.number().int().min(0),
        delta: z.number().int(),
      }),
    )
    .max(2000)
    .optional(),
  duplicationDeltas: z
    .array(
      z.object({
        file: z.string().min(1).max(400),
        line: z.number().int().min(1),
        duplicateOfLine: z.number().int().min(1),
        lines: z.number().int().min(1),
      }),
    )
    .max(2000)
    .optional(),
});
export const issueSlopSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
});

export const selfhostDeadLetterQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
  })
  .strict();

export const skippedPrAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    repoFullName: z.string().trim().min(3).max(200).optional(),
    reason: z.enum(PUBLIC_SURFACE_SKIP_REASONS).optional(),
    since: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const localBranchChangedFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    previousPath: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
    binary: z.boolean().optional(),
  })
  .strict();

export const localBranchValidationSchema = z
  .object({
    command: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
    summary: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    durationMs: z.number().int().min(0).optional(),
    exitCode: z.number().int().min(0).optional(),
  })
  .strict();

export const localBranchScorerSchema = z
  .object({
    mode: z.enum(["metadata_only", "external_command", "gittensor_root"]),
    activeModel: z.string().max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    sourceTokenScore: z.number().min(0).optional(),
    totalTokenScore: z.number().min(0).optional(),
    sourceLines: z.number().min(0).optional(),
    testTokenScore: z.number().min(0).optional(),
    nonCodeTokenScore: z.number().min(0).optional(),
    nonCodeLines: z.number().min(0).optional(),
    warnings: z.array(z.string().max(MAX_LOCAL_SCORER_WARNING_CHARS)).max(MAX_LOCAL_SCORER_WARNING_COUNT).optional(),
  })
  .strict();

export const linkedIssueContextSchema = z
  .object({
    status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]).optional(),
    source: z.enum(["user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]).optional(),
    issueNumbers: z.array(z.number().int().positive()).max(50).optional(),
    solvedByPullRequests: z.array(z.number().int().positive()).max(50).optional(),
    reason: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    warnings: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(20).optional(),
  })
  .strict();

/**
 * The FIELDS a caller may send, before the route's normalisation runs (#9773).
 *
 * Exported separately because `branchEligibilitySchema` is a pipe (it transforms), so its members are not
 * reachable through it -- and the stdio CLI needs exactly those members to validate `--branch-eligibility`
 * and `--branch-eligibility-source` against the route's own vocabulary instead of restating both lists.
 */
export const branchEligibilityFields = z
  .object({
    status: z.enum(["eligible", "ineligible", "unknown"]),
    source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
    reason: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    checkedAt: z.string().max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    stale: z.boolean().optional(),
  })
  .strict();

export const branchEligibilitySchema = branchEligibilityFields.transform((value) => ({
  ...value,
  status: value.status === "eligible" ? ("unknown" as const) : value.status,
  source: "user_supplied" as const,
}));

export const focusManifestInputSchema = z
  .record(z.string(), z.unknown())
  .refine((manifest) => isJsonByteLengthWithinLimit(manifest, MAX_FOCUS_MANIFEST_BYTES), {
    message: `focusManifest must serialize to ${MAX_FOCUS_MANIFEST_BYTES} bytes or fewer`,
  });

export const localBranchAnalysisSchema = z
  .object({
    login: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
    baseRef: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
    headRef: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
    branchName: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
    baseSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    headSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    mergeBaseSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    remoteTrackingSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    commitMessages: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(30).optional(),
    changedFiles: z.array(localBranchChangedFileSchema).max(500).optional(),
    validation: z.array(localBranchValidationSchema).max(50).optional(),
    linkedIssues: z.array(z.number().int().positive()).max(SCENARIO_MAX_LINKED_ISSUE_NUMBERS).optional(),
    labels: z.array(z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS)).max(50).optional(),
    title: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    body: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    localScorer: localBranchScorerSchema.optional(),
    pendingMergedPrCount: z.number().int().min(0).optional(),
    pendingClosedPrCount: z.number().int().min(0).optional(),
    approvedPrCount: z.number().int().min(0).optional(),
    expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
    projectedCredibility: z.number().min(0).max(1).optional(),
    scenarioNotes: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(20).optional(),
    pendingCommitCount: z.number().int().min(0).optional(),
    ciStatusHints: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(20).optional(),
    focusManifest: focusManifestInputSchema.optional(),
    branchEligibility: branchEligibilitySchema.optional(),
  })
  .strict();

export const scorePreviewSchema = z.object({
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("planned_pr"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  linkedIssueContext: linkedIssueContextSchema.optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  nonCodeLines: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  prAgeHours: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  mergedPullRequests: z.number().int().min(0).optional(),
  validSolvedIssues: z.number().int().min(0).optional(),
  issueCredibility: z.number().min(0).max(1).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  duplicateRiskCount: z.number().int().min(0).optional(),
  fixedBaseScore: z.number().min(0).optional(),
  metadataOnly: z.boolean().default(false),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: branchEligibilitySchema.optional(),
});

export const agentSurfaceSchema = z.enum(["api", "mcp", "github_comment"]).default("api");

export const agentRunSchema = z
  .object({
    objective: z.string().min(1).max(500),
    actorLogin: z.string().min(1),
    surface: agentSurfaceSchema.optional(),
    target: z
      .object({
        repoFullName: z.string().min(3).optional(),
        pullNumber: z.number().int().positive().optional(),
        issueNumber: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const agentPlanSchema = z
  .object({
    login: z.string().min(1),
    objective: z.string().min(1).max(500).optional(),
    repoFullName: z.string().min(3).optional(),
    surface: agentSurfaceSchema.optional(),
  })
  .strict();

export const agentExplainBlockersSchema = z.union([localBranchAnalysisSchema, agentPlanSchema]);

// reviewCheckMode/linkedIssueGateMode/duplicatePrGateMode/qualityGateMode/qualityGateMinScore/
// aiReviewMode/aiReviewByok/aiReviewProvider/aiReviewModel/aiReviewAllAuthors removed from this write
// schema (Batch C, loopover#6444) -- config-as-code only via .loopover.yml's gate.* block now;
// upsertRepositorySettings no longer has a DB column to write any of them into.
export const COMMAND_AUTHORIZATION_ROLES = ["maintainer", "collaborator", "pr_author", "confirmed_miner"] as const;

/** The command-authorization block, without a default. */
export const CommandAuthorizationPolicySchema = z.object({
  default: z.array(z.enum(COMMAND_AUTHORIZATION_ROLES)).max(4).optional(),
  commands: z.record(z.string().trim().min(1).max(64), z.array(z.enum(COMMAND_AUTHORIZATION_ROLES)).max(4)).optional(),
});
export type CommandAuthorizationPolicy = z.infer<typeof CommandAuthorizationPolicySchema>;

/**
 * The repository settings WRITE schema, as a factory over its one non-portable default.
 *
 * A factory rather than a plain schema because `commandAuthorization`'s default is a twenty-key policy
 * object owned by @loopover/engine, and this is a zod-only leaf that cannot import it. Restating the policy
 * here would be the exact duplication this move exists to remove -- so the shape lives here once and the
 * src layer supplies the engine's own value once, at the single place the schema is constructed.
 */
export function buildRepositorySettingsSchema(defaultCommandAuthorization: CommandAuthorizationPolicy) {
  return z.object({
    gatePack: z.enum(["gittensor", "oss-anti-slop"]).default("gittensor"),
    aiReviewLowConfidenceDisposition: z.enum(["one_shot", "hold_for_review", "advisory_only"]).default("hold_for_review"),
    closeOwnerAuthors: z.boolean().default(false),
    autoLabelEnabled: z.boolean().default(true),
    // #6443: gittensorLabel/blacklistLabel/createMissingLabel/contributorBlacklist removed -- no longer
    // DB-backed, config-as-code only via .loopover.yml's settings: block now.
    requireLinkedIssue: z.boolean().default(false),
    commandAuthorization: CommandAuthorizationPolicySchema.default(defaultCommandAuthorization),
  });
}

// #130 maintainer self-serve settings editor. A PATCH-style subset: every field optional so the maintainer
// dashboard can save just the group it changed. Excludes the secret-bearing aiReview* group (set via the
// dedicated /ai-review + /ai-key routes) and the operator-only scoring internal (backfillEnabled). The
// handler loads current settings and merges, since upsertRepositorySettings defaults any absent field
// rather than preserving it.
// reviewCheckMode/linkedIssueGateMode/duplicatePrGateMode/qualityGateMode/qualityGateMinScore/
// selfAuthoredLinkedIssueGateMode removed from this write schema (Batch C, loopover#6444) --
// config-as-code only via .loopover.yml's gate.* block now.
export const maintainerSettingsSchema = z
  .object({
    gatePack: z.enum(["gittensor", "oss-anti-slop"]),
    mergeReadinessGateMode: z.enum(["off", "advisory", "block"]),
    manifestPolicyGateMode: z.enum(["off", "advisory", "block"]),
    linkedIssueSatisfactionGateMode: z.enum(["off", "advisory", "block"]),
    contentLaneDeliverableGateMode: z.enum(["off", "advisory", "block"]),
    backtestRegressionGateMode: z.enum(["off", "advisory", "block"]),
    // #6443: mergeTrainMode/gittensorLabel/blacklistLabel/createMissingLabel removed -- no longer DB-backed,
    // config-as-code only via .loopover.yml's settings: block now.
    // #6446: firstTimeContributorGrace removed -- a dead, never-wired RESERVED/INERT field (#2266); deleted
    // rather than wired in, since the gate's one-shot design deliberately never softens a blocker for a
    // newcomer.
    slopGateMode: z.enum(["off", "advisory", "block"]),
    slopGateMinScore: z.number().int().min(0).max(100).nullable(),
    slopAiAdvisory: z.boolean(),
    autoLabelEnabled: z.boolean(),
    closeOwnerAuthors: z.boolean(),
    requireLinkedIssue: z.boolean(),
    agentPaused: z.boolean(),
    agentDryRun: z.boolean(),
    requireFreshRebaseWindowMinutes: z.number().int().positive().nullable(),
    staleBaseAheadByThreshold: z.number().int().positive().nullable(),
    commandAuthorization: z.object({
      default: z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4).optional(),
      commands: z.record(z.string().trim().min(1).max(64), z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4)).optional(),
    }),
    // Agent-layer config (#773/#774). The DB layer normalizes autonomy (deny-by-default), so a loose
    // record here is safe — invalid entries are dropped on persist.
    // #6445: autoMaintain removed -- no longer DB-backed, config-as-code only via .loopover.yml's
    // settings: block now.
    autonomy: z.record(z.string().trim().min(1).max(32), z.enum(["observe", "auto_with_approval", "auto"])),
  })
  .partial();

// #7676 installation-scoped bulk pause/dry-run: the same two per-repo flags maintainerSettingsSchema already
// validates, picked out on their own so a tenant with many repos under one installation can flip both at once
// instead of one PUT /v1/repos/:owner/:repo/settings call per repo. Deliberately just these two fields -- not
// a general bulk settings merge -- and deliberately separate from the global operator kill-switch
// (getGlobalAgentFrozenState), which stays its own singleton untouched by this.
export const installationBulkAgentSettingsSchema = maintainerSettingsSchema.pick({ agentPaused: true, agentDryRun: true }).strict();

// downgradeQualityGateMode (the settings-write-path "block" -> "advisory" downgrade for
// qualityGateMode/#2267) was removed here: qualityGateMode is config-as-code only now (Batch C,
// loopover#6444), so no write path sets it anymore. resolveEffectiveSettings's own downgrade logic
// (src/signals/focus-manifest.ts) still applies the same rule on the read/resolver path.

// Maintainer BYOK provider key. Write-only: the key is encrypted at rest and never returned. A loose
// prefix check catches the common provider/key mismatch (e.g. pasting an OpenAI key under Anthropic)
// without coupling to exact provider key formats: Anthropic keys start with `sk-ant-`; OpenAI keys
// start with `sk-` but never `sk-ant-`.
export const repositoryAiKeySchema = z
  .object({
    provider: z.enum(["anthropic", "openai"]),
    key: z.string().trim().min(20).max(400),
    model: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .refine((value) => (value.provider === "anthropic" ? value.key.startsWith("sk-ant-") : value.key.startsWith("sk-") && !value.key.startsWith("sk-ant-")), {
    message: "API key does not match the selected provider (Anthropic keys start with sk-ant-, OpenAI keys start with sk-).",
    path: ["key"],
  });

// Instance subscription-CLI credential (#9543). Write-only: encrypted at rest, never returned. The
// single-line / no-comment / no-surrounding-whitespace rule is the SAME one the host-side rotation path
// enforces, for the same reason -- src/selfhost/load-file-secrets.ts only .trim()s, so a label line above
// the value silently becomes part of the credential and every AI call fails auth while the container stays
// healthy. Validating it here too means the DB path cannot store a shape the file path would reject.
export const rotatableProviderSchema = z.enum(["claude-code", "codex"]);
export const providerCredentialSchema = z.object({
  credential: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\r\n]/.test(value), "must be a single line -- a comment or label line would become part of the credential")
    .refine((value) => value.trim() === value, "must not have leading or trailing whitespace")
    .refine((value) => !value.startsWith("#"), "must not start with '#' -- that is a comment, not a credential"),
});

// Linear personal API key (#3186) -- no provider-prefix assertion (unlike the AI-key schema above): Linear's
// key format is not a stable enough public contract to hard-validate against, so only a length bound applies.
export const repositoryLinearKeySchema = z.object({
  key: z.string().trim().min(20).max(400),
});

// Maintainer-settable AI-review config. mode/byok/provider/model/allAuthors are config-as-code only now
// (Batch C, loopover#6444) -- set via a repo's own .loopover.yml gate.aiReview.* block, not this route --
// so they are intentionally NOT accepted here anymore (a caller submitting the old shape gets a clean
// validation error naming the current route, not a silently-ignored write). The secret key is set
// separately via the ai-key route; never here.
export const repositoryAiReviewSchema = z
  .object({
    closeOwnerAuthors: z.boolean().optional(),
    // Disposition for a sub-aiReviewCloseConfidence-floor ai_consensus_defect/ai_review_split finding (#4603).
    // Optional -- upsertRepositorySettings applies its own "hold_for_review" default when omitted.
    lowConfidenceDisposition: z.enum(["one_shot", "hold_for_review", "advisory_only"]).optional(),
  })
  // .strict() so a caller still sending the pre-Batch-C shape (mode/byok/provider/model/allAuthors) gets
  // an immediate "unrecognized key" validation error naming exactly which fields moved, instead of those
  // keys being silently dropped and the request appearing to partially succeed.
  .strict();

export const contributorIssueDraftGenerateSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  create: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

// #7764: REST mirror of the loopover_plan_repo_issues MCP tool (src/mcp/server.ts's planRepoIssuesShape).
// Unlike the contributor-issue-draft schema above, `goal` is a REQUIRED maintainer-supplied free-form string
// and `limit` is capped lower (10, not 20): every draft here costs real LLM spend, unlike that tool's zero-cost
// static signals. dryRun/create keep the same create-safety contract (create alone is rejected below).
export const issuePlanDraftGenerateSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  dryRun: z.boolean().optional().default(true),
  create: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

export const settingsPreviewSchema = z.object({
  sample: z
    .object({
      authorLogin: z.string().trim().min(1).max(100).optional(),
      authorType: z.enum(["User", "Bot"]).optional(),
      authorAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
      minerStatus: z.enum(["confirmed", "not_found", "unavailable"]).optional(),
      title: z.string().max(300).optional(),
      body: z.string().max(10000).nullable().optional(),
      labels: z.array(z.string().max(100)).max(50).optional(),
      linkedIssues: z.array(z.number().int().positive()).max(50).optional(),
      commandName: z.string().trim().min(1).max(64).optional(),
      commenterLogin: z.string().trim().min(1).max(100).optional(),
      commenterAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
    })
    .optional(),
});

export const chatQaRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
  })
  .strict();

export const commandPreviewSchema = z
  .object({
    command: z.string().min(1).max(80),
    repoFullName: z.string().min(3).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    pullNumber: z.number().int().positive().optional(),
    login: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    sample: z
      .object({
        authorLogin: z.string().trim().min(1).max(100).optional(),
        authorType: z.enum(["User", "Bot"]).optional(),
        authorAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
        commenterLogin: z.string().trim().min(1).max(100).optional(),
        commenterAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
        minerStatus: z.enum(["confirmed", "not_found", "unavailable"]).optional(),
        title: z.string().max(300).optional(),
        body: z.string().max(10000).nullable().optional(),
        labels: z.array(z.string().max(100)).max(50).optional(),
        linkedIssues: z.array(z.number().int().positive()).max(50).optional(),
        permissions: z.record(z.string(), z.string()).optional(),
        missingPermissions: z.array(z.string().max(100)).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const commandFeedbackSchema = z
  .object({
    answerId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
    vote: z.enum(["useful", "not_useful"]),
  })
  .strict();

export const killSwitchUpdateSchema = z
  .object({
    frozen: z.boolean(),
  })
  .strict();

// Config-push write path (#7522, piece 1 of #4902's design): an operator-addressed Orb-operational notice
// (enrollment lifecycle, capability announcement, deprecation notice) -- explicit installationIds target list
// only, no percentage/canary selector (no rollout-percentage primitive exists in this codebase to build one on
// top of; out of scope here). pushId doubles as the idempotency key (see enqueueConfigPushRelay's deliveryId
// derivation), so it's constrained to the same safe-identifier shape as commandFeedbackSchema's answerId above.
export const configPushSchema = z
  .object({
    installationIds: z.array(z.number().int().positive()).min(1).max(500),
    pushId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
    message: z.string().min(1).max(500),
    capability: z.string().min(1).max(120).optional(),
    deprecatesAt: z.string().datetime().optional(),
  })
  .strict();

export const digestSubscriptionSchema = z
  .object({
    email: z.string().email().max(320),
  })
  .strict();

export const postMergeIncidentSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const postMergeIncidentReportSchema = z
  .object({
    description: z.string().min(1).max(4000),
    severity: postMergeIncidentSeveritySchema,
    mergedSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i)
      .optional(),
  })
  .strict();

export const operatorPostMergeIncidentReportSchema = z
  .object({
    repoFullName: z.string().min(3).max(200),
    pullNumber: z.number().int().positive(),
    description: z.string().min(1).max(4000),
    severity: postMergeIncidentSeveritySchema,
    mergedSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i)
      .optional(),
  })
  .strict();

/**
 * The queue-intelligence analysis payload (#9750).
 *
 * Declared INSIDE its handler until now, rebuilt on every request and invisible to any tool wanting to
 * submit the same shape. The role and status literals are the ones src/queue-intelligence.ts exports as
 * types; expressed here as the enums that validate them, so the schema and the analyzer cannot disagree
 * about what a role is.
 */
export const QUEUE_INTELLIGENCE_LIMITS = {
  bodyBytes: 1024 * 1024,
  pullRequests: 250,
  authorChars: 100,
  titleChars: 300,
  bodyChars: 4000,
  duplicateCandidates: 25,
} as const;

export const QUEUE_INTELLIGENCE_AUTHOR_ROLES = ["first-time", "contributor", "maintainer"] as const;
export const QUEUE_INTELLIGENCE_CHECKS_STATUSES = ["passing", "failing", "pending"] as const;

export const QueueIntelligencePullRequestSchema = z.object({
  number: z.number().int().positive(),
  author: z.string().max(QUEUE_INTELLIGENCE_LIMITS.authorChars),
  authorRole: z.enum(QUEUE_INTELLIGENCE_AUTHOR_ROLES),
  isConfirmedMiner: z.boolean(),
  linkedIssue: z.object({ qualityScore: z.number().min(0).max(1) }).nullable(),
  checksStatus: z.enum(QUEUE_INTELLIGENCE_CHECKS_STATUSES),
  isStale: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  title: z.string().max(QUEUE_INTELLIGENCE_LIMITS.titleChars),
  body: z.string().max(QUEUE_INTELLIGENCE_LIMITS.bodyChars),
  duplicateCandidates: z.array(z.number().int().positive()).max(QUEUE_INTELLIGENCE_LIMITS.duplicateCandidates),
  createdAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
});

export const QueueIntelligenceRepoContextSchema = z.object({
  totalOpenPRs: z.number().int().nonnegative(),
  avgReviewTimeDays: z.number().nonnegative(),
  maintainerWorkload: z.number().min(0).max(1),
});
