import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

// packages/loopover-mcp ships .ts source only (no committed compiled output -- Vite/esbuild already
// resolves .js-suffixed import specifiers to the sibling .ts by default, which is why in-process imports
// never needed anything special either). Spawning the real CLI as a subprocess still needs a real runnable
// entrypoint, so this runs the .ts directly via Node's own built-in type-stripping (--experimental-strip-
// types, explicit rather than relying on its default-on state so this keeps working regardless of exactly
// which supported Node 22.x patch is running) instead of requiring a prior `npm run build:mcp`. Type
// STRIPPING, not full transformation or type-checking -- that's fine here since `npm run typecheck`/
// `build:mcp` elsewhere in the gate already own type-correctness, and neither bin/lib file uses syntax
// erasable-only stripping can't handle (enums, namespaces, constructor parameter properties): this harness
// only needs the CLI to actually run. process.execPath (not a bare "node") mirrors scripts/check-syntax.mjs's
// own convention -- guarantees the exact Node binary already running the test, not whatever "node" resolves
// to on PATH.
const NODE_STRIP_TYPES_ARGS = ["--experimental-strip-types"];
export const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.ts");
export const repoOnboardingPackFixture = {
  repoFullName: "owner/repo",
  accepted: true,
  policySource: "policy_compiler",
  preview: {
    repoFullName: "owner/repo",
    generatedAt: "2026-07-17T00:00:00.000Z",
    source: "policy_compiler",
    previewOnly: true,
    publicSafe: true,
    contributionLanes: [],
    labelPolicy: { preferredLabels: ["help wanted"], requiredLabels: [], discouragedLabels: [], note: null },
    validationExpectations: ["npm test"],
    readinessWarnings: [],
    maintainerExpectations: [],
    publicOutputBoundaries: ["Preview only."],
    previewMarkdown: "# Contributor onboarding",
    droppedPublicItems: [],
    privateOwnerContext: { itemCount: 0, includedInPublicPreview: false },
    publication: { status: "preview_only", allowed: false, actions: [], reason: "Preview-only output." },
  },
} as const;
let server: Server | null = null;

/** #6261: put `injection` in every free-text field of a slop assessment that reaches plain-text output. */
function withTerminalInjection<T extends { band?: unknown; findings?: unknown }>(fixture: T, injection?: string): T {
  if (!injection) return fixture;
  return { ...fixture, band: injection, findings: [{ title: injection, detail: injection }] };
}

export async function closeFixtureServer() {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
}

export function run(args: string[], env: Record<string, string> = {}) {
  try {
    return execFileSync(process.execPath, [...NODE_STRIP_TYPES_ARGS, bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPOVER_API_TIMEOUT_MS: "1000",
        LOOPOVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "loopover-cli-config-")),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A failing command's message may land on stdout (--json contract) or stderr (plain text) —
    // fold both into the thrown Error's message so callers can keep matching it with toThrow(/regex/).
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    if (failure instanceof Error && failure.stdout) failure.message = `${failure.message}\n${failure.stdout}`;
    throw failure;
  }
}

export function runAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [...NODE_STRIP_TYPES_ARGS, bin, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPOVER_API_TIMEOUT_MS: "1000",
          LOOPOVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "loopover-cli-config-")),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Run a command expected to fail and return its exit code + both streams, instead of throwing —
 *  for asserting the shape of the failure output itself (e.g. the --json `{ ok: false, error }` contract). */
