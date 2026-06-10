import { createMcpHandler } from "agents/mcp";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticatePrivateToken, extractBearerToken, type AuthIdentity } from "../auth/security";
import { loadControlPanelAccessScope, loadControlPanelRoleSummary, type ControlPanelAccessScope } from "../services/control-panel-roles";
import {
  countOpenIssues,
  countOpenPullRequests,
  getBounty,
  listBountiesByRepo,
  getContributorEvidence,
  getLatestRepoGithubTotalsSnapshot,
  getIssue,
  getRepository,
  getRepoQueueTrendSnapshot,
  listCheckSummaries,
  listContributorRepoStats,
  listContributorIssues,
  listContributorPullRequests,
  listIssueSignalSample,
  listIssues,
  listOpenPullRequests,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepoSyncSegments,
  listRepoSyncStates,
  listRepositories,
  recordProductUsageEvent,
} from "../db/repositories";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile } from "../github/public";
import { listLatestRegistrySnapshots } from "../registry/sync";
import { getOrCreateScoringModelSnapshot } from "../scoring/model";
import { buildScorePreview, makeScorePreviewRecord } from "../scoring/preview";
import {
  explainBlockersWithAgent,
  getAgentRunBundle,
  planNextWork,
  preparePrPacketWithAgent,
  startAgentRun,
} from "../services/agent-orchestrator";
import { loadContributorDecisionPackForServing, repoDecisionFromPack } from "../services/decision-pack";
import { buildPublicPrBodyDraft } from "../services/pr-body-draft";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadOrComputeBurdenForecastResponse } from "../services/burden-forecast";
import { buildFederatedQueueIndex, FEDERATED_QUEUE_INDEX_MAX_LIMIT } from "../services/queue-federation";
import { buildMcpClientTelemetry } from "../services/client-telemetry";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
import { buildUnavailableQueueTrendReport } from "../services/queue-trends";
import {
  applyMcpPlanningChoices,
  buildMcpPlanningElicitationAudit,
  buildMcpPlanningElicitationRequest,
  planningChoicesFromElicitationResult,
  validateMcpPlanningElicitationRequest,
  type McpPlanningChoices,
} from "../services/mcp-planning-elicitation";
import {
  buildBountyAdvisory,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildLaneAdvice,
  buildLocalDiffPreflightResult,
  buildPreflightResult,
  buildQueueHealth,
  buildRegistryChangeReport,
  buildRoleContext,
} from "../signals/engine";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildRepoDataQuality } from "../signals/data-quality";
import { PREFLIGHT_LIMITS } from "../signals/preflight-limits";
import { loadUpstreamStatus } from "../upstream/ruleset";

type AppContext = Context<{ Bindings: Env }>;
type ToolPayload = {
  summary: string;
  data: Record<string, unknown>;
};
type McpToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function decisionPackSummary(login: string, freshness: string, rebuildEnqueued: boolean): string {
  if (freshness === "fresh") return `Gittensory decision pack for ${login}.`;
  if (rebuildEnqueued) return `Gittensory decision pack for ${login} (stale; background rebuild enqueued).`;
  return `Gittensory decision pack for ${login} (stale; rebuild not enqueued).`;
}

const ownerRepoShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const loginShape = {
  login: z.string().min(1),
};

const loginRepoShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const bountyShape = {
  id: z.string().min(1),
};

const preflightShape = {
  repoFullName: z.string().min(3).max(PREFLIGHT_LIMITS.repoFullNameChars),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(PREFLIGHT_LIMITS.linkedIssues).optional(),
  tests: z.array(z.string().max(PREFLIGHT_LIMITS.testChars)).max(PREFLIGHT_LIMITS.tests).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
};

const localDiffPreflightShape = {
  ...preflightShape,
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  commitMessage: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
};

const branchEligibilityShape = {
  status: z.enum(["eligible", "ineligible", "unknown"]),
  source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  stale: z.boolean().optional(),
};

