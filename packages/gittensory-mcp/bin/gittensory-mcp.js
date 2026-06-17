#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildBranchAnalysisPayload, collectLocalDiff, collectLocalBranchMetadata, probeLocalScorer, referenceScorePreviewExample, resolveScorePreviewCommand, resolveWorkspaceCwd, sanitizeLocalScorerStatus, setupGuidanceForLocalScorer } from "../lib/local-branch.js";

const defaultApiUrl = "https://gittensory-api.aethereal.dev";
const legacyDefaultApiUrls = new Set(["https://gittensory-api.zeronode.workers.dev"]);
const packageName = "@jsonbored/gittensory-mcp";
const packageVersion = "0.6.0";
const npmRegistryUrl = (process.env.GITTENSORY_NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const upgradeCommand = `npm install -g ${packageName}@latest`;
const npxFallbackCommand = `npx ${packageName}@latest <command>`;
const compatibilityPath = "/v1/mcp/compatibility";
const currentApiVersion = "0.1.0";
const decisionPackCacheSchemaVersion = 1;
const decisionPackCacheMaxEntries = 25;
const decisionPackCacheMaxBytes = 512 * 1024;
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const cliArgs = process.argv.slice(2);
const defaultProfileName = "default";
// Single source of truth for shell-completion: top-level command -> its subcommands (if any).
const CLI_COMMAND_SPEC = {
  login: [],
  logout: [],
  whoami: [],
  config: [],
  status: [],
  changelog: [],
  completion: [],
  version: [],
  doctor: [],
  "init-client": [],
  "decision-pack": [],
  "repo-decision": [],
  "analyze-branch": [],
  preflight: [],
  profile: ["list", "create", "switch", "remove"],
  cache: ["status", "clear"],
  agent: ["plan", "status", "explain", "packet"],
};
const COMPLETION_SHELLS = ["bash", "zsh", "fish"];
const AGENT_PROFILE_IDS = ["miner-planner", "maintainer-triage", "repo-owner-intake"];
const AGENT_PROFILES = {
  "miner-planner": {
    id: "miner-planner",
    title: "Miner planner",
    audience: "contributors choosing and preparing Gittensor OSS work",
    purpose: "Plan cleanup-first work, run branch preflight, explain blockers, and prepare public-safe PR packets.",
    recommendedPrompts: ["gittensory_miner_select_issue", "gittensory_miner_branch_preflight", "gittensory_miner_cleanup_first", "gittensory_miner_draft_pr_packet"],
    recommendedTools: ["gittensory_agent_plan_next_work", "gittensory_preflight_current_branch", "gittensory_agent_prepare_pr_packet"],
    boundaries: [
      "Human-approved only: plan, explain, draft, and prepare packets; do not open PRs, post comments, label, close, merge, or publish public GitHub output.",
      "Use public-safe summaries for copyable text and keep authenticated decision-pack context out of public GitHub text.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
    ],
    whenNotToUse: "Do not use this profile to chase compensation, predict public scores, or automate submissions without maintainer review.",
  },
  "maintainer-triage": {
    id: "maintainer-triage",
    title: "Maintainer queue triage",
    audience: "maintainers preparing low-noise queue and PR review context",
    purpose: "Summarize queue risk, prepare review notes, and draft public guidance for human review.",
    recommendedPrompts: ["gittensory_maintainer_queue_triage", "gittensory_maintainer_review_prep", "gittensory_maintainer_public_guidance"],
    recommendedTools: ["gittensory_get_repo_context", "gittensory_get_burden_forecast", "gittensory_preflight_pr"],
    boundaries: [
      "Human-approved only: prepare summaries and draft guidance; do not post comments, label, close, merge, or edit contributor work.",
      "Keep private review context, raw trust context, and authenticated-only evidence out of public snippets.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
    ],
    whenNotToUse: "Do not use this profile as an autonomous maintainer bot or for public ranking, public scoring, or compensation claims.",
  },
  "repo-owner-intake": {
    id: "repo-owner-intake",
    title: "Repo-owner intake",
    audience: "repository owners preparing intake readiness and onboarding plans",
    purpose: "Review registration readiness, focus manifests, docs/onboarding gaps, and manual setup actions.",
    recommendedPrompts: ["gittensory_repo_owner_intake_readiness", "gittensory_repo_owner_focus_manifest_review", "gittensory_repo_owner_onboarding_pack"],
    recommendedTools: ["gittensory_get_repo_context", "gittensory_get_issue_quality"],
    boundaries: [
      "Human-approved only: review, explain, and draft setup plans; do not push config, label issues, post comments, close issues, or publish public output.",
      "Separate public readiness guidance from private maintainer or authenticated owner context.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
    ],
    whenNotToUse: "Do not use this profile to bypass owner approval, auto-register repositories, or publish policy changes automatically.",
  },
};
const configPath =
  process.env.GITTENSORY_CONFIG_PATH ??
  (process.env.GITTENSORY_CONFIG_DIR
    ? join(process.env.GITTENSORY_CONFIG_DIR, "config.json")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gittensory", "config.json"));
const cacheDir = process.env.GITTENSORY_CACHE_DIR ?? join(dirname(configPath), "cache");
const decisionPackCacheDir = join(cacheDir, "decision-packs");
const config = loadConfig();
const requestedProfileName = cliOptionValue(cliArgs, "profile") ?? process.env.GITTENSORY_PROFILE;
const activeProfileName = selectProfileName(config, requestedProfileName);
const activeProfile = config.profiles?.[activeProfileName] ?? {};
const configuredApiUrl = typeof activeProfile.apiUrl === "string" ? activeProfile.apiUrl.replace(/\/+$/, "") : typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : undefined;
const apiUrl = (process.env.GITTENSORY_API_URL ?? (configuredApiUrl && !legacyDefaultApiUrls.has(configuredApiUrl) ? configuredApiUrl : defaultApiUrl)).replace(/\/+$/, "");

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

const validateLinkedIssueShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  plannedChange: z
    .object({
      title: z.string().min(1).optional(),
      changedFiles: z.array(z.string()).optional(),
      contributorLogin: z.string().min(1).optional(),
    })
    .optional(),
};

const checkBeforeStartShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive().optional(),
  title: z.string().min(1).optional(),
  plannedPaths: z.array(z.string()).optional(),
};

const lintPrTextShape = {
  commitMessages: z.array(z.string()).max(50).optional(),
  prBody: z.string().optional(),
  linkedIssue: z.number().int().positive().optional(),
};

const checkSlopRiskShape = {
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000)
    .optional(),
  description: z.string().max(20000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
};

const checkIssueSlopShape = {
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
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

const localDiffShape = {
  repoFullName: z.string().min(3),
  cwd: z.string().optional(),
  baseRef: z.string().default("HEAD"),
  contributorLogin: z.string().min(1).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  tests: z.array(z.string()).optional(),
  authorAssociation: z.string().optional(),
  commitMessage: z.string().optional(),
};

const branchEligibilityShape = {
  status: z.enum(["eligible", "ineligible", "unknown"]),
  source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  stale: z.boolean().optional(),
};

const localScoreShape = {
  ...localDiffShape,
  targetKey: z.string().optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).optional(),
  branchEligibility: z.object(branchEligibilityShape).strict().optional(),
  scorePreviewCommand: z.string().optional(),
};

const variantsShape = {
  variants: z.array(z.object(localScoreShape)).min(1).max(10),
};

const currentBranchShape = {
  login: z.string().min(1),
  cwd: z.string().optional(),
  repoFullName: z.string().min(3).optional(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  branchName: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).optional(),
  branchEligibility: z.object(branchEligibilityShape).strict().optional(),
  validation: z
    .array(
      z.object({
        command: z.string().min(1),
        status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
        summary: z.string().optional(),
        durationMs: z.number().int().min(0).optional(),
        exitCode: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
  scorePreviewCommand: z.string().optional(),
};

const currentBranchVariantsShape = {
  variants: z.array(z.object(currentBranchShape)).min(1).max(10),
};

const agentPlanShape = {
  login: z.string().min(1),
  objective: z.string().optional(),
  repoFullName: z.string().min(3).optional(),
};

const agentRunShape = {
  objective: z.string().min(1),
  actorLogin: z.string().min(1),
  targetRepoFullName: z.string().min(3).optional(),
  targetPullNumber: z.number().int().positive().optional(),
  targetIssueNumber: z.number().int().positive().optional(),
};

const agentRunIdShape = {
  runId: z.string().min(1),
};

if (cliArgs[0] && cliArgs[0] !== "--stdio") {
  await runCli(cliArgs);
  process.exit(0);
}

const server = new McpServer({
  name: "gittensory-local",
  version: packageVersion,
});

server.registerTool(
  "gittensory_get_repo_context",
  {
    description: "Return the canonical repo intelligence bundle from the private Gittensory API.",
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("Gittensory repo intelligence.", await apiGet(`${prefix}/intelligence`));
  },
);

server.registerTool(
  "gittensory_preflight_pr",
  {
    description: "Preflight planned PR metadata against lane, duplicate, linked issue, test, and queue signals.",
    inputSchema: preflightShape,
  },
  async (input) => toolResult("Gittensory PR preflight.", await apiPost("/v1/preflight/pr", input)),
);

server.registerTool(
  "gittensory_validate_linked_issue",
  {
    description:
      "Report whether linking an issue will actually earn the standard linked-issue scoring multiplier for a planned PR — open, valid, single-owner, solvable by this PR — with the blocking reason if not. The raw multiplier value stays private.",
    inputSchema: validateLinkedIssueShape,
  },
  async ({ owner, repo, issueNumber, plannedChange }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const body = { issueNumber, ...(plannedChange ? { plannedChange } : {}) };
    return toolResult("Gittensory linked-issue validation.", await apiPost(`${prefix}/validate-linked-issue`, body));
  },
);

server.registerTool(
  "gittensory_check_before_start",
  {
    description:
      "Before writing any code, check whether an issue is already claimed or solved, whether a duplicate cluster is forming, and whether it is a valid target. Returns a go/raise/avoid recommendation with public-safe reasons from cached metadata.",
    inputSchema: checkBeforeStartShape,
  },
  async ({ owner, repo, issueNumber, title, plannedPaths }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const body = {
      ...(issueNumber != null ? { issueNumber } : {}),
      ...(title ? { title } : {}),
      ...(plannedPaths ? { plannedPaths } : {}),
    };
    return toolResult("Gittensory pre-start check.", await apiPost(`${prefix}/check-before-start`, body));
  },
);

server.registerTool(
  "gittensory_lint_pr_text",
  {
    description:
      "Lint a commit message + PR body against the gittensor traceability/no-issue-rationale and Conventional Commit rubric before submitting. Returns a deterministic verdict (strong/adequate/weak) plus specific public-safe fixes. No source upload.",
    inputSchema: lintPrTextShape,
  },
  async (input) => toolResult("Gittensory PR-text lint.", await apiPost("/v1/lint/pr-text", input)),
);

server.registerTool(
  "gittensory_check_slop_risk",
  {
    description:
      "Assess the deterministic slop risk of a planned change from local diff metadata (paths + line counts) + the PR description — an agent-native, source-free quality self-check. Returns slopRisk (0-100), band, findings, and the rubric. No repo data needed.",
    inputSchema: checkSlopRiskShape,
  },
  async (input) => toolResult("Gittensory slop-risk self-check.", await apiPost("/v1/lint/slop-risk", input)),
);

server.registerTool(
  "gittensory_check_issue_slop",
  {
    description:
      "Assess the deterministic slop risk of an issue from its title + body alone (no repo data) — flags clearly low-effort issues (empty body, an unfilled template) for triage. Returns slopRisk (0-100), band, findings, and the rubric. Advisory-only.",
    inputSchema: checkIssueSlopShape,
  },
  async (input) => toolResult("Gittensory issue-slop self-check.", await apiPost("/v1/lint/issue-slop", input)),
);

server.registerTool(
  "gittensory_preflight_local_diff",
  {
    description: "Inspect local git diff metadata and run Gittensory preflight without uploading source contents.",
    inputSchema: localDiffShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const diff = collectLocalDiff(workspaceInput.cwd, input.baseRef, workspaceInput.workspaceRoots);
    const body = {
      repoFullName: input.repoFullName,
      contributorLogin: input.contributorLogin,
      title: input.title ?? diff.title,
      body: input.body,
      labels: input.labels,
      linkedIssues: input.linkedIssues,
      tests: input.tests,
      authorAssociation: input.authorAssociation,
      commitMessage: input.commitMessage ?? diff.commitMessage,
      changedFiles: diff.changedFiles,
      testFiles: diff.testFiles,
      changedLineCount: diff.changedLineCount,
    };
    return toolResult("Gittensory local diff preflight.", await apiPost("/v1/preflight/local-diff", body));
  },
);

server.registerTool(
  "gittensory_get_registry_changes",
  {
    description: "Return latest cached Gittensor registry change report.",
    inputSchema: {},
  },
  async () => toolResult("Gittensory registry changes.", await apiGet("/v1/registry/changes")),
);

server.registerTool(
  "gittensory_preview_local_pr_score",
  {
    description: "Inspect local diff metadata and request a private Gittensory scoring preview. No source contents are uploaded.",
    inputSchema: localScoreShape,
  },
  async (input) => toolResult("Gittensory private local PR scoring preview.", await previewLocalScore(await withClientWorkspaceRoots(input))),
);

server.registerTool(
  "gittensory_explain_score_breakdown",
  {
    description: "Explain a private score preview multiplier-by-multiplier with plain-English levers and the highest-impact improvement.",
    inputSchema: localScoreShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const contributorLogin = workspaceInput.contributorLogin ?? activeProfile.session?.login;
    if (!contributorLogin) throw new Error("contributorLogin is required for score breakdown.");
    const workspace = resolveWorkspaceCwd(workspaceInput);
    const diff = collectLocalDiff(workspace.cwd, workspaceInput.baseRef, workspaceInput.workspaceRoots);
    const branchPayload = buildBranchAnalysisPayload({
      ...workspaceInput,
      login: contributorLogin,
      cwd: workspace.cwd,
      repoFullName: workspaceInput.repoFullName,
      baseRef: workspaceInput.baseRef,
    });
    const upstreamPreview = branchPayload.localScorerStatus;
    const estimatedSourceLines = workspaceInput.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
    const body = {
      repoFullName: workspaceInput.repoFullName,
      targetType: "local_diff",
      targetKey: workspaceInput.targetKey ?? localDiffTargetKey(branchPayload, workspaceInput.baseRef),
      contributorLogin,
      labels: workspaceInput.labels,
      linkedIssueMode: workspaceInput.linkedIssueMode,
      sourceTokenScore: workspaceInput.sourceTokenScore ?? estimatedSourceLines,
      sourceLines: estimatedSourceLines,
      totalTokenScore: workspaceInput.totalTokenScore ?? diff.changedLineCount,
      testTokenScore: diff.testFiles.length,
      openPrCount: workspaceInput.openPrCount,
      credibility: workspaceInput.credibility,
      changesRequestedCount: workspaceInput.changesRequestedCount,
      pendingMergedPrCount: workspaceInput.pendingMergedPrCount,
      pendingClosedPrCount: workspaceInput.pendingClosedPrCount,
      approvedPrCount: workspaceInput.approvedPrCount,
      expectedOpenPrCountAfterMerge: workspaceInput.expectedOpenPrCountAfterMerge,
      projectedCredibility: workspaceInput.projectedCredibility,
      scenarioNotes: workspaceInput.scenarioNotes,
      branchEligibility: workspaceInput.branchEligibility,
      metadataOnly: !upstreamPreview.ok,
    };
    return toolResult("Gittensory private score breakdown.", await apiPost("/v1/scoring/explain-breakdown", body));
  },
);

server.registerTool(
  "gittensory_get_decision_pack",
  {
    description: "Return the canonical private contributor decision pack for a GitHub login.",
    inputSchema: loginShape,
  },
  async ({ login }) => {
    const payload = await getDecisionPackWithCache(login);
    return toolResult(decisionPackToolSummary(login, payload), payload);
  },
);

server.registerTool(
  "gittensory_explain_repo_decision",
  {
    description: "Return the contributor/repo decision from the canonical decision pack.",
    inputSchema: loginRepoShape,
  },
  async ({ login, owner, repo }) => {
    const payload = await getRepoDecisionWithCache(login, owner, repo);
    return toolResult(repoDecisionToolSummary(login, `${owner}/${repo}`, payload), payload);
  },
);

server.registerTool(
  "gittensory_compare_pr_variants",
  {
    description: "Compare private Gittensory scoring previews across local/metadata variants.",
    inputSchema: variantsShape,
  },
  async ({ variants }) => {
    const roots = await clientWorkspaceRoots();
    const previews = [];
    for (const variant of variants) previews.push(await previewLocalScore(withWorkspaceRoots({ ...variant, targetKey: variant.targetKey ?? `variant:${previews.length + 1}` }, roots)));
    previews.sort((left, right) => Number(right?.remotePreview?.result?.effectiveEstimatedScore ?? right?.remotePreview?.result?.scoreEstimate?.estimatedMergedScore ?? 0) - Number(left?.remotePreview?.result?.effectiveEstimatedScore ?? left?.remotePreview?.result?.scoreEstimate?.estimatedMergedScore ?? 0));
    return toolResult("Gittensory PR variant comparison.", { variants: previews });
  },
);

server.registerTool(
  "gittensory_local_status",
  {
    description: "Return local Gittensory MCP status, inferred git repo metadata, and privacy defaults.",
    inputSchema: {
      cwd: z.string().optional(),
      baseRef: z.string().optional(),
      repoFullName: z.string().min(3).optional(),
    },
  },
  async (input) => {
    let git = null;
    const workspaceInput = await withClientWorkspaceRoots(input);
    try {
      git = collectLocalBranchMetadata({ cwd: workspaceInput.cwd, baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local", workspaceRoots: workspaceInput.workspaceRoots });
    } catch (error) {
      git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    return toolResult("Gittensory local MCP status.", {
      apiUrl,
      package: {
        name: packageName,
        version: packageVersion,
      },
      hasToken: Boolean(getApiToken()),
      profile: profilePublicState(activeProfileName),
      authLogin: activeProfile.session?.login ?? null,
      sessionExpiresAt: activeProfile.session?.expiresAt ?? null,
      sourceUploadDefault: false,
      sourceUploadSupported: false,
      workspaceRoots: workspaceRootStatus(workspaceInput.workspaceRoots),
      git,
    });
  },
);

server.registerTool(
  "gittensory_preflight_current_branch",
  {
    description: "Analyze the current git branch and return PR readiness. Sends metadata only.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("Gittensory current-branch preflight.", {
      local: result.local,
      preflight: result.analysis.preflight,
      prPacket: result.analysis.prPacket,
      workspaceIntelligence: result.analysis.workspaceIntelligence,
    });
  },
);

server.registerTool(
  "gittensory_preview_current_branch_score",
  {
    description: "Analyze the current git branch and return private scoreability context. Sends metadata only.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("Gittensory current-branch private score preview.", {
      local: result.local,
      scorePreview: result.analysis.scorePreview,
      scenarioScorePreview: result.analysis.scenarioScorePreview,
      scoreBlockers: result.analysis.scoreBlockers,
      recommendedRerunCondition: result.analysis.recommendedRerunCondition,
    });
  },
);

server.registerTool(
  "gittensory_rank_local_next_actions",
  {
    description: "Analyze the current git branch and rank local next actions by private reward/risk and review friction.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("Gittensory local next-action ranking.", { local: result.local, nextActions: result.analysis.nextActions, rewardRisk: result.analysis.rewardRisk, recommendedRerunCondition: result.analysis.recommendedRerunCondition });
  },
);

server.registerTool(
  "gittensory_explain_local_blockers",
  {
    description: "Analyze the current git branch and explain private scoreability, lane, and review blockers.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("Gittensory local blocker explanation.", {
      local: result.local,
      scoreBlockers: result.analysis.scoreBlockers,
      branchQualityBlockers: result.analysis.branchQualityBlockers,
      accountStateBlockers: result.analysis.accountStateBlockers,
      baseFreshness: result.analysis.baseFreshness,
      localFindings: result.analysis.localFindings,
      recommendedRerunCondition: result.analysis.recommendedRerunCondition,
    });
  },
);