export function runExpectingFailure(args: string[], env: Record<string, string> = {}) {
  try {
    execFileSync(process.execPath, [...NODE_STRIP_TYPES_ARGS, bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPOVER_API_TIMEOUT_MS: "1000",
        LOOPOVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "loopover-cli-config-")),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; stdout?: string; stderr?: string };
    return { status: failure.status ?? null, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
  throw new Error(`expected \`node --experimental-strip-types ${bin} ${args.join(" ")}\` to fail`);
}

export function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function createPacketRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "loopover-cli-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "LoopOver Test");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "remote", "add", "origin", "git@github.com:JSONbored/loopover.git");
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
      LOOPOVER_API_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
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
    /** #6261: when set, the routes whose free text reaches plain-text terminal output return this string in
     *  those fields, standing in for a hostile API. Tests assert it can't reach the terminal un-neutered. */
    terminalInjection?: string;
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
    onIssueDraftRequest?: (body: { dryRun?: boolean; create?: boolean; limit?: number }) => void;
    onWatchRequest?: (req: { method: string; body: { repoFullName?: string; labels?: string[] } }) => void;
    onApiRequest?: (request: IncomingMessage) => void;
    validateConfigWarnings?: string[];
    openPrMonitor?: Record<string, unknown>;
    prOutcomes?: Record<string, unknown>;
    /** #6980: overrides POST /v1/preflight/review-risk and captures the request body. */
    reviewRisk?: Record<string, unknown>;
    onReviewRiskRequest?: (body: unknown) => void;
    /** #6745: overrides the notification feed / mark-read responses, and captures the mark-read POST body. */
    notifications?: Record<string, unknown>;
    notificationsRead?: Record<string, unknown>;
    onMarkNotificationsRead?: (body: unknown) => void;
    intakeStatus?: number;
    localBranchAnalysisStatus?: number;
    /** #6743: overrides the repo-doc refresh route's default "opened a new PR" response, e.g. to exercise
     *  the reused-PR or not-opened branches. */
    repoDocRefresh?: unknown;
    /** #6792: queued /v1/auth/github/device/poll responses, consumed one per request -- the last entry
     *  repeats once exhausted. Lets a test simulate a transient 429 (or GitHub's own slow_down/pending
     *  statuses) before the device flow eventually resolves. Requires deviceFlowStart to be set too. */
    deviceFlowStart?: { deviceCode: string; userCode: string; verificationUri: string; expiresIn?: number; interval?: number };
    deviceFlowPollResponses?: Array<{ status?: number; retryAfterSeconds?: number; body: unknown }>;
  } = {},
) {
  let deviceFlowPollCallCount = 0;
  server = createServer(async (request, response) => {
    options.onApiRequest?.(request);
    response.setHeader("content-type", "application/json");
    if (request.url && request.url.includes("loopover%2Fmcp/latest")) {
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
          service: "loopover-api",
          apiVersion: "0.1.0",
          mcp: {
            packageName: "@loopover/mcp",
            minimumSupportedVersion,
            latestRecommendedVersion,
            latestPackageVersion: latestRecommendedVersion,
            supportedVersionRange: `>=${minimumSupportedVersion}`,
            upgradeCommand: "npm install -g @loopover/mcp@latest",
            npxFallbackCommand: "npx @loopover/mcp@latest <command>",
          },
          compatibilityWarnings: [],
          breakingChanges: [],
          generatedAt: "2026-05-30T00:00:00.000Z",
        }),
      );
      return;
    }
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", service: "loopover-api", ...(options.minMcpVersion ? { minMcpVersion: options.minMcpVersion } : {}) }));
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
    if (request.url === "/v1/auth/github/device/start" && request.method === "POST" && options.deviceFlowStart) {
      const start = options.deviceFlowStart;
      response.end(JSON.stringify({ status: "pending", deviceCode: start.deviceCode, userCode: start.userCode, verificationUri: start.verificationUri, expiresIn: start.expiresIn ?? 900, interval: start.interval ?? 5 }));
      return;
    }
    if (request.url === "/v1/auth/github/device/poll" && request.method === "POST" && options.deviceFlowPollResponses) {
      await readJsonRequest(request);
      const responses = options.deviceFlowPollResponses;
      const next = responses[Math.min(deviceFlowPollCallCount, responses.length - 1)];
      deviceFlowPollCallCount += 1;
      response.statusCode = next?.status ?? 200;
      if (next?.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(next.retryAfterSeconds));
      response.end(JSON.stringify(next?.body ?? {}));
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/decision-pack" && request.method === "GET") {
      if (options.decisionPackStatus && options.decisionPackStatus >= 400) {
        response.statusCode = options.decisionPackStatus;
        if (options.decisionPackErrorContentType) response.setHeader("content-type", options.decisionPackErrorContentType);
        response.end(options.decisionPackErrorBody ?? JSON.stringify({ error: "decision_pack_unavailable" }));
        return;
      }
      response.end(
        JSON.stringify(
          options.terminalInjection
            ? { ...decisionPackFixture(), summary: options.terminalInjection, cache: { rerunGuidance: options.terminalInjection } }
            : decisionPackFixture(),
        ),
      );
      return;
    }
    const contributorProfileMatch = /^\/v1\/contributors\/([^/]+)\/profile$/.exec(new URL(request.url ?? "/", "http://localhost").pathname);
    if (contributorProfileMatch && request.method === "GET") {
      response.end(
        JSON.stringify({
          login: decodeURIComponent(contributorProfileMatch[1]!),
          generatedAt: "2026-05-30T00:00:00.000Z",
          summary: "3 registered repos; 12 merged PRs; strongest in review-tooling.",
        }),
      );
      return;
    }
    // #6746: GET/POST/DELETE /v1/contributors/:login/watches. GET returns a fixed list; POST/DELETE reflect the
    // forwarded {repoFullName, labels} so the CLI test can assert the exact body + verb it sent.
    const watchesMatch = /^\/v1\/contributors\/([^/]+)\/watches$/.exec(new URL(request.url ?? "/", "http://localhost").pathname);
    if (watchesMatch && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
      if (request.method === "GET") {
        response.end(JSON.stringify({ watching: [{ repoFullName: "acme/widgets", labels: ["bug"] }, { repoFullName: "acme/gadgets", labels: [] }] }));
        return;
      }
      const requestBody = (await readJsonRequest(request)) as { repoFullName?: string; labels?: string[] };
      options.onWatchRequest?.({ method: request.method, body: requestBody });
      if (request.method === "POST") {
        const labelSuffix = requestBody.labels && requestBody.labels.length > 0 ? ` (labels: ${requestBody.labels.join(", ")})` : "";
        response.end(JSON.stringify({ watching: [{ repoFullName: requestBody.repoFullName, labels: requestBody.labels ?? [] }], changed: `watching ${requestBody.repoFullName}${labelSuffix}` }));
      } else {
        response.end(JSON.stringify({ watching: [], changed: `unwatched ${requestBody.repoFullName}` }));
      }
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/open-pr-monitor" && request.method === "GET") {
      response.end(JSON.stringify({ ...openPrMonitorFixture(), ...(options.openPrMonitor ?? {}) }));
      return;
    }
    const prOutcomesMatch = request.url?.match(/^\/v1\/contributors\/([^/]+)\/pr-outcomes(?:\?(.*))?$/);
    if (prOutcomesMatch && request.method === "GET") {
      const login = decodeURIComponent(prOutcomesMatch[1]!);
      response.end(JSON.stringify({ ...prOutcomesFixture(login), ...(options.prOutcomes ?? {}) }));
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/notifications" && request.method === "GET") {
      response.end(JSON.stringify({ ...notificationsFixture(), ...(options.notifications ?? {}) }));
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/notifications/read" && request.method === "POST") {
      options.onMarkNotificationsRead?.(await readJsonRequest(request));
      response.end(JSON.stringify({ login: "jsonbored", marked: 2, ...(options.notificationsRead ?? {}) }));
      return;
    }
    if (request.url === "/v1/contributors/JSONbored/repos/JSONbored/loopover/decision" && request.method === "GET") {
      if (options.repoDecisionStatus && options.repoDecisionStatus >= 400) {
        response.statusCode = options.repoDecisionStatus;
        if (options.repoDecisionErrorContentType) response.setHeader("content-type", options.repoDecisionErrorContentType);
        response.end(options.repoDecisionErrorBody ?? JSON.stringify({ error: "repo_decision_unavailable" }));
        return;
      }
      const repoDecision = decisionPackFixture().repoDecisions[0];
      response.end(
        JSON.stringify({
          status: "ready",
          login: "JSONbored",
          repoFullName: "JSONbored/loopover",
          decision: options.terminalInjection ? { ...repoDecision, nextActions: [options.terminalInjection] } : repoDecision,
          ...(options.terminalInjection ? { cache: { rerunGuidance: options.terminalInjection } } : {}),
        }),
      );
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
      if (options.localBranchAnalysisStatus && options.localBranchAnalysisStatus >= 400) {
        response.statusCode = options.localBranchAnalysisStatus;
        response.end(JSON.stringify({ error: "local_branch_analysis_unavailable" }));
        return;
      }
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
      response.end(JSON.stringify(withTerminalInjection(slopRiskFixture(body), options.terminalInjection)));
      return;
    }
    if (request.url === "/v1/preflight/review-risk" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as {
        repoFullName?: string;
        title?: string;
        contributorLogin?: string;
      };
      options.onReviewRiskRequest?.(body);
      response.end(JSON.stringify({ ...reviewRiskFixture(body), ...(options.reviewRisk ?? {}) }));
      return;
    }
    if (request.url === "/v1/lint/improvement-potential" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as {
        changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>;
        tests?: string[];
        testFiles?: string[];
        patchCoverageDeltaPercent?: number;
      };
      response.end(JSON.stringify(withTerminalInjection(improvementPotentialFixture(body), options.terminalInjection)));
      return;
    }
    if (request.url === "/v1/lint/issue-slop" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as { title?: string; body?: string };
      response.end(JSON.stringify(withTerminalInjection(issueSlopFixture(body), options.terminalInjection)));
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
        { owner: "JSONbored", repo: "loopover", issueNumber: 100, title: "Improve REES test retry", rankScore: 85, laneFit: lane, freshness: 0.9, dupRisk: 0.1, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "loopover", issueNumber: 101, title: "Add label-audit coverage", rankScore: 72, laneFit: lane, freshness: 0.7, dupRisk: 0.2, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "loopover", issueNumber: 102, title: "Fix flaky buildBrief test", rankScore: 68, laneFit: lane, freshness: 0.5, dupRisk: 0.3, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "loopover", issueNumber: 103, title: "Normalize path matchers", rankScore: 55, laneFit: lane, freshness: 0.4, dupRisk: 0.1, aiPolicyAllowed: true },
        { owner: "JSONbored", repo: "loopover", issueNumber: 104, title: "Document score breakdown", rankScore: 45, laneFit: lane, freshness: 0.3, dupRisk: 0.1, aiPolicyAllowed: true },
      ];
      const ranked = candidates.filter((c) => c.rankScore >= minRank).slice(0, limit);
      response.end(JSON.stringify({ ranked, totalCandidates: candidates.length, appliedLane: lane, appliedMinRankScore: minRank }));
      return;
    }
    if (request.url === "/v1/issue-rag/retrieve" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as { owner?: string; repo?: string; title?: string };
      response.end(
        JSON.stringify({
          status: "ok",
          repoFullName: `${body.owner}/${body.repo}`,
          telemetry: {
            attempted: true,
            injected: true,
            candidates: 1,
            kept: 1,
            topScore: 0.9,
            minScore: 0.4,
            reranked: true,
            injectedChars: 120,
            retrievedPathCount: 1,
            retrievedPaths: ["src/helper.ts"],
          },
        }),
      );
      return;
    }
    // #784 maintainer controls (agent approval queue + kill-switch).
    if (request.url === "/v1/repos/owner/repo/agent/pending-actions" && request.method === "GET") {
      const action = { id: "pa-1", actionClass: "merge", pullNumber: 7, reason: "clean", status: "pending" };
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          pendingActions: [options.terminalInjection ? { ...action, reason: options.terminalInjection, actionClass: options.terminalInjection } : action],
        }),
      );
      return;
    }
    // #6744 propose: the CREATE side of the approval queue — bare path POST (no trailing slash), so it does NOT
    // collide with the decision `.../pending-actions/:id/:decision` POST stub below. Echoes the posted actionClass
    // + pullNumber so a test can assert the CLI serialized the right body.
    if (request.url === "/v1/repos/owner/repo/agent/pending-actions" && request.method === "POST") {
      const body = (await readJsonRequest(request)) as { pullNumber?: number; actionClass?: string; reason?: string | null };
      const action = { id: "pa-1", actionClass: body.actionClass ?? "merge", pullNumber: body.pullNumber ?? 7, status: "pending", reason: body.reason ?? null };
      response.end(JSON.stringify({ created: true, action: options.terminalInjection ? { ...action, actionClass: options.terminalInjection } : action }));
      return;
    }
    if (request.url === "/v1/repos/owner/repo/maintainer-noise" && request.method === "GET") {
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          generatedAt: "2026-06-01T00:00:00.000Z",
          score: 42,
          level: "medium",
          noiseSources: ["3 open PRs lack linked issue context."],
          maintainerActions: ["review_now"],
          queueHealth: { signals: { openPullRequests: 2 } },
          summary: "LoopOver maintainer noise report for owner/repo: medium noise (score 42); 1 source(s) to triage.",
        }),
      );
      return;
    }
    if (request.url === "/v1/repos/owner/repo/outcome-patterns" && request.method === "GET") {
      response.end(
        JSON.stringify({
          status: "ready",
          source: "snapshot",
          repoFullName: "owner/repo",
          generatedAt: "2026-06-01T00:00:00.000Z",
          ageSeconds: 120,
          freshness: "fresh",
          patterns: {
            repoFullName: "owner/repo",
            generatedAt: "2026-06-01T00:00:00.000Z",
            accepted: { count: 3, themes: ["tests"] },
            rejected: { count: 1, themes: ["scope"] },
            evidenceCompleteness: "partial",
          },
        }),
      );
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
    // #6743 repo-doc refresh (write). Defaults to the "opened a new PR" shape; a test can override via
    // options.repoDocRefresh to exercise the reused / not-opened branches.
    if (request.url === "/v1/repos/owner/repo/repo-docs/refresh" && request.method === "POST") {
      response.end(
        JSON.stringify(
          options.repoDocRefresh ?? {
            opened: true,
            reused: false,
            pullNumber: 42,
            url: "https://github.com/owner/repo/pull/42",
            claudeMode: "symlink",
          },
        ),
      );
      return;
    }
    // #6733 agent audit feed (read-only). Echoes the forwarded query so the CLI's pass-through is testable, and
    // mirrors the route's two shapes: a repo-wide feed, or a ?pull=N-scoped one that also echoes `pullNumber`.
    if (request.url?.startsWith("/v1/repos/owner/repo/agent/audit-feed") && request.method === "GET") {
      const params = new URL(request.url, "http://localhost").searchParams;
      const pull = params.get("pull");
      const limit = params.get("limit");
      const events = [
        { id: "ae-1", createdAt: "2026-05-30T00:00:00.000Z", eventType: "github_app.merged", actor: "loopover", outcome: "success", detail: "merged #7" },
        { id: "ae-2", createdAt: "2026-05-29T00:00:00.000Z", eventType: "github_app.review_evasion_closed", actor: "loopover", outcome: "denied", detail: null },
      ];
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          ...(pull ? { pullNumber: Number(pull) } : {}),
          echoedQuery: { since: params.get("since"), limit, pull },
          events: limit ? events.slice(0, Number(limit)) : events,
        }),
      );
      return;
    }
    // #6742 derived automation state (read-only). Returns the derived mode/readiness/acting-classes view.
    if (request.url?.startsWith("/v1/repos/owner/repo/automation-state") && request.method === "GET") {
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          configured: true,
          autonomy: { merge: "auto", close: "auto_with_approval" },
          autoMaintain: "auto",
          agentPaused: false,
          agentDryRun: false,
          mode: "live",
          permissionReadiness: "ready",
          actingActionClasses: ["merge", "close"],
          pendingActionCount: 3,
        }),
      );
      return;
    }
    // #554 gate precision telemetry (read-only). Echoes ?windowDays so the CLI window pass-through is testable.
    if (request.url?.startsWith("/v1/repos/owner/repo/gate-precision") && request.method === "GET") {
      const windowDays = new URL(request.url, "http://localhost").searchParams.get("windowDays");
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          generatedAt: "2026-05-30T00:00:00.000Z",
          windowDays: windowDays ? Number(windowDays) : null,
          perGateType: [
            { gateType: "duplicate-pr", blocked: 8, blockedThenMerged: 2, overridden: 1, falsePositiveRate: 0.25 },
            { gateType: "missing-linked-issue", blocked: 3, blockedThenMerged: 0, overridden: 0, falsePositiveRate: null },
          ],
          overall: { blocked: 11, blockedThenMerged: 2, falsePositiveRate: 0.182 },
          signals: ["Highest false-positive gate: `duplicate-pr` — 25% of its 8 blocks merged anyway (1 overridden). Keep it advisory until this drops."],
        }),
      );
      return;
    }
    if (request.url?.startsWith("/v1/repos/owner/repo/outcome-calibration") && request.method === "GET") {
      const windowDays = new URL(request.url, "http://localhost").searchParams.get("windowDays");
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          generatedAt: "2026-05-30T00:00:00.000Z",
          windowDays: windowDays ? Number(windowDays) : null,
          slop: [
            { band: "clean", sampleSize: 12, merged: 9, closed: 3, mergeRate: 0.75 },
            { band: "high", sampleSize: 4, merged: 1, closed: 3, mergeRate: 0.25 },
          ],
          recommendations: { total: 20, positive: 14, negative: 3, pending: 3, positiveRate: 0.82 },
          signals: ["Higher-slop bands merge less often — the slop signal is tracking real outcomes."],
        }),
      );
      return;
    }
    if (request.url === "/v1/repos/owner/repo/contributor-issue-drafts/generate" && request.method === "POST") {
      // Reflect the forwarded {dryRun, create, limit} back so the CLI test can assert the exact body it sent.
      // The draft title carries an ANSI escape to prove the plain-text path is sanitized (#6261).
      const requestBody = (await readJsonRequest(request)) as { dryRun?: boolean; create?: boolean; limit?: number };
      options.onIssueDraftRequest?.(requestBody);
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          generatedAt: "2026-05-30T00:00:00.000Z",
          dryRun: requestBody.dryRun ?? true,
          createRequested: requestBody.create ?? false,
          proposed: 1,
          skippedDuplicate: 0,
          skippedDeclined: 0,
          skippedUnsafe: 0,
          created: requestBody.create ? 1 : 0,
          skippedCreateFailed: 0,
          drafts: [
            {
              status: "proposed",
              title: "Add [31mcursor[0m pagination",
              ...(requestBody.create ? { issue: { number: 42, url: "https://github.com/owner/repo/issues/42" } } : {}),
            },
          ],
        }),
      );
      return;
    }
    const onboardingPackUrl = new URL(request.url ?? "/", "http://localhost");
    if (onboardingPackUrl.pathname === "/v1/repos/owner/repo/onboarding-pack/preview" && request.method === "GET") {
      const refresh = onboardingPackUrl.searchParams.get("refresh");
      if (refresh === null || refresh === "true") {
        response.end(JSON.stringify(repoOnboardingPackFixture));
        return;
      }
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
          burdenForecast: {
            projectedReviewLoad: "elevated",
            queueGrowthRisk: "medium",
            stalePrSignals: ["#101 idle 21d"],
          },
          burdenForecastFreshness: {
            source: "cache",
            generatedAt: "2026-05-30T00:00:00.000Z",
            ageSeconds: 120,
            freshness: "fresh",
          },
        }),
      );
      return;
    }
    if (request.url === "/v1/repos/owner/repo/issue-quality" && request.method === "GET") {
      if (options.intakeStatus && options.intakeStatus >= 400) {
        response.statusCode = options.intakeStatus;
        response.end(JSON.stringify({ error: "issue_quality_unavailable" }));
        return;
      }
      response.end(JSON.stringify({ repoFullName: "owner/repo", generatedAt: "2026-05-30T00:00:00.000Z", issues: [{ number: 12, actionability: "high" }] }));
      return;
    }
    if (request.url === "/v1/repos/owner/repo/registration-readiness" && request.method === "GET") {
      if (options.intakeStatus && options.intakeStatus >= 400) {
        response.statusCode = options.intakeStatus;
        response.end(JSON.stringify({ error: "registration_readiness_unavailable" }));
        return;
      }
      response.end(JSON.stringify({ repoFullName: "owner/repo", registered: false, directPrLaneReady: true, appInstalled: false }));
      return;
    }
    if (request.url === "/v1/repos/owner/repo/gittensor-config-recommendation" && request.method === "GET") {
      if (options.intakeStatus && options.intakeStatus >= 400) {
        response.statusCode = options.intakeStatus;
        response.end(JSON.stringify({ error: "config_recommendation_unavailable" }));
        return;
      }
      response.end(JSON.stringify({ repoFullName: "owner/repo", privateOnly: true, recommendations: [] }));
      return;
    }
    if (request.url?.startsWith("/v1/app/skipped-pr-audit") && request.method === "GET") {
      if (options.intakeStatus && options.intakeStatus >= 400) {
        response.statusCode = options.intakeStatus;
        response.end(JSON.stringify({ error: "skipped_pr_audit_unavailable" }));
        return;
      }
      response.end(JSON.stringify({ generatedAt: "2026-05-30T00:00:00.000Z", limit: 20, hasMore: false, items: [{ prNumber: 7, reason: "duplicate", remediation: "link the canonical PR" }] }));
      return;
    }
    // #6750: the boundary-tests lint mirror proxies here; echo a fired finding + spec.
    if (request.url === "/v1/lint/boundary-tests" && request.method === "POST") {
      response.end(
        JSON.stringify({
          finding: { code: "boundary_test_generation", severity: "advisory", summary: "Boundary-condition code changed without test evidence." },
          spec: { action: "scaffold_boundary_tests", hints: ["Cover the empty and one-element cases."], boundary: "Your agent scaffolds the tests; loopover never writes code." },
        }),
      );
      return;
    }
    // #6751: the open-PR-pressure mirror proxies here.
    if (request.url === "/v1/lint/open-pr-pressure" && request.method === "POST") {
      response.end(JSON.stringify({ repoFullName: "acme/widgets", summary: "Ranked 2 scenarios.", scenarios: [{ id: "close_stale", rank: 1 }] }));
      return;
    }
    if (request.url === "/v1/repos/owner/repo/pulls/7/reviewability" && request.method === "GET") {
      response.end(
        JSON.stringify({
          repoFullName: "owner/repo",
          pullNumber: 7,
          generatedAt: "2026-05-30T00:00:00.000Z",
          readiness: "ready",
          blockers: [],
          advisories: [],
          summary: "PR 7 is ready to review.",
        }),
      );
      return;
    }
    // #6619: the route carries the author login as a query param, so match on the path prefix.
    if (request.url?.startsWith("/v1/repos/owner/repo/pulls/7/ai-review-findings") && request.method === "GET") {
      response.end(
        JSON.stringify({
          status: "ready",
          repoFullName: "owner/repo",
          pullNumber: 7,
          login: "octocat",
          headSha: "abc123",
          findings: [{ category: "correctness", path: "src/index.ts", severity: "blocker", line: 12, body: "Null deref." }],
          categoryCounts: { correctness: 1 },
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
    repoFullName: "JSONbored/loopover",
    generatedAt: "2026-06-01T00:00:00.000Z",
    summary: "Local branch preflight fixture.",
    nextActions: [{ actionKind: "prepare_pr_packet", whyThisHelps: ["Keeps public packet safe."] }],
    // #6741: fields required by buildPublicPrBodyDraft (linkedIssues/collisions + packet slices).
    preflight: {
      status: "ready",
      findings: [],
      linkedIssues: [42],
      collisions: [],
      reviewBurden: "low",
    },
    prPacket: {
      titleSuggestion: "Local branch preflight",
      markdown: "# Public-safe PR packet\n",
      bodySections: [{ heading: "Changed Paths", lines: ["- src/widget.ts (modified, +8/-1)"] }],
      validationSummary: {
        passed: 1,
        failed: 0,
        notRun: 0,
        commands: [{ command: "npm test", status: "passed", summary: "ok" }],
      },
      publicSafeWarnings: [],
      reviewerNotes: [],
    },
    baseFreshness: {
      status: "fresh",
      changedFileCount: 1,
      testFileCount: 0,
      passedValidationCount: 1,
      warnings: [],
      recommendation: undefined,
    },
    manifestGuidance: {
      present: false,
      source: "none",
      linkedIssuePolicy: "optional",
      issueDiscoveryPolicy: "neutral",
      matchedWantedPaths: [],
      preferredLabelHits: [],
      findings: [],
      publicNextSteps: [],
      warnings: [],
      summary: "",
    },
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
    predictedGate: {
      pack: "gittensor",
      conclusion: "advisory_pass",
      title: "Predicted gate: advisory pass",
      summary: "No hard blockers predicted for this planned PR.",
      readinessScore: 72,
      blockers: [],
      warnings: [{ code: "missing_tests", title: "Missing tests", detail: "No test files accompany the changed paths." }],
    },
  };
}

/** Mirrors the ContributorOpenPrMonitor shape src/signals/contributor-open-pr-monitor.ts returns. */
export function openPrMonitorFixture() {
  return {
    login: "JSONbored",
    generatedAt: "2026-06-01T00:00:00.000Z",
    openPrCount: 1,
    registeredRepoCount: 2,
    cleanupFirst: true,
    summary: "1 open PR needs attention before starting new work.",
    guidance: ["Clear the failing check on JSONbored/loopover#42 before opening anything new."],
    pendingScenarios: [],
    pullRequests: [
      {
        repoFullName: "JSONbored/loopover",
        number: 42,
        title: "fix(queue): drain stale entries",
        classification: "failing_checks",
        summary: "CI is red on this PR.",
        reasons: ["1 check is failing."],
        nextSteps: ["Fix the failing check, then push."],
      },
    ],
  };
}

/** Mirrors GET /v1/contributors/:login/pr-outcomes / buildContributorPrOutcomes. */
export function prOutcomesFixture(login = "JSONbored") {
  return {
    login: login.toLowerCase(),
    count: 1,
    summary: `LoopOver post-merge outcomes for ${login}: 1 merged PR(s).`,
    outcomes: [
      {
        repoFullName: "JSONbored/loopover",
        pullNumber: 42,
        outcome: "merged" as const,
        attribution: "Your pull request JSONbored/loopover#42 merged. Merged contributions strengthen your standing.",
        deeplink: "https://github.com/JSONbored/loopover/pull/42",
        recordedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
  };
}

/** #6980: mirrors POST /v1/preflight/review-risk / buildReviewRiskExplanation. */
export function reviewRiskFixture(input: { repoFullName?: string; title?: string; contributorLogin?: string } = {}) {
  const repoFullName = input.repoFullName ?? "JSONbored/loopover";
  return {
    preflight: {
      repoFullName,
      generatedAt: "2026-06-01T00:00:00.000Z",
      status: "ready" as const,
      lane: { lane: "direct_pr", reasons: ["Fixture lane."] },
      reviewBurden: "low" as const,
      linkedIssues: [] as number[],
      findings: [] as unknown[],
      collisions: [] as unknown[],
    },
    roleContext: input.contributorLogin
      ? {
          login: input.contributorLogin.toLowerCase(),
          repoFullName,
          generatedAt: "2026-06-01T00:00:00.000Z",
          role: "outside_contributor" as const,
          maintainerLane: false,
          normalContributorEvidenceAllowed: true,
          source: "unknown" as const,
          reasons: ["Fixture role context."],
          guidance: "Outside-contributor work is scoreable when the lane fits.",
        }
      : null,
    recommendation: "review" as const,
    summary: `LoopOver review-risk explanation for ${repoFullName}.`,
  };
}

/** #6745: mirrors the NotificationFeed { login, unreadCount, notifications } shape the route/tool returns. */
export function notificationsFixture() {
  return {
    login: "jsonbored",
    unreadCount: 1,
    notifications: [
      {
        id: "d-42",
        eventType: "pull_request_merged",
        repoFullName: "JSONbored/loopover",
        pullNumber: 42,
        title: "Your pull request JSONbored/loopover#42 was merged.",
        body: "Nice work.",
        deeplink: "https://github.com/JSONbored/loopover/pull/42",
        status: "delivered",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "d-7",
        eventType: "pull_request_changes_requested",
        repoFullName: "JSONbored/loopover",
        pullNumber: 7,
        title: "Changes requested on JSONbored/loopover#7.",
        body: "Please address review.",
        deeplink: "https://github.com/JSONbored/loopover/pull/7",
        status: "read",
        createdAt: "2026-05-20T00:00:00.000Z",
      },
    ],
  };
}

/** #6745: mirrors the { login, marked } shape POST /notifications/read returns. */
export function notificationsReadFixture() {
  return { login: "jsonbored", marked: 2 };
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
        repoFullName: "JSONbored/loopover",
        recommendation: "pursue",
        nextActions: ["Pick one narrow change."],
        changedFiles: [{ path: "src/cache.ts", content: "must stay local" }],
        localPath: "/tmp/source/private.ts",
      },
    ],
    topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "JSONbored/loopover", priorityScore: 50 }],
    cleanupFirst: [],
    pursueRepos: [{ repoFullName: "JSONbored/loopover", recommendation: "pursue" }],
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
  // #6990: the route returns band + findings only (numeric score + rubric withheld); the fixture mirrors that.
  return {
    band: slopRisk <= 0 ? "clean" : slopRisk < 25 ? "low" : slopRisk < 60 ? "elevated" : "high",
    findings,
  };
}

