import { afterEach, describe, expect, it, vi } from "vitest";
import {
  upsertBounty,
  upsertCheckSummary,
  upsertInstallation,
  upsertInstallationHealth,
  upsertPullRequestFile,
  upsertPullRequestReview,
  upsertPullRequestDetailSyncState,
  upsertRecentMergedPullRequest,
  persistRepoGithubTotalsSnapshot,
  persistSignalSnapshot,
  listLatestSignalSnapshotsByTarget,
  upsertRepoLabel,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  persistScoringModelSnapshot,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { createApp } from "../../src/api/routes";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("api routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves health openly and keeps OpenAPI private", async () => {
    const app = createApp();
    const env = createTestEnv();

    const preflight = await app.request("/v1/repos", { method: "OPTIONS", headers: { origin: "https://gittensory.aethereal.dev" } }, env);
    expect(preflight.status).toBe(204);

    const health = await app.request("/health", {}, env);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok", service: "gittensory-api" });

    const unauthenticatedSpec = await app.request("/openapi.json", {}, env);
    expect(unauthenticatedSpec.status).toBe(401);

    const spec = await app.request("/openapi.json", { headers: apiHeaders(env) }, env);
    expect(spec.status).toBe(200);
    await expect(spec.json()).resolves.toMatchObject({ info: { title: "Gittensory API" } });
  });

  it("serves registry drift through the canonical registry change endpoint", async () => {
    const app = createApp();
    const env = createTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/removed": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "owner/changed": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "owner/stable": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://old-registry" },
        "2026-05-24T00:00:00.000Z",
      ),
    );
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/added": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "owner/changed": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "owner/stable": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://current-registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    const changes = await app.request("/v1/registry/changes", { headers: apiHeaders(env) }, env);
    expect(changes.status).toBe(200);
    await expect(changes.json()).resolves.toMatchObject({
      summary: expect.stringContaining("added"),
      addedRepos: ["owner/added"],
      removedRepos: ["owner/removed"],
      changedRepos: [expect.objectContaining({ repoFullName: "owner/changed" })],
    });

    const legacyPerRepoDrift = await app.request("/v1/repos/owner/changed/registry-drift", { headers: apiHeaders(env) }, env);
    expect(legacyPerRepoDrift.status).toBe(404);
  });

  it("queues signed GitHub webhooks and rejects invalid signatures", async () => {
    const app = createApp();
    const queued: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          queued.push(message);
        },
      } as unknown as Queue,
    });
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 123 },
      repository: { full_name: "JSONbored/gittensory", name: "gittensory" },
    });
    const signature = await signWebhook(body, env.GITHUB_WEBHOOK_SECRET);

    const accepted = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body,
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signature,
        },
      },
      env,
    );

    expect(accepted.status).toBe(202);
    expect(queued).toHaveLength(1);

    const missingHeaders = await app.request("/v1/github/webhook", { method: "POST", body }, env);
    expect(missingHeaders.status).toBe(400);

    const duplicate = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body,
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signature,
        },
      },
      env,
    );

    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ status: "duplicate" });
    expect(queued).toHaveLength(1);

    const rejected = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body,
        headers: {
          "x-github-delivery": "delivery-2",
          "x-github-event": "pull_request",
          "x-hub-signature-256": "sha256=bad",
        },
      },
      env,
    );

    expect(rejected.status).toBe(401);
  });

  it("serves deterministic signal endpoints from cached registry and GitHub metadata", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedSignalData(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            hotkey: "hotkey",
            githubUsername: "oktofeesh1",
            githubId: "12345",
            totalPrs: 2,
            totalMergedPrs: 1,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 1,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/12345") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "entrius/allways-ui",
              totalPrs: "2",
              totalMergedPrs: "1",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "1",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/12345/prs") {
        return Response.json([{ repository: "entrius/allways-ui", pullRequestNumber: 12, pullRequestTitle: "Fix dashboard cache", prState: "OPEN", label: "bug" }]);
      }
      if (url === "https://mirror.gittensor.io/api/v1/miners/12345/issues") {
        return Response.json({ issues: [{ labels: [{ name: "bug" }] }] });
      }
      if (url.endsWith("/users/oktofeesh1")) {
        return Response.json({ login: "oktofeesh1", public_repos: 42, followers: 7 });
      }
      if (url.includes("/users/oktofeesh1/repos")) {
        return Response.json([{ language: "TypeScript" }, { language: "Python" }, { language: "TypeScript" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const unauthenticated = await app.request("/v1/repos/entrius/allways-ui/intelligence", {}, env);
    expect(unauthenticated.status).toBe(401);

    const intelligence = await app.request("/v1/repos/entrius/allways-ui/intelligence", { headers: apiHeaders(env) }, env);
    expect(intelligence.status).toBe(200);
    await expect(intelligence.json()).resolves.toMatchObject({
      status: "ready",
      repoFullName: "entrius/allways-ui",
      lane: { lane: "direct_pr" },
      queueHealth: { signals: { openPullRequests: 2 } },
      collisions: { summary: { clusterCount: expect.any(Number) } },
      configQuality: { notObservedConfiguredLabels: expect.arrayContaining(["refactor"]) },
      labelAudit: { missingConfiguredLabels: expect.arrayContaining(["refactor"]) },
      dataQuality: expect.any(Object),
    });

    const settingsPreviewUnauthenticated = await app.request("/v1/repos/entrius/allways-ui/settings-preview", { method: "POST", body: "{}" }, env);
    expect(settingsPreviewUnauthenticated.status).toBe(401);

    const minerPreview = await app.request(
      "/v1/repos/entrius/allways-ui/settings-preview",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ sample: { authorLogin: "oktofeesh1", minerStatus: "confirmed", title: "Fix cache", labels: ["bug"], linkedIssues: [7] } }) },
      env,
    );
    expect(minerPreview.status).toBe(200);
    const minerPreviewBody = (await minerPreview.json()) as { decision: { willComment: boolean; skipped: boolean }; previewComment: string | null; settings: { publicSurface: string } };
    expect(minerPreviewBody.decision.skipped).toBe(false);
    expect(minerPreviewBody.decision.willComment).toBe(true);
    expect(minerPreviewBody.previewComment).toContain("Gittensory contribution context");
    expect(minerPreviewBody.previewComment).not.toMatch(/wallet|hotkey|trust score|scoreability|payout/i);

    const invalidPreview = await app.request(
      "/v1/repos/entrius/allways-ui/settings-preview",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ sample: { minerStatus: "maybe" } }) },
      env,
    );
    expect(invalidPreview.status).toBe(400);

    const unknownRepoPreview = await app.request("/v1/repos/missing/repo/settings-preview", { method: "POST", headers: apiHeaders(env), body: "{" }, env);
    expect(unknownRepoPreview.status).toBe(200);
    await expect(unknownRepoPreview.json()).resolves.toMatchObject({
      installation: null,
      sample: { authorLogin: "sample-contributor", minerStatus: "confirmed" },
    });

    const botPreview = await app.request(
      "/v1/repos/entrius/allways-ui/settings-preview",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ sample: { authorLogin: "robot", authorType: "Bot", minerStatus: "confirmed" } }) },
      env,
    );
    expect(botPreview.status).toBe(200);
    await expect(botPreview.json()).resolves.toMatchObject({ decision: { skipped: true, skipReason: "bot_author" }, previewComment: null });

    const registrationReadiness = await app.request("/v1/repos/entrius/allways-ui/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(registrationReadiness.status).toBe(200);
    await expect(registrationReadiness.json()).resolves.toMatchObject({
      repoFullName: "entrius/allways-ui",
      recommendedRegistrationMode: "direct_pr",
      issuePolicy: "direct_pr_no_issue_required",
      labelPolicy: { label: "gittensor" },
      docsCompleteness: { status: "repo_docs_not_crawled" },
      dataQuality: expect.any(Object),
    });

    const configRecommendation = await app.request("/v1/repos/entrius/allways-ui/gittensor-config-recommendation", { headers: apiHeaders(env) }, env);
    expect(configRecommendation.status).toBe(200);
    await expect(configRecommendation.json()).resolves.toMatchObject({
      repoFullName: "entrius/allways-ui",
      privateOnly: true,
      recommended: {
        participationMode: "direct_pr",
        issueDiscoveryShare: 0,
        confirmedMinerLabel: "gittensor",
      },
      reasons: expect.arrayContaining([expect.stringMatching(/Direct-PR|Direct-PR|Direct/i)]),
    });

    for (const path of [
      "/v1/repos/entrius/allways-ui/queue-health",
      "/v1/repos/entrius/allways-ui/collisions",
      "/v1/repos/entrius/allways-ui/config-quality",
      "/v1/repos/entrius/allways-ui/lane",
      "/v1/repos/entrius/allways-ui/labels/audit",
      "/v1/repos/entrius/allways-ui/workboard",
      "/v1/repos/entrius/allways-ui/maintainer-packet",
      "/v1/repos/entrius/allways-ui/maintainer-lane",
      "/v1/repos/entrius/allways-ui/maintainer-cut-readiness",
      "/v1/repos/entrius/allways-ui/contributor-intake-health",
      "/v1/repos/entrius/allways-ui/maintainer-noise",
    ]) {
      const legacy = await app.request(path, { headers: apiHeaders(env) }, env);
      expect(legacy.status).toBe(404);
    }

    const maintainerPacket = await app.request("/v1/repos/entrius/allways-ui/pulls/12/maintainer-packet", { headers: apiHeaders(env) }, env);
    expect(maintainerPacket.status).toBe(200);
    await expect(maintainerPacket.json()).resolves.toMatchObject({ pullNumber: 12, reviewSignals: { linkedIssues: [7] } });

    const reviewIntelligence = await app.request("/v1/repos/entrius/allways-ui/pulls/12/review-intelligence", { headers: apiHeaders(env) }, env);
    expect(reviewIntelligence.status).toBe(404);

    const reviewability = await app.request("/v1/repos/entrius/allways-ui/pulls/12/reviewability", { headers: apiHeaders(env) }, env);
    expect(reviewability.status).toBe(200);
    await expect(reviewability.json()).resolves.toMatchObject({ repoFullName: "entrius/allways-ui", pullNumber: 12, action: expect.any(String), privateSummary: expect.any(String) });

    const preflight = await app.request(
      "/v1/preflight/pr",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          repoFullName: "entrius/allways-ui",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          changedFiles: ["src/cache.ts"],
        }),
      },
      env,
    );
    expect(preflight.status).toBe(200);
    await expect(preflight.json()).resolves.toMatchObject({ status: "needs_work" });

    const contributorProfile = await app.request("/v1/contributors/oktofeesh1/profile", { headers: apiHeaders(env) }, env);
    expect(contributorProfile.status).toBe(200);
    await expect(contributorProfile.json()).resolves.toMatchObject({ login: "oktofeesh1", github: { topLanguages: ["TypeScript", "Python"] } });

    const missingDecisionPack = await app.request("/v1/contributors/oktofeesh1/decision-pack", { headers: apiHeaders(env) }, env);
    expect(missingDecisionPack.status).toBe(202);
    await expect(missingDecisionPack.json()).resolves.toMatchObject({
      status: "needs_snapshot_refresh",
      login: "oktofeesh1",
      reason: "missing_snapshot",
      freshness: "missing",
      rebuildEnqueued: true,
    });

    const builtDecisionPack = await app.request(
      "/v1/internal/jobs/build-contributor-decision-packs/run",
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ login: "oktofeesh1" }),
      },
      env,
    );
    expect(builtDecisionPack.status).toBe(200);
    const builtDecisionPayload = (await builtDecisionPack.json()) as {
      profile: { github: { topLanguages: string[] }; officialStats?: Record<string, unknown> | null };
      outcomeHistory: { totals: Record<string, unknown> };
      topActions: unknown[];
    };
    expect(builtDecisionPayload.profile.github.topLanguages).toEqual(["TypeScript", "Python"]);
    expect(builtDecisionPayload.profile.officialStats).not.toHaveProperty("hotkey");
    expect(builtDecisionPayload.outcomeHistory.totals).toMatchObject({ pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1 });
    expect(builtDecisionPayload.topActions.length).toBeGreaterThan(0);

    const decisionPack = await app.request("/v1/contributors/oktofeesh1/decision-pack", { headers: apiHeaders(env) }, env);
    expect(decisionPack.status).toBe(200);
    await expect(decisionPack.json()).resolves.toMatchObject({ status: "ready", login: "oktofeesh1", profile: { github: { topLanguages: ["TypeScript", "Python"] } } });

    const repoDecision = await app.request("/v1/contributors/oktofeesh1/repos/entrius/allways-ui/decision", { headers: apiHeaders(env) }, env);
    expect(repoDecision.status).toBe(200);
    await expect(repoDecision.json()).resolves.toMatchObject({
      status: "ready",
      login: "oktofeesh1",
      repoFullName: "entrius/allways-ui",
      decision: { repoFullName: "entrius/allways-ui", rewardUpside: expect.any(Object), roleContext: { role: "outside_contributor" } },
    });

    const agentPlan = await app.request(
      "/v1/agent/plan-next-work",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ login: "oktofeesh1", repoFullName: "entrius/allways-ui" }),
      },
      env,
    );
    expect(agentPlan.status).toBe(200);
    const agentPlanPayload = (await agentPlan.json()) as {
      run: { id: string; status: string; mode: string; surface: string };
      actions: Array<{ actionType: string; publicSafeSummary: string; payload: Record<string, unknown> }>;
    };
    expect(agentPlanPayload.run).toMatchObject({ status: "completed", mode: "copilot", surface: "api" });
    expect(agentPlanPayload.actions.length).toBeGreaterThan(0);
    expect(agentPlanPayload.actions[0]?.publicSafeSummary).not.toMatch(/wallet|hotkey|reward estimate|payout|farming|raw trust score/i);
    expect(agentPlanPayload.actions[0]?.payload).toHaveProperty("decision");

    const fetchedAgentRun = await app.request(`/v1/agent/runs/${agentPlanPayload.run.id}`, { headers: apiHeaders(env) }, env);
    expect(fetchedAgentRun.status).toBe(200);
    await expect(fetchedAgentRun.json()).resolves.toMatchObject({ run: { id: agentPlanPayload.run.id }, actions: expect.any(Array) });

    const missingRepoDecisionSnapshot = await app.request("/v1/contributors/new-user/repos/entrius/allways-ui/decision", { headers: apiHeaders(env) }, env);
    expect(missingRepoDecisionSnapshot.status).toBe(202);
    await expect(missingRepoDecisionSnapshot.json()).resolves.toMatchObject({
      status: "needs_snapshot_refresh",
      repoFullName: "entrius/allways-ui",
      freshness: "missing",
      rebuildEnqueued: true,
    });

    for (const path of [
      "/v1/contributors/oktofeesh1/opportunities",
      "/v1/contributors/oktofeesh1/fit",
      "/v1/contributors/oktofeesh1/scoring-profile",
      "/v1/contributors/oktofeesh1/strategy",
      "/v1/contributors/oktofeesh1/reward-risk-strategy",
      "/v1/contributors/oktofeesh1/actions/recommendations",
      "/v1/contributors/oktofeesh1/role-context",
      "/v1/contributors/oktofeesh1/outcome-history",
      "/v1/contributors/oktofeesh1/success-patterns",
      "/v1/contributors/oktofeesh1/failure-patterns",
      "/v1/contributors/oktofeesh1/repos/entrius/allways-ui/role-context",
      "/v1/contributors/oktofeesh1/repos/entrius/allways-ui/recommendation",
      "/v1/contributors/oktofeesh1/repos/entrius/allways-ui/reward-risk",
    ]) {
      const legacy = await app.request(path, { headers: apiHeaders(env) }, env);
      expect(legacy.status).toBe(404);
    }

    const localDiff = await app.request(
      "/v1/preflight/local-diff",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          repoFullName: "entrius/allways-ui",
          title: "Fix dashboard cache refresh after reconnect",
          commitMessage: "Fixes #7",
          changedFiles: ["src/cache.ts", "test/cache.test.ts"],
          changedLineCount: 42,
        }),
      },
      env,
    );
    expect(localDiff.status).toBe(200);
    await expect(localDiff.json()).resolves.toMatchObject({ localDiff: { testFileCount: 1, inferredLinkedIssues: [7] } });

    const invalidPreflight = await app.request("/v1/preflight/pr", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({}) }, env);
    expect(invalidPreflight.status).toBe(400);

    const invalidLocalDiff = await app.request("/v1/preflight/local-diff", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({}) }, env);
    expect(invalidLocalDiff.status).toBe(400);

    const localBranchAnalysis = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          baseRef: "origin/test",
          headRef: "fix-cache",
          branchName: "fix-cache-reconnect",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          labels: ["bug"],
          changedFiles: [
            { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
            { path: "test/cache.test.ts", additions: 20, deletions: 0, status: "added" },
          ],
          validation: [{ command: "npm test -- cache", status: "passed", summary: "cache regression passed" }],
          localScorer: { mode: "external_command", sourceTokenScore: 42, totalTokenScore: 66, sourceLines: 44, testTokenScore: 20 },
        }),
      },
      env,
    );
    expect(localBranchAnalysis.status).toBe(200);
    const localBranchPayload = (await localBranchAnalysis.json()) as {
      prPacket: unknown;
    };
    expect(localBranchPayload).toMatchObject({
      login: "oktofeesh1",
      repoFullName: "entrius/allways-ui",
      preflight: { localDiff: { testFileCount: 1, inferredLinkedIssues: [7] } },
      scorePreview: { privateOnly: true },
      rewardRisk: { rewardUpside: { relevantLane: "direct_pr" } },
      prPacket: { titleSuggestion: "Fix dashboard cache refresh after reconnect" },
    });

    const agentPacket = await app.request(
      "/v1/agent/prepare-pr-packet",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          baseRef: "origin/test",
          headRef: "fix-cache",
          branchName: "fix-cache-reconnect",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          changedFiles: [
            { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
            { path: "test/cache.test.ts", additions: 20, deletions: 0, status: "added" },
          ],
          validation: [{ command: "npm test -- cache", status: "passed", summary: "cache regression passed" }],
        }),
      },
      env,
    );
    expect(agentPacket.status).toBe(200);
    await expect(agentPacket.json()).resolves.toMatchObject({
      run: { status: "completed" },
      actions: [expect.objectContaining({ actionType: "prepare_pr_packet", safetyClass: "public_safe" })],
    });
    expect(JSON.stringify(localBranchPayload.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);

    const localBranchWithMcpToken = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.GITTENSORY_MCP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache-reconnect",
          changedFiles: [{ path: "src/cache.ts", additions: 1, deletions: 0 }],
        }),
      },
      env,
    );
    expect(localBranchWithMcpToken.status).toBe(200);

    const localBranchWithHeadRefOnly = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          headRef: "head-only",
          changedFiles: [{ path: "src/cache.ts", additions: 1, deletions: 0 }],
        }),
      },
      env,
    );
    expect(localBranchWithHeadRefOnly.status).toBe(200);

    const localBranchWithLocalTarget = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          changedFiles: [{ path: "src/cache.ts", additions: 1, deletions: 0 }],
        }),
      },
      env,
    );
    expect(localBranchWithLocalTarget.status).toBe(200);

    const oversizedLocalBranch = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "a".repeat(257),
          changedFiles: [{ path: "src/cache.ts", additions: 1, deletions: 0 }],
        }),
      },
      env,
    );
    expect(oversizedLocalBranch.status).toBe(400);

    const sourceContentRejected = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          changedFiles: [{ path: "src/cache.ts", additions: 1, deletions: 0, content: "source should not be accepted" }],
        }),
      },
      env,
    );
    expect(sourceContentRejected.status).toBe(400);

    const imported = await app.request(
      "/v1/internal/bounties/import",
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` },
        body: JSON.stringify({
          success: true,
          issue_count: 1,
          issues: [
            {
              id: 2,
              repository_full_name: "entrius/allways-ui",
              issue_number: 8,
              status: "Cancelled",
              bounty_alpha: "0.0000",
              target_alpha: "17.0000",
            },
          ],
        }),
      },
      env,
    );
    expect(imported.status).toBe(200);
    await expect(imported.json()).resolves.toMatchObject({ imported: 1 });

    const bounties = await app.request("/v1/bounties", { headers: apiHeaders(env) }, env);
    expect(bounties.status).toBe(200);
    await expect(bounties.json()).resolves.toHaveLength(2);

    const bountyAdvisory = await app.request("/v1/bounties/bounty-1/advisory", { headers: apiHeaders(env) }, env);
    expect(bountyAdvisory.status).toBe(200);
    await expect(bountyAdvisory.json()).resolves.toMatchObject({ lifecycle: "historical", fundingStatus: "target_only" });

    const missingBountyAdvisory = await app.request("/v1/bounties/missing/advisory", { headers: apiHeaders(env) }, env);
    expect(missingBountyAdvisory.status).toBe(404);

    const syncStatus = await app.request("/v1/sync/status", { headers: apiHeaders(env) }, env);
    expect(syncStatus.status).toBe(200);
    await expect(syncStatus.json()).resolves.toMatchObject({ repositories: expect.any(Array), installations: expect.any(Array) });

    const readiness = await app.request("/v1/readiness", { headers: apiHeaders(env) }, env);
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({ status: expect.any(String), secrets: { githubPublicToken: false } });

    const installations = await app.request("/v1/installations", { headers: apiHeaders(env) }, env);
    expect(installations.status).toBe(200);
    await expect(installations.json()).resolves.toMatchObject({ health: expect.arrayContaining([expect.objectContaining({ status: "healthy" })]) });

    const installationHealth = await app.request("/v1/installations/123/health", { headers: apiHeaders(env) }, env);
    expect(installationHealth.status).toBe(200);
    await expect(installationHealth.json()).resolves.toMatchObject({
      installationId: 123,
      requiredPermissions: { metadata: "read", pull_requests: "read", issues: "write" },
      optionalPermissions: { checks: "write" },
      permissionRemediation: expect.arrayContaining([expect.objectContaining({ permission: "issues", ok: true })]),
      repairSteps: ["No repair needed."],
    });

    const invalidInstallationHealth = await app.request("/v1/installations/not-a-number/health", { headers: apiHeaders(env) }, env);
    expect(invalidInstallationHealth.status).toBe(400);

    const missingInstallationHealth = await app.request("/v1/installations/999/health", { headers: apiHeaders(env) }, env);
    expect(missingInstallationHealth.status).toBe(404);

    const missingRepo = await app.request("/v1/repos/missing/repo", { headers: apiHeaders(env) }, env);
    expect(missingRepo.status).toBe(404);

    const registryChanges = await app.request("/v1/registry/changes", { headers: apiHeaders(env) }, env);
    expect(registryChanges.status).toBe(200);
    await expect(registryChanges.json()).resolves.toMatchObject({ addedRepos: expect.any(Array), summary: expect.any(String) });

    const scoringModel = await app.request("/v1/scoring/model", { headers: apiHeaders(env) }, env);
    expect(scoringModel.status).toBe(200);
    await expect(scoringModel.json()).resolves.toMatchObject({ activeModel: "current_density_model", id: "scoring-1" });

    const scorePreview = await app.request(
      "/v1/scoring/preview",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          repoFullName: "entrius/allways-ui",
          targetKey: "planned-fixture",
          contributorLogin: "oktofeesh1",
          labels: ["bug"],
          linkedIssueMode: "standard",
          sourceTokenScore: 42,
          totalTokenScore: 60,
          sourceLines: 40,
          openPrCount: 1,
        }),
      },
      env,
    );
    expect(scorePreview.status).toBe(200);
    await expect(scorePreview.json()).resolves.toMatchObject({
      repoFullName: "entrius/allways-ui",
      targetType: "planned_pr",
      result: { privateOnly: true, scoringModelSnapshotId: "scoring-1" },
    });
    const noContributorScorePreview = await app.request(
      "/v1/scoring/preview",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ repoFullName: "entrius/allways-ui", targetKey: "no-contributor", sourceTokenScore: 3 }),
      },
      env,
    );
    expect(noContributorScorePreview.status).toBe(200);

    for (const [signalType, payload] of [
      ["queue-health", { repoFullName: "entrius/allways-ui", signals: { openPullRequests: 2 } }],
      ["config-quality", { repoFullName: "entrius/allways-ui", notObservedConfiguredLabels: ["refactor"] }],
      ["label-audit", { repoFullName: "entrius/allways-ui", missingConfiguredLabels: ["refactor"] }],
      ["maintainer-lane", { repoFullName: "entrius/allways-ui" }],
      ["maintainer-cut-readiness", { repoFullName: "entrius/allways-ui" }],
      ["contributor-intake-health", { repoFullName: "entrius/allways-ui" }],
    ] as const) {
      await persistSignalSnapshot(env, {
        id: `snapshot-${signalType}`,
        signalType,
        targetKey: "entrius/allways-ui",
        repoFullName: "entrius/allways-ui",
        payload: payload as unknown as Record<string, never>,
        generatedAt: "2026-05-25T00:00:00.000Z",
      });
    }
    const snapshotIntelligence = await app.request("/v1/repos/entrius/allways-ui/intelligence", { headers: apiHeaders(env) }, env);
    expect(snapshotIntelligence.status).toBe(200);
    await expect(snapshotIntelligence.json()).resolves.toMatchObject({ source: "snapshot", queueHealth: { signals: { openPullRequests: 2 } } });

    for (const path of [
      "/v1/repos/entrius/allways-ui/issue-quality",
      "/v1/repos/entrius/allways-ui/burden-forecast",
      "/v1/repos/entrius/allways-ui/pulls/12/scoring-preview",
      "/v1/contributors/oktofeesh1/scoring-profile",
      "/v1/contributors/oktofeesh1/strategy",
      "/v1/contributors/oktofeesh1/reward-risk-strategy",
      "/v1/contributors/oktofeesh1/actions/recommendations",
    ]) {
      const legacy = await app.request(path, { headers: apiHeaders(env) }, env);
      expect(legacy.status).toBe(404);
    }
  });

  it("settings-preview never mutates GitHub state", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedSignalData(env);
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), url: input.toString() });
      return new Response("not found", { status: 404 });
    });
    const response = await app.request(
      "/v1/repos/entrius/allways-ui/settings-preview",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ sample: { authorLogin: "oktofeesh1", minerStatus: "confirmed", labels: ["bug"], linkedIssues: [7] } }) },
      env,
    );
    expect(response.status).toBe(200);
    // The dry-run preview is fully offline: it must make no GitHub calls at all, and certainly no mutating ones.
    const githubCalls = calls.filter((call) => /github\.com/.test(call.url));
    expect(githubCalls).toEqual([]);
    const mutatingCalls = calls.filter((call) => call.method !== "GET" && call.method !== "HEAD");
    expect(mutatingCalls).toEqual([]);
  });

  it("reports ready status when required public-review dependencies are present", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedSignalData(env);

    const readiness = await app.request("/v1/readiness", { headers: apiHeaders(env) }, env);
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      status: "ready",
      readyForPublicReview: true,
      freshnessSlo: { status: "fresh", repairRecommended: false },
      secrets: { githubPublicToken: true },
      githubBackfill: { failingSyncs: [] },
      warnings: [],
    });

    const failingEnv = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedSignalData(failingEnv);
    await upsertRepoSyncState(failingEnv, {
      repoFullName: "entrius/allways-ui",
      status: "error",
      sourceKind: "github",
      primaryLanguage: "TypeScript",
      defaultBranch: "main",
      isPrivate: false,
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      lastCompletedAt: "2026-05-23T00:00:00.000Z",
      errorSummary: "rate limited",
      warnings: [],
    });
    const failingReadiness = await app.request("/v1/readiness", { headers: apiHeaders(failingEnv) }, failingEnv);
    expect(failingReadiness.status).toBe(200);
    await expect(failingReadiness.json()).resolves.toMatchObject({
      status: "ready",
      ready: true,
      readyForPublicReview: false,
      signalFidelity: { status: "blocked" },
      githubBackfill: { failingSyncs: [expect.objectContaining({ errorSummary: "rate limited" })] },
      warnings: expect.arrayContaining([expect.stringContaining("repo sync error"), expect.stringContaining("Core open-data fidelity")]),
    });

    const skippedEnv = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedSignalData(skippedEnv);
    await upsertRepoSyncState(skippedEnv, {
      repoFullName: "entrius/allways-ui",
      status: "skipped",
      sourceKind: "github",
      primaryLanguage: "TypeScript",
      defaultBranch: "main",
      isPrivate: false,
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      lastCompletedAt: "2026-05-23T00:00:00.000Z",
      warnings: ["missing token"],
    });
    const skippedReadiness = await app.request("/v1/readiness", { headers: apiHeaders(skippedEnv) }, skippedEnv);
    expect(skippedReadiness.status).toBe(200);
    await expect(skippedReadiness.json()).resolves.toMatchObject({
      status: "ready",
      ready: true,
      readyForPublicReview: false,
      signalFidelity: { status: "blocked" },
      githubBackfill: { incompleteSyncs: [expect.objectContaining({ status: "skipped" })] },
      warnings: expect.arrayContaining([expect.stringContaining("incomplete or skipped"), expect.stringContaining("Core open-data fidelity")]),
    });

    const missingSnapshotEnv = createTestEnv();
    const missingSnapshotReadiness = await app.request("/v1/readiness", { headers: apiHeaders(missingSnapshotEnv) }, missingSnapshotEnv);
    expect(missingSnapshotReadiness.status).toBe(200);
    await expect(missingSnapshotReadiness.json()).resolves.toMatchObject({
      readyForPublicReview: false,
      freshnessSlo: { status: "degraded", missingCount: expect.any(Number), repairRecommended: true },
      warnings: expect.arrayContaining([
        "Registry snapshot is missing.",
        "Scoring model snapshot is missing. Run refresh-scoring-model before public review.",
        "GITHUB_PUBLIC_TOKEN is not configured; public registered-repo backfill may hit GitHub rate limits.",
      ]),
    });

    const staleEnv = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await persistRegistrySnapshot(
      staleEnv,
      normalizeRegistryPayload(
        { "entrius/allways-ui": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://stale-registry" },
        "2026-05-01T00:00:00.000Z",
      ),
    );
    await persistScoringModelSnapshot(staleEnv, {
      id: "stale-scoring",
      sourceKind: "test",
      sourceUrl: "fixture://stale-scoring",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      activeModel: "current_density_model",
      constants: {},
      programmingLanguages: {},
      warnings: [],
      payload: {},
    });
    const staleReadiness = await app.request("/v1/readiness", { headers: apiHeaders(staleEnv) }, staleEnv);
    expect(staleReadiness.status).toBe(200);
    await expect(staleReadiness.json()).resolves.toMatchObject({
      readyForPublicReview: false,
      freshnessSlo: { status: "degraded", staleCount: expect.any(Number), launchBlockingCount: expect.any(Number), repairRecommended: true },
      warnings: expect.arrayContaining([expect.stringContaining("Freshness SLO is degraded")]),
    });

    const missingSyncEnv = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await persistRegistrySnapshot(
      missingSyncEnv,
      normalizeRegistryPayload(
        { "entrius/allways-ui": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    const missingSyncReadiness = await app.request("/v1/readiness", { headers: apiHeaders(missingSyncEnv) }, missingSyncEnv);
    expect(missingSyncReadiness.status).toBe(200);
    await expect(missingSyncReadiness.json()).resolves.toMatchObject({
      readyForPublicReview: false,
      warnings: expect.arrayContaining([expect.stringContaining("registered repo(s) do not have GitHub backfill state yet")]),
    });
  });

  it("keeps optional stale signal snapshots visible without blocking public review readiness", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedSignalData(env);
    const nowMs = Date.now();
    await persistSignalSnapshot(env, {
      id: "stale-queue-health-entrius",
      signalType: "queue-health",
      targetKey: "entrius/allways-ui",
      repoFullName: "entrius/allways-ui",
      payload: {},
      generatedAt: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
    });
    for (let index = 0; index < 250; index += 1) {
      await persistSignalSnapshot(env, {
        id: `fresh-queue-health-${index}`,
        signalType: "queue-health",
        targetKey: `owner/repo-${index}`,
        repoFullName: `owner/repo-${index}`,
        payload: {},
        generatedAt: new Date(nowMs - index * 1000).toISOString(),
      });
    }

    const readiness = await app.request("/v1/readiness", { headers: apiHeaders(env) }, env);
    expect(readiness.status).toBe(200);
    const payload = await readiness.json() as {
      readyForPublicReview: boolean;
      freshnessSlo: { status: string; launchBlockingCount: number; items: Array<{ area: string; targetKey: string; status: string; launchBlocking: boolean }> };
      warnings: string[];
    };

    expect(payload.readyForPublicReview).toBe(true);
    expect(payload.freshnessSlo).toMatchObject({
      status: "degraded",
      launchBlockingCount: 0,
    });
    expect(payload.freshnessSlo.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "signal_snapshot", targetKey: "entrius/allways-ui", status: "stale", launchBlocking: false }),
      ]),
    );
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Freshness SLO is degraded")]));
  });

  it("bounds freshness snapshot listings and excludes private local branch targets", async () => {
    const env = createTestEnv();
    const nowMs = Date.now();
    await persistSignalSnapshot(env, {
      id: "private-local-branch",
      signalType: "local-branch-analysis",
      targetKey: `attacker:victim/repo:${"a".repeat(200)}`,
      repoFullName: "victim/repo",
      payload: { private: true },
      generatedAt: new Date(nowMs - 60 * 1000).toISOString(),
    });
    await persistSignalSnapshot(env, {
      id: "oversized-public-target",
      signalType: "queue-health",
      targetKey: `owner/repo-${"b".repeat(260)}`,
      repoFullName: "owner/repo",
      payload: { ignored: true },
      generatedAt: new Date(nowMs - 60 * 1000).toISOString(),
    });
    for (let index = 0; index < 220; index += 1) {
      await persistSignalSnapshot(env, {
        id: `public-target-${index}`,
        signalType: "queue-health",
        targetKey: `owner/repo-${index}`,
        repoFullName: `owner/repo-${index}`,
        payload: { large: "x".repeat(100) },
        generatedAt: new Date(nowMs - index * 1000).toISOString(),
      });
    }

    const snapshots = await listLatestSignalSnapshotsByTarget(env);

    expect(snapshots).toHaveLength(200);
    expect(snapshots.some((snapshot) => snapshot.signalType === "local-branch-analysis")).toBe(false);
    expect(snapshots.some((snapshot) => snapshot.id === "oversized-public-target")).toBe(false);
    expect(snapshots.every((snapshot) => Object.keys(snapshot.payload).length === 0)).toBe(true);
  });

  it("exposes capped and rate-limited sync segments in readiness and sync status", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedSignalData(env);
    await upsertInstallationHealth(env, {
      installationId: 123,
      accountLogin: "entrius",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 1,
      status: "needs_attention",
      missingPermissions: ["issues"],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read" },
      events: ["issues", "issue_comment", "pull_request", "repository"],
      checkedAt: "2026-05-23T00:00:00.000Z",
    });
    await upsertRepoSyncSegment(env, {
      repoFullName: "entrius/allways-ui",
      segment: "open_pull_requests",
      status: "capped",
      sourceKind: "github",
      mode: "full",
      fetchedCount: 100,
      pageCount: 1,
      nextCursor: "2",
      completedAt: "2026-05-23T00:00:00.000Z",
      warnings: ["local cap"],
    });
    await upsertRepoSyncSegment(env, {
      repoFullName: "entrius/allways-ui",
      segment: "open_issues",
      status: "rate_limited",
      sourceKind: "github",
      mode: "full",
      fetchedCount: 0,
      pageCount: 0,
      rateLimitResetAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-23T00:00:00.000Z",
      warnings: ["secondary rate limit"],
    });
    await upsertRepoSyncSegment(env, {
      repoFullName: "entrius/allways-ui",
      segment: "check_summaries",
      status: "stale",
      sourceKind: "github",
      mode: "full",
      fetchedCount: 2,
      expectedCount: 2,
      pageCount: 1,
      completedAt: "2026-05-23T00:00:00.000Z",
      warnings: ["old check data"],
    });

    const readiness = await app.request("/v1/readiness", { headers: apiHeaders(env) }, env);
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      status: "ready",
      ready: true,
      readyForPublicReview: false,
      signalFidelity: {
        status: "blocked",
        cappedRepos: ["entrius/allways-ui"],
        rateLimitedRepos: ["entrius/allways-ui"],
        staleRepos: ["entrius/allways-ui"],
        nextRecoverableAt: "2026-05-27T00:00:00.000Z",
      },
      cappedRepos: ["entrius/allways-ui"],
      rateLimitedRepos: ["entrius/allways-ui"],
      staleRepos: ["entrius/allways-ui"],
      nextRecoverableAt: "2026-05-27T00:00:00.000Z",
      githubBackfill: {
        cappedSegments: [expect.objectContaining({ repoFullName: "entrius/allways-ui", segment: "open_pull_requests", nextCursor: "2" })],
        rateLimitedSegments: [expect.objectContaining({ repoFullName: "entrius/allways-ui", segment: "open_issues", rateLimitResetAt: "2026-05-27T00:00:00.000Z" })],
      },
      warnings: expect.arrayContaining([expect.stringContaining("repo sync(s) are stale"), "One or more GitHub App installations need attention."]),
    });

    const syncStatus = await app.request("/v1/sync/status", { headers: apiHeaders(env) }, env);
    expect(syncStatus.status).toBe(200);
    await expect(syncStatus.json()).resolves.toMatchObject({
      signalFidelity: { status: "blocked" },
      segments: expect.arrayContaining([
        expect.objectContaining({ repoFullName: "entrius/allways-ui", segment: "open_pull_requests", status: "capped" }),
        expect.objectContaining({ repoFullName: "entrius/allways-ui", segment: "open_issues", status: "rate_limited" }),
      ]),
    });

    const refreshingEnv = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedSignalData(refreshingEnv);
    await upsertRepoSyncSegment(refreshingEnv, {
      repoFullName: "entrius/allways-ui",
      segment: "labels",
      status: "running",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 2,
      expectedCount: 2,
      pageCount: 1,
      completedAt: "2026-05-23T00:00:00.000Z",
      warnings: [],
    });
    const refreshingReadiness = await app.request("/v1/readiness", { headers: apiHeaders(refreshingEnv) }, refreshingEnv);
    expect(refreshingReadiness.status).toBe(200);
    await expect(refreshingReadiness.json()).resolves.toMatchObject({
      readyForPublicReview: true,
      coreSignalFidelity: { status: "complete", refreshingRepos: ["entrius/allways-ui"] },
      warnings: expect.arrayContaining([expect.stringContaining("repo(s) are refreshing")]),
    });
  });

  it("serves private MCP tool listing and tool calls", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedSignalData(env);
    stubOktofeeshFetch();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/removed": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "owner/stable": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "entrius/allways-ui": { emission_share: 0.01107, issue_discovery_share: 0, label_multipliers: { bug: 1.1 }, trusted_label_pipeline: true },
        },
        { kind: "raw-github", url: "fixture://mcp-old-registry" },
        "2026-05-24T00:00:00.000Z",
      ),
    );
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/added": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "owner/stable": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "entrius/allways-ui": { emission_share: 0.01107, issue_discovery_share: 0, label_multipliers: { bug: 1.1 }, trusted_label_pipeline: true },
        },
        { kind: "raw-github", url: "fixture://mcp-current-registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    const decisionBuild = await app.request(
      "/v1/internal/jobs/build-contributor-decision-packs/run",
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ login: "oktofeesh1" }),
      },
      env,
    );
    expect(decisionBuild.status).toBe(200);

    const unauthorized = await app.request(
      "/mcp",
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      env,
    );
    expect(unauthorized.status).toBe(401);

    const tools = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "gittensory-tests", version: "0.1.0" },
          },
        }),
      },
      env,
    );
    expect(tools.status).toBe(200);
    const initializePayload = (await mcpJson(tools)) as { result: { serverInfo: { name: string } } };
    expect(initializePayload.result.serverInfo.name).toBe("gittensory");

    const toolsList = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      },
      env,
    );
    expect(toolsList.status).toBe(200);
    const toolsPayload = (await mcpJson(toolsList)) as { result: { tools: Array<{ name: string }> } };
    const toolNames = toolsPayload.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("gittensory_get_repo_context");
    expect(toolNames).toContain("gittensory_get_contributor_profile");
    expect(toolNames).toContain("gittensory_get_decision_pack");
    expect(toolNames).toContain("gittensory_explain_repo_decision");
    expect(toolNames).toContain("gittensory_preflight_pr");
    expect(toolNames).toContain("gittensory_preflight_local_diff");
    expect(toolNames).toContain("gittensory_preview_local_pr_score");
    expect(toolNames).toContain("gittensory_get_registry_changes");
    expect(toolNames).toContain("gittensory_explain_review_risk");
    expect(toolNames).toContain("gittensory_compare_pr_variants");
    expect(toolNames).toContain("gittensory_local_status");
    expect(toolNames).toContain("gittensory_preflight_current_branch");
    expect(toolNames).toContain("gittensory_preview_current_branch_score");
    expect(toolNames).toContain("gittensory_rank_local_next_actions");
    expect(toolNames).toContain("gittensory_compare_local_variants");
    expect(toolNames).toContain("gittensory_explain_local_blockers");
    expect(toolNames).toContain("gittensory_prepare_pr_packet");
    expect(toolNames).toContain("gittensory_agent_plan_next_work");
    expect(toolNames).toContain("gittensory_agent_start_run");
    expect(toolNames).toContain("gittensory_agent_get_run");
    expect(toolNames).toContain("gittensory_agent_explain_next_action");
    expect(toolNames).toContain("gittensory_agent_prepare_pr_packet");
    for (const removed of [
      "gittensory_get_contributor_fit",
      "gittensory_find_opportunities",
      "gittensory_get_contribution_strategy",
      "gittensory_explain_reward_risk",
      "gittensory_rank_next_actions",
      "gittensory_explain_score_blockers",
      "gittensory_explain_maintainer_noise",
      "gittensory_get_role_context",
      "gittensory_get_outcome_history",
      "gittensory_explain_repo_fit",
      "gittensory_explain_maintainer_lane",
    ]) {
      expect(toolNames).not.toContain(removed);
    }

    const call = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "gittensory_get_repo_context",
            arguments: { owner: "entrius", repo: "allways-ui" },
          },
        }),
      },
      env,
    );
    expect(call.status).toBe(200);
    const callPayload = (await mcpJson(call)) as { result: { structuredContent: { repoFullName: string }; content: Array<{ text: string }> } };
    expect(callPayload.result.structuredContent.repoFullName).toBe("entrius/allways-ui");
    expect(callPayload.result.content[0]?.text).not.toMatch(/reward|farming/i);

    const noTotalsContext = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "repo-context-no-totals",
          method: "tools/call",
          params: {
            name: "gittensory_get_repo_context",
            arguments: { owner: "owner", repo: "stable" },
          },
        }),
      },
      env,
    );
    expect(noTotalsContext.status).toBe(200);
    const noTotalsPayload = (await mcpJson(noTotalsContext)) as { result: { structuredContent: { queueHealth: { signals: { openIssues: number; openPullRequests: number } } } } };
    expect(noTotalsPayload.result.structuredContent.queueHealth.signals).toMatchObject({ openIssues: 0, openPullRequests: 0 });

    for (const [name, args] of [
      ["gittensory_get_decision_pack", { login: "needs-snapshot" }],
      ["gittensory_explain_repo_decision", { login: "needs-snapshot", owner: "entrius", repo: "allways-ui" }],
      ["gittensory_get_contributor_profile", { login: "unknown-user" }],
    ] as const) {
      const response = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders(env),
          body: JSON.stringify({ jsonrpc: "2.0", id: `refresh-${name}`, method: "tools/call", params: { name, arguments: args } }),
        },
        env,
      );
      expect(response.status).toBe(200);
      const payload = (await mcpJson(response)) as { result: { structuredContent: Record<string, unknown> } };
      if (name === "gittensory_get_contributor_profile") expect(payload.result.structuredContent).toMatchObject({ login: "unknown-user" });
      else expect(payload.result.structuredContent).toMatchObject({ status: "needs_snapshot_refresh", freshness: "missing", rebuildEnqueued: true });
    }

    const missingRepoDecision = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "missing-repo-decision",
          method: "tools/call",
          params: { name: "gittensory_explain_repo_decision", arguments: { login: "oktofeesh1", owner: "missing", repo: "repo" } },
        }),
      },
      env,
    );
    expect(missingRepoDecision.status).toBe(200);
    await expect(mcpJson(missingRepoDecision)).resolves.toMatchObject({ result: { structuredContent: { status: "not_found", decision: null } } });

    for (const [name, args] of [
      ["gittensory_get_repo_context", { owner: "entrius", repo: "allways-ui" }],
      ["gittensory_get_contributor_profile", { login: "oktofeesh1" }],
      ["gittensory_get_decision_pack", { login: "oktofeesh1" }],
      ["gittensory_explain_repo_decision", { login: "oktofeesh1", owner: "entrius", repo: "allways-ui" }],
      ["gittensory_agent_plan_next_work", { login: "oktofeesh1", repoFullName: "entrius/allways-ui" }],
      [
        "gittensory_preflight_pr",
        {
          repoFullName: "entrius/allways-ui",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          changedFiles: ["src/cache.ts", "test/cache.test.ts"],
        },
      ],
      ["gittensory_get_registry_changes", {}],
      [
        "gittensory_preview_local_pr_score",
        {
          repoFullName: "entrius/allways-ui",
          targetKey: "mcp-local-fixture",
          contributorLogin: "oktofeesh1",
          labels: ["bug"],
          linkedIssueMode: "standard",
          sourceTokenScore: 40,
          totalTokenScore: 60,
          sourceLines: 42,
        },
      ],
      [
        "gittensory_explain_review_risk",
        {
          repoFullName: "entrius/allways-ui",
          contributorLogin: "oktofeesh1",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          changedFiles: ["src/cache.ts"],
        },
      ],
      [
        "gittensory_compare_pr_variants",
        {
          variants: [
            { repoFullName: "entrius/allways-ui", targetKey: "small", sourceTokenScore: 10, totalTokenScore: 12, sourceLines: 10 },
            { repoFullName: "entrius/allways-ui", targetKey: "larger", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 42, labels: ["bug"] },
          ],
        },
      ],
      [
        "gittensory_preflight_local_diff",
        {
          repoFullName: "entrius/allways-ui",
          title: "Fix dashboard cache refresh after reconnect",
          changedFiles: ["src/cache.ts", "test/cache.test.ts"],
          changedLineCount: 42,
        },
      ],
      ["gittensory_local_status", {}],
      [
        "gittensory_preflight_current_branch",
        {
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache-reconnect",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          labels: ["bug"],
          changedFiles: [
            { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
            { path: "test/cache.test.ts", additions: 20, deletions: 0, status: "added" },
          ],
          validation: [{ command: "npm test -- cache", status: "passed" }],
          localScorer: { mode: "external_command", sourceTokenScore: 42, totalTokenScore: 66, sourceLines: 44 },
        },
      ],
      [
        "gittensory_preview_current_branch_score",
        {
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache-reconnect",
          changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        },
      ],
      [
        "gittensory_rank_local_next_actions",
        {
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache-reconnect",
          changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        },
      ],
      [
        "gittensory_explain_local_blockers",
        {
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache-reconnect",
          changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        },
      ],
      [
        "gittensory_prepare_pr_packet",
        {
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache-reconnect",
          body: "Fixes #7",
          changedFiles: [
            { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
            { path: "test/cache.test.ts", additions: 20, deletions: 0, status: "added" },
          ],
        },
      ],
      [
        "gittensory_compare_local_variants",
        {
          variants: [
            {
              login: "oktofeesh1",
              repoFullName: "entrius/allways-ui",
              branchName: "small-cache-fix",
              changedFiles: [{ path: "src/cache.ts", additions: 8, deletions: 1, status: "modified" }],
            },
            {
              login: "oktofeesh1",
              repoFullName: "entrius/allways-ui",
              branchName: "tested-cache-fix",
              changedFiles: [
                { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
                { path: "test/cache.test.ts", additions: 20, deletions: 0, status: "added" },
              ],
            },
          ],
        },
      ],
      ["gittensory_get_bounty_advisory", { id: "bounty-1" }],
    ] as const) {
      const response = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders(env),
          body: JSON.stringify({ jsonrpc: "2.0", id: `tool-${name}`, method: "tools/call", params: { name, arguments: args } }),
        },
        env,
      );
      expect(response.status).toBe(200);
      const payload = (await mcpJson(response)) as { result?: { content?: Array<{ text: string }> } };
      const text = payload.result?.content?.[0]?.text ?? "";
      const privateRewardTools = new Set([
        "gittensory_get_decision_pack",
        "gittensory_explain_repo_decision",
        "gittensory_preview_local_pr_score",
        "gittensory_compare_pr_variants",
        "gittensory_preview_current_branch_score",
        "gittensory_rank_local_next_actions",
        "gittensory_explain_local_blockers",
        "gittensory_compare_local_variants",
        "gittensory_agent_plan_next_work",
        "gittensory_agent_explain_next_action",
      ]);
      expect(text).not.toMatch(/farming|wallet|hotkey|guaranteed payout/i);
      if (!privateRewardTools.has(name)) expect(text).not.toMatch(/reward/i);
    }

    const agentStart = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "agent-start",
          method: "tools/call",
          params: {
            name: "gittensory_agent_start_run",
            arguments: {
              actorLogin: "oktofeesh1",
              objective: "Plan next Gittensor action",
              repoFullName: "entrius/allways-ui",
            },
          },
        }),
      },
      env,
    );
    expect(agentStart.status).toBe(200);
    const agentStartPayload = (await mcpJson(agentStart)) as { result: { structuredContent: { run: { id: string; status: string } } } };
    expect(agentStartPayload.result.structuredContent.run.status).toBe("queued");

    for (const [name, args] of [
      ["gittensory_agent_get_run", { runId: agentStartPayload.result.structuredContent.run.id }],
      ["gittensory_agent_explain_next_action", { login: "oktofeesh1", repoFullName: "entrius/allways-ui" }],
      [
        "gittensory_agent_prepare_pr_packet",
        {
          login: "oktofeesh1",
          repoFullName: "entrius/allways-ui",
          branchName: "fix-cache",
          changedFiles: [
            { path: "src/cache.ts", additions: 8, deletions: 1, status: "modified" },
            { path: "test/cache.test.ts", additions: 5, deletions: 0, status: "added" },
          ],
          linkedIssues: [7],
          validation: [{ command: "npm test -- cache", status: "passed", summary: "cache tests passed" }],
        },
      ],
    ] as const) {
      const response = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders(env),
          body: JSON.stringify({ jsonrpc: "2.0", id: `agent-${name}`, method: "tools/call", params: { name, arguments: args } }),
        },
        env,
      );
      expect(response.status).toBe(200);
      const payload = (await mcpJson(response)) as { result?: { content?: Array<{ text: string }> } };
      expect(payload.result?.content?.[0]?.text ?? "").not.toMatch(/wallet|hotkey|farming|guaranteed payout/i);
    }

    for (const [args, recommendation] of [
      [
        {
          repoFullName: "entrius/allways-ui",
          title: "Fix dashboard cache refresh after reconnect",
          body: "Fixes #7",
          changedFiles: ["src/cache.ts"],
        },
        "likely_duplicate",
      ],
      [
        {
          repoFullName: "entrius/allways-ui",
          contributorLogin: "entrius",
          title: "Maintainer config cleanup",
          body: "Maintenance follow-up",
          changedFiles: ["README.md"],
        },
        "maintainer_lane",
      ],
      [
        {
          repoFullName: "entrius/allways-ui",
          contributorLogin: "oktofeesh1",
          title: "Focused parser guard without validation evidence",
          body: "Fixes #999",
          changedFiles: ["src/parser.ts"],
        },
        "needs_author",
      ],
      [
        {
          repoFullName: "entrius/allways-ui",
          contributorLogin: "oktofeesh1",
          title: "Documentation note for isolated setup",
          body: "Fixes #999",
          changedFiles: ["docs/setup.md"],
        },
        "review",
      ],
      [
        {
          repoFullName: "missing/repo",
          title: "Unknown repo preflight",
          body: "Fixes #999",
          changedFiles: ["docs/setup.md"],
        },
        "watch",
      ],
    ] as const) {
      const response = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders(env),
          body: JSON.stringify({ jsonrpc: "2.0", id: `review-risk-${args.title}`, method: "tools/call", params: { name: "gittensory_explain_review_risk", arguments: args } }),
        },
        env,
      );
      expect(response.status).toBe(200);
      const payload = (await mcpJson(response)) as { result: { structuredContent: { recommendation: string } } };
      expect(payload.result.structuredContent.recommendation).toBe(recommendation);
    }

    const sparseVariantComparison = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "sparse-variant-comparison",
          method: "tools/call",
          params: {
            name: "gittensory_compare_pr_variants",
            arguments: {
              variants: [
                { repoFullName: "entrius/allways-ui", targetKey: "metadata-only" },
                { repoFullName: "entrius/allways-ui", targetKey: "label-only", labels: ["feature"] },
              ],
            },
          },
        }),
      },
      env,
    );
    expect(sparseVariantComparison.status).toBe(200);

    const tiedLocalVariantComparison = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tied-local-variant-comparison",
          method: "tools/call",
          params: {
            name: "gittensory_compare_local_variants",
            arguments: {
              variants: [
                { login: "oktofeesh1", repoFullName: "missing/b", branchName: "same", changedFiles: [] },
                { login: "oktofeesh1", repoFullName: "missing/a", branchName: "same", changedFiles: [] },
              ],
            },
          },
        }),
      },
      env,
    );
    expect(tiedLocalVariantComparison.status).toBe(200);
    await expect(mcpJson(tiedLocalVariantComparison)).resolves.toMatchObject({
      result: { structuredContent: { variants: [expect.objectContaining({ repoFullName: "missing/a" }), expect.objectContaining({ repoFullName: "missing/b" })] } },
    });

    const missingBounty = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "missing-bounty", method: "tools/call", params: { name: "gittensory_get_bounty_advisory", arguments: { id: "missing" } } }),
      },
      env,
    );
    expect(missingBounty.status).toBe(200);
    const missingBountyPayload = await mcpJson(missingBounty);
    expect(JSON.stringify(missingBountyPayload)).toMatch(/Bounty not found|error|isError/i);
  }, 15_000);

  it("covers registration-readiness policy variants for repo-owner launch planning", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedSignalData(env);

    const unknownReadiness = await app.request("/v1/repos/JSONbored/gittensory/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(unknownReadiness.status).toBe(200);
    await expect(unknownReadiness.json()).resolves.toMatchObject({
      ready: false,
      recommendedRegistrationMode: "direct_pr",
      blockers: expect.arrayContaining(["Repository is not registered in the latest Gittensory registry snapshot."]),
    });

    await upsertRepositorySettings(env, {
      repoFullName: "entrius/allways-ui",
      publicSurface: "off",
      requireLinkedIssue: true,
      autoLabelEnabled: false,
      createMissingLabel: false,
      gittensorLabel: "gittensor-miner",
    });
    const directReadiness = await app.request("/v1/repos/entrius/allways-ui/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(directReadiness.status).toBe(200);
    await expect(directReadiness.json()).resolves.toMatchObject({
      issuePolicy: "direct_pr_requires_linked_issue",
      labelPolicy: { autoLabelEnabled: false, label: "gittensor-miner", createMissingLabel: false },
      warnings: expect.arrayContaining(["GitHub App public surface is disabled; maintainers will not get comment/label assistance."]),
    });

    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "entrius/allways-ui": {
            emission_share: 0.01107,
            issue_discovery_share: 0.01,
            label_multipliers: {},
            trusted_label_pipeline: false,
            maintainer_cut: 0.03,
          },
        },
        { kind: "raw-github", url: "https://example.test/issue-discovery-registry.json" },
        "2026-05-26T00:00:00.000Z",
      ),
    );
    const issueDiscoveryReadiness = await app.request("/v1/repos/entrius/allways-ui/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(issueDiscoveryReadiness.status).toBe(200);
    await expect(issueDiscoveryReadiness.json()).resolves.toMatchObject({
      recommendedRegistrationMode: "split",
      issuePolicy: "split_pr_and_issue_discovery_enabled",
    });

    const recommendation = await app.request("/v1/repos/entrius/allways-ui/gittensor-config-recommendation", { headers: apiHeaders(env) }, env);
    expect(recommendation.status).toBe(200);
    await expect(recommendation.json()).resolves.toMatchObject({
      privateOnly: true,
      current: { issueDiscoveryShare: 0.01, maintainerCut: 0.03 },
      recommended: {
        requireLinkedIssue: true,
        confirmedMinerLabel: "gittensor-miner",
        publicSurface: "off",
      },
      reasons: expect.arrayContaining([expect.stringMatching(/issue discovery|Direct-PR/i)]),
    });
  });

  it("covers modern route fallback branches, stale snapshots, and launch-readiness edge policies", async () => {
    const queued: unknown[] = [];
    const app = createApp();
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          queued.push(message);
        },
      } as unknown as Queue,
    });

    const deviceStart = await app.request("/v1/auth/github/device/start", { method: "POST" }, env);
    expect(deviceStart.status).toBe(503);
    const deviceMissingCode = await app.request("/v1/auth/github/device/poll", { method: "POST", body: JSON.stringify({}) }, env);
    expect(deviceMissingCode.status).toBe(400);
    const devicePollUnconfigured = await app.request("/v1/auth/github/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: "abc" }) }, env);
    expect(devicePollUnconfigured.status).toBe(503);
    const sessionMissingToken = await app.request("/v1/auth/github/session", { method: "POST", body: JSON.stringify({}) }, env);
    expect(sessionMissingToken.status).toBe(400);
    vi.stubGlobal("fetch", async () => new Response("bad token", { status: 401 }));
    const sessionRejected = await app.request("/v1/auth/github/session", { method: "POST", body: JSON.stringify({ githubToken: "bad" }) }, env);
    expect(sessionRejected.status).toBe(401);
    const unauthenticatedSession = await app.request("/v1/auth/session", {}, env);
    expect(unauthenticatedSession.status).toBe(401);
    const logout = await app.request("/v1/auth/logout", { method: "POST" }, env);
    await expect(logout.json()).resolves.toMatchObject({ ok: true, revoked: false });

    await persistSignalSnapshot(env, {
      id: "stale-pack",
      signalType: "contributor-decision-pack",
      targetKey: "stale-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "stale-user",
        generatedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [{ repoFullName: "owner/repo", recommendation: "pursue" }],
        topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "owner/repo", priorityScore: 50 }],
        cleanupFirst: [],
        pursueRepos: [{ repoFullName: "owner/repo", recommendation: "pursue" }],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: [],
        dataQuality: { signalFidelity: { status: "degraded" } },
        summary: "stale",
        nextActions: ["pick a narrow change"],
      } as never,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const staleDecisionPack = await app.request("/v1/contributors/stale-user/decision-pack", { headers: apiHeaders(env) }, env);
    expect(staleDecisionPack.status).toBe(200);
    const staleBody = (await staleDecisionPack.json()) as {
      status: string;
      freshness: string;
      rebuildEnqueued: boolean;
      stale: boolean;
      generatedAt: string;
      topActions: unknown[];
      repoDecisions: unknown[];
      dataQuality: { signalFidelity: { status: string } };
    };
    expect(staleBody).toMatchObject({
      status: "ready",
      freshness: "rebuilding",
      rebuildEnqueued: true,
      stale: true,
      generatedAt: "2026-01-01T00:00:00.000Z",
      dataQuality: { signalFidelity: { status: "degraded" } },
    });
    expect(staleBody.topActions.length).toBeGreaterThan(0);
    expect(staleBody.repoDecisions.length).toBeGreaterThan(0);

    const staleRepoDecision = await app.request("/v1/contributors/stale-user/repos/owner/repo/decision", { headers: apiHeaders(env) }, env);
    expect(staleRepoDecision.status).toBe(200);
    await expect(staleRepoDecision.json()).resolves.toMatchObject({
      status: "ready",
      login: "stale-user",
      repoFullName: "owner/repo",
      freshness: "rebuilding",
      rebuildEnqueued: true,
      decision: { repoFullName: "owner/repo", recommendation: "pursue" },
    });

    const staleMcpQueued = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "stale-mcp-queued",
          method: "tools/call",
          params: { name: "gittensory_get_decision_pack", arguments: { login: "stale-user" } },
        }),
      },
      env,
    );
    expect(staleMcpQueued.status).toBe(200);
    const staleMcpQueuedPayload = (await mcpJson(staleMcpQueued)) as { result: { structuredContent: { freshness: string; rebuildEnqueued: boolean }; content: Array<{ text: string }> } };
    expect(staleMcpQueuedPayload.result.structuredContent).toMatchObject({ freshness: "rebuilding", rebuildEnqueued: true });
    expect(staleMcpQueuedPayload.result.content[0]?.text).toContain("background rebuild enqueued");

    const queueDownEnv = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue offline");
        },
      } as unknown as Queue,
    });
    await persistSignalSnapshot(queueDownEnv, {
      id: "stale-mcp-queue-down",
      signalType: "contributor-decision-pack",
      targetKey: "mcp-stale-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "mcp-stale-user",
        generatedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [{ repoFullName: "owner/repo", recommendation: "pursue" }],
        topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "owner/repo", priorityScore: 50 }],
        cleanupFirst: [],
        pursueRepos: [{ repoFullName: "owner/repo", recommendation: "pursue" }],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: [],
        dataQuality: { signalFidelity: { status: "complete" } },
        summary: "stale",
        nextActions: ["pick a narrow change"],
      } as never,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const staleMcp = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(queueDownEnv),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "stale-mcp-queue-down",
          method: "tools/call",
          params: { name: "gittensory_get_decision_pack", arguments: { login: "mcp-stale-user" } },
        }),
      },
      queueDownEnv,
    );
    expect(staleMcp.status).toBe(200);
    const staleMcpPayload = (await mcpJson(staleMcp)) as { result: { structuredContent: { freshness: string; rebuildEnqueued: boolean }; content: Array<{ text: string }> } };
    expect(staleMcpPayload.result.structuredContent).toMatchObject({ freshness: "stale", rebuildEnqueued: false });
    expect(staleMcpPayload.result.content[0]?.text).toContain("rebuild not enqueued");
    expect(staleMcpPayload.result.content[0]?.text).not.toContain("background rebuild enqueued");

    await persistSignalSnapshot(env, {
      id: "fresh-empty-pack",
      signalType: "contributor-decision-pack",
      targetKey: "fresh-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "fresh-user",
        generatedAt: new Date().toISOString(),
        stale: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [],
        topActions: [],
        cleanupFirst: [],
        pursueRepos: [],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: [],
        dataQuality: { signalFidelity: { status: "complete" } },
        summary: "fresh",
        nextActions: [],
      } as never,
      generatedAt: new Date().toISOString(),
    });
    const missingRepoDecision = await app.request("/v1/contributors/fresh-user/repos/owner/repo/decision", { headers: apiHeaders(env) }, env);
    expect(missingRepoDecision.status).toBe(404);

    const invalidReviewability = await app.request("/v1/repos/owner/repo/pulls/not-a-number/reviewability", { headers: apiHeaders(env) }, env);
    expect(invalidReviewability.status).toBe(400);
    const noAuthorReviewability = await app.request("/v1/repos/owner/repo/pulls/123/reviewability", { headers: apiHeaders(env) }, env);
    expect(noAuthorReviewability.status).toBe(200);
    await expect(noAuthorReviewability.json()).resolves.toMatchObject({ action: "review_now" });

    const backfillDefault = await app.request(
      "/v1/internal/jobs/backfill-registered-repos",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ mode: "invalid" }) },
      env,
    );
    expect(backfillDefault.status).toBe(202);
    const backfillFullRun = await app.request(
      "/v1/internal/jobs/backfill-registered-repos/run",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ mode: "full" }) },
      env,
    );
    expect(backfillFullRun.status).toBe(200);
    const missingSegmentRepo = await app.request("/v1/internal/jobs/backfill-repo-segment", { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({}) }, env);
    expect(missingSegmentRepo.status).toBe(400);
    const invalidSegment = await app.request(
      "/v1/internal/jobs/backfill-repo-segment/run",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ repoFullName: "owner/repo", segment: "bad" }) },
      env,
    );
    expect(invalidSegment.status).toBe(400);
    const queuedSegment = await app.request(
      "/v1/internal/jobs/backfill-repo-segment",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ repoFullName: "owner/repo", segment: "labels", mode: "full", cursor: "2", force: true }) },
      env,
    );
    expect(queuedSegment.status).toBe(202);
    const queuedResumeSegment = await app.request(
      "/v1/internal/jobs/backfill-repo-segment",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ repoFullName: "owner/repo", segment: "labels", mode: "resume" }) },
      env,
    );
    expect(queuedResumeSegment.status).toBe(202);
    const missingDetailsRepo = await app.request("/v1/internal/jobs/backfill-pr-details", { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({}) }, env);
    expect(missingDetailsRepo.status).toBe(400);
    const queuedDetails = await app.request(
      "/v1/internal/jobs/backfill-pr-details",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ repoFullName: "owner/repo", mode: "resume", cursor: "5" }) },
      env,
    );
    expect(queuedDetails.status).toBe(202);
    const queuedFullDetails = await app.request(
      "/v1/internal/jobs/backfill-pr-details",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ repoFullName: "owner/repo", mode: "full" }) },
      env,
    );
    expect(queuedFullDetails.status).toBe(202);
    const evidenceAll = await app.request("/v1/internal/jobs/build-contributor-evidence", { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: "{}" }, env);
    expect(evidenceAll.status).toBe(202);
    const packsAll = await app.request("/v1/internal/jobs/build-contributor-decision-packs", { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: "{}" }, env);
    expect(packsAll.status).toBe(202);
    const missingActivityLogin = await app.request("/v1/internal/jobs/refresh-contributor-activity", { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: "{}" }, env);
    expect(missingActivityLogin.status).toBe(400);
    const activityQueued = await app.request(
      "/v1/internal/jobs/refresh-contributor-activity",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ login: "jsonbored", repoFullName: "owner/repo" }) },
      env,
    );
    expect(activityQueued.status).toBe(202);
    const burdenAll = await app.request("/v1/internal/jobs/build-burden-forecasts", { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: "{}" }, env);
    expect(burdenAll.status).toBe(202);
    const signalsOne = await app.request(
      "/v1/internal/jobs/generate-signal-snapshots",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ repoFullName: "owner/repo" }) },
      env,
    );
    expect(signalsOne.status).toBe(202);
    const invalidSettings = await app.request(
      "/v1/internal/repos/owner/repo/settings",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` }, body: JSON.stringify({ commentMode: "loud" }) },
      env,
    );
    expect(invalidSettings.status).toBe(400);
    expect(queued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-registered-repos", mode: "light" }),
        expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "owner/repo", segment: "labels", mode: "full", cursor: "2", force: true }),
        expect.objectContaining({ type: "backfill-pr-details", repoFullName: "owner/repo", mode: "resume", cursor: 5 }),
        expect.objectContaining({ type: "build-contributor-evidence", login: undefined }),
        expect.objectContaining({ type: "build-contributor-decision-packs", login: undefined }),
        expect.objectContaining({ type: "refresh-contributor-activity", login: "jsonbored", repoFullName: "owner/repo" }),
        expect.objectContaining({ type: "build-burden-forecasts", repoFullName: undefined }),
        expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "owner/repo" }),
      ]),
    );

    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/excellent": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false, maintainer_cut: 0 },
          "owner/issue-only": { emission_share: 0.02, issue_discovery_share: 1, label_multipliers: {}, trusted_label_pipeline: false, maintainer_cut: 0 },
          "owner/fragile": { emission_share: 0, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: true, maintainer_cut: 0 },
        },
        { kind: "raw-github", url: "fixture://route-edge-registry" },
        "2026-05-26T00:00:00.000Z",
      ),
    );
    for (const fullName of ["owner/excellent", "owner/issue-only", "owner/fragile"]) {
      const [, name] = fullName.split("/");
      await upsertRepositoryFromGitHub(env, { name: name!, full_name: fullName, private: false, owner: { login: "owner" }, default_branch: "main" });
    }
    await persistRepoGithubTotalsSnapshot(env, {
      id: "excellent-totals",
      repoFullName: "owner/excellent",
      openIssuesTotal: 0,
      openPullRequestsTotal: 0,
      mergedPullRequestsTotal: 0,
      closedUnmergedPullRequestsTotal: 0,
      labelsTotal: 0,
      sourceKind: "github",
      fetchedAt: "2026-05-26T00:00:00.000Z",
      payload: {},
    });
    await persistRepoGithubTotalsSnapshot(env, {
      id: "fragile-totals",
      repoFullName: "owner/fragile",
      openIssuesTotal: 500,
      openPullRequestsTotal: 300,
      mergedPullRequestsTotal: 0,
      closedUnmergedPullRequestsTotal: 0,
      labelsTotal: 0,
      sourceKind: "github",
      fetchedAt: "2026-05-26T00:00:00.000Z",
      payload: {},
    });
    const excellentRecommendation = await app.request("/v1/repos/owner/excellent/gittensor-config-recommendation", { headers: apiHeaders(env) }, env);
    expect(excellentRecommendation.status).toBe(200);
    await expect(excellentRecommendation.json()).resolves.toMatchObject({
      recommended: { participationMode: "split", issueDiscoveryShare: 0.1, maintainerCut: 0.02 },
      reasons: expect.arrayContaining(["Config and intake signals are strong enough to consider a small issue-discovery slice.", "Maintainer cut can be considered because config and queue signals are clean."]),
    });
    const issueOnlyReadiness = await app.request("/v1/repos/owner/issue-only/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(issueOnlyReadiness.status).toBe(200);
    await expect(issueOnlyReadiness.json()).resolves.toMatchObject({ recommendedRegistrationMode: "issue_discovery", issuePolicy: "issue_discovery_enabled" });
    const fragileReadiness = await app.request("/v1/repos/owner/fragile/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(fragileReadiness.status).toBe(200);
    await expect(fragileReadiness.json()).resolves.toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(["Repository config quality is fragile.", "Contributor intake health is blocked."]),
    });
  });

  it("updates repository settings through protected internal API", async () => {
    const app = createApp();
    const env = createTestEnv();

    const rejected = await app.request(
      "/v1/internal/repos/entrius/allways-ui/settings",
      {
        method: "POST",
        body: JSON.stringify({ commentMode: "detected_contributors_only", publicSignalLevel: "minimal" }),
      },
      env,
    );
    expect(rejected.status).toBe(401);

    const updated = await app.request(
      "/v1/internal/repos/entrius/allways-ui/settings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` },
        body: JSON.stringify({ commentMode: "detected_contributors_only", publicSignalLevel: "minimal" }),
      },
      env,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ commentMode: "detected_contributors_only", publicSignalLevel: "minimal" });

    const settings = await app.request("/v1/repos/entrius/allways-ui/settings", { headers: apiHeaders(env) }, env);
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({ commentMode: "detected_contributors_only" });
  });
});