server.registerTool(
  "gittensory_remediation_plan",
  {
    description: "Analyze the current git branch and return an ordered public-safe remediation checklist with rerun conditions.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const payload = buildBranchAnalysisPayload({ ...workspaceInput, cwd: resolveWorkspaceCwd(workspaceInput).cwd });
    const { localScorerStatus: _localScorerStatus, ...body } = payload;
    return toolResult("Gittensory remediation plan.", await apiPost("/v1/local/remediation-plan", body));
  },
);

server.registerTool(
  "gittensory_prepare_pr_packet",
  {
    description: "Analyze the current git branch and return a public-safe PR packet. Sends metadata only.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("Gittensory public-safe PR packet.", { local: result.local, prPacket: result.analysis.prPacket });
  },
);

server.registerTool(
  "gittensory_compare_local_variants",
  {
    description: "Compare current-branch metadata variants without uploading source contents.",
    inputSchema: currentBranchVariantsShape,
  },
  async ({ variants }) => {
    const roots = await clientWorkspaceRoots();
    const analyses = [];
    for (const variant of variants) analyses.push(await analyzeCurrentBranch(withWorkspaceRoots(variant, roots)));
    analyses.sort(
      (left, right) =>
        Number(right.analysis.nextActions?.[0]?.priorityScore ?? 0) - Number(left.analysis.nextActions?.[0]?.priorityScore ?? 0) ||
        Number(right.analysis.scorePreview?.effectiveEstimatedScore ?? right.analysis.scorePreview?.scoreEstimate?.estimatedMergedScore ?? 0) - Number(left.analysis.scorePreview?.effectiveEstimatedScore ?? left.analysis.scorePreview?.scoreEstimate?.estimatedMergedScore ?? 0),
    );
    return toolResult("Gittensory local variant comparison.", {
      variants: analyses.map((entry) => ({
        local: entry.local,
        preflightStatus: entry.analysis.preflight.status,
        scoreBlockers: entry.analysis.scoreBlockers,
        topAction: entry.analysis.nextActions?.[0] ?? null,
        prPacket: entry.analysis.prPacket,
      })),
    });
  },
);

server.registerTool(
  "gittensory_agent_plan_next_work",
  {
    description: "Run the deterministic Gittensory base-agent planner for a GitHub login.",
    inputSchema: agentPlanShape,
  },
  async (input) => toolResult(`Gittensory base-agent plan for ${input.login}.`, await apiPost("/v1/agent/plan-next-work", input)),
);

server.registerTool(
  "gittensory_agent_start_run",
  {
    description: "Create a queued copilot-only Gittensory base-agent run.",
    inputSchema: agentRunShape,
  },
  async (input) =>
    toolResult(
      `Queued Gittensory base-agent run for ${input.actorLogin}.`,
      await apiPost("/v1/agent/runs", {
        objective: input.objective,
        actorLogin: input.actorLogin,
        surface: "mcp",
        target: stripUndefined({
          repoFullName: input.targetRepoFullName,
          pullNumber: input.targetPullNumber,
          issueNumber: input.targetIssueNumber,
        }),
      }),
    ),
);

server.registerTool(
  "gittensory_agent_get_run",
  {
    description: "Fetch a persisted Gittensory base-agent run.",
    inputSchema: agentRunIdShape,
  },
  async ({ runId }) => toolResult(`Gittensory base-agent run ${runId}.`, await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`)),
);

server.registerTool(
  "gittensory_agent_explain_next_action",
  {
    description: "Explain the next deterministic action and blocker context for a GitHub login.",
    inputSchema: agentPlanShape,
  },
  async (input) => {
    const result = await apiPost("/v1/agent/explain-blockers", input);
    return toolResult(`Gittensory base-agent next-action explanation for ${input.login}.`, {
      ...result,
      topAction: result.actions?.[0] ?? null,
    });
  },
);

server.registerTool(
  "gittensory_agent_prepare_pr_packet",
  {
    description: "Prepare a public-safe PR packet from current branch metadata. Sends metadata only.",
    inputSchema: currentBranchShape,
  },
  async (input) => toolResult("Gittensory base-agent public-safe PR packet.", await agentPreparePrPacket(await withClientWorkspaceRoots(input))),
);

// ── Output schemas for structured tool responses (#291) ──────────────────────

const repoContextOutputSchema = {
  type: "object",
  properties: {
    repoFullName: { type: "string" },
    lane: { type: "string" },
    primaryLanguage: { type: ["string", "null"] },
    openIssueCount: { type: "number" },
    openPrCount: { type: "number" },
  },
  additionalProperties: true,
};

const preflightOutputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "warn", "fail", "unknown"] },
    signals: { type: "array", items: { type: "object" } },
    summary: { type: "string" },
  },
  additionalProperties: true,
};

const decisionPackOutputSchema = {
  type: "object",
  properties: {
    login: { type: "string" },
    decisions: { type: "array", items: { type: "object" } },
    cachedAt: { type: ["string", "null"] },
  },
  additionalProperties: true,
};

const localStatusOutputSchema = {
  type: "object",
  properties: {
    apiUrl: { type: "string" },
    package: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } }, additionalProperties: true },
    hasToken: { type: "boolean" },
    profile: { type: "object", additionalProperties: true },
    authLogin: { type: ["string", "null"] },
    sessionExpiresAt: { type: ["string", "null"] },
    sourceUploadDefault: { type: "boolean" },
    sourceUploadSupported: { type: "boolean" },
    git: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
};

const agentPlanOutputSchema = {
  type: "object",
  properties: {
    login: { type: "string" },
    actions: { type: "array", items: { type: "object" } },
    topAction: { type: ["object", "null"] },
  },
  additionalProperties: true,
};

// Attach outputSchema to key tools via registerTool with zod output schemas.
// All other tools continue to return unschematized text+structured content.

server.registerTool(
  "gittensory_local_status_structured",
  {
    description: "Return local Gittensory MCP status with a validated structured output schema.",
    inputSchema: {
      cwd: z.string().optional(),
      baseRef: z.string().optional(),
      repoFullName: z.string().min(3).optional(),
    },
    outputSchema: z.object({
      apiUrl: z.string(),
      package: z.object({ name: z.string(), version: z.string() }),
      hasToken: z.boolean(),
      profile: z.record(z.unknown()),
      authLogin: z.string().nullable(),
      sessionExpiresAt: z.string().nullable(),
      sourceUploadDefault: z.boolean(),
      sourceUploadSupported: z.boolean(),
      git: z.record(z.unknown()),
    }),
  },
  async (input) => {
    let git = null;
    const workspaceInput = await withClientWorkspaceRoots(input);
    try {
      git = collectLocalBranchMetadata({ cwd: workspaceInput.cwd, baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local", workspaceRoots: workspaceInput.workspaceRoots });
    } catch (error) {
      git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    const data = {
      apiUrl,
      package: { name: packageName, version: packageVersion },
      hasToken: Boolean(getApiToken()),
      profile: profilePublicState(activeProfileName),
      authLogin: activeProfile.session?.login ?? null,
      sessionExpiresAt: activeProfile.session?.expiresAt ?? null,
      sourceUploadDefault: false,
      sourceUploadSupported: false,
      git: git ?? {},
    };
    return { content: [{ type: "text", text: `Gittensory local MCP status.\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
  },
);

// ── Resources: decision-pack, doctor, compatibility, changelog (#292) ─────────

server.registerResource(
  "gittensory_changelog",
  "gittensory://changelog",
  {
    title: "Gittensory MCP Changelog",
    description: "Current CHANGELOG.md for the installed gittensory-mcp package.",
    mimeType: "text/markdown",
  },
  async () => {
    let text;
    try {
      text = readFileSync(changelogPath, "utf8");
    } catch {
      text = "Changelog not available.";
    }
    return { contents: [{ uri: "gittensory://changelog", mimeType: "text/markdown", text }] };
  },
);

