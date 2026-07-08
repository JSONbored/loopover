import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

export const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");
let server: Server | null = null;

export async function closeFixtureServer() {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
}

export function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync("node", [bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITTENSORY_API_TIMEOUT_MS: "1000",
      GITTENSORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "gittensory-cli-config-")),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "node",
      [bin, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITTENSORY_API_TIMEOUT_MS: "1000",
          GITTENSORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "gittensory-cli-config-")),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function createPacketRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Gittensory Test");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", "initial commit");
  return cwd;
}

export async function capturePacketValidation(tempDir: string, validationArgs: string[]) {
  const requests: unknown[] = [];
  const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
  await runAsync(
    ["agent", "packet", "--login", "oktofeesh1", "--cwd", tempDir, "--base", "HEAD", ...validationArgs, "--json"],
    {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    },
  );
  return (requests[0] as { validation: Array<{ command: string; status: string; exitCode?: number; summary?: string }> }).validation;
}

export function decisionPackCacheFile(configDir: string) {
  const cacheDir = join(configDir, "cache", "decision-packs");
  const files = readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  const file = files[0];
  if (!file) throw new Error("expected one decision-pack cache file");
  return join(cacheDir, file);
}

export function readDecisionPackCacheText(configDir: string) {
  return readFileSync(decisionPackCacheFile(configDir), "utf8");
}