async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mcpHeaders(env: Env, sessionId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_MCP_TOKEN}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`,
    "content-type": "application/json",
  };
}

function stubOktofeeshFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "https://api.gittensor.io/miners") {
      return Response.json([
        {
          uid: 7,
          hotkey: "hotkey",
          githubUsername: "oktofeesh1",
          githubId: "12345",
          totalPrs: 2,
          totalMergedPrs: 1,
          totalOpenPrs: 1,
          totalClosedPrs: 0,
          totalOpenIssues: 1,
          totalClosedIssues: 0,
          totalSolvedIssues: 0,
          totalValidSolvedIssues: 0,
          isEligible: true,
          credibility: 1,
          eligibleRepoCount: 1,
        },
      ]);
    }
    if (url === "https://api.gittensor.io/miners/12345") {
      return Response.json({
        repositories: [
          {
            repositoryFullName: "entrius/allways-ui",
            totalPrs: "2",
            totalMergedPrs: "1",
            totalOpenPrs: "1",
            totalClosedPrs: "0",
            totalOpenIssues: "1",
            totalClosedIssues: "0",
            isEligible: true,
            credibility: "1.000000",
          },
        ],
      });
    }
    if (url === "https://api.gittensor.io/miners/12345/prs") {
      return Response.json([{ repository: "entrius/allways-ui", pullRequestNumber: 12, pullRequestTitle: "Fix dashboard cache", prState: "OPEN", label: "bug" }]);
    }
    if (url === "https://mirror.gittensor.io/api/v1/miners/12345/issues") {
      return Response.json({ issues: [{ labels: [{ name: "bug" }] }] });
    }
    if (url.endsWith("/users/oktofeesh1")) {
      return Response.json({ login: "oktofeesh1", public_repos: 42, followers: 7 });
    }
    if (url.includes("/users/oktofeesh1/repos")) {
      return Response.json([{ language: "TypeScript" }, { language: "Python" }, { language: "TypeScript" }]);
    }
    return new Response("not found", { status: 404 });
  });
}

async function mcpJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("application/json")) return JSON.parse(text);
  const dataLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`Missing MCP data event: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function seedSignalData(env: Env): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: 123,
      account: { login: "entrius", id: 1, type: "Organization" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "pull_request", "repository"],
    },
  });
  await upsertInstallationHealth(env, {
    installationId: 123,
    accountLogin: "entrius",
    repositorySelection: "selected",
    installedReposCount: 1,
    registeredInstalledCount: 1,
    status: "healthy",
    missingPermissions: [],
    missingEvents: [],
    permissions: { metadata: "read", pull_requests: "read", issues: "write" },
    events: ["issues", "pull_request", "repository"],
    checkedAt: "2026-05-23T00:00:00.000Z",
  });
  const snapshot = normalizeRegistryPayload(
    {
      "entrius/allways-ui": {
        emission_share: 0.01107,
        issue_discovery_share: 0,
        label_multipliers: { bug: 1.1, enhancement: 1, feature: 1.25, refactor: 0.5 },
        trusted_label_pipeline: true,
        maintainer_cut: 0,
      },
    },
    { kind: "raw-github", url: "https://example.test/master_repositories.json" },
    "2026-05-23T00:00:00.000Z",
  );
  await persistRegistrySnapshot(
    env,
    normalizeRegistryPayload(
      {
        "entrius/allways-ui": {
          emission_share: 0.005,
          issue_discovery_share: 0,
          label_multipliers: {},
          trusted_label_pipeline: true,
          maintainer_cut: 0,
        },
      },
      { kind: "raw-github", url: "https://example.test/old_master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    ),
  );
  await persistRegistrySnapshot(env, snapshot);
  await upsertRepositoryFromGitHub(env, {
    name: "allways-ui",
    full_name: "entrius/allways-ui",
    private: false,
    default_branch: "test",
    owner: { login: "entrius" },
  }, 123);
  await persistScoringModelSnapshot(env, {
    id: "scoring-1",
    sourceKind: "test",
    sourceUrl: "fixture://scoring",
    fetchedAt: "2026-05-23T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {
      OSS_EMISSION_SHARE: 0.9,
      MERGED_PR_BASE_SCORE: 25,
      MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
      MAX_CODE_DENSITY_MULTIPLIER: 1.15,
      MAX_CONTRIBUTION_BONUS: 25,
      CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
      STANDARD_ISSUE_MULTIPLIER: 1.33,
      MAINTAINER_ISSUE_MULTIPLIER: 1.66,
      MIN_CREDIBILITY: 0.8,
      REVIEW_PENALTY_RATE: 0.15,
      EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
      OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
      MAX_OPEN_PR_THRESHOLD: 30,
      OPEN_PR_COLLATERAL_PERCENT: 0.2,
      SRC_TOK_SATURATION_SCALE: 58,
    },
    programmingLanguages: { TypeScript: 1 },
    registrySnapshotId: snapshot.id,
    warnings: [],
    payload: {},
  });
  await upsertRepoSyncState(env, {
    repoFullName: "entrius/allways-ui",
    status: "success",
    sourceKind: "github",
    primaryLanguage: "TypeScript",
    defaultBranch: "main",
    isPrivate: false,
    openIssuesCount: 2,
    openPullRequestsCount: 2,
    recentMergedPullRequestsCount: 1,
    warnings: [],
  });
  await persistRepoGithubTotalsSnapshot(env, {
    id: "totals-entrius-allways-ui",
    repoFullName: "entrius/allways-ui",
    openIssuesTotal: 2,
    openPullRequestsTotal: 2,
    mergedPullRequestsTotal: 1,
    closedUnmergedPullRequestsTotal: 0,
    labelsTotal: 2,
    sourceKind: "github",
    fetchedAt: "2026-05-23T00:00:00.000Z",
    payload: {},
  });
  await Promise.all(
    [
      { segment: "metadata", fetchedCount: 1, expectedCount: 1 },
      { segment: "labels", fetchedCount: 2, expectedCount: 2 },
      { segment: "open_issues", fetchedCount: 2, expectedCount: 2 },
      { segment: "open_pull_requests", fetchedCount: 2, expectedCount: 2 },
      { segment: "pull_request_files", fetchedCount: 2, expectedCount: 2 },
      { segment: "pull_request_reviews", fetchedCount: 2, expectedCount: 2 },
      { segment: "check_summaries", fetchedCount: 2, expectedCount: 2 },
      { segment: "recent_merged_pull_requests", fetchedCount: 1, expectedCount: 1 },
    ].map((record) =>
      upsertRepoSyncSegment(env, {
        repoFullName: "entrius/allways-ui",
        segment: record.segment as never,
        status: "complete",
        sourceKind: "github",
        mode: "full",
        fetchedCount: record.fetchedCount,
        expectedCount: record.expectedCount,
        pageCount: 1,
        completedAt: "2026-05-23T00:00:00.000Z",
        warnings: [],
      }),
    ),
  );
  await upsertRepoLabel(env, {
    repoFullName: "entrius/allways-ui",
    name: "bug",
    color: "cc0000",
    description: "Bug",
    isConfigured: true,
    observedCount: 3,
    payload: {},
  });
  await upsertRepoLabel(env, {
    repoFullName: "entrius/allways-ui",
    name: "feature",
    color: "00cc00",
    description: "Feature",
    isConfigured: true,
    observedCount: 1,
    payload: {},
  });
  await upsertInstallationHealth(env, {
    installationId: 123,
    accountLogin: "entrius",
    repositorySelection: "selected",
    installedReposCount: 1,
    registeredInstalledCount: 1,
    status: "healthy",
    missingPermissions: [],
    missingEvents: [],
    permissions: { metadata: "read", pull_requests: "read", issues: "write" },
    events: ["issues", "issue_comment", "pull_request", "repository"],
    checkedAt: "2026-05-23T00:00:00.000Z",
  });
  await upsertIssueFromGitHub(env, "entrius/allways-ui", {
    number: 7,
    title: "Dashboard cache refresh fails after reconnect",
    state: "open",
    html_url: "https://github.com/entrius/allways-ui/issues/7",
    user: { login: "reporter" },
    labels: [{ name: "bug" }],
    body: "Cache refresh fails after reconnect.",
  });
  await upsertIssueFromGitHub(env, "entrius/allways-ui", {
    number: 8,
    title: "Add reconnect regression coverage",
    state: "open",
    html_url: "https://github.com/entrius/allways-ui/issues/8",
    user: { login: "reporter" },
    labels: [{ name: "feature" }],
    body: "Reconnect flows need regression coverage.",
  });
  await upsertPullRequestFromGitHub(env, "entrius/allways-ui", {
    number: 12,
    title: "Fix dashboard cache refresh after reconnect",
    state: "open",
    html_url: "https://github.com/entrius/allways-ui/pull/12",
    user: { login: "oktofeesh1" },
    author_association: "NONE",
    head: { sha: "abc123", ref: "fix-cache" },
    base: { ref: "test" },
    labels: [{ name: "bug" }],
    body: "Fixes #7",
  });
  await upsertPullRequestDetailSyncState(env, {
    repoFullName: "entrius/allways-ui",
    pullNumber: 12,
    status: "complete",
    filesSyncedAt: "2026-05-23T00:00:00.000Z",
    reviewsSyncedAt: "2026-05-23T00:00:00.000Z",
    checksSyncedAt: "2026-05-23T00:00:00.000Z",
    lastSyncedAt: "2026-05-23T00:00:00.000Z",
  });
  await upsertPullRequestFile(env, {
    repoFullName: "entrius/allways-ui",
    pullNumber: 12,
    path: "src/cache.ts",
    additions: 20,
    deletions: 2,
    changes: 22,
    payload: {},
  });
  await upsertPullRequestReview(env, {
    id: "entrius/allways-ui#12#1",
    repoFullName: "entrius/allways-ui",
    pullNumber: 12,
    reviewerLogin: "maintainer",
    state: "APPROVED",
    payload: {},
  });
  await upsertCheckSummary(env, {
    id: "entrius/allways-ui#abc123#test",
    repoFullName: "entrius/allways-ui",
    pullNumber: 12,
    headSha: "abc123",
    name: "test",
    status: "completed",
    conclusion: "success",
    payload: {},
  });
  await upsertPullRequestFromGitHub(env, "entrius/allways-ui", {
    number: 13,
    title: "Alternative cache reconnect fix",
    state: "open",
    html_url: "https://github.com/entrius/allways-ui/pull/13",
    user: { login: "other" },
    author_association: "NONE",
    head: { sha: "def456", ref: "alt-cache" },
    base: { ref: "test" },
    labels: [{ name: "bug" }],
    body: "Fixes #7",
  });
  await upsertPullRequestDetailSyncState(env, {
    repoFullName: "entrius/allways-ui",
    pullNumber: 13,
    status: "complete",
    filesSyncedAt: "2026-05-23T00:00:00.000Z",
    reviewsSyncedAt: "2026-05-23T00:00:00.000Z",
    checksSyncedAt: "2026-05-23T00:00:00.000Z",
    lastSyncedAt: "2026-05-23T00:00:00.000Z",
  });
  await upsertRecentMergedPullRequest(env, {
    repoFullName: "entrius/allways-ui",
    number: 3,
    title: "Fix dashboard cache refresh after reconnect",
    authorLogin: "oktofeesh1",
    mergedAt: "2026-05-01T00:00:00.000Z",
    labels: ["bug"],
    linkedIssues: [7],
    changedFiles: ["src/cache.ts"],
    payload: {},
  });
  await upsertBounty(env, {
    id: "bounty-1",
    repoFullName: "entrius/allways-ui",
    issueNumber: 7,
    status: "Completed",
    amountText: "0.0000",
    sourceUrl: "contract://issues/1",
    payload: { target_alpha: "74.0000", bounty_alpha: "0.0000" },
  });
}