server.registerResource(
  "gittensory_compatibility",
  "gittensory://compatibility",
  {
    title: "Gittensory API Compatibility",
    description: "Current API compatibility state: version, supported methods, and any deprecation notices.",
    mimeType: "application/json",
  },
  async () => {
    let data;
    try {
      data = await apiGet(compatibilityPath);
    } catch {
      data = { status: "unavailable", currentApiVersion, packageVersion };
    }
    return { contents: [{ uri: "gittensory://compatibility", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  },
);

server.registerResource(
  "gittensory_decision_pack",
  new ResourceTemplate("gittensory://decision-packs/{login}", { list: undefined }),
  {
    title: "Gittensory Decision Pack",
    description: "Cached private contributor decision pack for a GitHub login. Requires authentication.",
    mimeType: "application/json",
  },
  async (uri, { login }) => {
    const payload = await getDecisionPackWithCache(String(login));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
  },
);

// ── Miner planning prompts (#293) ─────────────────────────────────────────────

server.registerPrompt(
  "gittensory_miner_select_issue",
  {
    title: "Select Next Issue to Work On",
    description: "Guide a contributor through selecting the best open issue to work on next, using Gittensory lane and duplicate signals. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory miner planning assistant for ${login} working on ${repoFullName}.`,
            "",
            "Your job is to help the contributor select the best open issue to work on next.",
            "Use the gittensory_get_repo_context and gittensory_agent_plan_next_work tools to fetch lane and queue signals.",
            "",
            "Guidelines:",
            "- Prefer issues that match the repo lane (feature, bug, docs, test, refactor, chore).",
            "- Avoid issues with existing open PRs unless the contributor owns one of them.",
            "- Flag duplicate or stale work before the contributor invests time.",
            "- Summarize the top 3 candidate issues with a short rationale for each.",
            "- Do not open, comment on, label, close, or modify any GitHub issue or PR.",
            "- Do not predict reward amounts, payout estimates, or public scoreability rankings.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_miner_draft_pr_packet",
  {
    title: "Draft PR Packet for Current Branch",
    description: "Guide a contributor through preparing a public-safe PR packet for the current branch. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory miner planning assistant for ${login} working on ${repoFullName}.`,
            "",
            "Your job is to help the contributor prepare a public-safe PR packet for their current branch.",
            "Use gittensory_preflight_current_branch or gittensory_prepare_pr_packet to gather branch signals.",
            "",
            "Guidelines:",
            "- Draft a title, description, and label suggestions based on the diff metadata.",
            "- Flag any preflight warnings (duplicate work, missing linked issue, test coverage gaps).",
            "- Keep the draft public-safe: no private scoreability data, no raw trust scores.",
            "- Present the draft for the contributor to review and edit before opening a PR.",
            "- Do not open, comment on, label, close, or merge any GitHub PR.",
            "- Do not predict reward amounts or publish scoring predictions.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_miner_branch_preflight",
  {
    title: "Branch Preflight Check",
    description: "Run a preflight check on the current branch and summarize blockers for the contributor. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory miner planning assistant for ${login} working on ${repoFullName}.`,
            "",
            "Your job is to run a branch preflight check and explain any blockers clearly.",
            "Use gittensory_explain_local_blockers and gittensory_preflight_current_branch to fetch signals.",
            "",
            "Guidelines:",
            "- List each blocker with a plain-language explanation and suggested remediation.",
            "- Distinguish between hard blockers (will prevent merge) and soft warnings (worth fixing).",
            "- Do not open, comment on, label, close, or merge any GitHub PR.",
            "- Do not expose private scoreability details or raw trust scores in public-facing text.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_miner_cleanup_first",
  {
    title: "Cleanup-First Planning",
    description: "Help a contributor identify stale or low-value open PRs to close before opening new work. Advisory only.",
    argsSchema: {
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory miner planning assistant for ${login}.`,
            "",
            "Your job is to help the contributor identify stale or low-value open PRs to close or supersede before opening new work.",
            "Use gittensory_get_decision_pack to fetch the contributor decision pack.",
            "",
            "Guidelines:",
            "- List open PRs that are stale, duplicate, or conflicting with newer work.",
            "- Suggest which to close, which to rebase, and which to keep open.",
            "- Summarize the expected queue pressure impact of each decision.",
            "- Do not close, comment on, label, or merge any GitHub PR autonomously.",
            "- Do not predict reward amounts, payout estimates, or public scoring outcomes.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

// ── Maintainer and repo-owner workflow prompts (#294) ─────────────────────────

server.registerPrompt(
  "gittensory_maintainer_queue_triage",
  {
    title: "Maintainer Queue Triage",
    description: "Guide a maintainer through triaging the open PR queue using Gittensory signals. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory maintainer assistant for ${repoFullName}.`,
            "",
            "Your job is to help the maintainer triage the open PR queue.",
            "Use gittensory_get_repo_context to fetch current lane and queue signals.",
            "",
            "Guidelines:",
            "- Group PRs by: ready to review, needs changes, stale, duplicate.",
            "- Flag PRs with missing linked issues, failing checks, or low-quality diffs.",
            "- Suggest a review order based on lane fit and contributor history.",
            "- Prepare review notes and questions for the maintainer to post manually.",
            "- Do not post comments, approve, request changes, label, close, or merge any PR autonomously.",
            "- Do not expose private scoreability details, raw trust scores, or private reviewer context.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_maintainer_review_prep",
  {
    title: "Maintainer Review Preparation",
    description: "Prepare a structured review packet for a specific PR. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      pullNumber: z.string().min(1).describe("PR number to prepare a review for."),
    },
  },
  ({ repoFullName, pullNumber }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory maintainer assistant for ${repoFullName}.`,
            "",
            `Your job is to prepare a structured review packet for PR #${pullNumber}.`,
            "Use gittensory_preflight_pr or gittensory_explain_repo_decision to fetch relevant signals.",
            "",
            "Guidelines:",
            "- Summarize the PR scope, changed files, and linked issue (if any).",
            "- List preflight signals: lane fit, duplicate risk, test coverage, queue pressure.",
            "- Draft review questions or change requests for the maintainer to post manually.",
            "- Keep all output public-safe: no private scoreability data or raw trust scores.",
            "- Do not post review comments, approve, request changes, label, close, or merge the PR.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_maintainer_public_guidance",
  {
    title: "Maintainer Public Guidance Draft",
    description: "Draft low-noise, public-safe guidance for a contributor based on their PR. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      contributorLogin: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, contributorLogin }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory maintainer assistant for ${repoFullName}.`,
            "",
            `Your job is to draft low-noise, public-safe guidance for contributor ${contributorLogin}.`,
            "Use gittensory_get_repo_context for lane context.",
            "",
            "Guidelines:",
            "- Draft a short, encouraging, actionable comment the maintainer can post manually.",
            "- Focus on what the contributor should change, not on scoring or reward prediction.",
            "- Keep the tone neutral and constructive — no compensation language.",
            "- Do not mention trust scores, hotkeys, coldkeys, wallet addresses, reward estimates, or private reviewability.",
            "- Do not post the comment autonomously — present it for the maintainer to review and post.",
            "- Do not close, label, merge, or modify the PR autonomously.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_repo_owner_intake_readiness",
  {
    title: "Repo Owner Intake Readiness",
    description: "Guide a repo owner through assessing contributor intake readiness using Gittensory signals. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory repo-owner assistant for ${repoFullName}.`,
            "",
            "Your job is to help the repo owner assess contributor intake readiness.",
            "Use gittensory_get_repo_context to fetch lane and queue signals.",
            "",
            "Guidelines:",
            "- Summarize current lane health: open issue count, PR queue pressure, merge rate.",
            "- Flag gaps in the CONTRIBUTING.md, issue templates, or lane focus manifest.",
            "- Recommend intake improvements the repo owner can make manually.",
            "- Do not autonomously edit repo files, post comments, or open/close issues or PRs.",
            "- Do not expose private scoreability data or raw trust scores publicly.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_repo_owner_focus_manifest_review",
  {
    title: "Repo Owner Focus Manifest Review",
    description: "Help a repo owner review and improve their focus manifest using Gittensory policy signals. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory repo-owner assistant for ${repoFullName}.`,
            "",
            "Your job is to help the repo owner review and improve their Gittensory focus manifest.",
            "Use gittensory_get_repo_context to fetch current policy and lane signals.",
            "",
            "Guidelines:",
            "- Identify gaps or inconsistencies in the focus manifest.",
            "- Suggest improvements to label policy, contribution lanes, and readiness criteria.",
            "- Draft an updated manifest section for the repo owner to review and apply manually.",
            "- Do not autonomously push changes to the repo or open PRs.",
            "- Do not expose private scoreability data or raw trust scores.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "gittensory_repo_owner_onboarding_pack",
  {
    title: "Repo Owner Onboarding Pack Planning",
    description: "Help a repo owner plan and draft an onboarding pack for new contributors. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a Gittensory repo-owner assistant for ${repoFullName}.`,
            "",
            "Your job is to help the repo owner plan and draft an onboarding pack for new contributors.",
            "Use gittensory_get_repo_context to fetch lane and policy signals.",
            "",
            "Guidelines:",
            "- Draft an onboarding overview: repo purpose, contribution lanes, good-first-issue guidance.",
            "- Suggest CONTRIBUTING.md sections, issue templates, and label conventions to add or improve.",
            "- Keep all content public-safe: no private scoreability, raw trust, or reward prediction.",
            "- Present the draft for the repo owner to review and apply manually.",
            "- Do not autonomously push changes, open PRs, or post comments.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());

async function withClientWorkspaceRoots(input) {
  return withWorkspaceRoots(input, await clientWorkspaceRoots());
}

function withWorkspaceRoots(input, roots) {
  return roots.length > 0 ? { ...input, workspaceRoots: roots } : input;
}

async function clientWorkspaceRoots() {
  if (!server.server.getClientCapabilities()?.roots) return [];
  try {
    const result = await server.server.listRoots(undefined, { timeout: 1000 });
    return Array.isArray(result.roots) ? result.roots : [];
  } catch {
    return [];
  }
}

function workspaceRootStatus(roots) {
  const count = Array.isArray(roots) ? roots.length : 0;
  return {
    available: count > 0,
    count,
    pathsIncluded: false,
  };
}

async function runCli(args) {
  const command = args[0];
  if (command === "--help" || command === "help") return printHelp();
  if (command === "--version" || command === "-v" || command === "version") return printVersion(parseOptions(args.slice(1)));
  if (command === "completion") return completionCommand(args.slice(1));
  if (command === "agent") return runAgentCli(args.slice(1));
  if (command === "cache") return runCacheCli(args.slice(1));
  const options = parseOptions(args.slice(1));
  if (command === "login") return login(options);
  if (command === "logout") return logout(options);
  if (command === "profile" || command === "profiles") return profileCommand(args.slice(1));
  if (command === "whoami") return whoami(options);
  if (command === "config") return configCommand(options);
  if (command === "status") return status(options);
  if (command === "changelog") return changelog(options);
  if (command === "doctor") return doctor(options);
  if (command === "init-client") return initClient(options);
  if (command === "decision-pack") return decisionPackCli(options);
  if (command === "repo-decision") return repoDecisionCli(options);
  if (command !== "analyze-branch" && command !== "preflight") throw new Error(`Unknown command: ${command}. Run \`gittensory-mcp --help\` to list commands.`);
  const contributorLogin = options.login ?? process.env.GITTENSORY_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!contributorLogin) throw new Error("Pass --login <github-login> or set GITTENSORY_LOGIN.");
  const result = await analyzeCurrentBranch({
    login: contributorLogin,
    cwd: options.cwd,
    repoFullName: options.repo,
    baseRef: options.base,
    title: options.title,
    body: options.body,
    labels: options.label,
    linkedIssues: options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
    pendingMergedPrCount: optionalInteger(options.pendingMergedPrs),
    pendingClosedPrCount: optionalInteger(options.pendingClosedPrs),
    approvedPrCount: optionalInteger(options.approvedPrs),
    expectedOpenPrCountAfterMerge: optionalInteger(options.expectedOpenPrs),
    projectedCredibility: optionalNumber(options.projectedCredibility),
    scenarioNotes: options.scenarioNote,
    branchEligibility: branchEligibilityFromOptions(options),
    validation: validationFromOptions(options),
    scorePreviewCommand: options.scorePreviewCommand,
  });
  const payload =
    command === "preflight"
      ? { local: result.local, preflight: result.analysis.preflight, prPacket: result.analysis.prPacket, workspaceIntelligence: result.analysis.workspaceIntelligence }
      : result;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  writeBranchAnalysisCli(result, command);
}

async function decisionPackCli(options) {
  const login = options.login ?? process.env.GITTENSORY_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!login) throw new Error("Pass --login <github-login> or set GITTENSORY_LOGIN.");
  const payload = await getDecisionPackWithCache(login);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${decisionPackToolSummary(login, payload)}\n`);
  if (payload.summary) process.stdout.write(`${payload.summary}\n`);
  if (payload.cache?.rerunGuidance) process.stdout.write(`Rerun when: ${payload.cache.rerunGuidance}\n`);
}

async function repoDecisionCli(options) {
  const login = options.login ?? process.env.GITTENSORY_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!login) throw new Error("Pass --login <github-login> or set GITTENSORY_LOGIN.");
  const repoFullName = options.repo;
  if (!repoFullName || !repoFullName.includes("/")) throw new Error("Pass --repo owner/repo.");
  const [owner, repo] = repoFullName.split("/", 2);
  const payload = await getRepoDecisionWithCache(login, owner, repo);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${repoDecisionToolSummary(login, repoFullName, payload)}\n`);
  const actions = payload.decision?.nextActions ?? payload.decision?.publicNextActions ?? [];
  for (const action of actions.slice(0, 3)) process.stdout.write(`- ${action}\n`);
  if (payload.cache?.rerunGuidance) process.stdout.write(`Rerun when: ${payload.cache.rerunGuidance}\n`);
}

function runCacheCli(args) {
  const subcommand = args[0] ?? "help";
  if (subcommand === "--help" || subcommand === "help") return printCacheHelp();
  const options = parseOptions(args.slice(1));
  if (subcommand === "clear") {
    const payload = clearDecisionPackCache();
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Cleared ${payload.removed} decision-pack cache entr${payload.removed === 1 ? "y" : "ies"}.\n`);
    return;
  }
  if (subcommand === "status") {
    const payload = inspectDecisionPackCache();
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Decision-pack cache: ${payload.entries} entr${payload.entries === 1 ? "y" : "ies"}.\n`);
    return;
  }
  throw new Error(`Unknown cache command: ${subcommand}`);
}

async function runAgentCli(args) {
  const subcommand = args[0] ?? "help";
  if (subcommand === "--help" || subcommand === "help") return printAgentHelp();
  const options = parseOptions(args.slice(1));
  if (subcommand === "plan") {
    const login = options.login ?? process.env.GITTENSORY_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login) throw new Error("Pass --login <github-login> or set GITTENSORY_LOGIN.");
    const payload = await apiPost("/v1/agent/plan-next-work", stripUndefined({ login, repoFullName: options.repo, objective: options.objective, surface: "mcp" }));
    return outputAgentPayload(payload, options, `Gittensory agent plan: ${payload.summary ?? payload.run?.status ?? "ready"}`);
  }
  if (subcommand === "status") {
    const runId = args[1] && !args[1].startsWith("--") ? args[1] : options.runId;
    if (!runId) throw new Error("Usage: gittensory-mcp agent status <run-id>");
    const payload = await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`);
    return outputAgentPayload(payload, options, `Gittensory agent run ${runId}: ${payload.run?.status ?? "unknown"}`);
  }
  if (subcommand === "explain") {
    const runId = args[1] && !args[1].startsWith("--") ? args[1] : options.runId;
    if (!runId) throw new Error("Usage: gittensory-mcp agent explain <run-id>");
    const payload = await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`);
    const topAction = payload.actions?.[0] ?? null;
    return outputAgentPayload({ ...payload, topAction }, options, topAction ? `Top action: ${topAction.recommendation}` : "No top action is available yet.");
  }
  if (subcommand === "packet") {
    const login = options.login ?? process.env.GITTENSORY_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login) throw new Error("Pass --login <github-login> or set GITTENSORY_LOGIN.");
    const payload = await agentPreparePrPacket({
      login,
      cwd: options.cwd,
      repoFullName: options.repo,
      baseRef: options.base,
      title: options.title,
      body: options.body,
      labels: options.label,
      linkedIssues: options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
      pendingMergedPrCount: optionalInteger(options.pendingMergedPrs),
      pendingClosedPrCount: optionalInteger(options.pendingClosedPrs),
      approvedPrCount: optionalInteger(options.approvedPrs),
      expectedOpenPrCountAfterMerge: optionalInteger(options.expectedOpenPrs),
      projectedCredibility: optionalNumber(options.projectedCredibility),
      scenarioNotes: options.scenarioNote,
      branchEligibility: branchEligibilityFromOptions(options),
      validation: validationFromOptions(options),
      scorePreviewCommand: options.scorePreviewCommand,
    });
    return outputAgentPayload(payload, options, "Gittensory public-safe PR packet prepared.");
  }
  throw new Error(`Unknown agent command: ${subcommand}`);
}

function outputAgentPayload(payload, options, summary) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const packetMarkdown = payload?.prPacket?.markdown ?? payload?.actions?.find((action) => action?.actionType === "prepare_pr_packet")?.payload?.prPacket?.markdown;
  if (typeof packetMarkdown === "string" && packetMarkdown.trim()) {
    const safeMarkdown = requirePublicSafePacketMarkdown(packetMarkdown);
    return process.stdout.write(safeMarkdown.endsWith("\n") ? safeMarkdown : `${safeMarkdown}\n`);
  }
  process.stdout.write(`${summary}\n`);
  if (payload.summary && payload.summary !== summary) process.stdout.write(`${payload.summary}\n`);
  if (payload.recommendedRerunCondition) process.stdout.write(`Rerun when: ${payload.recommendedRerunCondition}\n`);
  const actions = payload.actions ?? payload.nextActions ?? [];
  for (const action of actions.slice(0, 3)) {
    const label = action.actionType ?? action.actionKind ?? action.recommendation ?? "action";
    const detail = action.recommendation ?? action.actionKind ?? action.summary ?? label;
    process.stdout.write(`- ${label}: ${detail}\n`);
    if (action.explanationCard) {
      process.stdout.write(`  why now: ${action.explanationCard.whyNow}\n`);
      process.stdout.write(`  impact: ${action.explanationCard.expectedImpact}\n`);
      process.stdout.write(`  rerun: ${action.explanationCard.rerunWhen}\n`);
    } else if (action.rerunWhen) {
      process.stdout.write(`  rerun: ${action.rerunWhen}\n`);
    }
  }
}

function writeBranchAnalysisCli(result, command) {
  const analysis = result.analysis;
  const intelligence = analysis.workspaceIntelligence;
  process.stdout.write(`${analysis.summary}\n`);
  process.stdout.write(`Top action: ${analysis.nextActions?.[0]?.actionKind ?? "none"}\n`);
  if (analysis.nextActions?.[0]?.whyThisHelps?.length) {
    process.stdout.write("Why this helps:\n");
    for (const line of analysis.nextActions[0].whyThisHelps.slice(0, 3)) process.stdout.write(`- ${line}\n`);
  }
  if (intelligence) writeWorkspaceIntelligenceCli(intelligence);
  if (command === "analyze-branch" && analysis.scoreBlockers?.length) {
    process.stdout.write("Score blockers:\n");
    for (const blocker of analysis.scoreBlockers.slice(0, 5)) process.stdout.write(`- ${blocker}\n`);
  }
  process.stdout.write(`Preflight: ${analysis.preflight.status}\n`);
  process.stdout.write(`Source upload: disabled\n`);
  if (result.local?.localScorerStatus?.ok === false) {
    process.stdout.write(`Local scorer: ${result.local.localScorerStatus.code ?? "metadata_only"}\n`);
    for (const line of result.local.setupGuidance ?? setupGuidanceForLocalScorer(result.local.localScorerStatus)) {
      process.stdout.write(`- ${line}\n`);
    }
  }
}

function writeWorkspaceIntelligenceCli(intelligence) {
  process.stdout.write(`Workspace intelligence v${intelligence.version}:\n`);
  const files = intelligence.changedFiles;
  process.stdout.write(`- Changed files: ${files.total} (${files.binary} binary, ${files.deleted} deleted, ${files.renamed} renamed)\n`);
  process.stdout.write(`- Test evidence: ${intelligence.testEvidence.level}\n`);
  if (intelligence.branch.pendingCommitCount > 0) {
    process.stdout.write(`- Pending commits ahead of base: ${intelligence.branch.pendingCommitCount}\n`);
  }
  if (intelligence.baseFreshness.status !== "fresh") {
    process.stdout.write(`- Base freshness: ${intelligence.baseFreshness.status}\n`);
    for (const warning of intelligence.baseFreshness.warnings.slice(0, 2)) process.stdout.write(`  ${warning}\n`);
  }
  if (intelligence.blockers.branchQuality.length) {
    process.stdout.write("- Branch-quality blockers:\n");
    for (const blocker of intelligence.blockers.branchQuality.slice(0, 4)) process.stdout.write(`  - ${blocker}\n`);
  }
  if (intelligence.blockers.accountState.length) {
    process.stdout.write("- Account/queue blockers:\n");
    for (const blocker of intelligence.blockers.accountState.slice(0, 4)) process.stdout.write(`  - ${blocker}\n`);
  }
  if (intelligence.ciStatusHints.length) {
    process.stdout.write("- CI hints:\n");
    for (const hint of intelligence.ciStatusHints.slice(0, 3)) process.stdout.write(`  - ${hint}\n`);
  }
  process.stdout.write(`- Rerun when: ${intelligence.rerunWhen}\n`);
}

function requirePublicSafePacketMarkdown(markdown) {
  const unsafeLine = markdown.split(/\r?\n/).find((line) => isUnsafePublicPacketText(line));
  if (unsafeLine) throw new Error("Refusing to print unsafe public packet markdown from the server.");
  return markdown;
}

function isUnsafePublicPacketText(value) {
  return /\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:[\\/]Users[\\/]/i.test(value);
}

function printVersion(options) {
  const payload = { name: packageName, version: packageVersion, apiVersion: currentApiVersion, node: process.version };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${packageName}/${packageVersion} (api ${currentApiVersion}, node ${process.version})\n`);
}

function completionCommand(args) {
  const shell = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const options = parseOptions(args.filter((arg) => arg.startsWith("--")));
  if (!shell) throw new Error(`Usage: gittensory-mcp completion <${COMPLETION_SHELLS.join("|")}> [--json]`);
  if (!COMPLETION_SHELLS.includes(shell)) throw new Error(`Unsupported shell: ${shell}. Supported shells: ${COMPLETION_SHELLS.join(", ")}.`);
  const script = buildCompletionScript(shell);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ shell, script }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${script}\n`);
}

function buildCompletionScript(shell) {
  const topLevel = [...Object.keys(CLI_COMMAND_SPEC), "help"];
  const withSubcommands = Object.entries(CLI_COMMAND_SPEC).filter(([, subcommands]) => subcommands.length > 0);
  if (shell === "bash") return buildBashCompletion(topLevel, withSubcommands);
  if (shell === "zsh") return buildZshCompletion(topLevel, withSubcommands);
  return buildFishCompletion(topLevel, withSubcommands);
}

function buildBashCompletion(topLevel, withSubcommands) {
  const subcommandCases = withSubcommands
    .map(([command, subcommands]) => `      ${command}) COMPREPLY=( $(compgen -W "${subcommands.join(" ")}" -- "$cur") ); return 0;;`)
    .join("\n");
  return `# gittensory-mcp bash completion. Add to ~/.bashrc:
#   source <(gittensory-mcp completion bash)
_gittensory_mcp() {
  local cur prev cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=\$COMP_CWORD
  local commands="${topLevel.join(" ")}"
  if [ "\$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\$commands --help --version" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${subcommandCases}
      *) COMPREPLY=( $(compgen -W "--json --login --repo --profile --agent-profile --base --cwd" -- "$cur") ); return 0;;
  esac
}
complete -F _gittensory_mcp gittensory-mcp`;
}

function buildZshCompletion(topLevel, withSubcommands) {
  const subcommandCases = withSubcommands
    .map(([command, subcommands]) => `      ${command}) _values 'subcommand' ${subcommands.join(" ")} ;;`)
    .join("\n");
  return `#compdef gittensory-mcp
# gittensory-mcp zsh completion. Add to your fpath, or:
#   source <(gittensory-mcp completion zsh)
_gittensory_mcp() {
  local -a commands
  commands=(${topLevel.join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case $words[2] in
${subcommandCases}
  esac
}
_gittensory_mcp "$@"`;
}

function buildFishCompletion(topLevel, withSubcommands) {
  const topLevelLines = topLevel
    .map((command) => `complete -c gittensory-mcp -n __fish_use_subcommand -a ${command} -d 'gittensory-mcp command'`)
    .join("\n");
  const subcommandLines = withSubcommands
    .map(([command, subcommands]) => `complete -c gittensory-mcp -n '__fish_seen_subcommand_from ${command}' -a '${subcommands.join(" ")}'`)
    .join("\n");
  return `# gittensory-mcp fish completion. Save to:
#   ~/.config/fish/completions/gittensory-mcp.fish
${topLevelLines}
${subcommandLines}`;
}

function printHelp() {
  process.stdout.write(`Usage:
  gittensory-mcp --stdio
  gittensory-mcp version [--json]
  gittensory-mcp completion bash|zsh|fish [--json]
  gittensory-mcp login [--profile name] [--github-token <token>] [--json]
  gittensory-mcp logout [--profile name] [--all] [--json]
  gittensory-mcp whoami [--profile name] [--json]
  gittensory-mcp config [--profile name] [--json]
  gittensory-mcp status [--profile name] [--json]
  gittensory-mcp profile list|create|switch|remove [name] [--json]
  gittensory-mcp changelog [--json]
  gittensory-mcp doctor [--profile name] [--cwd path] [--json]
  gittensory-mcp cache status|clear [--json]
  gittensory-mcp init-client --print codex|claude|cursor|mcp [--agent-profile miner-planner|maintainer-triage|repo-owner-intake] [--json]
  gittensory-mcp decision-pack --login <github-login> [--json]
  gittensory-mcp repo-decision --login <github-login> --repo owner/repo [--json]
  gittensory-mcp analyze-branch --login <github-login> [--repo owner/repo] [--base origin/main] [--branch-eligibility eligible|ineligible|unknown] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--scenario-note "..."] [--validation "passed|npm test|summary"] [--json]
  gittensory-mcp preflight --login <github-login> [--repo owner/repo] [--base origin/main] [--branch-eligibility eligible|ineligible|unknown] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--validation "passed|npm test|summary"] [--json]
  gittensory-mcp agent plan --login <github-login> [--repo owner/repo] [--json]
  gittensory-mcp agent status <run-id> [--json]
  gittensory-mcp agent explain <run-id> [--json]
  gittensory-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--json]

  Environment:
  GITTENSORY_API_URL
  GITTENSORY_PROFILE
  GITTENSORY_CONFIG_PATH or GITTENSORY_CONFIG_DIR
  GITTENSORY_API_TOKEN, GITTENSORY_MCP_TOKEN, GITTENSORY_TOKEN, or a session from gittensory-mcp login
  GITHUB_TOKEN for non-interactive login bootstrap
  GITTENSOR_SCORE_PREVIEW_CMD
  GITTENSOR_ROOT
  GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS
  GITTENSORY_UPLOAD_SOURCE=false
`);
}

function printCacheHelp() {
  process.stdout.write(`Usage:
  gittensory-mcp cache status [--json]
  gittensory-mcp cache clear [--json]

Decision-pack cache entries are local-only stale fallbacks for temporary API/network outages.
Source upload remains disabled.
`);
}

function printAgentHelp() {
  process.stdout.write(`Usage:
  gittensory-mcp agent plan --login <github-login> [--repo owner/repo] [--objective "..."] [--json]
  gittensory-mcp agent status <run-id> [--json]
  gittensory-mcp agent explain <run-id> [--json]
  gittensory-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--validation "passed|command|summary"] [--json]

The agent is copilot-only: it ranks, explains, and drafts public-safe packets. It does not edit code, open PRs, or post comments from the local MCP wrapper.
Source upload remains disabled.
  `);
}

function printProfileHelp() {
  process.stdout.write(`Usage:
  gittensory-mcp profile list [--json]
  gittensory-mcp profile create <name> [--json]
  gittensory-mcp profile switch <name> [--json]
  gittensory-mcp profile remove <name> [--json]

Use --profile <name> or GITTENSORY_PROFILE to run login, logout, whoami, status, doctor, and MCP API calls with a named local session.
`);
}

function parseOptions(args) {
  const options = {};
  const repeatable = new Set(["label", "issue", "validation", "validationCommand", "validationStatus", "validationSummary", "validationDuration", "scenarioNote"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!arg?.startsWith("--")) continue;
    const key = camel(arg.slice(2));
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    if (repeatable.has(key)) options[key] = [...(options[key] ?? []), value];
    else options[key] = value;
  }
  return options;
}

async function login(options) {
  const profileName = selectedProfileName(options);
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  const session = githubToken ? await apiFetch("/v1/auth/github/session", { method: "POST", body: JSON.stringify({ githubToken }) }, { auth: false }) : await loginWithDeviceFlow();
  const nextConfig = upsertProfile(config, profileName, {
    apiUrl,
    session: {
      token: session.token,
      login: session.login,
      expiresAt: session.expiresAt,
      scopes: session.scopes ?? [],
    },
  });
  saveConfig(nextConfig);
  const payload = { status: "authenticated", profile: profileName, login: session.login, apiUrl, expiresAt: session.expiresAt };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`Authenticated profile ${profileName} as ${session.login}. Session expires ${session.expiresAt}.\n`);
}

async function loginWithDeviceFlow() {
  const start = await apiFetch("/v1/auth/github/device/start", { method: "POST", body: "{}" }, { auth: false });
  process.stderr.write(`Open ${start.verificationUri} and enter code ${start.userCode}.\n`);
  const deadline = Date.now() + Number(start.expiresIn ?? 900) * 1000;
  let intervalMs = Math.max(5, Number(start.interval ?? 5)) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await apiFetch("/v1/auth/github/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: start.deviceCode }) }, { auth: false });
    if (result.token) return result;
    if (result.status === "slow_down") intervalMs += 5000;
    if (result.status && result.status !== "authorization_pending" && result.status !== "slow_down") throw new Error(`GitHub OAuth failed: ${result.status}`);
  }
  throw new Error("GitHub OAuth device flow expired.");
}

async function logout(options) {
  const profileName = selectedProfileName(options);
  const all = options.all === true;
  const envToken = getEnvApiToken();
  const tokens = all
    ? [envToken, ...profileSessions(config).map((entry) => entry.session.token)].filter(Boolean)
    : [envToken ?? configuredProfileToken(profileName)].filter(Boolean);
  const remote = [];
  for (const token of [...new Set(tokens)]) {
    try {
      remote.push(await apiFetch("/v1/auth/logout", { method: "POST", body: "{}" }, { token }));
    } catch (error) {
      remote.push({ error: sanitizeDiagnosticText(error instanceof Error ? error.message : "logout_failed") });
    }
  }
  const nextConfig = all ? clearAllProfileSessions(config) : clearProfileSession(config, profileName);
  if (hasPersistedConfigState(nextConfig)) saveConfig(nextConfig);
  else if (existsSync(configPath)) rmSync(configPath, { force: true });
  const decisionPackCache = clearDecisionPackCache();
  const payload = { status: "logged_out", profile: all ? "all" : profileName, apiUrl, remote: remote.length > 0 ? remote : null, decisionPackCache };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(all ? "Logged out all profiles.\n" : `Logged out profile ${profileName}.\n`);
}

function profileCommand(args) {
  const subcommand = args[0] ?? "list";
  const options = parseOptions(args.slice(1));
  if (subcommand === "--help" || subcommand === "help") return printProfileHelp();
  if (subcommand === "list" || subcommand === "ls") {
    const profiles = profileList(config);
    const payload = { activeProfile: activeProfileName, profiles };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`Active profile: ${activeProfileName}\n`);
      for (const profile of profiles) {
        process.stdout.write(`- ${profile.name}${profile.active ? " (active)" : ""}: ${profile.login ?? "not authenticated"}\n`);
      }
    }
    return;
  }

  const rawName = args[1] && !args[1].startsWith("--") ? args[1] : options.name ?? options.profile;
  if (!rawName) throw new Error(`Usage: gittensory-mcp profile ${subcommand} <name>`);
  const profileName = normalizeProfileName(rawName);

  if (subcommand === "create") {
    const nextConfig = ensureProfile(config, profileName, { activate: true });
    saveConfig(nextConfig);
    const payload = { status: "created", activeProfile: profileName, profile: profilePublicState(profileName, nextConfig) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Created and selected profile ${profileName}.\n`);
    return;
  }

  if (subcommand === "switch" || subcommand === "use") {
    if (!config.profiles?.[profileName]) throw new Error(`Profile ${profileName} does not exist. Run \`gittensory-mcp profile create ${profileName}\` or \`gittensory-mcp login --profile ${profileName}\`.`);
    const nextConfig = setActiveProfile(config, profileName);
    saveConfig(nextConfig);
    const payload = { status: "switched", activeProfile: profileName, profile: profilePublicState(profileName, nextConfig) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Selected profile ${profileName}.\n`);
    return;
  }

  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const nextConfig = removeProfile(config, profileName);
    if (hasPersistedConfigState(nextConfig)) saveConfig(nextConfig);
    else if (existsSync(configPath)) rmSync(configPath, { force: true });
    const payload = { status: "removed", removedProfile: profileName, activeProfile: nextConfig.activeProfile ?? defaultProfileName };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Removed profile ${profileName}.\n`);
    return;
  }

  throw new Error(`Unknown profile command: ${subcommand}`);
}

async function whoami(options) {
  const payload = { ...(await apiGet("/v1/auth/session")), profile: activeProfileName };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(activeProfileName === defaultProfileName ? `${payload.login}\n` : `${payload.login} (profile ${activeProfileName})\n`);
}

async function status(options) {
  let auth = { status: getApiToken() ? "token_configured" : "unauthenticated" };
  let health = null;
  if (getApiToken()) {
    try {
      auth = await apiGet("/v1/auth/session");
    } catch (error) {
      auth = { status: "token_configured", session: "unverified", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "status_failed") };
    }
  }
  try {
    health = await apiFetch("/health", { method: "GET" }, { auth: false, timeoutMs: 5000 });
  } catch (error) {
    health = { status: "unreachable", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "health_check_failed") };
  }
  const compatibility = await inspectApiCompatibility(health);
  const pkg = await inspectInstallVersion(compatibilityLatestRecommendedVersion(compatibility.report) ?? compatibilityLatestRecommendedVersion(health));
  const apiCompatibility = compatibility.evaluation;
  const decisionPackCache = inspectDecisionPackCache();
  const payload = {
    apiUrl,
    package: pkg,
    apiCompatibility,
    compatibility: compatibility.report,
    api: health,
    auth,
    profile: profilePublicState(activeProfileName),
    config: { configured: existsSync(configPath), activeProfile: activeProfileName, profileCount: profileList(config).length },
    decisionPackCache,
    sourceUploadDefault: false,
    sourceUploadSupported: false,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`${packageName}: ${packageVersion}${pkg.latestVersion ? ` (latest ${pkg.latestVersion})` : ""}\n`);
    process.stdout.write(`API: ${apiUrl}\n`);
    process.stdout.write(`Profile: ${activeProfileName}\n`);
    process.stdout.write(`API health: ${health?.status ?? "unknown"}\n`);
    process.stdout.write(`Auth: ${auth.status}${auth.login ? ` (${auth.login})` : ""}\n`);
    process.stdout.write(`Decision-pack cache: ${decisionPackCache.entries} entr${decisionPackCache.entries === 1 ? "y" : "ies"}\n`);
    process.stdout.write("Source upload: disabled\n");
    if (pkg.state === "stale") {
      process.stdout.write(`Update available: ${packageVersion} -> ${pkg.latestVersion}. Upgrade with:\n  ${pkg.upgradeCommand}\n`);
      process.stdout.write(`Or run without installing:\n  ${pkg.npxFallback}\n`);
    } else if (pkg.state === "unavailable") {
      process.stdout.write("Version check: npm registry was unavailable; skipping update check.\n");
    }
    if (apiCompatibility.status === "incompatible") {
      process.stdout.write(`API requires at least ${packageName}@${apiCompatibility.minVersion}. Upgrade with:\n  ${apiCompatibility.upgradeCommand}\n`);
    } else if (apiCompatibility.status === "compatible") {
      process.stdout.write(`API compatibility: compatible (minimum ${packageName}@${apiCompatibility.minVersion}).\n`);
    } else if (apiCompatibility.status === "unavailable") {
      process.stdout.write(`API compatibility: unavailable (${apiCompatibility.reason ?? "unknown"}).\n`);
    }
  }
}