export async function startFixtureServer(
  options: {
    latestVersion?: string;
    latestRecommendedMcpVersion?: string;
    minMcpVersion?: string;
    compatibilityStatus?: number;
    npmStatus?: number;
    decisionPackStatus?: number;
    decisionPackErrorBody?: string;
    decisionPackErrorContentType?: string;
    repoDecisionStatus?: number;
    repoDecisionErrorBody?: string;
    repoDecisionErrorContentType?: string;
    packetMarkdown?: string;
    localBranchAnalysis?: unknown;
    slopRiskStatus?: number;
    prTextLintStatus?: number;
    onPacketRequest?: (body: unknown) => void;
    onApiRequest?: (request: IncomingMessage) => void;
    validateConfigWarnings?: string[];
  } = {},
) {
  server = createServer(async (request, response) => {
    options.onApiRequest?.(request);
    response.setHeader("content-type", "application/json");
    if (request.url && request.url.includes("gittensory-mcp/latest")) {
      if (options.npmStatus && options.npmStatus >= 400) {
        response.statusCode = options.npmStatus;
        response.end(JSON.stringify({ error: "registry_error" }));
        return;
      }
      response.end(JSON.stringify({ version: options.latestVersion ?? "0.4.0" }));
      return;
    }
    if (request.url === "/v1/mcp/compatibility") {
      if (options.compatibilityStatus && options.compatibilityStatus >= 400) {
        response.statusCode = options.compatibilityStatus;
        response.end(JSON.stringify({ error: "compatibility_unavailable" }));
        return;
      }
      const minimumSupportedVersion = options.minMcpVersion ?? "0.4.0";
      const latestRecommendedVersion = options.latestRecommendedMcpVersion ?? options.latestVersion ?? "0.4.0";
      response.end(
        JSON.stringify({
          status: "ok",
          service: "gittensory-api",
          apiVersion: "0.1.0",
          mcp: {
            packageName: "@jsonbored/gittensory-mcp",
            minimumSupportedVersion,
            latestRecommendedVersion,
            latestPackageVersion: latestRecommendedVersion,
            supportedVersionRange: `>=${minimumSupportedVersion}`,
            upgradeCommand: "npm install -g @jsonbored/gittensory-mcp@latest",
            npxFallbackCommand: "npx @jsonbored/gittensory-mcp@latest <command>",
          },
          compatibilityWarnings: [],
          breakingChanges: [],
          generatedAt: "2026-05-30T00:00:00.000Z",
        }),
      );
      return;
    }
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", service: "gittensory-api", ...(options.minMcpVersion ? { minMcpVersion: options.minMcpVersion } : {}) }));
      return;
    }
    if (request.url === "/v1/auth/github/session" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as { githubToken?: string };
      const sessions: Record<string, { token: string; login: string }> = {
        "github-jsonbored": { token: "session-jsonbored", login: "JSONbored" },
        "github-okto": { token: "session-okto", login: "oktofeesh1" },
      };
      const session = body.githubToken ? sessions[body.githubToken] : null;
      if (!session) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "github_session_create_failed" }));
        return;
      }
      response.end(JSON.stringify({ status: "authenticated", token: session.token, login: session.login, expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["read:user"] }));
      return;
    }
    if (request.url === "/v1/auth/session" && request.headers.authorization === "Bearer session-token") {
      response.end(JSON.stringify({ status: "authenticated", login: "JSONbored", expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["read:user"] }));
      return;
    }
    if (request.url === "/v1/auth/session" && request.headers.authorization === "Bearer session-jsonbored") {
      response.end(JSON.stringify({ status: "authenticated", login: "JSONbored", expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["read:user"] }));
      return;
    }
    if (request.url === "/v1/auth/session" && request.headers.authorization === "Bearer session-okto") {
      response.end(JSON.stringify({ status: "authenticated", login: "oktofeesh1", expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["read:user"] }));
      return;
    }
    if (request.url === "/v1/auth/logout" && request.method === "POST") {
      response.end(JSON.stringify({ status: "logged_out" }));
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/decision-pack" && request.method === "GET") {
      if (options.decisionPackStatus && options.decisionPackStatus >= 400) {
        response.statusCode = options.decisionPackStatus;
        if (options.decisionPackErrorContentType) response.setHeader("content-type", options.decisionPackErrorContentType);
        response.end(options.decisionPackErrorBody ?? JSON.stringify({ error: "decision_pack_unavailable" }));
        return;
      }
      response.end(JSON.stringify(decisionPackFixture()));
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/repos/JSONbored/gittensory/decision" && request.method === "GET") {
      if (options.repoDecisionStatus && options.repoDecisionStatus >= 400) {
        response.statusCode = options.repoDecisionStatus;
        if (options.repoDecisionErrorContentType) response.setHeader("content-type", options.repoDecisionErrorContentType);
        response.end(options.repoDecisionErrorBody ?? JSON.stringify({ error: "repo_decision_unavailable" }));
        return;
      }
      response.end(JSON.stringify({ status: "ready", login: "JSONbored", repoFullName: "JSONbored/gittensory", decision: decisionPackFixture().repoDecisions[0] }));
      return;
    }
    if (request.url === "/v1/agent/plan-next-work" && request.method === "POST") {
      await readJsonRequest(request);
      response.end(JSON.stringify(agentFixture()));
      return;
    }
    if (request.url === "/v1/agent/runs/run-1" && request.method === "GET") {
      response.end(JSON.stringify(agentFixture()));
      return;
    }
    if (request.url === "/v1/agent/prepare-pr-packet" && request.method === "POST") {
      options.onPacketRequest?.(await readJsonRequest(request));
      response.end(JSON.stringify(agentPacketFixture(options.packetMarkdown)));
      return;
    }
    if (request.url === "/v1/local/branch-analysis" && request.method === "POST") {
      await readJsonRequest(request);
      response.end(JSON.stringify(options.localBranchAnalysis ?? localBranchAnalysisFixture()));
      return;
    }
    if (request.url === "/v1/lint/pr-text" && request.method === "POST") {
      if (options.prTextLintStatus && options.prTextLintStatus >= 400) {
        await readJsonRequest(request);
        response.statusCode = options.prTextLintStatus;
        response.end(JSON.stringify({ error: "pr_text_lint_unavailable" }));
        return;
      }
      const body = (await readJsonRequest(request)) as { commitMessages?: string[]; prBody?: string; linkedIssue?: number };
      response.end(JSON.stringify(lintPrTextFixture(body)));
      return;
    }
    if (request.url === "/v1/validate/focus-manifest" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as { content?: string };
      const content = body.content ?? "";
      const malformed = content.includes("not: valid json");
      response.end(
        JSON.stringify(
          malformed
            ? { present: false, status: "error", warnings: ["Manifest content was not valid JSON; ignoring it and falling back to deterministic signals."], normalized: { present: false, source: "repo_file" } }
            : { present: true, status: "ok", warnings: options.validateConfigWarnings ?? [], normalized: { present: true, source: "repo_file", wantedPaths: ["src/"] } },
        ),
      );
      return;
    }
    if (request.url === "/v1/lint/slop-risk" && request.method === "POST") {
      if (options.slopRiskStatus && options.slopRiskStatus >= 400) {
        await readJsonRequest(request);
        response.statusCode = options.slopRiskStatus;
        response.end(JSON.stringify({ error: "slop_risk_unavailable" }));
        return;
      }
      const body = (await readJsonRequest(request)) as {
        changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>;
        description?: string;
        tests?: string[];
        testFiles?: string[];
      };
      response.end(JSON.stringify(slopRiskFixture(body)));
      return;
    }
    if (request.url === "/v1/lint/issue-slop" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as { title?: string; body?: string };
      response.end(JSON.stringify(issueSlopFixture(body)));
      return;
    }
    if (request.url === "/v1/opportunities/find" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as {
        targets?: Array<{ owner: string; repo: string }>;
        searchQuery?: string;
        goalSpec?: { lane?: string; minRankScore?: number; languages?: string[] };
        limit?: number;
      };
      const limit = body.limit ?? 5;
      const lane = body.goalSpec?.lane ?? "default";
      const minRank = body.goalSpec?.minRankScore ?? 0;
      const candidates = [
        { owner: "JSONbored", repo: "gittensory", issueNumber: 100, title: "Improve REES test retry", rankScore: 85, laneFit: lane, freshness: 0.9, dupRisk: 0.1, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "gittensory", issueNumber: 101, title: "Add label-audit coverage", rankScore: 72, laneFit: lane, freshness: 0.7, dupRisk: 0.2, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "gittensory", issueNumber: 102, title: "Fix flaky buildBrief test", rankScore: 68, laneFit: lane, freshness: 0.5, dupRisk: 0.3, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "gittensory", issueNumber: 103, title: "Normalize path matchers", rankScore: 55, laneFit: lane, freshness: 0.4, dupRisk: 0.1, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "gittensory", issueNumber: 104, title: "Document score breakdown", rankScore: 45, laneFit: lane, freshness: 0.3, dupRisk: 0.1, aiPolicyAllowed: true },
      ];
      const ranked = candidates.filter((c) => c.rankScore >= minRank).slice(0, limit);
      response.end(JSON.stringify({ ranked, totalCandidates: candidates.length, appliedLane: lane, appliedMinRankScore: minRank }));
      return;
    }
    // #784 maintainer controls (agent approval queue + kill-switch).
    if (request.url === "/v1/repos/owner/repo/agent/pending-actions" && request.method === "GET") {
      response.end(JSON.stringify({ repoFullName: "owner/repo", pendingActions: [{ id: "pa-1", actionClass: "merge", pullNumber: 7, reason: "clean", status: "pending" }] }));
      return;
    }
    if (request.url?.startsWith("/v1/repos/owner/repo/agent/pending-actions/") && request.method === "POST") {
      const accepted = request.url.endsWith("/accept");
      response.end(JSON.stringify(accepted ? { status: "accepted", executionOutcome: "completed" } : { status: "rejected" }));
      return;
    }
    if (request.url === "/v1/repos/owner/repo/settings" && request.method === "GET") {
      response.end(JSON.stringify({ repoFullName: "owner/repo", autonomy: { label: "auto" }, agentPaused: false, agentDryRun: false }));
      return;
    }
    if (request.url === "/v1/repos/owner/repo/settings" && request.method === "PUT") {
      const body = (await readJsonRequest(request)) as { agentPaused?: boolean; autonomy?: Record<string, string> };
      response.end(JSON.stringify({ repoFullName: "owner/repo", agentPaused: body.agentPaused === true, ...(body.autonomy ? { autonomy: body.autonomy } : {}) }));
      return;
    }
    if (request.url === "/v1/upstream/drift" && request.method === "GET") {
      response.end(
        JSON.stringify({
          generatedAt: "2026-05-30T00:00:00.000Z",
          upstreamDrift: { status: "ok", ruleset: "gittensor-core", lastCheckedAt: "2026-05-30T00:00:00.000Z", warnings: [] },
          reports: [{ id: "drift-1", severity: "info", summary: "no drift detected", detectedAt: "2026-05-30T00:00:00.000Z" }],
        }),
      );
      return;
    }
    if (request.url === "/v1/repos/owner/repo/intelligence" && request.method === "GET") {
      response.end(
        JSON.stringify({
          status: "ready",
          source: "computed",
          repoFullName: "owner/repo",
          generatedAt: "2026-05-30T00:00:00.000Z",
          labelAudit: {
            configuredLabels: ["gittensor:feature", "gittensor:bug"],
            liveLabels: ["gittensor:feature", "visual"],
            missingConfiguredLabels: ["gittensor:bug"],
            suspiciousLabels: ["visual"],
            trustedLabelPipelineReady: false,
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function readJsonRequest(request: IncomingMessage) {
  return new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

export function agentPacketFixture(markdown = "# Public-safe PR packet\n\n## Linked Context\n- Closes #39\n\n## Validation\n- passed: npm test (packet tests passed)\n") {
  return {
    ...agentFixture(),
    actions: [
      {
        id: "action-packet",
        runId: "run-1",
        actionType: "prepare_pr_packet",
        status: "ready",
        recommendation: "Use this public-safe packet.",
        why: ["Fixture"],
        blockedBy: [],
        publicSafeSummary: "Packet ready.",
        approvalRequired: false,
        safetyClass: "public_safe",
        payload: {
          prPacket: {
            markdown,
          },
        },
      },
    ],
  };
}

export function localBranchAnalysisFixture() {
  return {
    login: "JSONbored",
    repoFullName: "JSONbored/gittensory",
    generatedAt: "2026-06-01T00:00:00.000Z",
    summary: "Local branch preflight fixture.",
    nextActions: [{ actionKind: "prepare_pr_packet", whyThisHelps: ["Keeps public packet safe."] }],
    preflight: { status: "ready", findings: [] },
    prPacket: { titleSuggestion: "Local branch preflight", markdown: "# Public-safe PR packet\n" },
    workspaceIntelligence: {
      version: 2,
      changedFiles: { total: 1, binary: 0, deleted: 0, renamed: 0 },
      testEvidence: { level: "validation_commands" },
      branch: { pendingCommitCount: 1 },
      baseFreshness: { status: "fresh", warnings: [] },
      blockers: {
        branchQuality: [],
        accountState: ["Open PR count 4 exceeds threshold 2.", "Credibility 0.2 is below floor 0.8."],
      },
      ciStatusHints: [],
      rerunWhen: "Rerun after account/queue maturity blockers clear.",
    },
    dataQuality: { signalFidelity: { status: "complete" } },
  };
}

export function decisionPackFixture() {
  return {
    status: "ready",
    source: "snapshot",
    login: "JSONbored",
    generatedAt: "2026-06-01T00:00:00.000Z",
    stale: false,
    freshness: "fresh",
    rebuildEnqueued: false,
    scoringModelSnapshotId: "scoring-1",
    profile: {
      login: "JSONbored",
      github: { topLanguages: ["TypeScript"] },
      source: { cache: "fixture" },
      officialStats: { totalMergedPrs: 12, hotkey: "hotkey-value", wallet: "wallet-value" },
      registeredRepoActivity: {},
      trustSignals: {},
    },
    outcomeHistory: {},
    roleContexts: [],
    opportunities: [],
    repoDecisions: [
      {
        repoFullName: "JSONbored/gittensory",
        recommendation: "pursue",
        nextActions: ["Pick one narrow change."],
        changedFiles: [{ path: "src/cache.ts", content: "must stay local" }],
        localPath: "/tmp/source/private.ts",
      },
    ],
    topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "JSONbored/gittensory", priorityScore: 50 }],
    cleanupFirst: [],
    pursueRepos: [{ repoFullName: "JSONbored/gittensory", recommendation: "pursue" }],
    avoidRepos: [],
    maintainerLaneRepos: [],
    scoreBlockers: [],
    dataQuality: { signalFidelity: { status: "complete" } },
    summary: "fixture decision pack",
    nextActions: ["Pick one narrow change."],
    sourceContents: "must stay local",
  };
}

export function agentFixture() {
  return {
    run: {
      id: "run-1",
      objective: "plan",
      actorLogin: "JSONbored",
      surface: "mcp",
      mode: "copilot",
      status: "completed",
      dataQualityStatus: "complete",
      payload: {},
    },
    actions: [
      {
        id: "action-1",
        runId: "run-1",
        actionType: "choose_next_work",
        status: "recommended",
        recommendation: "Pick narrow work and run branch preflight.",
        why: ["Fixture"],
        blockedBy: [],
        rerunWhen: "Rerun before opening a PR or when repo queue signals change.",
        publicSafeSummary: "Fixture public summary.",
        explanationCard: {
          summary: "Pursue now: this action is the current ranked next step.",
          whyNow: "Current deterministic planning signals rank this action ahead of other available next steps.",
          scoreabilityBlocker: "No hard scoreability blocker is visible in current signals.",
          risk: "No major action-specific risk is visible in the current card.",
          maintainerFriction: "Narrow, validated work is easier for maintainers to review.",
          expectedImpact: "Advance toward one narrow, validated contribution path.",
          blockerGroups: [],
          rerunWhen: "Rerun before opening a PR or when repo queue signals change.",
          publicSafe: {
            summary: "Fixture public summary.",
            whyNow: "Fixture public summary.",
            rerunWhen: "Rerun before opening a PR or when repo queue signals change.",
          },
        },
        approvalRequired: true,
        safetyClass: "private",
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "fixture",
  };
}

export function lintPrTextFixture(input: { commitMessages?: string[]; prBody?: string; linkedIssue?: number } = {}) {
  const weakCommit = (input.commitMessages ?? []).some((message) => /^wip$/i.test(message.trim()));
  const missingTraceability = input.linkedIssue === undefined && !/no issue needed|no issue applies/i.test(input.prBody ?? "");
  const verdict = weakCommit || !input.prBody ? "weak" : missingTraceability ? "adequate" : "strong";
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    verdict,
    score: verdict === "strong" ? 100 : verdict === "adequate" ? 81 : 45,
    summary: `Fixture PR-text lint verdict: ${verdict}.`,
    fixes: verdict === "strong" ? [] : ["Use a Conventional Commit subject with a specific scope and summary."],
    components: [
      {
        key: "traceability",
        label: "Traceability",
        status: missingTraceability ? "weak" : "ok",
        evidence: missingTraceability ? "No linked issue or no-issue rationale." : `Linked issue #${input.linkedIssue}.`,
      },
    ],
  };
}

export function slopRiskFixture(input: {
  changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>;
  description?: string;
  tests?: string[];
  testFiles?: string[];
} = {}) {
  const changedFiles = input.changedFiles ?? [];
  const hasCodeChange = changedFiles.some((file) => !file.path.includes(".test."));
  const hasTestEvidence = changedFiles.some((file) => file.path.includes(".test.")) || (input.testFiles?.length ?? 0) > 0 || (input.tests?.length ?? 0) > 0;
  const emptyDescription = !input.description?.trim();
  const elevated = hasCodeChange && (!hasTestEvidence || emptyDescription);
  const slopRisk = elevated ? 45 : 0;
  const findings =
    elevated && emptyDescription
      ? [{ code: "empty_description", title: "Empty PR description", severity: "warning", detail: "Add a specific summary of what changed and why." }]
      : elevated
        ? [{ code: "missing_test_evidence", title: "Missing test evidence", severity: "warning", detail: "Add or update tests for the changed behavior." }]
        : [];
  return {
    slopRisk,
    band: slopRisk <= 0 ? "clean" : slopRisk < 25 ? "low" : slopRisk < 60 ? "elevated" : "high",
    findings,
    rubric: "Fixture slop rubric.",
  };
}

export function issueSlopFixture(input: { title?: string; body?: string } = {}) {
  const bodyText = typeof input.body === "string" ? input.body : "";
  const emptyBody = !bodyText.trim();
  const unfilledTemplate = !emptyBody && /##\s*summary/i.test(bodyText) && /-\s*\[?\s*\]?\s*$/m.test(bodyText);
  const titleOnly = !emptyBody && !unfilledTemplate && input.title && bodyText.trim().toLowerCase() === input.title.trim().toLowerCase();
  const slopRisk = emptyBody ? 30 : unfilledTemplate ? 40 : titleOnly ? 25 : 0;
  const findings = emptyBody
    ? [{ code: "empty_issue_body", title: "Issue has no description", severity: "warning", detail: "This issue was opened with an empty body." }]
    : unfilledTemplate
      ? [{ code: "unfilled_issue_template", title: "Issue template left unfilled", severity: "warning", detail: "Fill in the issue template sections with concrete detail." }]
      : titleOnly
        ? [{ code: "title_restatement", title: "Issue body only restates the title", severity: "warning", detail: "Add specific detail beyond the title." }]
        : [];
  return {
    slopRisk,
    band: slopRisk <= 0 ? "clean" : slopRisk < 25 ? "low" : slopRisk < 60 ? "elevated" : "high",
    findings,
    rubric: "Fixture issue slop rubric.",
  };
}
