import { createMcpHandler } from "agents/mcp";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authenticatePrivateToken, extractBearerToken, type AuthIdentity } from "../auth/security";
import {
  countOpenIssues,
  countOpenPullRequests,
  getBounty,
  getContributorEvidence,
  getLatestRepoGithubTotalsSnapshot,
  getIssue,
  getRepository,
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
import { buildLocalBranchAnalysis } from "../signals/local-branch";
import { buildRepoDataQuality } from "../signals/data-quality";

type AppContext = Context<{ Bindings: Env }>;
type ToolPayload = {
  summary: string;
  data: Record<string, unknown>;
};

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
  repoFullName: z.string().min(3),
  contributorLogin: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  changedFiles: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  tests: z.array(z.string()).optional(),
  authorAssociation: z.string().optional(),
};

const localDiffPreflightShape = {
  ...preflightShape,
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string()).optional(),
  commitMessage: z.string().optional(),
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
          status: z.enum(["passed", "failed", "not_run"]),
          summary: z.string().optional(),
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

const scorePreviewShape = {
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("local_diff"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  metadataOnly: z.boolean().default(true),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
};

const variantsShape = {
  variants: z.array(z.object(scorePreviewShape)).min(1).max(10),
};

export async function handleMcpRequest(c: AppContext): Promise<Response> {
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
  const identity = await authenticateMcpRequest(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);

  const server = new GittensoryMcp(c.env, identity).createServer();
  return createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(c.req.raw, c.env, getExecutionContext(c));
}

export class GittensoryMcp {
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
      },
      async (input) => this.toolResult(await this.getRepoContext(input)),
    );

    server.registerTool(
      "gittensory_get_contributor_profile",
      {
        description: "Return an evidence-backed Gittensory contributor profile for a GitHub login.",
        inputSchema: loginShape,
      },
      async (input) => this.toolResult(await this.getContributorProfile(input.login)),
    );

    server.registerTool(
      "gittensory_get_decision_pack",
      {
        description: "Return the canonical private contributor decision pack for a GitHub login.",
        inputSchema: loginShape,
      },
      async (input) => this.toolResult(await this.getDecisionPack(input.login)),
    );

    server.registerTool(
      "gittensory_explain_repo_decision",
      {
        description: "Return the contributor/repo decision from the canonical decision pack.",
        inputSchema: loginRepoShape,
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
      },
      async () => this.toolResult(await this.getRegistryChanges()),
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
      async (input) => this.toolResult(await this.agentPlanNextWork(input)),
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

    return server;
  }

  private requireContributorAccess(login: string): void {
    if (this.identity.kind === "session" && this.identity.actor.toLowerCase() !== login.toLowerCase()) {
      throw new Error("Forbidden: session can only access the authenticated GitHub login.");
    }
  }

  private async getRepoContext(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    const [repo, issues, pullRequests, recentMergedPullRequests, queueCounts] = await Promise.all([
      getRepository(this.env, fullName),
      listIssueSignalSample(this.env, fullName),
      listOpenPullRequests(this.env, fullName),
      listRecentMergedPullRequests(this.env, fullName),
      this.loadOpenQueueCounts(fullName),
    ]);
    const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
    return {
      summary: `Gittensory repo context for ${fullName}.`,
      data: {
        repoFullName: fullName,
        repo,
        lane: buildLaneAdvice(repo, fullName),
        queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts),
        collisions,
        configQuality: buildConfigQuality(repo, issues, pullRequests, fullName),
        dataQuality: await this.loadRepoDataQuality(fullName),
      },
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

  private async explainRepoDecision(input: { login: string; owner: string; repo: string }): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const fullName = `${input.owner}/${input.repo}`;
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

  private async preflightPr(input: z.infer<z.ZodObject<typeof preflightShape>>): Promise<ToolPayload> {
    const [repo, issues, pullRequests] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
    ]);
    return {
      summary: `Gittensory PR preflight for ${input.repoFullName}.`,
      data: buildPreflightResult(input, repo, issues, pullRequests) as unknown as Record<string, unknown>,
    };
  }

  private async preflightLocalDiff(input: z.infer<z.ZodObject<typeof localDiffPreflightShape>>): Promise<ToolPayload> {
    const [repo, issues, pullRequests] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
    ]);
    return {
      summary: `Gittensory local diff preflight for ${input.repoFullName}.`,
      data: buildLocalDiffPreflightResult(input, repo, issues, pullRequests) as unknown as Record<string, unknown>,
    };
  }

  private async previewScore(input: z.infer<z.ZodObject<typeof scorePreviewShape>>): Promise<ToolPayload> {
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
    const [repo, issues, pullRequests] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
    ]);
    const preflight = buildPreflightResult(input, repo, issues, pullRequests);
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

  private async agentPlanNextWork(input: z.infer<z.ZodObject<typeof agentPlanShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await planNextWork(this.env, { ...input, surface: "mcp" });
    return {
      summary: `Gittensory base-agent plan for ${input.login}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
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
    const bundle = await preparePrPacketWithAgent(this.env, input, "mcp");
    return {
      summary: `Gittensory base-agent public-safe PR packet for ${input.repoFullName}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async analyzeLocalBranch(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>) {
    this.requireContributorAccess(input.login);
    const [context, repo, issues, pullRequests, recentMergedPullRequests, snapshot] = await Promise.all([
      this.loadContributorFastContext(input.login),
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listRecentMergedPullRequests(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
    ]);
    const fit = buildContributorFit(context.profile, context.repositories, [], [], context.syncStates, context.repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: input.login, fit, scoringSnapshot: snapshot });
    return {
      ...buildLocalBranchAnalysis({
        input,
        repo,
        issues,
        pullRequests,
        recentMergedPullRequests,
        profile: context.profile,
        outcomeHistory: context.outcomeHistory,
        scoringSnapshot: snapshot,
        scoringProfile,
      }),
      dataQuality: await this.loadRepoDataQuality(input.repoFullName),
    };
  }

  private async getBountyAdvisory(id: string): Promise<ToolPayload> {
    const bounty = await getBounty(this.env, id);
    if (!bounty) throw new Error("Bounty not found.");
    const [repo, issue] = await Promise.all([getRepository(this.env, bounty.repoFullName), getIssue(this.env, bounty.repoFullName, bounty.issueNumber)]);
    return {
      summary: `Gittensory bounty advisory for ${id}.`,
      data: buildBountyAdvisory(bounty, repo, issue) as unknown as Record<string, unknown>,
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
    });
    return {
      profile,
      repositories,
      syncStates,
      repoStats,
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
      .filter(([key]) => !/hotkey|coldkey|wallet|private_key|privateKey|mnemonic/i.test(key))
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
  return authenticatePrivateToken(c.env, extractBearerToken(c.req.header("authorization")));
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