async function changelog(options) {
  const text = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n\nNo packaged changelog was found.\n";
  const payload = {
    package: {
      name: packageName,
      version: packageVersion,
    },
    changelog: text,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function doctor(options) {
  const checks = [];
  const add = (name, statusValue, detail, remediation) =>
    checks.push(
      stripUndefined({
        name,
        status: statusValue,
        detail: sanitizeDiagnosticText(detail, [options.cwd]),
        remediation: sanitizeDiagnosticText(remediation, [options.cwd]),
      }),
    );
  let authLogin = options.login ?? activeProfile.session?.login;
  let repoFullName = typeof options.repo === "string" ? options.repo : undefined;

  let health = null;
  try {
    health = await apiFetch("/health", { method: "GET" }, { auth: false });
    add("api_health", health.status === "ok" ? "pass" : "warn", `API responded from ${apiUrl}.`);
  } catch (error) {
    health = { status: "unreachable" };
    add("api_health", "fail", error instanceof Error ? error.message : "health_check_failed", "Check GITTENSORY_API_URL or network access.");
  }

  const compatibility = await inspectApiCompatibility(health);
  const pkg = await inspectInstallVersion(compatibilityLatestRecommendedVersion(compatibility.report) ?? compatibilityLatestRecommendedVersion(health));
  if (pkg.state === "stale") {
    add("version", "warn", `Installed ${packageVersion} is behind npm latest ${pkg.latestVersion}.`, `${pkg.upgradeCommand} (no-install fallback: ${pkg.npxFallback})`);
  } else if (pkg.state === "unavailable") {
    add("version", "warn", "Could not reach the npm registry to check for updates.", `Retry when online, or run the no-install fallback: ${npxFallbackCommand}`);
  } else if (pkg.state === "unknown") {
    add("version", "warn", `Could not compare local ${packageVersion} against npm latest ${pkg.latestVersion ?? "unknown"}.`);
  } else if (pkg.state === "ahead") {
    add("version", "pass", `Installed ${packageVersion} is ahead of npm latest ${pkg.latestVersion}.`);
  } else if (pkg.state === "skipped") {
    add("version", "pass", "npm version check was skipped (GITTENSORY_SKIP_NPM_VERSION_CHECK).");
  } else {
    add("version", "pass", `Installed ${packageVersion} matches npm latest ${pkg.latestVersion}.`);
  }

  const apiCompatibility = compatibility.evaluation;
  if (apiCompatibility.status === "incompatible") {
    add("api_compatibility", "fail", `API requires at least ${packageName}@${apiCompatibility.minVersion}; local is ${packageVersion}.`, apiCompatibility.upgradeCommand);
  } else if (apiCompatibility.status === "compatible") {
    add("api_compatibility", "pass", `Local ${packageVersion} meets the API minimum ${apiCompatibility.minVersion}.`);
  } else if (apiCompatibility.reason === "api_unreachable") {
    add("api_compatibility", "warn", "API compatibility check was unavailable because API health was unreachable.");
  } else if (apiCompatibility.reason === "compatibility_endpoint_unavailable") {
    add("api_compatibility", "warn", "API compatibility endpoint was unavailable; compatibility could not be confirmed.");
  } else if (apiCompatibility.status === "unknown") {
    add("api_compatibility", "warn", `API reported an unsupported minimum client version (${apiCompatibility.minVersion}).`);
  } else {
    add("api_compatibility", "pass", "API did not report a minimum client version; compatibility check skipped.");
  }

  const token = getApiToken();
  if (!token) {
    add("auth", "fail", `No Gittensory API/session token is configured for profile ${activeProfileName}.`, `Run \`gittensory-mcp login --profile ${activeProfileName}\`.`);
  } else {
    try {
      const session = await apiGet("/v1/auth/session");
      authLogin = session.login ?? authLogin;
      add("auth", "pass", `Profile ${activeProfileName} authenticated as ${session.login}; session expires ${session.expiresAt}.`);
    } catch (error) {
      add("auth", "warn", `A token is configured for profile ${activeProfileName} but no user session was verified: ${error instanceof Error ? error.message : "session_check_failed"}.`, "If this is a static beta token, this can be expected. Otherwise run `gittensory-mcp login`.");
    }
  }

  if (/^(1|true|yes)$/i.test(process.env.GITTENSORY_UPLOAD_SOURCE ?? "false")) {
    add("source_upload", "fail", "GITTENSORY_UPLOAD_SOURCE is enabled.", "Unset GITTENSORY_UPLOAD_SOURCE. Source upload is unsupported in v1.");
  } else {
    add("source_upload", "pass", "Source upload is disabled and unsupported in v1.");
  }

  const decisionPackCache = inspectDecisionPackCache();
  add(
    "decision_pack_cache",
    "pass",
    `Local stale fallback cache has ${decisionPackCache.entries} entr${decisionPackCache.entries === 1 ? "y" : "ies"} and is bounded at ${decisionPackCache.maxEntries}.`,
    "Run `gittensory-mcp cache clear` to remove local stale fallback data.",
  );

  try {
    const metadata = collectLocalBranchMetadata({
      cwd: options.cwd ?? process.cwd(),
      baseRef: options.base,
      repoFullName: options.repo,
      login: options.login ?? activeProfile.session?.login ?? "local",
    });
    repoFullName = metadata.repoFullName ?? repoFullName;
    add("git_metadata", "pass", `${metadata.repoFullName} on ${metadata.branchName}; ${metadata.changedFiles.length} changed file(s).`);
  } catch (error) {
    add("git_metadata", "warn", error instanceof Error ? error.message : "git_metadata_failed", "Run from a git repo or pass --repo owner/repo.");
  }

  const commandPath = findExecutable("gittensory-mcp");
  if (commandPath) add("client_path", "pass", "gittensory-mcp is visible on PATH.");
  else add("client_path", "warn", "gittensory-mcp was not found on PATH.", "Use an absolute command path in your MCP client config.");

  const scorerCommand = resolveScorePreviewCommand();
  if (!scorerCommand) {
    add(
      "local_scorer",
      "warn",
      "GITTENSOR_SCORE_PREVIEW_CMD is not configured; branch analysis will fall back to metadata-only scoring.",
      `Example: export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("metadata")}"`,
    );
  } else {
    const probe = probeLocalScorer(scorerCommand);
    if (probe.ok) {
      add("local_scorer", "pass", `Configured scorer responded in ${probe.durationMs ?? 0}ms.`);
    } else {
      const remediation = setupGuidanceForLocalScorer(probe).slice(1).join(" ");
      add("local_scorer", "warn", `Configured scorer failed (${probe.code ?? "scorer_failed"}): ${probe.reason}`, remediation || "Run gittensory-mcp doctor --json for structured diagnostics.");
    }
  }

  if (process.env.GITTENSOR_ROOT) {
    add("gittensor_root", "pass", "GITTENSOR_ROOT is configured.");
  } else if (scorerCommand?.includes("gittensor-score-preview.py")) {
    add("gittensor_root", "warn", "Python gittensor scorer is configured but GITTENSOR_ROOT is unset.", "Set GITTENSOR_ROOT to a local entrius/gittensor checkout.");
  }

  const statusValue = doctorStatus(checks);
  const checklist = buildDoctorChecklist(checks, {
    status: statusValue,
    profileName: activeProfileName,
    login: authLogin,
    repoFullName,
  });
  const nextCommand = checklist.find((group) => group.id === "next_command")?.nextCommand;
  const payload = {
    status: statusValue,
    apiUrl,
    profile: profilePublicState(activeProfileName),
    config: { configured: existsSync(configPath), activeProfile: activeProfileName, profileCount: profileList(config).length },
    decisionPackCache,
    sourceUploadSupported: false,
    checklist,
    nextCommand,
    checks,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`Gittensory doctor: ${payload.status}\n`);
    process.stdout.write(`Profile: ${activeProfileName}\n`);
    for (const group of checklist) {
      process.stdout.write(`\n${group.title}: ${group.status}\n`);
      if (group.id === "next_command") {
        process.stdout.write(`- ${group.detail}\n`);
        if (group.nextCommand?.command) process.stdout.write(`  ${group.nextCommand.command}\n`);
        continue;
      }
      for (const check of group.checks ?? []) {
        process.stdout.write(`- ${check.status}: ${check.name} - ${check.detail}\n`);
        if (check.remediation) process.stdout.write(`  ${check.remediation}\n`);
      }
    }
  }
}

function doctorStatus(checks) {
  if (checks.some((check) => check.status === "fail")) return "needs_attention";
  if (checks.some((check) => check.status === "warn")) return "warnings";
  return "ok";
}

function buildDoctorChecklist(checks, context) {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const groups = doctorChecklistGroups().map((group) => {
    const groupChecks = group.checks.map((name) => byName.get(name)).filter(Boolean);
    return stripUndefined({
      id: group.id,
      title: group.title,
      status: checklistStatus(groupChecks),
      checks: groupChecks,
    });
  });
  const nextCommand = doctorNextCommand(byName, context);
  return [
    ...groups,
    stripUndefined({
      id: "next_command",
      title: "Next command",
      status: context.status === "needs_attention" ? "fail" : context.status === "warnings" ? "warn" : "pass",
      detail: nextCommand.reason,
      nextCommand,
    }),
  ];
}

function doctorChecklistGroups() {
  return [
    { id: "auth", title: "Auth", checks: ["auth"] },
    { id: "api_compatibility", title: "API compatibility", checks: ["api_health", "version", "api_compatibility"] },
    { id: "local_repo_readiness", title: "Local repo readiness", checks: ["git_metadata", "client_path"] },
    { id: "scorer_availability", title: "Scorer availability", checks: ["local_scorer", "gittensor_root"] },
    { id: "output_safety", title: "Output safety", checks: ["source_upload", "decision_pack_cache"] },
  ];
}

function checklistStatus(checks) {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function doctorNextCommand(byName, context) {
  const sourceUpload = byName.get("source_upload");
  if (sourceUpload?.status === "fail") {
    return {
      command: "unset GITTENSORY_UPLOAD_SOURCE",
      reason: "Disable source upload first; the local MCP wrapper only sends metadata.",
    };
  }
  const apiCompatibility = byName.get("api_compatibility");
  if (apiCompatibility?.status === "fail") {
    return {
      command: apiCompatibility.remediation ?? upgradeCommand,
      reason: "Upgrade the MCP package before relying on API-backed commands.",
    };
  }
  const auth = byName.get("auth");
  if (auth?.status === "fail") {
    return {
      command: `gittensory-mcp login --profile ${shellArg(context.profileName ?? "default")}`,
      reason: "Authenticate the active profile so doctor, plan, preflight, and packet commands can call the API.",
    };
  }
  const apiHealth = byName.get("api_health");
  if (apiHealth?.status === "fail") {
    return {
      command: "gittensory-mcp status --json",
      reason: "Check API reachability before running planner or preflight commands.",
    };
  }
  const version = byName.get("version");
  if (version?.status === "warn" && version.remediation?.includes("npm install")) {
    return {
      command: upgradeCommand,
      reason: "Update the MCP package so local behavior matches the current API.",
    };
  }
  const gitMetadata = byName.get("git_metadata");
  if (gitMetadata?.status === "warn") {
    return {
      command: "gittensory-mcp doctor --repo owner/repo --json",
      reason: "Run doctor from a git checkout or pass the repository explicitly.",
    };
  }
  const localScorer = byName.get("local_scorer");
  if (localScorer?.status === "warn" && localScorer.remediation) {
    const scorerSetupCommand = localScorer.remediation.startsWith("Example: ") ? localScorer.remediation.replace(/^Example:\s*/, "") : "gittensory-mcp doctor --json";
    return {
      command: scorerSetupCommand,
      reason: "Configure the optional local scorer for richer private branch analysis.",
    };
  }
  return {
    command: `gittensory-mcp preflight --login ${shellArg(context.login ?? "<github-login>")} --repo ${shellArg(context.repoFullName ?? "owner/repo")} --json`,
    reason: "Run branch preflight next; source upload remains disabled.",
  };
}

function shellArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function initClient(options) {
  const client = String(options.print ?? options.client ?? "").toLowerCase();
  if (!client) throw new Error("Pass --print codex, --print claude, --print cursor, or --print mcp.");
  const command = options.command ?? "gittensory-mcp";
  const snippet = clientSnippet(client, command);
  const agentProfile = resolveAgentProfile(options.agentProfile);
  const payload = {
    client,
    command,
    args: ["--stdio"],
    snippet,
    agentProfile,
    notes: [
      "Run `gittensory-mcp login` before starting the MCP client.",
      "Use an absolute command path if the client does not inherit your shell PATH.",
      "This command prints config only; it does not edit client files.",
      ...(agentProfile ? [`Use the ${agentProfile.title} profile instructions as the agent system/developer prompt; keep all GitHub writes human-approved.`] : []),
    ],
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(agentProfile ? `${snippet}\n\n${formatAgentProfile(agentProfile)}\n` : `${snippet}\n`);
}

function resolveAgentProfile(profileId) {
  if (!profileId) return null;
  const id = String(profileId).trim().toLowerCase();
  if (!Object.hasOwn(AGENT_PROFILES, id)) throw new Error(`Unsupported agent profile: ${profileId}. Use ${AGENT_PROFILE_IDS.join(", ")}.`);
  return AGENT_PROFILES[id];
}

function formatAgentProfile(profile) {
  return [
    `# Gittensory agent profile: ${profile.title}`,
    `Audience: ${profile.audience}`,
    `Purpose: ${profile.purpose}`,
    "",
    "Recommended MCP prompts:",
    ...profile.recommendedPrompts.map((name) => `- ${name}`),
    "",
    "Recommended MCP tools:",
    ...profile.recommendedTools.map((name) => `- ${name}`),
    "",
    "Safety boundaries:",
    ...profile.boundaries.map((boundary) => `- ${boundary}`),
    "",
    `When not to use: ${profile.whenNotToUse}`,
  ].join("\n");
}

function getApiToken() {
  return getEnvApiToken() ?? configuredProfileToken(activeProfileName);
}

function getEnvApiToken() {
  return process.env.GITTENSORY_API_TOKEN ?? process.env.GITTENSORY_TOKEN ?? process.env.GITTENSORY_MCP_TOKEN;
}

function selectedProfileName(options = {}) {
  return normalizeProfileName(options.profile ?? activeProfileName);
}

function configuredProfileToken(profileName, currentConfig = config) {
  return currentConfig.profiles?.[profileName]?.session?.token;
}

function profileSessions(currentConfig = config) {
  return Object.entries(currentConfig.profiles ?? {})
    .flatMap(([name, profile]) => (profile?.session?.token ? [{ name, session: profile.session }] : []));
}

function profilePublicState(profileName, currentConfig = config) {
  const profile = currentConfig.profiles?.[profileName];
  const hasEnvToken = Boolean(getEnvApiToken());
  return {
    name: profileName,
    active: profileName === (currentConfig.activeProfile ?? defaultProfileName),
    configured: Boolean(profile),
    authenticated: Boolean(profile?.session?.token),
    login: profile?.session?.login ?? null,
    expiresAt: profile?.session?.expiresAt ?? null,
    tokenSource: hasEnvToken ? "environment" : profile?.session?.token ? "profile" : "none",
    apiUrl: profile?.apiUrl ?? currentConfig.apiUrl ?? null,
  };
}

function profileList(currentConfig = config) {
  const names = new Set([defaultProfileName, currentConfig.activeProfile ?? defaultProfileName, ...Object.keys(currentConfig.profiles ?? {})]);
  return [...names].sort((left, right) => (left === currentConfig.activeProfile ? -1 : right === currentConfig.activeProfile ? 1 : left.localeCompare(right))).map((name) => profilePublicState(name, currentConfig));
}

function selectProfileName(currentConfig, requestedName) {
  const requested = requestedName ? normalizeProfileName(requestedName) : undefined;
  if (requested) return requested;
  const configured = currentConfig?.activeProfile ? normalizeProfileName(currentConfig.activeProfile) : defaultProfileName;
  if (currentConfig?.profiles?.[configured]) return configured;
  return currentConfig?.profiles?.[defaultProfileName] || configured === defaultProfileName ? defaultProfileName : configured;
}

function resolvedApiUrlSource() {
  if (process.env.GITTENSORY_API_URL) return "environment";
  const profileApiUrl = typeof activeProfile.apiUrl === "string" ? activeProfile.apiUrl.replace(/\/+$/, "") : undefined;
  if (profileApiUrl && !legacyDefaultApiUrls.has(profileApiUrl)) return "profile";
  const globalApiUrl = typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : undefined;
  if (globalApiUrl && !legacyDefaultApiUrls.has(globalApiUrl)) return "config";
  return "default";
}

function resolvedConfigPathSource() {
  if (process.env.GITTENSORY_CONFIG_PATH) return "GITTENSORY_CONFIG_PATH";
  if (process.env.GITTENSORY_CONFIG_DIR) return "GITTENSORY_CONFIG_DIR";
  if (process.env.XDG_CONFIG_HOME) return "XDG_CONFIG_HOME";
  return "default";
}

function resolvedTokenSource() {
  if (getEnvApiToken()) return "environment";
  if (configuredProfileToken(activeProfileName)) return "profile";
  return "none";
}

function sourceUploadState() {
  const enabled = /^(1|true|yes)$/i.test(process.env.GITTENSORY_UPLOAD_SOURCE ?? "false");
  return {
    default: false,
    enabled,
    source: enabled ? "GITTENSORY_UPLOAD_SOURCE" : "default",
    supported: false,
  };
}

// Report the resolved effective configuration and where each value came from, without leaking
// local absolute paths or token values. Distinct from `status` (health/version), `doctor`
// (diagnostic checks), and `whoami` (session identity): this answers "what config is in effect
// and which source supplied it?".
function configCommand(options) {
  const payload = {
    apiUrl,
    apiUrlSource: resolvedApiUrlSource(),
    activeProfile: activeProfileName,
    profileCount: profileList(config).length,
    configured: existsSync(configPath),
    configPathSource: resolvedConfigPathSource(),
    cacheDirSource: process.env.GITTENSORY_CACHE_DIR ? "GITTENSORY_CACHE_DIR" : "default",
    tokenConfigured: Boolean(getApiToken()),
    tokenSource: resolvedTokenSource(),
    sourceUpload: sourceUploadState(),
    profile: profilePublicState(activeProfileName),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`API URL: ${payload.apiUrl} (${payload.apiUrlSource})\n`);
  process.stdout.write(`Active profile: ${payload.activeProfile} (${payload.profileCount} configured)\n`);
  process.stdout.write(`Config file: ${payload.configured ? "present" : "absent"} (location: ${payload.configPathSource})\n`);
  process.stdout.write(`Cache dir: ${payload.cacheDirSource}\n`);
  process.stdout.write(`Token: ${payload.tokenConfigured ? `configured (${payload.tokenSource})` : "not configured"}\n`);
  process.stdout.write(
    payload.sourceUpload.enabled
      ? `Source upload: enabled via ${payload.sourceUpload.source} (unsupported; unset GITTENSORY_UPLOAD_SOURCE)\n`
      : "Source upload: disabled (unsupported)\n",
  );
}

function normalizeProfileName(value) {
  const name = String(value ?? defaultProfileName).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("Profile names must be 1-64 characters and use letters, numbers, dots, dashes, or underscores.");
  return name;
}

function cliOptionValue(args, optionName) {
  const dashed = `--${optionName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === dashed) {
      const next = args[index + 1];
      return next && !next.startsWith("--") ? next : undefined;
    }
    if (value?.startsWith(`${dashed}=`)) return value.slice(dashed.length + 1);
  }
  return undefined;
}

function upsertProfile(currentConfig, profileName, patch) {
  const now = new Date().toISOString();
  const existing = currentConfig.profiles?.[profileName] ?? {};
  const profiles = {
    ...(currentConfig.profiles ?? {}),
    [profileName]: stripUndefined({
      ...existing,
      apiUrl: patch.apiUrl ?? existing.apiUrl,
      session: patch.session ?? existing.session,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    }),
  };
  return normalizeConfig({ ...currentConfig, apiUrl: patch.apiUrl ?? currentConfig.apiUrl, activeProfile: profileName, profiles });
}

function ensureProfile(currentConfig, profileName, options = {}) {
  const existing = currentConfig.profiles?.[profileName];
  const nextConfig = existing ? currentConfig : upsertProfile(currentConfig, profileName, {});
  return options.activate ? setActiveProfile(nextConfig, profileName) : nextConfig;
}

function setActiveProfile(currentConfig, profileName) {
  return normalizeConfig({ ...currentConfig, activeProfile: profileName });
}

function clearProfileSession(currentConfig, profileName) {
  const existing = currentConfig.profiles?.[profileName];
  if (!existing) return currentConfig;
  const profiles = {
    ...(currentConfig.profiles ?? {}),
    [profileName]: stripUndefined({ ...existing, session: undefined, updatedAt: new Date().toISOString() }),
  };
  return normalizeConfig({ ...currentConfig, profiles });
}

function clearAllProfileSessions(currentConfig) {
  const profiles = Object.fromEntries(
    Object.entries(currentConfig.profiles ?? {}).map(([name, profile]) => [name, stripUndefined({ ...profile, session: undefined, updatedAt: new Date().toISOString() })]),
  );
  return normalizeConfig({ ...currentConfig, profiles });
}

function removeProfile(currentConfig, profileName) {
  const profiles = { ...(currentConfig.profiles ?? {}) };
  delete profiles[profileName];
  const remaining = Object.keys(profiles);
  const activeProfile = currentConfig.activeProfile === profileName ? (profiles[defaultProfileName] ? defaultProfileName : remaining[0] ?? defaultProfileName) : currentConfig.activeProfile;
  const session = profileName === defaultProfileName ? undefined : currentConfig.session;
  return normalizeConfig({ ...currentConfig, activeProfile, profiles, session });
}

function hasPersistedConfigState(currentConfig) {
  return Boolean(currentConfig.apiUrl || Object.keys(currentConfig.profiles ?? {}).length > 0);
}

function validationFromOptions(options) {
  const direct = (options.validation ?? []).map(parseValidationEntry);
  const commands = options.validationCommand ?? [];
  const statuses = options.validationStatus ?? [];
  const summaries = options.validationSummary ?? [];
  const durations = options.validationDuration ?? [];
  const expanded = commands.map((command, index) =>
    validationEntry({
      command,
      statusText: statuses[index],
      summaryText: summaries[index],
      durationText: durations[index],
    }),
  );
  return [...direct, ...expanded].filter((entry) => typeof entry.command === "string" && entry.command.length > 0);
}

function parseValidationEntry(entry) {
  const parts = String(entry ?? "").split("|").map((part) => part.trim());
  const explicitStatus = normalizeValidationStatus(parts[0]);
  const command = explicitStatus ? parts[1] : parts[0];
  const rest = explicitStatus ? parts.slice(2) : parts.slice(1);
  const inferredStatusText = !explicitStatus && isValidationStatusLike(rest[0]) ? rest[0] : undefined;
  const detailParts = inferredStatusText ? rest.slice(1) : rest;
  const durationMs = parseDurationMs(detailParts[0]);
  const summaryParts = durationMs !== undefined ? detailParts.slice(1) : detailParts;
  return validationEntry({
    command,
    statusText: explicitStatus ?? inferredStatusText,
    summaryText: summaryParts.join("|"),
    durationMs,
  });
}

function validationEntry({ command, statusText, summaryText, durationText, durationMs }) {
  const statusSource = nonEmptyString(statusText);
  const summarySource = statusSource ? undefined : nonEmptyString(summaryText);
  const exitCode =
    inferValidationExitCode(statusSource, { allowBareCode: true, allowGenericStatus: true }) ??
    inferValidationExitCode(summarySource, { allowBareCode: false, allowGenericStatus: false });
  const status =
    normalizeValidationStatus(statusSource) ??
    normalizeSummaryValidationStatus(summarySource) ??
    (exitCode !== undefined ? (exitCode === 0 ? "passed" : "failed") : "not_run");
  return stripUndefined({
    command: sanitizeValidationText(command, 160),
    status,
    summary: sanitizeValidationText(summaryText),
    durationMs: durationMs ?? parseDurationMs(durationText),
    exitCode,
  });
}

function optionalInteger(value) {
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalNumber(value) {
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidationStatus(value) {
  return Boolean(normalizeValidationStatus(value));
}

function normalizeValidationStatus(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["passed", "pass", "success", "ok", "exit_0", "0"].includes(text)) return "passed";
  if (["failed", "fail", "failure", "error", "nonzero", "non_zero"].includes(text) || /^exit_[1-9]\d*$/.test(text) || /^[1-9]\d*$/.test(text)) return "failed";
  if (["not_run", "notrun", "not_ran", "pending"].includes(text)) return "not_run";
  if (["skipped", "skip"].includes(text)) return "skipped";
  if (["focused", "focus"].includes(text)) return "focused";
  if (["unknown", "unclear"].includes(text)) return "unknown";
  return undefined;
}

function isValidationStatusLike(value) {
  return Boolean(
    normalizeValidationStatus(value) ??
      inferValidationExitCode(value, { allowBareCode: true, allowGenericStatus: true }),
  );
}

function inferValidationExitCode(value, options = {}) {
  const text = String(value ?? "").trim().toLowerCase();
  const allowBareCode = options.allowBareCode === true;
  const allowGenericStatus = options.allowGenericStatus === true;
  if (allowBareCode && /^\d{1,3}$/.test(text)) return Number(text);
  const processExitPattern = /\b(?:exit(?:ed)?(?:\s+(?:code|status))?|exitcode|process\s+(?:exit(?:ed)?|status|code)|command\s+(?:exit(?:ed)?|status|code)|shell\s+(?:exit(?:ed)?|status|code))[\s:_-]*(\d{1,3})\b/;
  const genericStatusPattern = /^(?:status|code)[\s:_-]*(\d{1,3})\b/;
  const match = text.match(processExitPattern) ?? (allowGenericStatus ? text.match(genericStatusPattern) : null);
  if (match) return Number(match[1]);
  if (!allowBareCode && /^\d{1,3}$/.test(text)) return undefined;
  const status = normalizeValidationStatus(text);
  if (status === "passed" || status === "focused") return 0;
  if (status === "failed") return 1;
  return undefined;
}

function normalizeSummaryValidationStatus(value) {
  const text = nonEmptyString(value);
  if (!text || /^\d{1,3}$/.test(text)) return undefined;
  return normalizeValidationStatus(text);
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function parseDurationMs(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "ms";
  const multiplier = unit.startsWith("m") && unit !== "ms" ? 60000 : unit.startsWith("s") ? 1000 : 1;
  return Math.round(amount * multiplier);
}

function sanitizeValidationText(value, maxLength = 240) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return undefined;
  const redacted = redactPrivateValidationMetrics(redactLocalValidationPaths(text));
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}

function redactLocalValidationPaths(text) {
  const pathSegment = "[^\\\\/\\s\"'`,;)]+(?:\\s+[^\\\\/\\s\"'`,;)]+)*(?=[\\\\/])";
  const pathTail = "[^\\\\/\\s\"'`,;)]+";
  const localPathPattern = new RegExp(`(^|[\\s"'\\\`=])((?:~[\\\\/]|[A-Za-z]:[\\\\/]|/)(?:${pathSegment}[\\\\/])*${pathTail})`, "g");
  return text.replace(localPathPattern, (_, prefix) => `${prefix}<local-path>`);
}

function redactPrivateValidationMetrics(text) {
  return text.replace(
    /\b(?:wallet|hotkey|coldkey|mnemonic|raw[-_\s]?trust|private[-_\s]?reviewability|trust[-_\s]?score)\b(?:\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'`,;)]+))?/gi,
    "[redacted]",
  );
}

function clientSnippet(client, command) {
  if (client === "codex") return `[mcp_servers.gittensory]\ncommand = ${JSON.stringify(command)}\nargs = ["--stdio"]`;
  if (client === "claude" || client === "cursor" || client === "mcp") {
    return JSON.stringify(
      {
        mcpServers: {
          gittensory: {
            command,
            args: ["--stdio"],
          },
        },
      },
      null,
      2,
    );
  }
  throw new Error(`Unsupported client: ${client}. Use codex, claude, cursor, or mcp.`);
}

async function getDecisionPackWithCache(login) {
  try {
    const payload = await apiGet(`/v1/contributors/${encodeURIComponent(login)}/decision-pack`);
    if (isCacheableDecisionPack(payload, login)) writeDecisionPackCache(login, payload);
    return payload;
  } catch (error) {
    if (!isDecisionPackCacheFallbackEligible(error)) throw error;
    const cached = readDecisionPackCache(login);
    if (!cached) throw error;
    return staleDecisionPackFromCache(cached, error);
  }
}

async function getRepoDecisionWithCache(login, owner, repo) {
  const repoFullName = `${owner}/${repo}`;
  try {
    return await apiGet(`/v1/contributors/${encodeURIComponent(login)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/decision`);
  } catch (error) {
    if (!isDecisionPackCacheFallbackEligible(error)) throw error;
    const cached = readDecisionPackCache(login);
    if (!cached) throw error;
    return repoDecisionFromCachedPack(cached, repoFullName, error);
  }
}

function decisionPackToolSummary(login, payload) {
  if (payload?.source === "local_cache") return `Gittensory decision pack for ${login} (stale local cache).`;
  if (payload?.freshness === "stale" || payload?.freshness === "rebuilding") return `Gittensory decision pack for ${login} (${payload.freshness}).`;
  return `Gittensory decision pack for ${login}.`;
}

function repoDecisionToolSummary(login, repoFullName, payload) {
  if (payload?.source === "local_cache") return `Gittensory repo decision for ${login} in ${repoFullName} (stale local cache).`;
  return `Gittensory repo decision for ${login} in ${repoFullName}.`;
}

function isCacheableDecisionPack(payload, login) {
  return payload?.status === "ready" && typeof payload.login === "string" && payload.login.toLowerCase() === login.toLowerCase();
}

function decisionPackAuthCacheKey() {
  const token = getApiToken();
  if (!token) return null;
  return createHash("sha256").update(token).digest("base64url");
}

function decisionPackCachePath(login, authCacheKey = decisionPackAuthCacheKey()) {
  if (!authCacheKey) return null;
  const key = Buffer.from(`${apiUrl}\0${currentApiVersion}\0${login.toLowerCase()}\0${authCacheKey}`).toString("base64url");
  return join(decisionPackCacheDir, `${key}.json`);
}

function writeDecisionPackCache(login, payload) {
  const authCacheKey = decisionPackAuthCacheKey();
  if (!authCacheKey) return { status: "skipped", reason: "missing_auth" };
  const cachedAt = new Date().toISOString();
  const sanitizedPayload = sanitizeDecisionPackForCache(payload);
  const entry = {
    schemaVersion: decisionPackCacheSchemaVersion,
    apiVersion: typeof payload.apiVersion === "string" ? payload.apiVersion : currentApiVersion,
    packageVersion,
    apiUrl,
    authCacheKey,
    login: login.toLowerCase(),
    cachedAt,
    payload: sanitizedPayload,
  };
  if (entry.apiVersion !== currentApiVersion) return { status: "skipped", reason: "api_version_mismatch" };
  const serialized = `${JSON.stringify(entry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > decisionPackCacheMaxBytes) return { status: "skipped", reason: "too_large" };
  mkdirSync(decisionPackCacheDir, { recursive: true, mode: 0o700 });
  const path = decisionPackCachePath(login, authCacheKey);
  if (!path) return { status: "skipped", reason: "missing_auth" };
  writeFileSync(path, serialized, { mode: 0o600 });
  pruneDecisionPackCache();
  return { status: "stored", cachedAt };
}

function readDecisionPackCache(login) {
  const authCacheKey = decisionPackAuthCacheKey();
  const path = decisionPackCachePath(login, authCacheKey);
  if (!path || !existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (!isCompatibleDecisionPackCacheEntry(entry, login, authCacheKey)) return null;
    return entry;
  } catch {
    return null;
  }
}

function isCompatibleDecisionPackCacheEntry(entry, login, authCacheKey = decisionPackAuthCacheKey()) {
  return (
    entry &&
    typeof entry === "object" &&
    entry.schemaVersion === decisionPackCacheSchemaVersion &&
    entry.apiVersion === currentApiVersion &&
    entry.apiUrl === apiUrl &&
    typeof entry.authCacheKey === "string" &&
    entry.authCacheKey === authCacheKey &&
    typeof entry.cachedAt === "string" &&
    typeof entry.login === "string" &&
    entry.login.toLowerCase() === login.toLowerCase() &&
    isCacheableDecisionPack(entry.payload, login)
  );
}

function staleDecisionPackFromCache(entry, error) {
  const payload = entry.payload;
  return stripUndefined({
    ...payload,
    source: "local_cache",
    stale: true,
    freshness: "stale",
    rebuildEnqueued: false,
    cachedAt: entry.cachedAt,
    cache: cacheFallbackMetadata(entry, error),
  });
}

function repoDecisionFromCachedPack(entry, repoFullName, error) {
  const pack = staleDecisionPackFromCache(entry, error);
  const decision = cachedRepoDecision(pack, repoFullName);
  return stripUndefined({
    status: decision ? "ready" : "not_found",
    login: pack.login,
    repoFullName,
    generatedAt: pack.generatedAt,
    source: "local_cache",
    stale: true,
    freshness: "stale",
    cachedAt: entry.cachedAt,
    decision,
    dataQuality: pack.dataQuality,
    cache: cacheFallbackMetadata(entry, error),
  });
}

function cachedRepoDecision(pack, repoFullName) {
  const key = repoFullName.toLowerCase();
  return pack.repoDecisions?.find((decision) => String(decision?.repoFullName ?? "").toLowerCase() === key) ?? null;
}

function cacheFallbackMetadata(entry, error) {
  return {
    source: "local_cache",
    stale: true,
    cachedAt: entry.cachedAt,
    apiVersion: entry.apiVersion,
    schemaVersion: entry.schemaVersion,
    reason: "api_unavailable",
    detail: sanitizeDiagnosticText(error instanceof Error ? error.message : "api_unavailable"),
    rerunGuidance: "Retry when Gittensory API access is restored; cached guidance may be stale.",
    clearCommand: "gittensory-mcp cache clear",
  };
}

function isDecisionPackCacheFallbackEligible(error) {
  const status = error?.status;
  if (typeof status !== "number") return true;
  return status === 429 || status >= 500;
}

function sanitizeDecisionPackForCache(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeDecisionPackForCache(entry));
  if (typeof value === "string") return sanitizeCacheString(value);
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (isForbiddenCacheKey(entryKey)) continue;
    sanitized[entryKey] = sanitizeDecisionPackForCache(entryValue);
  }
  return sanitized;
}

function isForbiddenCacheKey(key) {
  return /^(?:authorization|token|accessToken|apiToken|githubToken|wallet|hotkey|coldkey|mnemonic|privateKey|private_key|sourceContent|sourceContents|fileContent|fileContents|rawSource|rawSourceContent|content|contents|diff|patch|rawDiff|localPath|absolutePath)$/i.test(
    key,
  );
}

function sanitizeCacheString(value) {
  return redactPrivateValidationMetrics(redactLocalValidationPaths(sanitizeDiagnosticText(value)));
}

function decisionPackCacheFiles() {
  if (!existsSync(decisionPackCacheDir)) return [];
  return readdirSync(decisionPackCacheDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(decisionPackCacheDir, name);
      try {
        const stats = statSync(path);
        return { path, mtimeMs: stats.mtimeMs, size: stats.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pruneDecisionPackCache() {
  const files = decisionPackCacheFiles().sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files.slice(decisionPackCacheMaxEntries)) rmSync(file.path, { force: true });
}

function clearDecisionPackCache() {
  const removed = decisionPackCacheFiles().length;
  rmSync(decisionPackCacheDir, { recursive: true, force: true });
  return {
    status: "cleared",
    removed,
    cache: {
      source: "local_cache",
      maxEntries: decisionPackCacheMaxEntries,
      clearCommand: "gittensory-mcp cache clear",
    },
  };
}

function inspectDecisionPackCache() {
  const files = decisionPackCacheFiles();
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return {
    status: "ok",
    entries: files.length,
    bytes,
    maxEntries: decisionPackCacheMaxEntries,
    schemaVersion: decisionPackCacheSchemaVersion,
    apiVersion: currentApiVersion,
    clearCommand: "gittensory-mcp cache clear",
  };
}

function findExecutable(name) {
  for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sanitizeDiagnosticText(value, extraPaths = []) {
  if (value === undefined || value === null) return value;
  let text = String(value);
  const sensitiveValues = [
    process.env.GITTENSORY_API_TOKEN,
    process.env.GITTENSORY_MCP_TOKEN,
    process.env.GITTENSORY_TOKEN,
    config.session?.token,
    ...profileSessions(config).map((entry) => entry.session.token),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const token of sensitiveValues) {
    text = text.split(token).join("[redacted]");
  }
  const localPaths = [
    configPath,
    process.env.GITTENSORY_CONFIG_PATH,
    process.env.GITTENSORY_CONFIG_DIR,
    process.cwd(),
    homedir(),
    ...extraPaths,
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 1);
  for (const localPath of localPaths.sort((left, right) => right.length - left.length)) {
    text = text.split(localPath).join("[local-path]");
  }
  return text;
}

function loadConfig() {
  if (!existsSync(configPath)) return {};
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return {};
  }
}

function saveConfig(nextConfig) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(configForPersistence(nextConfig), null, 2)}\n`, { mode: 0o600 });
}

function normalizeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const profiles = {};
  const rawProfiles = raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {};
  for (const [rawName, rawProfile] of Object.entries(rawProfiles)) {
    try {
      const name = normalizeProfileName(rawName);
      const profile = normalizeProfile(rawProfile);
      if (profile) profiles[name] = profile;
    } catch {
      // Ignore malformed profile names in local config instead of leaking paths or tokens.
    }
  }
  if (raw.session?.token && !profiles[defaultProfileName]) {
    profiles[defaultProfileName] = normalizeProfile({
      apiUrl: raw.apiUrl,
      session: raw.session,
    });
  }
  let activeProfile = defaultProfileName;
  try {
    activeProfile = selectProfileName({ ...raw, profiles }, raw.activeProfile);
  } catch {
    activeProfile = defaultProfileName;
  }
  return stripUndefined({
    ...raw,
    activeProfile,
    profiles,
    session: profiles[defaultProfileName]?.session,
  });
}

function normalizeProfile(rawProfile) {
  const raw = rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile) ? rawProfile : {};
  const session = normalizeSession(raw.session);
  return stripUndefined({
    apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl.replace(/\/+$/, "") : undefined,
    session,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  });
}

function normalizeSession(rawSession) {
  const raw = rawSession && typeof rawSession === "object" && !Array.isArray(rawSession) ? rawSession : {};
  if (typeof raw.token !== "string" || raw.token.length === 0) return undefined;
  return stripUndefined({
    token: raw.token,
    login: typeof raw.login === "string" ? raw.login : undefined,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : undefined,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope) => typeof scope === "string") : [],
  });
}