/** #6748: fixture for POST /v1/lint/improvement-potential — mirrors a mild positive signal when tests accompany code. */
export function improvementPotentialFixture(input: {
  changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>;
  tests?: string[];
  testFiles?: string[];
  patchCoverageDeltaPercent?: number;
} = {}) {
  const changedFiles = input.changedFiles ?? [];
  const hasCodeChange = changedFiles.some((file) => /\.(ts|tsx|js|jsx)$/i.test(file.path) && !file.path.includes(".test."));
  const hasTestEvidence =
    changedFiles.some((file) => file.path.includes(".test.")) || (input.testFiles?.length ?? 0) > 0 || (input.tests?.length ?? 0) > 0;
  const coverageUp = typeof input.patchCoverageDeltaPercent === "number" && input.patchCoverageDeltaPercent > 0;
  if (!hasCodeChange && !coverageUp) {
    return { improvementScore: 0, band: "insufficient-signal", findings: [] };
  }
  if (hasCodeChange && hasTestEvidence) {
    return {
      improvementScore: 10,
      band: "minor",
      findings: [
        {
          code: "added_test_evidence",
          title: "Added test evidence",
          severity: "info",
          detail: "Fixture: code change accompanied by tests.",
        },
      ],
    };
  }
  if (coverageUp) {
    return {
      improvementScore: 20,
      band: "minor",
      findings: [
        {
          code: "increased_patch_coverage",
          title: "Increased patch coverage",
          severity: "info",
          detail: "Fixture: patch coverage delta is positive.",
        },
      ],
    };
  }
  return { improvementScore: 0, band: "none", findings: [] };
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
  // #6990: blunted like the route — band + findings only, no numeric score or rubric.
  return {
    band: slopRisk <= 0 ? "clean" : slopRisk < 25 ? "low" : slopRisk < 60 ? "elevated" : "high",
    findings,
  };
}