const localBranchAnalysisShape = {
  login: z.string().min(1),
  repoFullName: z.string().min(3),
  baseRef: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  mergeBaseSha: z.string().min(1).optional(),
  remoteTrackingSha: z.string().min(1).optional(),
  commitMessages: z.array(z.string()).max(30).optional(),
  changedFiles: z
    .array(
      z
        .object({
          path: z.string().min(1),
          previousPath: z.string().min(1).optional(),
          additions: z.number().int().min(0).optional(),
          deletions: z.number().int().min(0).optional(),
          status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
          binary: z.boolean().optional(),
        })
        .strict(),
    )
    .max(500)
    .optional(),
  validation: z
    .array(
      z
        .object({
          command: z.string().min(1),
          status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
          summary: z.string().optional(),
          durationMs: z.number().int().min(0).optional(),
          exitCode: z.number().int().min(0).optional(),
        })
        .strict(),
    )
    .max(50)
    .optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  labels: z.array(z.string()).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  focusManifest: z.record(z.string(), z.unknown()).optional(),
  branchEligibility: z.object(branchEligibilityShape).strict().optional(),
  localScorer: z
    .object({
      mode: z.enum(["metadata_only", "external_command", "gittensor_root"]),
      activeModel: z.string().optional(),
      sourceTokenScore: z.number().min(0).optional(),
      totalTokenScore: z.number().min(0).optional(),
      sourceLines: z.number().min(0).optional(),
      testTokenScore: z.number().min(0).optional(),
      nonCodeTokenScore: z.number().min(0).optional(),
      warnings: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
};

const localBranchVariantsShape = {
  variants: z.array(z.object(localBranchAnalysisShape).strict()).min(1).max(10),
};

const agentRunShape = {
  objective: z.string().min(1).max(500),
  actorLogin: z.string().min(1),
  targetRepoFullName: z.string().min(3).optional(),
  targetPullNumber: z.number().int().positive().optional(),
  targetIssueNumber: z.number().int().positive().optional(),
};

const agentRunIdShape = {
  runId: z.string().min(1),
};

const agentPlanShape = {
  login: z.string().min(1),
  objective: z.string().min(1).max(500).optional(),
  repoFullName: z.string().min(3).optional(),
};

const linkedIssueContextShape = {
  status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]).optional(),
  source: z.enum(["user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]).optional(),
  issueNumbers: z.array(z.number().int().positive()).max(50).optional(),
  solvedByPullRequests: z.array(z.number().int().positive()).max(50).optional(),
  reason: z.string().optional(),
  warnings: z.array(z.string()).max(20).optional(),
};

const scorePreviewShape = {
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("local_diff"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  linkedIssueContext: z.object(linkedIssueContextShape).strict().optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  duplicateRiskCount: z.number().int().min(0).optional(),
  metadataOnly: z.boolean().default(true),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: z.object(branchEligibilityShape).strict().optional(),
};

const variantsShape = {
  variants: z.array(z.object(scorePreviewShape)).min(1).max(10),
};

// ── MCP tool output schemas ────────────────────────────────────────────────
// Structured-output metadata for machine-readable tools so modern MCP clients
// can discover and validate Gittensory responses. Schemas declare documented
// top-level fields; complex/nullable/variant fields use a permissive type so
// validation never rejects a real response (the SDK strips unknown keys). All
// fields are optional because several tools return either a result payload or a
// `{ status: "not_found" | ... }` / refresh envelope.
const repoContextOutputSchema = {
  repoFullName: z.string().optional(),
  repo: z.unknown().optional(),
  lane: z.unknown().optional(),
  queueHealth: z.unknown().optional(),
  queueTrends: z.unknown().optional(),
  collisions: z.unknown().optional(),
  configQuality: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};

const freshnessResponseOutputSchema = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  report: z.unknown().optional(),
};

const contributorProfileOutputSchema = {
  login: z.string().optional(),
  github: z.unknown().optional(),
  source: z.unknown().optional(),
  repoStats: z.unknown().optional(),
  trustSignals: z.unknown().optional(),
};

const decisionPackOutputSchema = {
  status: z.string().optional(),
  login: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  rebuildEnqueued: z.boolean().optional(),
  summary: z.string().optional(),
  repoDecisions: z.unknown().optional(),
  topActions: z.unknown().optional(),
};

const openPrMonitorOutputSchema = {
  login: z.string().optional(),
  generatedAt: z.string().optional(),
  openPrCount: z.number().optional(),
  registeredRepoCount: z.number().optional(),
  cleanupFirst: z.boolean().optional(),
  summary: z.string().optional(),
  guidance: z.unknown().optional(),
  pendingScenarios: z.unknown().optional(),
  pullRequests: z.unknown().optional(),
};

const explainRepoDecisionOutputSchema = {
  status: z.string().optional(),
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  rebuildEnqueued: z.boolean().optional(),
  decision: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};

const registryChangesOutputSchema = {
  generatedAt: z.string().optional(),
  currentSnapshotId: z.string().optional(),
  previousSnapshotId: z.string().optional(),
  addedRepos: z.unknown().optional(),
  removedRepos: z.unknown().optional(),
  changedRepos: z.unknown().optional(),
  summary: z.string().optional(),
};

const upstreamDriftOutputSchema = {
  generatedAt: z.string().optional(),
  status: z.string().optional(),
  latestCommitSha: z.string().nullable().optional(),
  latestRulesetId: z.string().nullable().optional(),
  highestSeverity: z.string().nullable().optional(),
  affectedAreas: z.unknown().optional(),
  openReportCount: z.number().optional(),
  reports: z.unknown().optional(),
};

const localStatusOutputSchema = {
  apiAvailable: z.boolean().optional(),
  sourceUploadDefault: z.boolean().optional(),
  supportedEndpoint: z.string().optional(),
  supportedTools: z.unknown().optional(),
};

export async function handleMcpRequest(c: AppContext): Promise<Response> {
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
  const identity = await authenticateMcpRequest(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);

  const telemetry = buildMcpClientTelemetry(c.req.raw.headers, { defaultClientName: "mcp" })!;
  const usageMetadata = await describeMcpUsageRequest(c.req.raw, telemetry.metadata);
  const startedAt = Date.now();
  const server = new GittensoryMcp(c.env, identity).createServer();
  try {
    const response = await createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(c.req.raw, c.env, getExecutionContext(c));
    await recordProductUsageEvent(c.env, {
      surface: "mcp",
      role: "miner",
      eventName: typeof usageMetadata.toolName === "string" ? "mcp_tool_called" : "mcp_request",
      route: "/mcp",
      actor: identity.actor,
      sessionId: identity.kind === "session" ? identity.session.id : undefined,
      outcome: response.status >= 400 ? "error" : "success",
      latencyMs: Date.now() - startedAt,
      clientName: telemetry.clientName,
      clientVersion: telemetry.clientVersion,
      metadata: usageMetadata,
    }).catch(() => undefined);
    return response;
  } catch (error) {
    await recordProductUsageEvent(c.env, {
      surface: "mcp",
      role: "miner",
      eventName: typeof usageMetadata.toolName === "string" ? "mcp_tool_called" : "mcp_request",
      route: "/mcp",
      actor: identity.actor,
      sessionId: identity.kind === "session" ? identity.session.id : undefined,
      outcome: "error",
      latencyMs: Date.now() - startedAt,
      clientName: telemetry.clientName,
      clientVersion: telemetry.clientVersion,
      metadata: usageMetadata,
    }).catch(() => undefined);
    throw error;
  }
}

async function describeMcpUsageRequest(request: Request, telemetryMetadata: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const body = await request.clone().json().catch(() => null);
  if (!body || typeof body !== "object") return { transport: "http", method: request.method, ...telemetryMetadata };
  const envelope = body as { method?: unknown; params?: { name?: unknown } };
  const rpcMethod = typeof envelope.method === "string" ? envelope.method : undefined;
  const toolName = envelope.params && typeof envelope.params.name === "string" ? envelope.params.name : undefined;
  return {
    transport: "http",
    rpcMethod,
    toolName,
    ...telemetryMetadata,
  };
}

export class GittensoryMcp {
  private accessScopePromise: Promise<ControlPanelAccessScope> | null = null;

  constructor(
    private readonly env: Env,
    private readonly identity: AuthIdentity = { kind: "static", actor: "mcp" },
  ) {}

  createServer(): McpServer {
    const server = new McpServer({
      name: "gittensory",
      version: "0.1.0",
    });

    server.registerTool(
      "gittensory_get_repo_context",
      {
        description: "Return Gittensory repo context: registration, lane, queue health, collisions, and config quality.",
        inputSchema: ownerRepoShape,
        outputSchema: repoContextOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoContext(input)),
    );

    server.registerTool(
      "gittensory_get_burden_forecast",
      {
        description: "Return the cached or freshly-computed maintainer burden forecast for a repo, including projected review load, queue growth risk, stale PR signals, and a freshness marker.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getBurdenForecast(input)),
    );

    server.registerTool(
      "gittensory_queue_health_federation",
      {
        description: "Return a ranked cross-repo queue pressure index showing the worst-burden registered repos. Operator-only.",
        inputSchema: { limit: z.number().int().min(1).max(FEDERATED_QUEUE_INDEX_MAX_LIMIT).optional() },
      },
      async (input) => this.toolResult(await this.getQueueHealthFederation(input.limit)),
    );

    server.registerTool(
      "gittensory_get_repo_outcome_patterns",
      {
        description: "Return cached or freshly-computed per-repo accepted/rejected PR outcome patterns: what maintainers actually merge or close, separated from maintainer-lane activity, with a freshness marker and explicit evidence-completeness.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoOutcomePatterns(input)),
    );

    server.registerTool(
      "gittensory_get_contributor_profile",
      {
        description: "Return an evidence-backed Gittensory contributor profile for a GitHub login.",
        inputSchema: loginShape,
        outputSchema: contributorProfileOutputSchema,
      },
      async (input) => this.toolResult(await this.getContributorProfile(input.login)),
    );

    server.registerTool(
      "gittensory_get_decision_pack",
      {
        description: "Return the canonical private contributor decision pack for a GitHub login.",
        inputSchema: loginShape,
        outputSchema: decisionPackOutputSchema,
      },
      async (input) => this.toolResult(await this.getDecisionPack(input.login)),
    );

    server.registerTool(
      "gittensory_monitor_open_prs",
      {
        description:
          "Inspect a contributor's open PRs on registered repos, classify queue state, and return public-safe next-step packets from cached metadata.",
        inputSchema: loginShape,
        outputSchema: openPrMonitorOutputSchema,
      },
      async (input) => this.toolResult(await this.monitorOpenPullRequests(input.login)),
    );

    server.registerTool(
      "gittensory_explain_repo_decision",
      {
        description: "Return the contributor/repo decision from the canonical decision pack.",
        inputSchema: loginRepoShape,
        outputSchema: explainRepoDecisionOutputSchema,
      },
      async (input) => this.toolResult(await this.explainRepoDecision(input)),
    );

    server.registerTool(
      "gittensory_preflight_pr",
      {
        description: "Preflight a planned PR for lane correctness, duplicate risk, linked issues, and review burden.",
        inputSchema: preflightShape,
      },
      async (input) => this.toolResult(await this.preflightPr(input)),
    );

    server.registerTool(
      "gittensory_get_bounty_advisory",
      {
        description: "Return lifecycle, funding, and consensus-risk context for a cached Gittensor bounty.",
        inputSchema: bountyShape,
      },
      async (input) => this.toolResult(await this.getBountyAdvisory(input.id)),
    );

    server.registerTool(
      "gittensory_get_registry_changes",
      {
        description: "Return the diff between the latest cached Gittensor registry snapshots.",
        inputSchema: {},
        outputSchema: registryChangesOutputSchema,
      },
      async () => this.toolResult(await this.getRegistryChanges()),
    );

    server.registerTool(
      "gittensory_get_upstream_drift",
      {
        description: "Return private upstream Gittensor ruleset drift status, including stale/drift warnings for MCP planning.",
        inputSchema: {},
        outputSchema: upstreamDriftOutputSchema,
      },
      async () => this.toolResult(await this.getUpstreamDrift()),
    );

    server.registerTool(
      "gittensory_get_issue_quality",
      {
        description: "Return the cached or freshly-computed issue-quality report for a repo, ranking which open issues are actionable, need proof, are stale/duplicate-prone, or already solved.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getIssueQuality(input)),
    );

    server.registerTool(
      "gittensory_preflight_local_diff",
      {
        description: "Preflight local git-diff metadata without uploading code content.",
        inputSchema: localDiffPreflightShape,
      },
      async (input) => this.toolResult(await this.preflightLocalDiff(input)),
    );

    server.registerTool(
      "gittensory_preview_local_pr_score",
      {
        description: "Return a private scoring preview from local diff metrics or supplied metadata. Source contents are not required.",
        inputSchema: scorePreviewShape,
      },
      async (input) => this.toolResult(await this.previewScore(input)),
    );

    server.registerTool(
      "gittensory_explain_review_risk",
      {
        description: "Explain review risk for a planned PR using preflight, lane, duplicate, and role context.",
        inputSchema: preflightShape,
      },
      async (input) => this.toolResult(await this.explainReviewRisk(input)),
    );

    server.registerTool(
      "gittensory_compare_pr_variants",
      {
        description: "Compare private scoring previews for multiple PR variants.",
        inputSchema: variantsShape,
      },
      async (input) => this.toolResult(await this.comparePrVariants(input.variants)),
    );

    server.registerTool(
      "gittensory_local_status",
      {
        description: "Return Gittensory local-MCP contract status and privacy defaults.",
        inputSchema: {},
        outputSchema: localStatusOutputSchema,
      },
      async () =>
        this.toolResult({
          summary: "Gittensory local MCP status.",
          data: {
            apiAvailable: true,
            sourceUploadDefault: false,
            supportedEndpoint: "/v1/local/branch-analysis",
            supportedTools: [
              "gittensory_get_decision_pack",
              "gittensory_explain_repo_decision",
              "gittensory_get_upstream_drift",
              "gittensory_preflight_current_branch",
              "gittensory_preview_current_branch_score",
              "gittensory_rank_local_next_actions",
              "gittensory_compare_local_variants",
              "gittensory_explain_local_blockers",
              "gittensory_prepare_pr_packet",
            ],
          },
        }),
    );

    server.registerTool(
      "gittensory_preflight_current_branch",
      {
        description: "Analyze current-branch metadata supplied by a local MCP wrapper and return PR readiness.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "preflight")),
    );

    server.registerTool(
      "gittensory_preview_current_branch_score",
      {
        description: "Analyze current-branch metadata and return private scoreability context.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scorePreview")),
    );

    server.registerTool(
      "gittensory_rank_local_next_actions",
      {
        description: "Analyze current-branch metadata and rank local next actions by private reward/risk signals.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "nextActions")),
    );

    server.registerTool(
      "gittensory_explain_local_blockers",
      {
        description: "Analyze current-branch metadata and explain private scoreability and review blockers.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scoreBlockers")),
    );

    server.registerTool(
      "gittensory_prepare_pr_packet",
      {
        description: "Analyze current-branch metadata and return a public-safe PR packet for coding agents.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "prPacket")),
    );

    server.registerTool(
      "gittensory_draft_pr_body",
      {
        description: "Draft a public-safe, copy/paste PR body from local branch metadata (changed files, tests run, linked issue, duplicate/WIP caution, branch freshness, next steps). Private scoreability/reward/trust context is excluded; source contents are not uploaded.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.draftPrBody(input)),
    );

    server.registerTool(
      "gittensory_compare_local_variants",
      {
        description: "Compare private local-branch analysis variants without source uploads.",
        inputSchema: localBranchVariantsShape,
      },
      async (input) => this.toolResult(await this.compareLocalVariants(input.variants)),
    );

    server.registerTool(
      "gittensory_agent_plan_next_work",
      {
        description: "Run the deterministic Gittensory base-agent planner and rank the next Gittensor OSS contribution actions.",
        inputSchema: agentPlanShape,
      },
      async (input, extra) => this.toolResult(await this.agentPlanNextWork(input, extra, server)),
    );

    server.registerTool(
      "gittensory_agent_start_run",
      {
        description: "Create a queued copilot-only Gittensory agent run. The agent plans and explains; it does not edit code or open PRs.",
        inputSchema: agentRunShape,
      },
      async (input) => this.toolResult(await this.agentStartRun(input)),
    );

    server.registerTool(
      "gittensory_agent_get_run",
      {
        description: "Fetch a persisted Gittensory agent run with ranked actions and context snapshots.",
        inputSchema: agentRunIdShape,
      },
      async (input) => this.toolResult(await this.agentGetRun(input.runId)),
    );

    server.registerTool(
      "gittensory_agent_explain_next_action",
      {
        description: "Explain the top deterministic next action and its scoreability/risk/maintainer impact.",
        inputSchema: agentPlanShape,
      },
      async (input) => this.toolResult(await this.agentExplainNextAction(input)),
    );

    server.registerTool(
      "gittensory_agent_prepare_pr_packet",
      {
        description: "Prepare a public-safe PR packet from local branch metadata. Source contents are not uploaded.",
        inputSchema: localBranchAnalysisShape,
      },
      async (input) => this.toolResult(await this.agentPreparePrPacket(input)),
    );

    // ── Miner planning prompts ───────────────────────────────────────────
    server.registerPrompt(
      "gittensory_select_contribution_issue",
      {
        title: "Select contribution issue",
        description: "Identify the best open issue for a contributor to work on based on lane fit, issue quality, and queue signals. Advisory only — no GitHub writes.",
        argsSchema: { ...ownerRepoShape, login: z.string().min(1) },
      },
      ({ owner, repo, login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use gittensory_get_issue_quality and gittensory_explain_repo_decision for ${login} on ${owner}/${repo} to identify which open issues are the best fit. Rank candidates by actionability, lane alignment, and queue pressure. Present a short ranked list with a brief rationale for each. Do not create issues, file comments, or take any GitHub action — this is a planning aid for the contributor to decide from.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "gittensory_draft_contribution_pr_packet",
      {
        title: "Draft contribution PR packet",
        description: "Draft a public-safe PR submission packet for a planned contribution without uploading source code. Advisory only — no GitHub writes.",
        argsSchema: { ...ownerRepoShape, login: z.string().min(1) },
      },
      ({ owner, repo, login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use gittensory_get_repo_context and gittensory_get_decision_pack for ${login} to prepare a public-safe PR packet for work on ${owner}/${repo}. The packet should include lane fit, recommended next steps, and any preflight considerations the contributor should address before opening the PR. Do not open a PR, post any comment, or take any GitHub action — present the packet for the contributor to review and submit manually.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "gittensory_preflight_contribution_branch",
      {
        title: "Preflight contribution branch",
        description: "Assess branch readiness before opening a PR using cached lane and preflight signals. Advisory only — no GitHub writes.",
        argsSchema: { ...ownerRepoShape, login: z.string().min(1) },
      },
      ({ owner, repo, login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use gittensory_get_repo_context and gittensory_explain_repo_decision for ${login} on ${owner}/${repo} to assess whether the planned branch is ready to be submitted as a PR. Check lane fit, duplicate risk, linked issue coverage, and any signals that suggest the branch needs more work. Present a preflight summary the contributor can act on before opening the PR. Do not open a PR, push any branch, or take any GitHub action.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "gittensory_plan_cleanup_first",
      {
        title: "Plan cleanup-first work",
        description: "Identify open PRs to address before starting new work to reduce queue pressure and improve lane fit. Advisory only — no GitHub writes.",
        argsSchema: { login: z.string().min(1) },
      },
      ({ login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use gittensory_monitor_open_prs and gittensory_get_decision_pack for ${login} to identify which open PRs to address before starting new contribution work. Surface PRs with failing checks, pending review comments, stale queue pressure, or duplicate risk. Recommend an ordered cleanup list with a brief rationale for each item. Do not close PRs, post comments, or take any GitHub action — present the plan for the contributor to execute manually.`,
            },
          },
        ],
      }),
    );

    return server;
  }

  private requireContributorAccess(login: string): void {
    if (this.identity.kind === "session" && this.identity.actor.toLowerCase() !== login.toLowerCase()) {
      throw new Error("Forbidden: session can only access the authenticated GitHub login.");
    }
  }

  private async requireRepoAccess(repoFullName: string): Promise<void> {
    if (await this.canAccessRepo(repoFullName)) return;
    throw new Error("Forbidden: session cannot access this repository.");
  }

  private loadSessionAccessScope(): Promise<ControlPanelAccessScope> {
    if (this.identity.kind !== "session") throw new Error("Session access scope is only available for session identities.");
    this.accessScopePromise ??= loadControlPanelAccessScope(this.env, this.identity.actor);
    return this.accessScopePromise;
  }

  private async getRepoContext(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const [repo, issues, pullRequests, recentMergedPullRequests, queueCounts, queueTrends] = await Promise.all([
      getRepository(this.env, fullName),
      listIssueSignalSample(this.env, fullName),
      listOpenPullRequests(this.env, fullName),
      listRecentMergedPullRequests(this.env, fullName),
      this.loadOpenQueueCounts(fullName),
      getRepoQueueTrendSnapshot(this.env, fullName),
    ]);
    const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
    return {
      summary: `Gittensory repo context for ${fullName}.`,
      data: {
        repoFullName: fullName,
        repo,
        lane: buildLaneAdvice(repo, fullName),
        queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts),
        queueTrends: queueTrends?.payload ?? buildUnavailableQueueTrendReport(fullName),
        collisions,
        configQuality: buildConfigQuality(repo, issues, pullRequests, fullName),
        dataQuality: await this.loadRepoDataQuality(fullName),
      },
    };
  }

  private async getBurdenForecast(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const response = await loadOrComputeBurdenForecastResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `Gittensory has no cached burden forecast for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `Gittensory burden forecast for ${fullName} (cached, ${response.freshness}).`
          : `Gittensory burden forecast for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async getQueueHealthFederation(limit?: number): Promise<ToolPayload> {
    if (this.identity.kind === "session") {
      const summary = await loadControlPanelRoleSummary(this.env, this.identity.actor);
      if (!summary.roles.includes("operator")) {
        throw new Error("Forbidden: gittensory_queue_health_federation requires operator role.");
      }
    } else if (this.identity.actor !== "mcp") {
      throw new Error("Forbidden: gittensory_queue_health_federation requires operator role.");
    }
    const index = await buildFederatedQueueIndex(this.env, limit);
    const criticalCount = index.entries.filter((entry) => entry.level === "critical" || entry.level === "high").length;
    return {
      summary: `Cross-repo queue pressure index: ${index.repoCount} repo(s) ranked, ${criticalCount} at critical/high burden.`,
      data: index as unknown as Record<string, unknown>,
    };
  }

  private async getIssueQuality(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access issue quality for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const response = await loadOrComputeIssueQualityResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `Gittensory has no cached issue quality for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `Gittensory issue quality for ${fullName} (cached).`
          : `Gittensory issue quality for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async canAccessRepo(fullName: string): Promise<boolean> {
    if (this.identity.kind !== "session") return true;
    const [scope, repo] = await Promise.all([this.loadSessionAccessScope(), getRepository(this.env, fullName)]);
    if (scope.operator) return true;
    const requestedRepo = fullName.toLowerCase();
    if (scope.repositoryFullNames.some((name) => name.toLowerCase() === requestedRepo)) return true;
    return Boolean(repo && scope.accountLogins.some((login) => login.toLowerCase() === repo.owner.toLowerCase()));
  }

  private async getRepoOutcomePatterns(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const response = await loadOrComputeRepoOutcomePatternsResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `Gittensory has no cached repo outcome patterns for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `Gittensory repo outcome patterns for ${fullName} (cached, ${response.freshness}).`
          : `Gittensory repo outcome patterns for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async loadOpenQueueCounts(fullName: string): Promise<{ openIssues: number; openPullRequests: number }> {
    const [totals, openIssues, openPullRequests] = await Promise.all([
      getLatestRepoGithubTotalsSnapshot(this.env, fullName),
      countOpenIssues(this.env, fullName),
      countOpenPullRequests(this.env, fullName),
    ]);
    return {
      openIssues: totals?.openIssuesTotal ?? openIssues,
      openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
    };
  }

  private async getContributorProfile(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const [github, pullRequests, issues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(login),
      listContributorPullRequests(this.env, login),
      listContributorIssues(this.env, login),
      listContributorRepoStats(this.env, login),
      fetchGittensorContributorSnapshot(login),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    return {
      summary: `Gittensory contributor profile for ${login}.`,
      data: buildContributorProfile(login, github, pullRequests, issues, repoStats, gittensorSnapshot) as unknown as Record<string, unknown>,
    };
  }

  private async getDecisionPack(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const serving = await loadContributorDecisionPackForServing(this.env, login);
    if (serving.kind === "ready") {
      return {
        summary: decisionPackSummary(login, serving.pack.freshness, serving.pack.rebuildEnqueued),
        data: serving.pack as unknown as Record<string, unknown>,
      };
    }
    return {
      summary: `Gittensory decision pack for ${login} needs a snapshot refresh.`,
      data: serving.refresh as unknown as Record<string, unknown>,
    };
  }

  private async monitorOpenPullRequests(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const monitor = await buildContributorOpenPrMonitor(this.env, login);
    return {
      summary: monitor.summary,
      data: monitor as unknown as Record<string, unknown>,
    };
  }

  private async explainRepoDecision(input: { login: string; owner: string; repo: string }): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const serving = await loadContributorDecisionPackForServing(this.env, input.login);
    if (serving.kind === "needs_refresh") {
      return {
        summary: `Gittensory repo decision for ${input.login} in ${fullName} needs a snapshot refresh.`,
        data: { ...serving.refresh, repoFullName: fullName } as unknown as Record<string, unknown>,
      };
    }
    const pack = serving.pack;
    const decision = repoDecisionFromPack(pack, fullName);
    return {
      summary: `Gittensory repo decision for ${input.login} in ${fullName}.`,
      data: {
        status: decision ? "ready" : "not_found",
        login: input.login,
        repoFullName: fullName,
        generatedAt: pack.generatedAt,
        source: pack.source,
        freshness: pack.freshness,
        rebuildEnqueued: pack.rebuildEnqueued,
        decision,
        dataQuality: pack.dataQuality,
      },
    };
  }

  private async getRegistryChanges(): Promise<ToolPayload> {
    const report = buildRegistryChangeReport(await listLatestRegistrySnapshots(this.env, 2));
    return {
      summary: "Gittensory registry changes from latest cached snapshots.",
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getUpstreamDrift(): Promise<ToolPayload> {
    const status = await loadUpstreamStatus(this.env);
    const detail =
      status.status === "current"
        ? "upstream ruleset is current"
        : status.status === "drift_detected"
          ? `upstream drift detected (${status.highestSeverity ?? "unknown"})`
          : status.status === "stale"
            ? "upstream ruleset snapshot is stale"
            : "upstream ruleset snapshot is unavailable";
    return {
      summary: `Gittensory upstream drift status: ${detail}.`,
      data: status as unknown as Record<string, unknown>,
    };
  }

  private async preflightPr(input: z.infer<z.ZodObject<typeof preflightShape>>): Promise<ToolPayload> {
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
      loadOrComputeIssueQualityResponse(this.env, input.repoFullName),
    ]);
    return {
      summary: `Gittensory PR preflight for ${input.repoFullName}.`,
      data: buildPreflightResult(input, repo, issues, pullRequests, bounties, issueQuality?.report) as unknown as Record<string, unknown>,
    };
  }

  private async preflightLocalDiff(input: z.infer<z.ZodObject<typeof localDiffPreflightShape>>): Promise<ToolPayload> {
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
      loadOrComputeIssueQualityResponse(this.env, input.repoFullName),
    ]);
    return {
      summary: `Gittensory local diff preflight for ${input.repoFullName}.`,
      data: buildLocalDiffPreflightResult(input, repo, issues, pullRequests, bounties, issueQuality?.report) as unknown as Record<string, unknown>,
    };
  }

  private async previewScore(input: z.infer<z.ZodObject<typeof scorePreviewShape>>): Promise<ToolPayload> {
    if (input.contributorLogin) this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, snapshot, evidence] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
      input.contributorLogin ? getContributorEvidence(this.env, input.contributorLogin) : Promise.resolve(null),
    ]);
    const result = buildScorePreview({ input, repo, snapshot, contributorEvidence: evidence });
    return {
      summary: `Private Gittensory scoring preview for ${input.repoFullName}.`,
      data: makeScorePreviewRecord(input, snapshot, result) as unknown as Record<string, unknown>,
    };
  }

  private async explainReviewRisk(input: z.infer<z.ZodObject<typeof preflightShape>>): Promise<ToolPayload> {
    if (input.contributorLogin) this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
    ]);
    const preflight = buildPreflightResult(input, repo, issues, pullRequests, bounties);
    const roleContext = input.contributorLogin
      ? buildRoleContext({ login: input.contributorLogin, repo, repoFullName: input.repoFullName, pullRequests, issues })
      : null;
    return {
      summary: `Gittensory review-risk explanation for ${input.repoFullName}.`,
      data: {
        preflight,
        roleContext,
        recommendation: preflight.collisions.some((cluster) => cluster.risk === "high")
          ? "likely_duplicate"
          : roleContext?.maintainerLane
            ? "maintainer_lane"
            : preflight.status === "needs_work"
              ? "needs_author"
              : preflight.status === "ready"
                ? "review"
                : "watch",
      },
    };
  }

  private async comparePrVariants(variants: Array<z.infer<z.ZodObject<typeof scorePreviewShape>>>): Promise<ToolPayload> {
    const previews = [];
    for (const variant of variants) previews.push((await this.previewScore({ ...variant, targetType: "variant" })).data);
    previews.sort((left, right) => {
      const leftScore = Number((left as { result: { scoreEstimate: { estimatedMergedScore: number } } }).result.scoreEstimate.estimatedMergedScore);
      const rightScore = Number((right as { result: { scoreEstimate: { estimatedMergedScore: number } } }).result.scoreEstimate.estimatedMergedScore);
      return rightScore - leftScore;
    });
    return {
      summary: "Private Gittensory PR variant comparison.",
      data: { variants: previews },
    };
  }

  private async localBranchSlice(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>, slice: "preflight" | "scorePreview" | "nextActions" | "scoreBlockers" | "prPacket"): Promise<ToolPayload> {
    const analysis = await this.analyzeLocalBranch(input);
    return {
      summary: `${analysis.summary} (${slice}).`,
      data: {
        login: analysis.login,
        repoFullName: analysis.repoFullName,
        generatedAt: analysis.generatedAt,
        [slice]: analysis[slice],
        scenarioScorePreview: slice === "scorePreview" || slice === "scoreBlockers" ? analysis.scenarioScorePreview : undefined,
        branchQualityBlockers: slice === "scoreBlockers" ? analysis.branchQualityBlockers : undefined,
        accountStateBlockers: slice === "scoreBlockers" ? analysis.accountStateBlockers : undefined,
        recommendedRerunCondition: slice === "scoreBlockers" || slice === "nextActions" ? analysis.recommendedRerunCondition : undefined,
        dataQuality: analysis.dataQuality,
      } as Record<string, unknown>,
    };
  }

  private async compareLocalVariants(variants: Array<z.infer<z.ZodObject<typeof localBranchAnalysisShape>>>): Promise<ToolPayload> {
    const analyses = [];
    for (const variant of variants) analyses.push(await this.analyzeLocalBranch(variant));
    analyses.sort(
      (left, right) =>
        (right.nextActions[0]?.priorityScore ?? 0) - (left.nextActions[0]?.priorityScore ?? 0) ||
        right.scorePreview.effectiveEstimatedScore - left.scorePreview.effectiveEstimatedScore ||
        left.repoFullName.localeCompare(right.repoFullName),
    );
    return {
      summary: "Gittensory local branch variant comparison.",
      data: {
        variants: analyses.map((analysis) => ({
          repoFullName: analysis.repoFullName,
          branchName: analysis.branchName,
          preflightStatus: analysis.preflight.status,
          scoreBlockers: analysis.scoreBlockers,
          scorePreview: analysis.scorePreview,
          topAction: analysis.nextActions[0] ?? null,
          prPacket: analysis.prPacket,
          dataQuality: analysis.dataQuality,
        })),
      },
    };
  }

  private async agentPlanNextWork(
    input: z.infer<z.ZodObject<typeof agentPlanShape>>,
    extra?: McpToolExtra,
    mcpServer?: McpServer,
  ): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const elicitation = await this.collectPlanningChoices(input, extra, mcpServer);
    const planInput = applyMcpPlanningChoices(input, elicitation.choices);
    const bundle = await planNextWork(this.env, { ...planInput, surface: "mcp" });
    return {
      summary: `Gittensory base-agent plan for ${input.login}.`,
      data: {
        ...bundle,
        planningElicitation: buildMcpPlanningElicitationAudit(elicitation, elicitation.choices),
        planningChoices: elicitation.choices,
      } as unknown as Record<string, unknown>,
    };
  }

  private async collectPlanningChoices(
    input: z.infer<z.ZodObject<typeof agentPlanShape>>,
    extra?: McpToolExtra,
    mcpServer?: McpServer,
  ): Promise<{ supported: boolean; requested: boolean; accepted: boolean; choices: McpPlanningChoices }> {
    const elicitationCapabilities = mcpServer?.server.getClientCapabilities()?.elicitation;
    const supportsFormElicitation = Boolean(
      extra && elicitationCapabilities && (elicitationCapabilities.form || Object.keys(elicitationCapabilities).length === 0),
    );
    if (!extra || !supportsFormElicitation) return { supported: false, requested: false, accepted: false, choices: {} };
    if (input.objective && input.repoFullName) return { supported: true, requested: false, accepted: false, choices: {} };
    const request = buildMcpPlanningElicitationRequest();
    validateMcpPlanningElicitationRequest(request);
    try {
      const result = await extra.sendRequest({ method: "elicitation/create", params: request }, ElicitResultSchema, { timeout: 1000 });
      const choices = planningChoicesFromElicitationResult(result);
      return { supported: true, requested: true, accepted: result.action === "accept", choices };
    } catch /* v8 ignore next -- sendRequest throw requires live MCP transport, not testable in-process */ {
      return { supported: true, requested: true, accepted: false, choices: {} };
    }
  }

  private async agentStartRun(input: z.infer<z.ZodObject<typeof agentRunShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.actorLogin);
    const bundle = await startAgentRun(this.env, {
      objective: input.objective,
      actorLogin: input.actorLogin,
      surface: "mcp",
      target: {
        repoFullName: input.targetRepoFullName,
        pullNumber: input.targetPullNumber,
        issueNumber: input.targetIssueNumber,
      },
    });
    return {
      summary: `Queued Gittensory base-agent run for ${input.actorLogin}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async agentGetRun(runId: string): Promise<ToolPayload> {
    const bundle = await getAgentRunBundle(this.env, runId);
    if (!bundle) throw new Error("Agent run not found.");
    this.requireContributorAccess(bundle.run.actorLogin);
    return {
      summary: `Gittensory base-agent run ${runId}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async agentExplainNextAction(input: z.infer<z.ZodObject<typeof agentPlanShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await explainBlockersWithAgent(this.env, { ...input, surface: "mcp" });
    return {
      summary: `Gittensory base-agent next-action explanation for ${input.login}.`,
      data: {
        ...bundle,
        topAction: bundle.actions[0] ?? null,
      } as unknown as Record<string, unknown>,
    };
  }

  private async agentPreparePrPacket(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await preparePrPacketWithAgent(this.env, input, "mcp");
    return {
      summary: `Gittensory base-agent public-safe PR packet for ${input.repoFullName}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async draftPrBody(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>): Promise<ToolPayload> {
    const analysis = await this.analyzeLocalBranch(input);
    const draft = buildPublicPrBodyDraft(analysis);
    // Human-readable summary carries the rendered markdown body; structured draft is returned as JSON.
    return {
      summary: `Public-safe PR body draft for ${analysis.repoFullName} (metadata only; private scoreability excluded).\n\n${draft.markdown}`,
      data: draft as unknown as Record<string, unknown>,
    };
  }

  private async analyzeLocalBranch(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>) {
    this.requireContributorAccess(input.login);
    await this.requireRepoAccess(input.repoFullName);
    const [context, repo, issues, pullRequests, recentMergedPullRequests, bounties, snapshot, issueQuality, repoManifest] = await Promise.all([
      this.loadContributorFastContext(input.login),
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listRecentMergedPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
      loadOrComputeIssueQualityResponse(this.env, input.repoFullName),
      loadRepoFocusManifest(this.env, input.repoFullName),
    ]);
    const fit = buildContributorFit(context.profile, context.repositories, [], [], context.syncStates, context.repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: input.login, fit, scoringSnapshot: snapshot });
    const checkSummaries = await this.loadCheckSummariesForPullRequests(input.repoFullName, input, pullRequests);
    // Caller-supplied focusManifest wins; otherwise fall back to the repo-owned manifest when present.
    const analysisInput = input.focusManifest !== undefined || !repoManifest.present
      ? input
      : { ...input, focusManifest: repoManifest as unknown };
    return {
      ...buildLocalBranchAnalysis({
        input: analysisInput,
        repo,
        issues,
        pullRequests,
        contributorPullRequests: context.contributorPullRequests,
        recentMergedPullRequests,
        bounties,
        repositories: context.repositories,
        checkSummaries,
        profile: context.profile,
        outcomeHistory: context.outcomeHistory,
        scoringSnapshot: snapshot,
        scoringProfile,
        issueQuality: issueQuality?.report,
        gittensorSnapshot: context.gittensorSnapshot,
      }),
      dataQuality: await this.loadRepoDataQuality(input.repoFullName),
    };
  }

  private async loadCheckSummariesForPullRequests(repoFullName: string, input: Parameters<typeof findCurrentBranchPullRequest>[0], pullRequests: Parameters<typeof findCurrentBranchPullRequest>[1]) {
    const currentPullRequest = findCurrentBranchPullRequest(input, pullRequests);
    return currentPullRequest ? listCheckSummaries(this.env, repoFullName, currentPullRequest.number) : [];
  }

  private async getBountyAdvisory(id: string): Promise<ToolPayload> {
    const bounty = await getBounty(this.env, id);
    if (!bounty) throw new Error("Bounty not found.");
    if (!(await this.canAccessRepo(bounty.repoFullName))) throw new Error("Bounty not found.");
    const [repo, issue, pullRequests] = await Promise.all([
      getRepository(this.env, bounty.repoFullName),
      getIssue(this.env, bounty.repoFullName, bounty.issueNumber),
      listPullRequests(this.env, bounty.repoFullName),
    ]);
    return {
      summary: `Gittensory bounty advisory for ${id}.`,
      data: buildBountyAdvisory(bounty, repo, issue, pullRequests) as unknown as Record<string, unknown>,
    };
  }

  private async loadContributorFastContext(login: string) {
    const [github, contributorPullRequests, contributorIssues, repositories, syncStates, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(login),
      listContributorPullRequests(this.env, login),
      listContributorIssues(this.env, login),
      listRepositories(this.env),
      listRepoSyncStates(this.env),
      listContributorRepoStats(this.env, login),
      fetchGittensorContributorSnapshot(login),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    const profile = buildContributorProfile(login, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
    const outcomeHistory = buildContributorOutcomeHistory({
      login,
      profile,
      repositories,
      pullRequests: contributorPullRequests,
      issues: contributorIssues,
      repoStats,
      cachedRepoStats,
    });
    return {
      profile,
      contributorPullRequests,
      repositories,
      syncStates,
      repoStats,
      gittensorSnapshot,
      outcomeHistory,
    };
  }

  private async loadRepoDataQuality(fullName: string) {
    const [syncStates, syncSegments] = await Promise.all([listRepoSyncStates(this.env), listRepoSyncSegments(this.env, fullName)]);
    return buildRepoDataQuality(
      fullName,
      syncStates.find((state) => state.repoFullName === fullName),
      syncSegments,
    );
  }

  private toolResult(payload: ToolPayload) {
    const data = redactSensitiveForMcp(payload.data) as Record<string, unknown>;
    return {
      content: [
        {
          type: "text" as const,
          text: `${payload.summary}\n\n${JSON.stringify(data, null, 2)}`,
        },
      ],
      structuredContent: data,
    };
  }
}

function redactSensitiveForMcp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveForMcp(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/hotkey|coldkey|wallet|private_key|privateKey|mnemonic|alphaPerDay|taoPerDay|usdPerDay/i.test(key))
      .map(([key, entry]) => [key, redactSensitiveForMcp(entry)]),
  );
}

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}

async function authenticateMcpRequest(c: AppContext): Promise<AuthIdentity | null> {
  const identity = await authenticatePrivateToken(c.env, extractBearerToken(c.req.header("authorization")));
  if (!identity || identity.kind !== "session") return identity;
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor);
  return summary.roles.length > 0 ? identity : null;
}

function getExecutionContext(c: AppContext): ExecutionContext<unknown> {
  try {
    return c.executionCtx as unknown as ExecutionContext<unknown>;
  } catch {
    return {
      waitUntil: () => {},
      passThroughOnException: () => {},
      exports: {},
      props: {},
    } as unknown as ExecutionContext<unknown>;
  }
}