function configForPersistence(nextConfig) {
  const normalized = normalizeConfig(nextConfig);
  return stripUndefined({
    apiUrl: normalized.apiUrl,
    activeProfile: normalized.activeProfile,
    profiles: normalized.profiles,
    session: normalized.profiles?.[defaultProfileName]?.session,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(path) {
  return apiFetch(path, { method: "GET" });
}

async function apiPost(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}

async function apiFetch(path, init, options = {}) {
  const token = options.token ?? getApiToken();
  if (options.auth !== false && !token) {
    const error = new Error("Run `gittensory-mcp login`, or set GITTENSORY_API_TOKEN, GITTENSORY_MCP_TOKEN, or GITTENSORY_TOKEN before starting the MCP wrapper.");
    error.status = 401;
    error.code = "missing_auth";
    throw error;
  }
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GITTENSORY_API_TIMEOUT_MS ?? options.timeoutMs ?? 30000);
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    signal: init?.signal ?? controller.signal,
    headers: {
      ...(token && options.auth !== false ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json",
      "x-gittensory-mcp-package": packageName,
      "x-gittensory-mcp-version": packageVersion,
      "x-gittensory-mcp-client": "gittensory-mcp-cli",
    },
  }).finally(() => clearTimeout(timeout));
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (response.ok) throw error;
      payload = { error: "non_json_response", body: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const error = new Error(`Gittensory API ${response.status}${retry ? ` retry-after=${retry}s` : ""}: ${JSON.stringify(payload).slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchLatestPackageVersion() {
  if (/^(1|true|yes)$/i.test(process.env.GITTENSORY_SKIP_NPM_VERSION_CHECK ?? "false")) return { status: "skipped" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(`${npmRegistryUrl}/@jsonbored%2fgittensory-mcp/latest`, {
    signal: controller.signal,
    headers: { accept: "application/json" },
  }).finally(() => clearTimeout(timeout));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.version !== "string") throw new Error("npm_latest_version_unavailable");
  return { status: "ok", version: payload.version };
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}

// Compares two dot-separated semver prerelease strings per the semver spec:
// numeric identifiers compare numerically, others lexically, numeric < non-numeric,
// and a shorter set of identifiers has lower precedence when all earlier ones match.
function comparePrerelease(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftId = left[index];
    const rightId = right[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      if (Number(leftId) !== Number(rightId)) return Number(leftId) < Number(rightId) ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftId !== rightId) {
      return leftId < rightId ? -1 : 1;
    }
  }
  return 0;
}

// Returns -1 if a < b, 1 if a > b, 0 if equal, or null when either side is unparseable.
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  // A release version has higher precedence than any prerelease of the same core.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

// Maps a raw npm-latest lookup into a single install state. `comparison` is the result of
// compareSemver(local, latest): negative means local is behind (stale), positive means ahead.
function classifyVersionState(latestStatus, latestVersion, comparison) {
  if (latestStatus === "skipped") return "skipped";
  if (!latestVersion) return "unavailable";
  if (comparison === null) return "unknown";
  if (comparison < 0) return "stale";
  if (comparison > 0) return "ahead";
  return "current";
}

// Shared by `status` and `doctor`: compares the local install against npm latest and
// produces deterministic upgrade guidance. Never throws and never returns sensitive data.
async function inspectInstallVersion(apiRecommendedVersion) {
  let latest;
  try {
    latest = await fetchLatestPackageVersion();
  } catch (error) {
    latest = { status: "unavailable", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "npm_version_check_failed") };
  }
  if (latest.status === "unavailable" && typeof apiRecommendedVersion === "string" && apiRecommendedVersion.length > 0) {
    latest = { status: "api", version: apiRecommendedVersion };
  }
  const latestVersion = typeof latest.version === "string" ? latest.version : null;
  const comparison = latestVersion ? compareSemver(packageVersion, latestVersion) : null;
  const state = classifyVersionState(latest.status, latestVersion, comparison);
  const stale = state === "stale";
  return stripUndefined({
    name: packageName,
    version: packageVersion,
    latestVersion,
    latestStatus: latest.status ?? "ok",
    state,
    updateAvailable: stale,
    upgradeCommand: stale ? upgradeCommand : undefined,
    npxFallback: stale ? npxFallbackCommand : undefined,
    detail: latest.error,
  });
}

async function inspectApiCompatibility(health) {
  try {
    const report = await apiFetch(compatibilityPath, { method: "GET" }, { auth: false, timeoutMs: 5000 });
    return { report, evaluation: evaluateApiCompatibility(report, "compatibility_endpoint") };
  } catch (error) {
    const report = {
      status: "unavailable",
      reason: "compatibility_endpoint_unavailable",
      error: sanitizeDiagnosticText(error instanceof Error ? error.message : "compatibility_check_failed"),
    };
    const fallback = evaluateApiCompatibility(health, "health");
    return {
      report,
      evaluation: fallback.reason === "not_reported" ? evaluateApiCompatibility(report, "compatibility_endpoint") : fallback,
    };
  }
}

// Prefer the first-class compatibility endpoint, but keep supporting older APIs that only
// advertise `minMcpVersion`/`minClientVersion` on /health.
function evaluateApiCompatibility(report, source) {
  if (!report || report.status === "unreachable") return { status: "unavailable", reason: "api_unreachable", source };
  if (report.status === "unavailable") {
    return stripUndefined({ status: "unavailable", reason: report.reason ?? "compatibility_unavailable", source, detail: report.error });
  }
  const minVersion = compatibilityMinimumVersion(report);
  if (!minVersion) return { status: "unavailable", reason: "not_reported", source };
  const comparison = compareSemver(packageVersion, minVersion);
  const latestRecommendedVersion = compatibilityLatestRecommendedVersion(report);
  const apiVersion = typeof report.apiVersion === "string" ? report.apiVersion : undefined;
  const warnings = Array.isArray(report.compatibilityWarnings) ? report.compatibilityWarnings : Array.isArray(report.warnings) ? report.warnings : [];
  const breakingChanges = Array.isArray(report.breakingChanges) ? report.breakingChanges : [];
  if (comparison === null) return stripUndefined({ status: "unknown", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges });
  if (comparison < 0) return stripUndefined({ status: "incompatible", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges, upgradeCommand });
  return stripUndefined({ status: "compatible", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges });
}

function compatibilityMinimumVersion(report) {
  if (typeof report?.mcp?.minimumSupportedVersion === "string") return report.mcp.minimumSupportedVersion;
  if (typeof report?.minimumSupportedMcpVersion === "string") return report.minimumSupportedMcpVersion;
  if (typeof report?.minMcpVersion === "string") return report.minMcpVersion;
  if (typeof report?.minClientVersion === "string") return report.minClientVersion;
  return null;
}

function compatibilityLatestRecommendedVersion(report) {
  if (typeof report?.mcp?.latestRecommendedVersion === "string") return report.mcp.latestRecommendedVersion;
  if (typeof report?.mcp?.latestPackageVersion === "string") return report.mcp.latestPackageVersion;
  if (typeof report?.latestRecommendedMcpVersion === "string") return report.latestRecommendedMcpVersion;
  if (typeof report?.latestPackageVersion === "string") return report.latestPackageVersion;
  return null;
}

async function analyzeCurrentBranch(input) {
  const workspace = resolveWorkspaceCwd(input);
  const payload = buildBranchAnalysisPayload({ ...input, cwd: workspace.cwd });
  const { localScorerStatus, ...body } = payload;
  const analysis = await apiPost("/v1/local/branch-analysis", body);
  return {
    local: {
      sourceUpload: false,
      workspaceRoots: {
        available: workspace.rootsAvailable,
        count: workspace.rootCount,
        cwdInsideRoot: workspace.rootsAvailable ? true : undefined,
        pathsIncluded: false,
      },
      repoFullName: body.repoFullName,
      baseRef: body.baseRef,
      headRef: body.headRef,
      branchName: body.branchName,
      baseSha: body.baseSha,
      headSha: body.headSha,
      mergeBaseSha: body.mergeBaseSha,
      remoteTrackingSha: body.remoteTrackingSha,
      changedFileCount: body.changedFiles?.length ?? 0,
      testFileCount: body.changedFiles?.filter((file) => /(^|\/)(test|tests|spec|__tests__)\/|(^|\/)src\/test\/|(^|\/)[^/]+_test\.(go|py|rb)$|(^|\/)[^/]+_spec\.rb$|\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file.path)).length ?? 0,
      passedValidationCount: body.validation?.filter((entry) => entry.status === "passed").length ?? 0,
      localScorerStatus: sanitizeLocalScorerStatus(localScorerStatus),
      setupGuidance: setupGuidanceForLocalScorer(localScorerStatus),
    },
    analysis,
  };
}

async function agentPreparePrPacket(input) {
  const workspace = resolveWorkspaceCwd(input);
  const payload = buildBranchAnalysisPayload({ ...input, cwd: workspace.cwd });
  const { localScorerStatus: _localScorerStatus, ...body } = payload;
  return apiPost("/v1/agent/prepare-pr-packet", body);
}

async function previewLocalScore(input) {
  const workspace = resolveWorkspaceCwd(input);
  const cwd = workspace.cwd;
  const diff = collectLocalDiff(cwd, input.baseRef, input.workspaceRoots);
  const branchPayload = buildBranchAnalysisPayload({ ...input, login: input.contributorLogin ?? "local", cwd, repoFullName: input.repoFullName, baseRef: input.baseRef });
  const upstreamPreview = branchPayload.localScorerStatus;
  const estimatedSourceLines = input.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
  const body = {
    repoFullName: input.repoFullName,
    targetType: "local_diff",
    targetKey: input.targetKey ?? localDiffTargetKey(branchPayload, input.baseRef),
    contributorLogin: input.contributorLogin,
    labels: input.labels,
    linkedIssueMode: input.linkedIssueMode,
    sourceTokenScore: input.sourceTokenScore ?? estimatedSourceLines,
    sourceLines: estimatedSourceLines,
    totalTokenScore: input.totalTokenScore ?? diff.changedLineCount,
    testTokenScore: diff.testFiles.length,
    openPrCount: input.openPrCount,
    credibility: input.credibility,
    changesRequestedCount: input.changesRequestedCount,
    pendingMergedPrCount: input.pendingMergedPrCount,
    pendingClosedPrCount: input.pendingClosedPrCount,
    approvedPrCount: input.approvedPrCount,
    expectedOpenPrCountAfterMerge: input.expectedOpenPrCountAfterMerge,
    projectedCredibility: input.projectedCredibility,
    scenarioNotes: input.scenarioNotes,
    branchEligibility: input.branchEligibility,
    metadataOnly: !upstreamPreview.ok,
  };
  return {
    localDiff: {
      changedFiles: diff.changedFiles,
      changedLineCount: diff.changedLineCount,
      testFiles: diff.testFiles,
      codeFiles: diff.codeFiles,
      commitMessage: input.commitMessage ?? diff.commitMessage,
    },
    upstreamPreview: sanitizeLocalScorerStatus(upstreamPreview),
    remotePreview: await apiPost("/v1/scoring/preview", body),
    setupGuidance: upstreamPreview.ok
      ? []
      : setupGuidanceForLocalScorer(upstreamPreview),
  };
}

function localDiffTargetKey(branchPayload, baseRef) {
  return [
    branchPayload.repoFullName,
    branchPayload.branchName ?? branchPayload.headRef ?? "local",
    branchPayload.headSha ?? baseRef ?? "diff",
  ]
    .filter(Boolean)
    .join(":");
}

function branchEligibilityFromOptions(options) {
  const status = options.branchEligibility ?? options.branchEligibilityStatus;
  if (!["eligible", "ineligible", "unknown"].includes(status)) return undefined;
  const source = ["github_metadata", "local_metadata", "registry", "user_supplied"].includes(options.branchEligibilitySource) ? options.branchEligibilitySource : "user_supplied";
  return stripUndefined({
    status,
    source,
    reason: options.branchEligibilityReason,
    checkedAt: options.branchEligibilityCheckedAt,
    stale: optionalBoolean(options.branchEligibilityStale),
  });
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function toolResult(summary, data) {
  return {
    content: [
      {
        type: "text",
        text: `${summary}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
    structuredContent: data,
  };
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
