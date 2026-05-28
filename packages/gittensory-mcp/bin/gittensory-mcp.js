#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildBranchAnalysisPayload, collectLocalDiff, collectLocalBranchMetadata, setupGuidanceForLocalScorer } from "../lib/local-branch.js";

const defaultApiUrl = "https://gittensory-api.aethereal.dev";
const packageName = "@jsonbored/gittensory-mcp";
const packageVersion = "0.2.0";
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const configPath =
  process.env.GITTENSORY_CONFIG_PATH ??
  (process.env.GITTENSORY_CONFIG_DIR
    ? join(process.env.GITTENSORY_CONFIG_DIR, "config.json")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gittensory", "config.json"));
const config = loadConfig();
const apiUrl = (process.env.GITTENSORY_API_URL ?? config.apiUrl ?? defaultApiUrl).replace(/\/+$/, "");

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
  validation: z
    .array(
      z.object({
        command: z.string().min(1),
        status: z.enum(["passed", "failed", "not_run"]),
        summary: z.string().optional(),
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

const cliArgs = process.argv.slice(2);
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
  "gittensory_preflight_local_diff",
  {
    description: "Inspect local git diff metadata and run Gittensory preflight without uploading source contents.",
    inputSchema: localDiffShape,
  },
  async (input) => {
    const diff = collectLocalDiff(input.cwd ?? process.cwd(), input.baseRef);
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
  async (input) => toolResult("Gittensory private local PR scoring preview.", await previewLocalScore(input)),
);

server.registerTool(
  "gittensory_get_decision_pack",
  {
    description: "Return the canonical private contributor decision pack for a GitHub login.",
    inputSchema: loginShape,
  },
  async ({ login }) => toolResult(`Gittensory decision pack for ${login}.`, await apiGet(`/v1/contributors/${encodeURIComponent(login)}/decision-pack`)),
);

server.registerTool(
  "gittensory_explain_repo_decision",
  {
    description: "Return the contributor/repo decision from the canonical decision pack.",
    inputSchema: loginRepoShape,
  },
  async ({ login, owner, repo }) =>
    toolResult(
      `Gittensory repo decision for ${login} in ${owner}/${repo}.`,
      await apiGet(`/v1/contributors/${encodeURIComponent(login)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/decision`),
    ),
);

server.registerTool(
  "gittensory_compare_pr_variants",
  {
    description: "Compare private Gittensory scoring previews across local/metadata variants.",
    inputSchema: variantsShape,
  },
  async ({ variants }) => {
    const previews = [];
    for (const variant of variants) previews.push(await previewLocalScore({ ...variant, targetKey: variant.targetKey ?? `variant:${previews.length + 1}` }));
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
    try {
      git = collectLocalBranchMetadata({ cwd: input.cwd ?? process.cwd(), baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local" });
    } catch (error) {
      git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    return toolResult("Gittensory local MCP status.", {
      apiUrl,
      hasToken: Boolean(getApiToken()),
      authLogin: config.session?.login ?? null,
      sessionExpiresAt: config.session?.expiresAt ?? null,
      sourceUploadDefault: false,
      sourceUploadSupported: false,
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
    const result = await analyzeCurrentBranch(input);
    return toolResult("Gittensory current-branch preflight.", { local: result.local, preflight: result.analysis.preflight, prPacket: result.analysis.prPacket });
  },
);

server.registerTool(
  "gittensory_preview_current_branch_score",
  {
    description: "Analyze the current git branch and return private scoreability context. Sends metadata only.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(input);
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
    const result = await analyzeCurrentBranch(input);
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
    const result = await analyzeCurrentBranch(input);
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
  "gittensory_prepare_pr_packet",
  {
    description: "Analyze the current git branch and return a public-safe PR packet. Sends metadata only.",
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(input);
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
    const analyses = [];
    for (const variant of variants) analyses.push(await analyzeCurrentBranch(variant));
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
  async (input) => toolResult("Gittensory base-agent public-safe PR packet.", await agentPreparePrPacket(input)),
);

await server.connect(new StdioServerTransport());

async function runCli(args) {
  const command = args[0];
  if (command === "--help" || command === "help") return printHelp();
  if (command === "agent") return runAgentCli(args.slice(1));
  const options = parseOptions(args.slice(1));
  if (command === "login") return login(options);
  if (command === "logout") return logout(options);
  if (command === "whoami") return whoami(options);
  if (command === "status") return status(options);
  if (command === "changelog") return changelog(options);
  if (command === "doctor") return doctor(options);
  if (command === "init-client") return initClient(options);
  if (command !== "analyze-branch" && command !== "preflight") throw new Error(`Unknown command: ${command}`);
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
    validation: validationFromOptions(options),
    scorePreviewCommand: options.scorePreviewCommand,
  });
  const payload = command === "preflight" ? { local: result.local, preflight: result.analysis.preflight, prPacket: result.analysis.prPacket } : result;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.analysis.summary}\n`);
  process.stdout.write(`Top action: ${result.analysis.nextActions?.[0]?.actionKind ?? "none"}\n`);
  if (result.analysis.nextActions?.[0]?.whyThisHelps?.length) {
    process.stdout.write("Why this helps:\n");
    for (const line of result.analysis.nextActions[0].whyThisHelps.slice(0, 3)) process.stdout.write(`- ${line}\n`);
  }
  if (result.analysis.scoreBlockers?.length) {
    process.stdout.write("Score blockers:\n");
    for (const blocker of result.analysis.scoreBlockers.slice(0, 5)) process.stdout.write(`- ${blocker}\n`);
  }
  process.stdout.write(`Preflight: ${result.analysis.preflight.status}\n`);
  process.stdout.write(`Source upload: disabled\n`);
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
  process.stdout.write(`${summary}\n`);
  const actions = payload.actions ?? [];
  for (const action of actions.slice(0, 3)) {
    process.stdout.write(`- ${action.actionType}: ${action.recommendation}\n`);
    if (action.rerunWhen) process.stdout.write(`  rerun: ${action.rerunWhen}\n`);
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  gittensory-mcp --stdio
  gittensory-mcp login [--github-token <token>] [--json]
  gittensory-mcp logout [--json]
  gittensory-mcp whoami [--json]
  gittensory-mcp status [--json]
  gittensory-mcp changelog [--json]
  gittensory-mcp doctor [--cwd path] [--json]
  gittensory-mcp init-client --print codex|claude|cursor [--json]
  gittensory-mcp analyze-branch --login <github-login> [--repo owner/repo] [--base origin/main] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--scenario-note "..."] [--validation "passed|npm test|summary"] [--json]
  gittensory-mcp preflight --login <github-login> [--repo owner/repo] [--base origin/main] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--validation "passed|npm test|summary"] [--json]
  gittensory-mcp agent plan --login <github-login> [--repo owner/repo] [--json]
  gittensory-mcp agent status <run-id> [--json]
  gittensory-mcp agent explain <run-id> [--json]
  gittensory-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--json]

Environment:
  GITTENSORY_API_URL
  GITTENSORY_CONFIG_PATH or GITTENSORY_CONFIG_DIR
  GITTENSORY_API_TOKEN, GITTENSORY_MCP_TOKEN, GITTENSORY_TOKEN, or a session from gittensory-mcp login
  GITHUB_TOKEN for non-interactive login bootstrap
  GITTENSOR_SCORE_PREVIEW_CMD
  GITTENSOR_ROOT
  GITTENSORY_UPLOAD_SOURCE=false
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

function parseOptions(args) {
  const options = {};
  const repeatable = new Set(["label", "issue", "validation", "validationCommand", "validationStatus", "validationSummary", "scenarioNote"]);
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
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  const session = githubToken ? await apiFetch("/v1/auth/github/session", { method: "POST", body: JSON.stringify({ githubToken }) }, { auth: false }) : await loginWithDeviceFlow();
  saveConfig({
    ...config,
    apiUrl,
    session: {
      token: session.token,
      login: session.login,
      expiresAt: session.expiresAt,
      scopes: session.scopes ?? [],
    },
  });
  const payload = { status: "authenticated", login: session.login, apiUrl, expiresAt: session.expiresAt };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`Authenticated as ${session.login}. Session expires ${session.expiresAt}.\n`);
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
  const token = getApiToken();
  let remote = null;
  if (token) {
    try {
      remote = await apiFetch("/v1/auth/logout", { method: "POST", body: "{}" });
    } catch (error) {
      remote = { error: error instanceof Error ? error.message : "logout_failed" };
    }
  }
  if (existsSync(configPath)) rmSync(configPath, { force: true });
  const payload = { status: "logged_out", apiUrl, remote };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write("Logged out.\n");
}

async function whoami(options) {
  const payload = await apiGet("/v1/auth/session");
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${payload.login}\n`);
}

async function status(options) {
  let auth = { status: getApiToken() ? "token_configured" : "unauthenticated" };
  let health = null;
  let latest = null;
  if (getApiToken()) {
    try {
      auth = await apiGet("/v1/auth/session");
    } catch (error) {
      auth = { status: "token_configured", session: "unverified", error: error instanceof Error ? error.message : "status_failed" };
    }
  }
  try {
    health = await apiFetch("/health", { method: "GET" }, { auth: false, timeoutMs: 5000 });
  } catch (error) {
    health = { status: "unreachable", error: error instanceof Error ? error.message : "health_check_failed" };
  }
  try {
    latest = await fetchLatestPackageVersion();
  } catch (error) {
    latest = { status: "unavailable", error: error instanceof Error ? error.message : "npm_version_check_failed" };
  }
  const payload = {
    apiUrl,
    package: {
      name: packageName,
      version: packageVersion,
      latestVersion: latest?.version ?? null,
      updateAvailable: typeof latest?.version === "string" && latest.version !== packageVersion,
      latestStatus: latest?.status ?? "ok",
    },
    api: health,
    auth,
    configPath,
    sourceUploadDefault: false,
    sourceUploadSupported: false,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`${packageName}: ${packageVersion}${payload.package.latestVersion ? ` (latest ${payload.package.latestVersion})` : ""}\n`);
    process.stdout.write(`API: ${apiUrl}\n`);
    process.stdout.write(`API health: ${health?.status ?? "unknown"}\n`);
    process.stdout.write(`Auth: ${auth.status}${auth.login ? ` (${auth.login})` : ""}\n`);
    process.stdout.write("Source upload: disabled\n");
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
  const add = (name, statusValue, detail, remediation) => checks.push(stripUndefined({ name, status: statusValue, detail, remediation }));

  try {
    const health = await apiFetch("/health", { method: "GET" }, { auth: false });
    add("api_health", health.status === "ok" ? "pass" : "warn", `API responded from ${apiUrl}.`);
  } catch (error) {
    add("api_health", "fail", error instanceof Error ? error.message : "health_check_failed", "Check GITTENSORY_API_URL or network access.");
  }

  const token = getApiToken();
  if (!token) {
    add("auth", "fail", "No Gittensory API/session token is configured.", "Run `gittensory-mcp login`.");
  } else {
    try {
      const session = await apiGet("/v1/auth/session");
      add("auth", "pass", `Authenticated as ${session.login}; session expires ${session.expiresAt}.`);
    } catch (error) {
      add("auth", "warn", `A token is configured but no user session was verified: ${error instanceof Error ? error.message : "session_check_failed"}.`, "If this is a static beta token, this can be expected. Otherwise run `gittensory-mcp login`.");
    }
  }

  if (/^(1|true|yes)$/i.test(process.env.GITTENSORY_UPLOAD_SOURCE ?? "false")) {
    add("source_upload", "fail", "GITTENSORY_UPLOAD_SOURCE is enabled.", "Unset GITTENSORY_UPLOAD_SOURCE. Source upload is unsupported in v1.");
  } else {
    add("source_upload", "pass", "Source upload is disabled and unsupported in v1.");
  }

  try {
    const metadata = collectLocalBranchMetadata({
      cwd: options.cwd ?? process.cwd(),
      baseRef: options.base,
      repoFullName: options.repo,
      login: options.login ?? config.session?.login ?? "local",
    });
    add("git_metadata", "pass", `${metadata.repoFullName} on ${metadata.branchName}; ${metadata.changedFiles.length} changed file(s).`);
  } catch (error) {
    add("git_metadata", "warn", error instanceof Error ? error.message : "git_metadata_failed", "Run from a git repo or pass --repo owner/repo.");
  }

  const commandPath = findExecutable("gittensory-mcp");
  if (commandPath) add("client_path", "pass", `gittensory-mcp is visible on PATH at ${commandPath}.`);
  else add("client_path", "warn", "gittensory-mcp was not found on PATH.", "Use an absolute command path in Codex, Claude, or Cursor config.");

  const payload = {
    status: checks.some((check) => check.status === "fail") ? "needs_attention" : checks.some((check) => check.status === "warn") ? "warnings" : "ok",
    apiUrl,
    configPath,
    sourceUploadSupported: false,
    checks,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`Gittensory doctor: ${payload.status}\n`);
    for (const check of checks) {
      process.stdout.write(`- ${check.status}: ${check.name} - ${check.detail}\n`);
      if (check.remediation) process.stdout.write(`  ${check.remediation}\n`);
    }
  }
}

function initClient(options) {
  const client = String(options.print ?? options.client ?? "").toLowerCase();
  if (!client) throw new Error("Pass --print codex, --print claude, or --print cursor.");
  const command = options.command ?? "gittensory-mcp";
  const snippet = clientSnippet(client, command);
  const payload = {
    client,
    command,
    args: ["--stdio"],
    snippet,
    notes: [
      "Run `gittensory-mcp login` before starting the MCP client.",
      "Use an absolute command path if the client does not inherit your shell PATH.",
      "This command prints config only; it does not edit client files.",
    ],
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${snippet}\n`);
}

function getApiToken() {
  return process.env.GITTENSORY_API_TOKEN ?? process.env.GITTENSORY_TOKEN ?? process.env.GITTENSORY_MCP_TOKEN ?? config.session?.token;
}

function validationFromOptions(options) {
  const direct = (options.validation ?? []).map((entry) => {
    const [statusOrCommand, commandOrSummary, ...summaryParts] = String(entry).split("|");
    const status = isValidationStatus(statusOrCommand) ? statusOrCommand : "not_run";
    const command = isValidationStatus(statusOrCommand) ? commandOrSummary : statusOrCommand;
    return stripUndefined({
      command: command?.trim(),
      status,
      summary: summaryParts.join("|").trim() || (isValidationStatus(statusOrCommand) ? undefined : commandOrSummary?.trim()),
    });
  });
  const commands = options.validationCommand ?? [];
  const statuses = options.validationStatus ?? [];
  const summaries = options.validationSummary ?? [];
  const expanded = commands.map((command, index) =>
    stripUndefined({
      command,
      status: isValidationStatus(statuses[index]) ? statuses[index] : "not_run",
      summary: summaries[index],
    }),
  );
  return [...direct, ...expanded].filter((entry) => typeof entry.command === "string" && entry.command.length > 0);
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
  return value === "passed" || value === "failed" || value === "not_run";
}

function clientSnippet(client, command) {
  if (client === "codex") return `[mcp_servers.gittensory]\ncommand = ${JSON.stringify(command)}\nargs = ["--stdio"]`;
  if (client === "claude" || client === "cursor") {
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
  throw new Error(`Unsupported client: ${client}. Use codex, claude, or cursor.`);
}

function findExecutable(name) {
  for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadConfig() {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(nextConfig) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
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
  const token = getApiToken();
  if (options.auth !== false && !token) throw new Error("Run `gittensory-mcp login`, or set GITTENSORY_API_TOKEN, GITTENSORY_MCP_TOKEN, or GITTENSORY_TOKEN before starting the MCP wrapper.");
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
    },
  }).finally(() => clearTimeout(timeout));
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    throw new Error(`Gittensory API ${response.status}${retry ? ` retry-after=${retry}s` : ""}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

async function fetchLatestPackageVersion() {
  if (/^(1|true|yes)$/i.test(process.env.GITTENSORY_SKIP_NPM_VERSION_CHECK ?? "false")) return { status: "skipped" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch("https://registry.npmjs.org/@jsonbored%2fgittensory-mcp/latest", {
    signal: controller.signal,
    headers: { accept: "application/json" },
  }).finally(() => clearTimeout(timeout));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.version !== "string") throw new Error("npm_latest_version_unavailable");
  return { status: "ok", version: payload.version };
}

async function analyzeCurrentBranch(input) {
  const payload = buildBranchAnalysisPayload(input);
  const { localScorerStatus, ...body } = payload;
  const analysis = await apiPost("/v1/local/branch-analysis", body);
  return {
    local: {
      sourceUpload: false,
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
      localScorerStatus,
      setupGuidance: setupGuidanceForLocalScorer(localScorerStatus),
    },
    analysis,
  };
}

async function agentPreparePrPacket(input) {
  const payload = buildBranchAnalysisPayload(input);
  const { localScorerStatus: _localScorerStatus, ...body } = payload;
  return apiPost("/v1/agent/prepare-pr-packet", body);
}

async function previewLocalScore(input) {
  const cwd = input.cwd ?? process.cwd();
  const diff = collectLocalDiff(cwd, input.baseRef);
  const branchPayload = buildBranchAnalysisPayload({ ...input, login: input.contributorLogin ?? "local", cwd, repoFullName: input.repoFullName, baseRef: input.baseRef });
  const upstreamPreview = branchPayload.localScorerStatus;
  const estimatedSourceLines = input.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
  const body = {
    repoFullName: input.repoFullName,
    targetType: "local_diff",
    targetKey: input.targetKey ?? `${input.repoFullName}:${cwd}:${input.baseRef}`,
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
    upstreamPreview,
    remotePreview: await apiPost("/v1/scoring/preview", body),
    setupGuidance: upstreamPreview.ok
      ? []
      : setupGuidanceForLocalScorer(upstreamPreview),
  };
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
