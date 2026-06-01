import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionForGitHubUser, hashToken } from "../../src/auth/security";
import {
  upsertBounty,
  upsertAgentCommandAnswer,
  upsertBurdenForecast,
  upsertCheckSummary,
  upsertInstallation,
  upsertInstallationHealth,
  upsertPullRequestFile,
  upsertPullRequestReview,
  upsertPullRequestDetailSyncState,
  upsertRecentMergedPullRequest,
  persistRepoGithubTotalsSnapshot,
  persistSignalSnapshot,
  recordProductUsageEvent,
  recordGitHubRateLimitObservation,
  listProductUsageEvents,
  listLatestSignalSnapshotsByTarget,
  persistUpstreamRulesetSnapshot,
  upsertUpstreamDriftReport,
  upsertRepoLabel,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  persistScoringModelSnapshot,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
  createAgentRun,
} from "../../src/db/repositories";
import { createApp } from "../../src/api/routes";
import { BURDEN_FORECAST_MAX_AGE_MS } from "../../src/services/burden-forecast";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";
import type { JsonValue } from "../../src/types";

describe("api routes", () => {
  // Freshness/readiness fixtures are dated relative to late May 2026; pin the clock so freshness SLO
  // windows stay deterministic regardless of when CI runs (fixtures otherwise tip "stale" after 7 days).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serves health and OpenAPI openly", async () => {
    const app = createApp();
    const env = createTestEnv();

    const preflight = await app.request("/v1/repos", { method: "OPTIONS", headers: { origin: "https://gittensory.aethereal.dev" } }, env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://gittensory.aethereal.dev");

    const dynamicOriginEnv = createTestEnv({ PUBLIC_SITE_ORIGIN: "https://preview.gittensory.test/app", PUBLIC_API_ORIGIN: "not a url" });
    const dynamicPreflight = await app.request("/v1/repos", { method: "OPTIONS", headers: { origin: "https://preview.gittensory.test" } }, dynamicOriginEnv);
    expect(dynamicPreflight.status).toBe(204);
    expect(dynamicPreflight.headers.get("access-control-allow-origin")).toBe("https://preview.gittensory.test");

    const health = await app.request("/health", {}, env);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      service: "gittensory-api",
      minMcpVersion: "0.2.0",
      latestRecommendedMcpVersion: "0.3.0",
    });

    const compatibility = await app.request("/v1/mcp/compatibility", {}, env);
    expect(compatibility.status).toBe(200);
    const compatibilityPayload = await compatibility.json();
    expect(compatibilityPayload).toMatchObject({
      status: "ok",
      service: "gittensory-api",
      apiVersion: "0.1.0",
      mcp: {
        packageName: "@jsonbored/gittensory-mcp",
        minimumSupportedVersion: "0.2.0",
        latestRecommendedVersion: "0.3.0",
        latestPackageVersion: "0.3.0",
      },
      compatibilityWarnings: [],
      breakingChanges: [],
    });
    expect(JSON.stringify(compatibilityPayload)).not.toMatch(/token|admin|wallet|hotkey|raw trust|scoreability|private repo|local-path/i);

    const unauthenticatedSpec = await app.request("/openapi.json", {}, env);
    expect(unauthenticatedSpec.status).toBe(200);
    await expect(unauthenticatedSpec.json()).resolves.toMatchObject({ info: { title: "Gittensory API" } });
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

  it("serves upstream ruleset status, ruleset snapshots, and drift reports through private APIs", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", upstreamContractFetch());

    const missing = await app.request("/v1/upstream/status", { headers: apiHeaders(env) }, env);
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toMatchObject({ status: "unavailable" });

    const refresh = await app.request(
      "/v1/internal/jobs/refresh-upstream-drift/run",
      { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } },
      env,
    );
    expect(refresh.status).toBe(200);
    await expect(refresh.json()).resolves.toMatchObject({ ruleset: { activeModel: "pending_saturation_model", registryRepoCount: 1 }, drift: null });

    const status = await app.request("/v1/upstream/status", { headers: apiHeaders(env) }, env);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ status: "current", activeModel: "pending_saturation_model" });

    const ruleset = await app.request("/v1/upstream/ruleset", { headers: apiHeaders(env) }, env);
    expect(ruleset.status).toBe(200);
    await expect(ruleset.json()).resolves.toMatchObject({ commitSha: "api-commit", registryRepoCount: 1 });

    const drift = await app.request("/v1/upstream/drift", { headers: apiHeaders(env) }, env);
    expect(drift.status).toBe(200);
    await expect(drift.json()).resolves.toMatchObject({ upstreamDrift: { status: "current" }, reports: [] });
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

  it("rejects oversized webhook payloads and rate limits repeated invalid webhook traffic", async () => {
    const counters = new Map<string, number>();
    const app = createApp();
    const env = createTestEnv({
      GITHUB_WEBHOOK_MAX_BODY_BYTES: "1024",
      RATE_LIMITER: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get(id: DurableObjectId) {
          const key = String(id);
          return {
            async fetch() {
              const count = (counters.get(key) ?? 0) + 1;
              counters.set(key, count);
              if (count <= 10) return Response.json({ allowed: true, limit: 10, remaining: 10 - count, resetAt: "2099-01-01T00:00:00.000Z" });
              return Response.json({ allowed: false, limit: 10, remaining: 0, retryAfterSeconds: 60, resetAt: "2099-01-01T00:00:00.000Z" }, { status: 429 });
            },
          } as unknown as DurableObjectStub;
        },
      } as DurableObjectNamespace,
    });
    const oversizedBody = JSON.stringify({
      action: "opened",
      repository: { full_name: "JSONbored/gittensory" },
      blob: "x".repeat(3_000),
    });
    const tooLarge = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body: oversizedBody,
        headers: {
          "x-github-delivery": "oversized-1",
          "x-github-event": "push",
        },
      },
      env,
    );
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toMatchObject({ error: "payload_too_large", maxBytes: 1024 });

    const invalidBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" } });
    let sawUnauthorized = false;
    let sawRateLimited = false;
    for (let index = 0; index < 12; index += 1) {
      const response = await app.request(
        "/v1/github/webhook",
        {
          method: "POST",
          body: invalidBody,
          headers: {
            "x-github-delivery": `invalid-${index}`,
            "x-github-event": "push",
            "x-hub-signature-256": "sha256=bad",
          },
        },
        env,
      );
      if (response.status === 401) sawUnauthorized = true;
      if (response.status === 429) {
        sawRateLimited = true;
        await expect(response.json()).resolves.toMatchObject({ error: "rate_limited", routeClass: "strict" });
        break;
      }
    }
    expect(sawUnauthorized).toBe(true);
    expect(sawRateLimited).toBe(true);
  });

  it("rejects oversized webhook requests from content-length and signed invalid JSON payloads", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_WEBHOOK_MAX_BODY_BYTES: "1024" });

    const contentLengthRejected = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body: "{}",
        headers: {
          "x-github-delivery": "oversized-content-length",
          "x-github-event": "push",
          "content-length": "2048",
        },
      },
      env,
    );
    expect(contentLengthRejected.status).toBe(413);
    await expect(contentLengthRejected.json()).resolves.toMatchObject({ error: "payload_too_large", maxBytes: 1024 });

    const malformedBody = "{";
    const malformedSignature = await signWebhook(malformedBody, env.GITHUB_WEBHOOK_SECRET);
    const malformedJson = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body: malformedBody,
        headers: {
          "x-github-delivery": "invalid-json-signed",
          "x-github-event": "push",
          "x-hub-signature-256": malformedSignature,
        },
      },
      env,
    );
    expect(malformedJson.status).toBe(400);
    await expect(malformedJson.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("handles webhook size parsing fallbacks for invalid env/header values and empty request bodies", async () => {
    const app = createApp();
    const env = createTestEnv({
      GITHUB_WEBHOOK_MAX_BODY_BYTES: "0",
    });

    const emptyBody = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        headers: {
          "x-github-delivery": "empty-body",
          "x-github-event": "push",
          "x-hub-signature-256": "sha256=bad",
        },
      },
      env,
    );
    expect(emptyBody.status).toBe(401);
    await expect(emptyBody.json()).resolves.toMatchObject({ error: "invalid_signature" });

    const validBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory", name: "gittensory" } });
    const validSignature = await signWebhook(validBody, env.GITHUB_WEBHOOK_SECRET);
    const invalidLengthHeader = await app.request(
      "/v1/github/webhook",
      {
        method: "POST",
        body: validBody,
        headers: {
          "x-github-delivery": "invalid-content-length",
          "x-github-event": "pull_request",
          "x-hub-signature-256": validSignature,
          "content-length": "not-a-number",
        },
      },
      env,
    );
    expect(invalidLengthHeader.status).toBe(202);
    await expect(invalidLengthHeader.json()).resolves.toMatchObject({ status: "queued", deliveryId: "invalid-content-length" });
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

    const listedAgentRuns = await app.request("/v1/agent/runs?actorLogin=oktofeesh1", { headers: apiHeaders(env) }, env);
    expect(listedAgentRuns.status).toBe(200);
    await expect(listedAgentRuns.json()).resolves.toMatchObject({
      runs: expect.arrayContaining([expect.objectContaining({ run: expect.objectContaining({ id: agentPlanPayload.run.id }) })]),
    });

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

    const queueIntelligence = await app.request(
      "/v1/internal/queue-intelligence",
      {
        method: "POST",
        headers: internalHeaders(env),
        body: JSON.stringify({
          pullRequests: [
            {
              number: 1,
              author: "alice",
              authorRole: "contributor",
              isConfirmedMiner: true,
              linkedIssue: { qualityScore: 0.9 },
              checksStatus: "passing",
              isStale: false,
              additions: 50,
              deletions: 10,
              title: "Fix cache",
              body: "Fixes #1",
              duplicateCandidates: [],
              createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
              lastUpdatedAt: new Date(Date.now() - 3600000).toISOString(),
            },
            {
              number: 2,
              author: "bob",
              authorRole: "maintainer",
              isConfirmedMiner: false,
              linkedIssue: null,
              checksStatus: "failing",
              isStale: true,
              additions: 800,
              deletions: 900,
              title: "",
              body: "",
              duplicateCandidates: [5],
              createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
              lastUpdatedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
            },
          ],
          repoContext: { totalOpenPRs: 2, avgReviewTimeDays: 4, maintainerWorkload: 0.7 },
        }),
      },
      env,
    );
    expect(queueIntelligence.status).toBe(200);
    const queueIntelligencePayload = (await queueIntelligence.json()) as {
      rankedPRs: Array<{ number: number; title: string; author: string; recommendation: string }>;
      recommendations: Record<number, string>;
    };
    expect(queueIntelligencePayload.rankedPRs).toHaveLength(2);
    expect(queueIntelligencePayload.rankedPRs[0]).toMatchObject({ number: 1 });
    expect(queueIntelligencePayload.rankedPRs[1]).toMatchObject({ number: 2 });
    expect(queueIntelligencePayload.recommendations).toMatchObject({ "1": "review_now", "2": "maintainer_lane" });

    const invalidQueueIntelligence = await app.request(
      "/v1/internal/queue-intelligence",
      { method: "POST", headers: internalHeaders(env), body: JSON.stringify({ pullRequests: [{ number: 1 }] }) },
      env,
    );
    expect(invalidQueueIntelligence.status).toBe(400);

    const invalidRepoContext = await app.request(
      "/v1/internal/queue-intelligence",
      {
        method: "POST",
        headers: internalHeaders(env),
        body: JSON.stringify({
          pullRequests: [
            {
              number: 1,
              author: "alice",
              authorRole: "contributor",
              isConfirmedMiner: true,
              linkedIssue: { qualityScore: 0.9 },
              checksStatus: "passing",
              isStale: false,
              additions: 50,
              deletions: 10,
              title: "Fix cache",
              body: "Fixes #1",
              duplicateCandidates: [],
              createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
              lastUpdatedAt: new Date(Date.now() - 3600000).toISOString(),
            },
          ],
          repoContext: { totalOpenPRs: "invalid" },
        }),
      },
      env,
    );
    expect(invalidRepoContext.status).toBe(200);

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
    // A first sighting of bounty id "2" records one lifecycle event (the watcher).
    await expect(imported.json()).resolves.toMatchObject({ imported: 1, lifecycleEvents: 1 });

    const bounties = await app.request("/v1/bounties", { headers: apiHeaders(env) }, env);
    expect(bounties.status).toBe(200);
    await expect(bounties.json()).resolves.toHaveLength(2);

    const bountyAdvisory = await app.request("/v1/bounties/bounty-1/advisory", { headers: apiHeaders(env) }, env);
    expect(bountyAdvisory.status).toBe(200);
    await expect(bountyAdvisory.json()).resolves.toMatchObject({ lifecycle: "completed", isActiveOpportunity: false, fundingStatus: "target_only" });

    // Re-importing the same bounty with a changed status records a second lifecycle transition; an unchanged re-import records none.
    const reimported = await app.request(
      "/v1/internal/bounties/import",
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` },
        body: JSON.stringify({
          success: true,
          issue_count: 1,
          issues: [{ id: 2, repository_full_name: "entrius/allways-ui", issue_number: 8, status: "Completed", bounty_alpha: "0.0000", target_alpha: "17.0000" }],
        }),
      },
      env,
    );
    await expect(reimported.json()).resolves.toMatchObject({ imported: 1, lifecycleEvents: 1 });

    const lifecycle = await app.request("/v1/bounties/2/lifecycle", { headers: apiHeaders(env) }, env);
    expect(lifecycle.status).toBe(200);
    const lifecycleBody = (await lifecycle.json()) as { bountyId: string; events: Array<{ status: string }> };
    expect(lifecycleBody.bountyId).toBe("2");
    expect(lifecycleBody.events).toHaveLength(2);
    expect(lifecycleBody.events.map((event) => event.status)).toEqual(expect.arrayContaining(["Cancelled", "Completed"]));

    const missingLifecycle = await app.request("/v1/bounties/missing/lifecycle", { headers: apiHeaders(env) }, env);
    expect(missingLifecycle.status).toBe(404);

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
      [
        "issue-quality",
        {
          repoFullName: "entrius/allways-ui",
          generatedAt: "2026-05-25T00:00:00.000Z",
          lane: { lane: "direct_pr" },
          issues: [{ number: 7, title: "fixture", status: "ready", score: 80, reasons: [], warnings: [] }],
          summary: "fixture",
        },
      ],
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
    const staleForecastGeneratedAt = new Date(Date.now() - BURDEN_FORECAST_MAX_AGE_MS - 60_000).toISOString();
    await upsertBurdenForecast(env, {
      repoFullName: "entrius/allways-ui",
      payload: { repoFullName: "entrius/allways-ui", level: "medium", summary: "intelligence fixture" } as unknown as Record<string, JsonValue>,
      generatedAt: staleForecastGeneratedAt,
    });
    const snapshotIntelligence = await app.request("/v1/repos/entrius/allways-ui/intelligence", { headers: apiHeaders(env) }, env);
    expect(snapshotIntelligence.status).toBe(200);
    const snapshotIntelligenceBody = (await snapshotIntelligence.json()) as Record<string, unknown> & { burdenForecast?: Record<string, unknown>; burdenForecastFreshness?: { freshness: string; source: string; ageSeconds: number } };
    expect(snapshotIntelligenceBody).toMatchObject({ source: "snapshot", queueHealth: { signals: { openPullRequests: 2 } } });
    expect(snapshotIntelligenceBody.burdenForecast).toMatchObject({ level: "medium" });
    expect(snapshotIntelligenceBody.burdenForecastFreshness).toMatchObject({ source: "snapshot", freshness: "stale" });
    expect(snapshotIntelligenceBody.burdenForecastFreshness?.ageSeconds).toBeGreaterThanOrEqual(Math.floor((BURDEN_FORECAST_MAX_AGE_MS + 50_000) / 1000));
    expect(snapshotIntelligenceBody.burdenForecastFreshness?.ageSeconds).toBeLessThan(Math.floor((BURDEN_FORECAST_MAX_AGE_MS + 120_000) / 1000));

    await upsertRepositoryFromGitHub(env, { name: "uncached-burden", full_name: "entrius/uncached-burden", private: false, owner: { login: "entrius" }, default_branch: "main" });
    const computedIntelligence = await app.request("/v1/repos/entrius/uncached-burden/intelligence", { headers: apiHeaders(env) }, env);
    expect(computedIntelligence.status).toBe(200);
    await expect(computedIntelligence.json()).resolves.toMatchObject({
      source: "computed",
      burdenForecast: { repoFullName: "entrius/uncached-burden", level: "low" },
      burdenForecastFreshness: { source: "computed", freshness: "fresh", ageSeconds: 0 },
    });

    const degradedForecastEnv = withBurdenForecastReadFailure(env);
    const degradedIntelligence = await app.request("/v1/repos/entrius/allways-ui/intelligence", { headers: apiHeaders(env) }, degradedForecastEnv);
    expect(degradedIntelligence.status).toBe(200);
    const degradedBody = (await degradedIntelligence.json()) as Record<string, unknown> & { dataQuality: { status: string; warnings: string[] }; burdenForecast?: unknown };
    expect(degradedBody.burdenForecast).toBeUndefined();
    expect(degradedBody.dataQuality.status).toBe("degraded");
    expect(degradedBody.dataQuality.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Burden forecast unavailable/i)]));

    const issueQuality = await app.request("/v1/repos/entrius/allways-ui/issue-quality", { headers: apiHeaders(env) }, env);
    expect(issueQuality.status).toBe(200);
    await expect(issueQuality.json()).resolves.toMatchObject({
      status: "ready",
      source: "snapshot",
      repoFullName: "entrius/allways-ui",
      report: { repoFullName: "entrius/allways-ui", issues: expect.any(Array) },
    });

    await upsertRepositoryFromGitHub(env, { name: "uncached", full_name: "entrius/uncached", private: false, owner: { login: "entrius" }, default_branch: "main" });
    const computedIssueQuality = await app.request("/v1/repos/entrius/uncached/issue-quality", { headers: apiHeaders(env) }, env);
    expect(computedIssueQuality.status).toBe(200);
    await expect(computedIssueQuality.json()).resolves.toMatchObject({ status: "ready", source: "computed", repoFullName: "entrius/uncached" });

    for (const path of [
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

  it("serves live app dashboards, digest subscriptions, commands, and extension context", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "oktofeesh1,other", PRODUCT_USAGE_HASH_SALT: "usage-adoption-test-salt" });
    await seedSignalData(env);
    stubOktofeeshFetch();

    const { token: browserToken } = await createSessionForGitHubUser(env, { login: "oktofeesh1", id: 12345 });
    const cookieHeaders = { cookie: `gittensory_session=${browserToken}`, "content-type": "application/json" };
    const internalHeaders = { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" };

    const overviewPreflight = await app.request("/v1/app/overview", { method: "OPTIONS", headers: { origin: "https://gittensory.aethereal.dev" } }, env);
    expect(overviewPreflight.status).toBe(204);
    const bareOverviewPreflight = await app.request("/v1/app/overview", { method: "OPTIONS" }, env);
    expect(bareOverviewPreflight.status).toBe(204);

    const overview = await app.request("/v1/app/overview", { headers: cookieHeaders }, env);
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      actor: { kind: "session", login: "oktofeesh1" },
      roleSummary: {
        roles: ["operator"],
        onboarding: { status: "ready", primaryRole: "operator" },
      },
      metrics: expect.arrayContaining([expect.objectContaining({ label: "Registered repos" })]),
      upstreamDrift: expect.any(Object),
    });
    const roleSummary = await app.request("/v1/app/roles", { headers: cookieHeaders }, env);
    expect(roleSummary.status).toBe(200);
    await expect(roleSummary.json()).resolves.toMatchObject({
      login: "oktofeesh1",
      roles: ["operator"],
      roleCards: expect.arrayContaining([expect.objectContaining({ role: "operator", status: "active" })]),
      publicSafe: true,
    });

    const emptyEnv = createTestEnv();
    const emptyOverview = await app.request("/v1/app/overview", { headers: apiHeaders(emptyEnv) }, emptyEnv);
    expect(emptyOverview.status).toBe(200);
    await expect(emptyOverview.json()).resolves.toMatchObject({
      actor: { kind: "static", login: "api" },
      registry: null,
      scoringModel: null,
      recentRuns: [],
    });

    const missingRuleset = await app.request("/v1/upstream/ruleset", { headers: apiHeaders(emptyEnv) }, emptyEnv);
    expect(missingRuleset.status).toBe(404);
    const emptySyncStatus = await app.request("/v1/sync/status", { headers: apiHeaders(emptyEnv) }, emptyEnv);
    expect(emptySyncStatus.status).toBe(200);
    await expect(emptySyncStatus.json()).resolves.toMatchObject({ repositories: [], segments: [] });
    const emptyOperator = await app.request("/v1/app/operator-dashboard", { headers: apiHeaders(emptyEnv) }, emptyEnv);
    expect(emptyOperator.status).toBe(200);
    await expect(emptyOperator.json()).resolves.toMatchObject({
      metrics: expect.arrayContaining([expect.objectContaining({ label: "Registered repos", delta: "registry missing" })]),
    });
    const driftDigest = await app.request("/v1/app/digest", { headers: apiHeaders(emptyEnv) }, emptyEnv);
    expect(driftDigest.status).toBe(200);
    await expect(driftDigest.json()).resolves.toMatchObject({
      signal: "warn",
      items: expect.arrayContaining([expect.objectContaining({ kind: "drift", meta: "watch" })]),
    });
    const emptyMinerDashboard = await app.request("/v1/app/miner-dashboard?login=empty-user", { headers: apiHeaders(emptyEnv) }, emptyEnv);
    expect(emptyMinerDashboard.status).toBe(200);
    await expect(emptyMinerDashboard.json()).resolves.toMatchObject({
      status: "needs_refresh",
      mcp: { snapshot: null, lastRun: null },
    });

    const missingMinerLogin = await app.request("/v1/app/miner-dashboard", { headers: apiHeaders(env) }, env);
    expect(missingMinerLogin.status).toBe(400);

    const { token: otherToken } = await createSessionForGitHubUser(env, { login: "other", id: 987 });
    const forbiddenMiner = await app.request("/v1/app/miner-dashboard?login=oktofeesh1", { headers: { cookie: `gittensory_session=${otherToken}` } }, env);
    expect(forbiddenMiner.status).toBe(403);

    const unknownEnv = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token: unknownToken } = await createSessionForGitHubUser(unknownEnv, { login: "new-user", id: 2468 });
    const unknownHeaders = { cookie: `gittensory_session=${unknownToken}`, "content-type": "application/json" };
    const unknownSession = await app.request("/v1/auth/session", { headers: unknownHeaders }, unknownEnv);
    expect(unknownSession.status).toBe(200);
    const unknownSessionBody = await unknownSession.json();
    expect(unknownSessionBody).toMatchObject({
      status: "authenticated",
      login: "new-user",
      roles: [],
      roleSummary: { onboarding: { status: "needs_setup" } },
    });
    expect(JSON.stringify(unknownSessionBody)).not.toMatch(/wallet|hotkey|raw trust|payout|reward estimate|farming|private reviewability|public score estimate|\/Users|github_pat|ghp_/i);
    const unknownOverview = await app.request("/v1/app/overview", { headers: unknownHeaders }, unknownEnv);
    expect(unknownOverview.status).toBe(200);
    await expect(unknownOverview.json()).resolves.toMatchObject({ roleSummary: { roles: [], onboarding: { status: "needs_setup" } } });
    expect((await app.request("/v1/app/operator-dashboard", { headers: unknownHeaders }, unknownEnv)).status).toBe(403);
    expect((await app.request("/v1/app/analytics/daily-rollups", { headers: unknownHeaders }, unknownEnv)).status).toBe(403);
    expect((await app.request("/v1/app/analytics/mcp-compatibility", { headers: unknownHeaders }, unknownEnv)).status).toBe(403);
    expect((await app.request("/v1/app/analytics/weekly-value-report", { headers: unknownHeaders }, unknownEnv)).status).toBe(403);
    expect((await app.request("/v1/contributors/new-user/decision-pack", { headers: unknownHeaders }, unknownEnv)).status).toBe(403);
    expect((await app.request("/v1/auth/extension/session", { method: "POST", headers: unknownHeaders }, unknownEnv)).status).toBe(403);

    const ownerEnv = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    await upsertInstallation(ownerEnv, {
      installation: {
        id: 777,
        account: { login: "repo-owner", id: 777, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "pull_request", "repository"],
      },
    });
    await upsertRepositoryFromGitHub(ownerEnv, { name: "owned-repo", full_name: "repo-owner/owned-repo", private: false, default_branch: "main", owner: { login: "repo-owner" } }, 777);
    const { token: ownerToken } = await createSessionForGitHubUser(ownerEnv, { login: "repo-owner", id: 777 });
    const ownerHeaders = { cookie: `gittensory_session=${ownerToken}`, "content-type": "application/json" };
    const ownerRoles = await app.request("/v1/app/roles", { headers: ownerHeaders }, ownerEnv);
    expect(ownerRoles.status).toBe(200);
    await expect(ownerRoles.json()).resolves.toMatchObject({
      roles: ["maintainer", "owner"],
      evidence: { ownedInstalledRepos: 1, accountInstallations: 1, operator: false },
    });
    expect((await app.request("/v1/app/maintainer-dashboard", { headers: ownerHeaders }, ownerEnv)).status).toBe(200);
    expect((await app.request("/v1/app/notification-model", { headers: ownerHeaders }, ownerEnv)).status).toBe(200);
    expect((await app.request("/v1/app/operator-dashboard", { headers: ownerHeaders }, ownerEnv)).status).toBe(403);
    expect((await app.request("/v1/app/analytics/daily-rollups", { headers: ownerHeaders }, ownerEnv)).status).toBe(403);
    expect((await app.request("/v1/app/analytics/mcp-compatibility", { headers: ownerHeaders }, ownerEnv)).status).toBe(403);
    const ownerWeeklyReport = await app.request("/v1/app/analytics/weekly-value-report", { headers: ownerHeaders }, ownerEnv);
    expect(ownerWeeklyReport.status).toBe(200);
    const ownerWeeklyReportBody = await ownerWeeklyReport.json();
    expect(ownerWeeklyReportBody).toMatchObject({ variant: "public", publicSafe: true });
    expect(ownerWeeklyReportBody).not.toHaveProperty("operatorDetails");
    expect((await app.request("/v1/app/analytics/weekly-value-report?variant=operator", { headers: ownerHeaders }, ownerEnv)).status).toBe(403);
    const ownerExtensionSession = await app.request("/v1/auth/extension/session", { method: "POST", headers: ownerHeaders }, ownerEnv);
    expect(ownerExtensionSession.status).toBe(201);
    const ownerExtensionSessionBody = (await ownerExtensionSession.json()) as { token: string; login: string; scopes: string[] };
    expect(ownerExtensionSessionBody).toMatchObject({ login: "repo-owner", scopes: ["extension:pull_context"] });
    const ownerExtensionMissingPull = await app.request(
      "/v1/extension/pull-context?owner=repo-owner&repo=owned-repo",
      { headers: { authorization: `Bearer ${ownerExtensionSessionBody.token}` } },
      ownerEnv,
    );
    expect(ownerExtensionMissingPull.status).toBe(400);

    const minerNeedsRefresh = await app.request("/v1/app/miner-dashboard?login=oktofeesh1", { headers: apiHeaders(env) }, env);
    expect(minerNeedsRefresh.status).toBe(200);
    await expect(minerNeedsRefresh.json()).resolves.toMatchObject({
      status: "needs_refresh",
      blockers: [expect.objectContaining({ group: "decision-pack" })],
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

    const minerReady = await app.request("/v1/app/miner-dashboard", { headers: cookieHeaders }, env);
    expect(minerReady.status).toBe(200);
    await expect(minerReady.json()).resolves.toMatchObject({
      status: "ready",
      login: "oktofeesh1",
      nextActions: expect.any(Array),
      projections: expect.any(Array),
      repoFit: expect.any(Array),
      mcp: expect.objectContaining({ snapshot: "scoring-1" }),
    });

    await persistSignalSnapshot(env, {
      id: "blocker-pack",
      signalType: "contributor-decision-pack",
      targetKey: "blocker-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "blocker-user",
        generatedAt: new Date().toISOString(),
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        repoDecisions: [{ recommendation: "fallback" }, { priorityScore: 250 }, {}],
        topActions: undefined,
        cleanupFirst: [{ repoFullName: "entrius/allways-ui", reason: "cached queue needs cleanup before new work" }],
        pursueRepos: [{ repoFullName: "owner/stable", reason: "fresh low-risk queue" }],
        avoidRepos: [{ repoFullName: "owner/removed", reason: "removed from registry" }],
        maintainerLaneRepos: [{ repoFullName: "repo-owner/owned-repo", reason: "owner-maintained repo" }],
        scoreBlockers: ["legacy blocker", { code: "open_pr_pressure", detail: "Too many open PRs" }],
        dataQuality: { signalFidelity: { status: "degraded" } },
      } as never,
      generatedAt: new Date().toISOString(),
    });
    const minerWithBlockers = await app.request("/v1/app/miner-dashboard?login=blocker-user", { headers: apiHeaders(env) }, env);
    expect(minerWithBlockers.status).toBe(200);
    await expect(minerWithBlockers.json()).resolves.toMatchObject({
      status: "ready",
      blockers: expect.arrayContaining([expect.objectContaining({ group: "scoreability" })]),
      projections: expect.arrayContaining([expect.objectContaining({ name: "fallback" }), expect.objectContaining({ name: "repo" })]),
      repoFit: expect.arrayContaining([
        expect.objectContaining({ repoFullName: "owner/stable", lane: "pursue" }),
        expect.objectContaining({ repoFullName: "entrius/allways-ui", lane: "cleanup-first" }),
        expect.objectContaining({ repoFullName: "repo-owner/owned-repo", lane: "maintainer-lane" }),
        expect.objectContaining({ repoFullName: "owner/removed", lane: "avoid" }),
      ]),
    });

    await persistSignalSnapshot(env, {
      id: "sparse-pack",
      signalType: "contributor-decision-pack",
      targetKey: "sparse-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "sparse-user",
        generatedAt: new Date().toISOString(),
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        repoDecisions: [],
      } as never,
      generatedAt: new Date().toISOString(),
    });
    const sparseMiner = await app.request("/v1/app/miner-dashboard?login=sparse-user", { headers: apiHeaders(env) }, env);
    expect(sparseMiner.status).toBe(200);
    await expect(sparseMiner.json()).resolves.toMatchObject({
      status: "ready",
      nextActions: [],
      blockers: [],
      projections: [],
      repoFit: [],
      mcp: { snapshot: "scoring-1", lastRun: null },
    });

    await persistSignalSnapshot(env, {
      id: "empty-fit-pack",
      signalType: "contributor-decision-pack",
      targetKey: "empty-fit-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "empty-fit-user",
        generatedAt: new Date().toISOString(),
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        repoDecisions: [],
        dataQuality: { signalFidelity: { status: "complete" } },
      } as never,
      generatedAt: new Date().toISOString(),
    });
    const minerWithEmptyFit = await app.request("/v1/app/miner-dashboard?login=empty-fit-user", { headers: apiHeaders(env) }, env);
    expect(minerWithEmptyFit.status).toBe(200);
    await expect(minerWithEmptyFit.json()).resolves.toMatchObject({ status: "ready", repoFit: [] });

    await recordGitHubRateLimitObservation(env, {
      id: "rate-limit-healthy",
      repoFullName: "entrius/allways-ui",
      resource: "graphql",
      path: "/graphql",
      statusCode: 200,
      limitValue: 5000,
      remaining: 10,
      resetAt: "2026-05-31T12:00:00.000Z",
      observedAt: "2026-05-31T10:00:00.000Z",
    });
    await upsertPullRequestFromGitHub(env, "entrius/allways-ui", {
      number: 14,
      title: "Document install recovery",
      state: "open",
      html_url: "https://github.com/entrius/allways-ui/pull/14",
      labels: [],
      body: "No linked issue here.",
    });
    const maintainer = await app.request("/v1/app/maintainer-dashboard", { headers: apiHeaders(env) }, env);
    expect(maintainer.status).toBe(200);
    await expect(maintainer.json()).resolves.toMatchObject({
      installations: expect.any(Array),
      health: expect.arrayContaining([expect.objectContaining({ status: "healthy" })]),
      reviewability: expect.arrayContaining([
        expect.objectContaining({ pr: "entrius/allways-ui#12" }),
        expect.objectContaining({ pr: "entrius/allways-ui#14", author: "unknown", reason: "cached open PR without linked issue" }),
      ]),
      settingsPreview: { added: expect.any(Array), removed: expect.any(Array) },
    });

    await upsertAgentCommandAnswer(env, {
      id: "api-answer-feedback",
      repoFullName: "entrius/allways-ui",
      issueNumber: 14,
      command: "preflight",
      requestCommentId: 100,
      responseCommentId: 101,
      responseUrl: "https://github.com/entrius/allways-ui/pull/14#issuecomment-101",
      actorKind: "maintainer",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      metadata: {},
    });
    const unauthenticatedFeedback = await app.request(
      "/v1/app/commands/feedback",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answerId: "api-answer-feedback", vote: "useful" }) },
      env,
    );
    expect(unauthenticatedFeedback.status).toBe(401);
    const invalidFeedback = await app.request(
      "/v1/app/commands/feedback",
      { method: "POST", headers: cookieHeaders, body: JSON.stringify({ answerId: "bad<script>", vote: "useful" }) },
      env,
    );
    expect(invalidFeedback.status).toBe(400);
    const missingFeedback = await app.request(
      "/v1/app/commands/feedback",
      { method: "POST", headers: cookieHeaders, body: JSON.stringify({ answerId: "missing-answer", vote: "useful" }) },
      env,
    );
    expect(missingFeedback.status).toBe(404);
    const firstFeedback = await app.request(
      "/v1/app/commands/feedback",
      { method: "POST", headers: cookieHeaders, body: JSON.stringify({ answerId: "api-answer-feedback", vote: "useful" }) },
      env,
    );
    expect(firstFeedback.status).toBe(200);
    const updatedFeedback = await app.request(
      "/v1/app/commands/feedback",
      { method: "POST", headers: cookieHeaders, body: JSON.stringify({ answerId: "api-answer-feedback", vote: "not_useful" }) },
      env,
    );
    expect(updatedFeedback.status).toBe(200);
    const unauthenticatedUsefulness = await app.request("/v1/app/commands/usefulness?days=14", {}, env);
    expect(unauthenticatedUsefulness.status).toBe(401);
    const usefulness = await app.request("/v1/app/commands/usefulness?days=14", { headers: apiHeaders(env) }, env);
    expect(usefulness.status).toBe(200);
    await expect(usefulness.json()).resolves.toMatchObject({
      windowDays: 14,
      totals: { feedbackCount: 1, usefulCount: 0, notUsefulCount: 1, usefulnessRate: 0 },
      commands: [expect.objectContaining({ command: "preflight", feedbackCount: 1 })],
    });
    const clampedUsefulness = await app.request("/v1/app/commands/usefulness?days=not-a-number", { headers: apiHeaders(env) }, env);
    expect(clampedUsefulness.status).toBe(200);
    await expect(clampedUsefulness.json()).resolves.toMatchObject({ windowDays: 1 });
    const defaultUsefulness = await app.request("/v1/app/commands/usefulness", { headers: apiHeaders(env) }, env);
    expect(defaultUsefulness.status).toBe(200);
    await expect(defaultUsefulness.json()).resolves.toMatchObject({ windowDays: 30 });

    const operator = await app.request("/v1/app/operator-dashboard", { headers: apiHeaders(env) }, env);
    expect(operator.status).toBe(200);
    await expect(operator.json()).resolves.toMatchObject({
      metrics: expect.arrayContaining([expect.objectContaining({ label: "Active sessions" }), expect.objectContaining({ label: "Digest subscriptions" }), expect.objectContaining({ label: "Command usefulness", value: "0/1" })]),
      noiseReduction: expect.any(Array),
      weeklyReport: expect.arrayContaining([expect.stringContaining("registered repo")]),
      commandUsefulness: expect.objectContaining({ totals: expect.objectContaining({ feedbackCount: 1 }) }),
    });

    const notificationModel = await app.request("/v1/app/notification-model", { headers: apiHeaders(env) }, env);
    expect(notificationModel.status).toBe(200);
    const notificationBody = (await notificationModel.json()) as Record<string, unknown>;
    expect(notificationBody).toMatchObject({
      notificationModel: {
        mode: "opt_in",
        defaultState: "disabled",
        fallbackWhenUnavailable: "in_app_digest_only",
        channels: expect.arrayContaining([
          expect.objectContaining({ id: "in_app_digest", defaultEnabled: true }),
          expect.objectContaining({ id: "browser_push", defaultEnabled: false, requiresPermission: true }),
        ]),
        privacyGuards: expect.arrayContaining([
          expect.stringMatching(/wallets|hotkeys|payout\/reward/i),
          expect.stringMatching(/authenticated browser session/i),
        ]),
      },
      pwa: {
        nativeDependency: false,
        manifestPath: "/manifest.webmanifest",
        serviceWorkerPath: "/sw.js",
      },
      mobileReadyRoutes: expect.arrayContaining(["/app/operator", "/app/maintainer"]),
      nativeMobileFuture: expect.any(Array),
    });
    expect(JSON.stringify(notificationBody)).toMatch(/wallets|hotkeys|payout\/reward estimates|raw trust scores|farming language/i);

    const commands = await app.request("/v1/app/commands", { headers: apiHeaders(env) }, env);
    expect(commands.status).toBe(200);
    await expect(commands.json()).resolves.toMatchObject({
      commands: expect.arrayContaining([expect.objectContaining({ id: "public-summary" })]),
    });

    const publicPreview = await app.request(
      "/v1/app/commands/preview",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ command: "@gittensory public-summary", repoFullName: "entrius/allways-ui", pullNumber: 12 }),
      },
      env,
    );
    expect(publicPreview.status).toBe(200);
    await expect(publicPreview.json()).resolves.toMatchObject({
      preview: { boundary: "public", body: expect.stringContaining("entrius/allways-ui#12") },
    });

    const privatePreview = await app.request(
      "/v1/app/commands/preview",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ command: "preflight", repoFullName: "entrius/allways-ui", login: "oktofeesh1" }),
      },
      env,
    );
    expect(privatePreview.status).toBe(200);
    await expect(privatePreview.json()).resolves.toMatchObject({
      preview: { boundary: "private-api", endpoint: "/v1/agent/preflight-branch" },
    });

    const privatePreviewWithoutTarget = await app.request(
      "/v1/app/commands/preview",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ command: "preflight" }),
      },
      env,
    );
    expect(privatePreviewWithoutTarget.status).toBe(200);
    await expect(privatePreviewWithoutTarget.json()).resolves.toMatchObject({
      preview: { body: expect.stringContaining("selected target") },
    });

    const previewWithoutRepo = await app.request(
      "/v1/app/commands/preview",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ command: "public-summary", pullNumber: 12 }),
      },
      env,
    );
    expect(previewWithoutRepo.status).toBe(200);

    const telemetryDownPreviewEnv = withProductUsageInsertFailure(createTestEnv());
    const telemetryDownPreview = await app.request(
      "/v1/app/commands/preview",
      {
        method: "POST",
        headers: apiHeaders(telemetryDownPreviewEnv),
        body: JSON.stringify({ command: "public-summary", repoFullName: "entrius/allways-ui", pullNumber: 12 }),
      },
      telemetryDownPreviewEnv,
    );
    expect(telemetryDownPreview.status).toBe(200);

    expect((await app.request("/v1/app/commands/preview", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/app/commands/preview", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ command: "unknown" }) }, env)).status).toBe(404);

    const digest = await app.request("/v1/app/digest", { headers: cookieHeaders }, env);
    expect(digest.status).toBe(200);
    await expect(digest.json()).resolves.toMatchObject({
      delivery: { mode: "store_only", emailDeliveryEnabled: false },
      items: expect.arrayContaining([expect.objectContaining({ kind: "summary" })]),
      subscriptions: [],
    });

    const staticDigest = await app.request("/v1/app/digest", { headers: apiHeaders(env) }, env);
    expect(staticDigest.status).toBe(200);
    await expect(staticDigest.json()).resolves.toMatchObject({ signal: "ready", subscriptions: [] });

    const staticDigestSubscription = await app.request(
      "/v1/app/digest/subscriptions",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ email: "operator@example.com" }) },
      env,
    );
    expect(staticDigestSubscription.status).toBe(403);

    const invalidDigestSubscription = await app.request(
      "/v1/app/digest/subscriptions",
      { method: "POST", headers: cookieHeaders, body: JSON.stringify({ email: "not-an-email" }) },
      env,
    );
    expect(invalidDigestSubscription.status).toBe(400);

    const storedDigestSubscription = await app.request(
      "/v1/app/digest/subscriptions",
      { method: "POST", headers: cookieHeaders, body: JSON.stringify({ email: "operator@example.com" }) },
      env,
    );
    expect(storedDigestSubscription.status).toBe(201);
    await expect(storedDigestSubscription.json()).resolves.toMatchObject({
      status: "stored",
      subscription: { login: "oktofeesh1", email: "operator@example.com" },
      delivery: { mode: "store_only", emailDeliveryEnabled: false },
    });

    const digestWithSubscription = await app.request("/v1/app/digest", { headers: cookieHeaders }, env);
    expect(digestWithSubscription.status).toBe(200);
    await expect(digestWithSubscription.json()).resolves.toMatchObject({
      subscriptions: expect.arrayContaining([expect.objectContaining({ email: "operator@example.com" })]),
    });

    await recordGitHubRateLimitObservation(env, {
      id: "rate-limit-rest",
      repoFullName: "entrius/allways-ui",
      resource: "rest",
      path: "/repos/entrius/allways-ui/pulls",
      statusCode: 403,
      limitValue: 5000,
      remaining: 0,
      resetAt: "2026-05-31T12:00:00.000Z",
      observedAt: "2026-05-31T11:00:00.000Z",
    });
    await upsertInstallationHealth(env, {
      installationId: 123,
      accountLogin: "entrius",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 1,
      status: "needs_attention",
      missingPermissions: ["checks"],
      missingEvents: ["pull_request_review"],
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "pull_request", "repository"],
      checkedAt: "2026-05-31T11:00:00.000Z",
    });
    await upsertInstallationHealth(env, {
      installationId: 456,
      accountLogin: "jsonbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 0,
      status: "needs_attention",
      missingPermissions: [],
      missingEvents: [],
      permissions: { metadata: "read" },
      events: [],
      checkedAt: "2026-05-31T11:01:00.000Z",
    });
    const warningDigest = await app.request("/v1/app/digest", { headers: cookieHeaders }, env);
    expect(warningDigest.status).toBe(200);
    await expect(warningDigest.json()).resolves.toMatchObject({
      signal: "warn",
      items: expect.arrayContaining([expect.objectContaining({ kind: "install" }), expect.objectContaining({ kind: "queue" })]),
    });
    const overviewWithWarnings = await app.request("/v1/app/overview", { headers: cookieHeaders }, env);
    expect(overviewWithWarnings.status).toBe(200);
    await expect(overviewWithWarnings.json()).resolves.toMatchObject({
      metrics: expect.arrayContaining([expect.objectContaining({ label: "Install issues", delta: "needs attention" })]),
      rateLimits: expect.arrayContaining([expect.objectContaining({ id: "rate-limit-rest" })]),
    });
    await createAgentRun(env, {
      id: "completed-overview-run",
      objective: "Show completed overview run",
      actorLogin: "oktofeesh1",
      surface: "api",
      mode: "copilot",
      status: "completed",
      dataQualityStatus: "complete",
      payload: { kind: "plan_next_work" },
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:05:00.000Z",
    });
    const overviewWithRuns = await app.request("/v1/app/overview", { headers: cookieHeaders }, env);
    expect(overviewWithRuns.status).toBe(200);
    await expect(overviewWithRuns.json()).resolves.toMatchObject({
      metrics: expect.arrayContaining([expect.objectContaining({ label: "Agent runs", total: 1 })]),
      recentRuns: expect.arrayContaining([expect.objectContaining({ run: expect.objectContaining({ id: "completed-overview-run", status: "completed" }) })]),
    });

    const forbiddenRuns = await app.request("/v1/agent/runs?actorLogin=oktofeesh1", { headers: { cookie: `gittensory_session=${otherToken}` } }, env);
    expect(forbiddenRuns.status).toBe(403);
    const invalidLimitRuns = await app.request("/v1/agent/runs?actorLogin=oktofeesh1&limit=not-a-number", { headers: cookieHeaders }, env);
    expect(invalidLimitRuns.status).toBe(200);

    const queuedAgentRun = await app.request(
      "/v1/agent/runs",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ objective: "Plan work without a repo target", actorLogin: "oktofeesh1" }) },
      env,
    );
    expect(queuedAgentRun.status).toBe(202);
    const queuedPullAgentRun = await app.request(
      "/v1/agent/runs",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ objective: "Plan PR work", actorLogin: "oktofeesh1", target: { repoFullName: "entrius/allways-ui", pullNumber: 12 } }) },
      env,
    );
    expect(queuedPullAgentRun.status).toBe(202);
    const queuedIssueAgentRun = await app.request(
      "/v1/agent/runs",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ objective: "Plan issue work", actorLogin: "oktofeesh1", target: { repoFullName: "entrius/allways-ui", issueNumber: 1 } }) },
      env,
    );
    expect(queuedIssueAgentRun.status).toBe(202);
    const overviewWithQueuedRuns = await app.request("/v1/app/overview", { headers: cookieHeaders }, env);
    expect(overviewWithQueuedRuns.status).toBe(200);
    await expect(overviewWithQueuedRuns.json()).resolves.toMatchObject({
      metrics: expect.arrayContaining([expect.objectContaining({ label: "Agent runs", total: 4 })]),
      recentRuns: expect.arrayContaining([expect.objectContaining({ run: expect.objectContaining({ actorLogin: "oktofeesh1" }) })]),
    });

    const localAnalysis = await app.request(
      "/v1/local/branch-analysis",
      {
        method: "POST",
        headers: {
          ...apiHeaders(env),
          "x-gittensory-mcp-package": "@jsonbored/gittensory-mcp",
          "x-gittensory-mcp-version": "0.3.0",
          "x-gittensory-mcp-client": "gittensory-mcp-cli",
        },
        body: JSON.stringify({ login: "oktofeesh1", repoFullName: "entrius/allways-ui", branchName: "usage-spine" }),
      },
      env,
    );
    expect(localAnalysis.status).toBe(200);
    const agentPreflight = await app.request(
      "/v1/agent/preflight-branch",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ login: "oktofeesh1", repoFullName: "entrius/allways-ui" }) },
      env,
    );
    expect(agentPreflight.status).toBe(200);
    const agentPacket = await app.request(
      "/v1/agent/prepare-pr-packet",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ login: "oktofeesh1", repoFullName: "entrius/allways-ui", headRef: "usage-spine" }) },
      env,
    );
    expect(agentPacket.status).toBe(200);
    const agentBlockers = await app.request(
      "/v1/agent/explain-blockers",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ login: "oktofeesh1", repoFullName: "entrius/allways-ui", branchName: "usage-spine" }) },
      env,
    );
    expect(agentBlockers.status).toBe(200);

    const staticExtensionSession = await app.request("/v1/auth/extension/session", { method: "POST", headers: apiHeaders(env) }, env);
    expect(staticExtensionSession.status).toBe(403);

    const extensionSession = await app.request("/v1/auth/extension/session", { method: "POST", headers: cookieHeaders }, env);
    expect(extensionSession.status).toBe(201);
    const extensionSessionBody = (await extensionSession.json()) as { token: string; login: string; scopes: string[] };
    expect(extensionSessionBody).toMatchObject({ login: "oktofeesh1", scopes: ["extension:pull_context"] });

    const remintedExtensionSession = await app.request(
      "/v1/auth/extension/session",
      { method: "POST", headers: { authorization: `Bearer ${extensionSessionBody.token}` } },
      env,
    );
    expect(remintedExtensionSession.status).toBe(403);

    const extensionDecisionPack = await app.request(
      "/v1/contributors/oktofeesh1/decision-pack",
      { headers: { authorization: `Bearer ${extensionSessionBody.token}` } },
      env,
    );
    expect(extensionDecisionPack.status).toBe(403);
    await expect(extensionDecisionPack.json()).resolves.toMatchObject({ error: "insufficient_scope" });

    const extensionOverview = await app.request("/v1/app/overview", { headers: { authorization: `Bearer ${extensionSessionBody.token}` } }, env);
    expect(extensionOverview.status).toBe(403);
    await expect(extensionOverview.json()).resolves.toMatchObject({ error: "insufficient_scope" });

    const staticExtensionContext = await app.request("/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=12", { headers: apiHeaders(env) }, env);
    expect(staticExtensionContext.status).toBe(403);
    await expect(staticExtensionContext.json()).resolves.toMatchObject({ error: "extension_session_required" });
    const fullBrowserSessionExtensionContext = await app.request("/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=12", { headers: cookieHeaders }, env);
    expect(fullBrowserSessionExtensionContext.status).toBe(403);
    await expect(fullBrowserSessionExtensionContext.json()).resolves.toMatchObject({ error: "extension_session_required" });

    const fallbackOriginEnv = createTestEnv({ ADMIN_GITHUB_LOGINS: "oktofeesh1" });
    delete (fallbackOriginEnv as Partial<Env>).PUBLIC_API_ORIGIN;
    const { token: noIdToken } = await createSessionForGitHubUser(fallbackOriginEnv, { login: "oktofeesh1" });
    const fallbackOriginExtensionSession = await app.request(
      "/v1/auth/extension/session",
      { method: "POST", headers: { cookie: `gittensory_session=${noIdToken}` } },
      fallbackOriginEnv,
    );
    expect(fallbackOriginExtensionSession.status).toBe(201);
    await expect(fallbackOriginExtensionSession.json()).resolves.toMatchObject({ apiOrigin: "http://localhost" });

    const invalidExtensionContext = await app.request("/v1/extension/pull-context?owner=entrius&repo=allways-ui", { headers: { authorization: `Bearer ${extensionSessionBody.token}` } }, env);
    expect(invalidExtensionContext.status).toBe(400);
    const invalidZeroExtensionContext = await app.request("/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=0", { headers: { authorization: `Bearer ${extensionSessionBody.token}` } }, env);
    expect(invalidZeroExtensionContext.status).toBe(400);
    const invalidMissingOwnerExtensionContext = await app.request("/v1/extension/pull-context?repo=allways-ui&pullNumber=12", { headers: { authorization: `Bearer ${extensionSessionBody.token}` } }, env);
    expect(invalidMissingOwnerExtensionContext.status).toBe(400);

    const extensionContext = await app.request(
      "/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=12",
      { headers: { authorization: `Bearer ${extensionSessionBody.token}` } },
      env,
    );
    expect(extensionContext.status).toBe(200);
    await expect(extensionContext.json()).resolves.toMatchObject({
      repoFullName: "entrius/allways-ui",
      pullNumber: 12,
      reviewability: { repoFullName: "entrius/allways-ui", pullNumber: 12 },
      panels: expect.arrayContaining([expect.objectContaining({ label: "Reviewability" }), expect.objectContaining({ label: "Boundary" })]),
    });

    const missingPullContext = await app.request(
      "/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=99",
      { headers: { authorization: `Bearer ${extensionSessionBody.token}` } },
      env,
    );
    expect(missingPullContext.status).toBe(200);
    await expect(missingPullContext.json()).resolves.toMatchObject({
      repoFullName: "entrius/allways-ui",
      pullNumber: 99,
      panels: expect.arrayContaining([expect.objectContaining({ label: "Contributor", badge: "unknown" })]),
    });

    const expiringExtensionSession = await app.request("/v1/auth/extension/session", { method: "POST", headers: cookieHeaders }, env);
    expect(expiringExtensionSession.status).toBe(201);
    const expiringExtensionSessionBody = (await expiringExtensionSession.json()) as { token: string };
    await env.DB.prepare("update auth_sessions set expires_at = ? where token_hash = ?").bind("2020-01-01T00:00:00.000Z", await hashToken(expiringExtensionSessionBody.token)).run();
    const expiredExtensionContext = await app.request(
      "/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=12",
      { headers: { authorization: `Bearer ${expiringExtensionSessionBody.token}` } },
      env,
    );
    expect(expiredExtensionContext.status).toBe(401);
    await expect(expiredExtensionContext.json()).resolves.toMatchObject({ error: "unauthorized" });

    const extensionLogout = await app.request("/v1/auth/logout", { method: "POST", headers: { authorization: `Bearer ${extensionSessionBody.token}` } }, env);
    expect(extensionLogout.status).toBe(200);
    await expect(extensionLogout.json()).resolves.toMatchObject({ ok: true, revoked: true });
    const revokedExtensionContext = await app.request(
      "/v1/extension/pull-context?owner=entrius&repo=allways-ui&pullNumber=12",
      { headers: { authorization: `Bearer ${extensionSessionBody.token}` } },
      env,
    );
    expect(revokedExtensionContext.status).toBe(401);
    await expect(revokedExtensionContext.json()).resolves.toMatchObject({ error: "unauthorized" });

    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_tool_called",
      actor: "mcp-user",
      sessionId: "mcp-session",
      outcome: "success",
      clientName: "gittensory-mcp",
      clientVersion: "0.2.1",
      metadata: {
        toolName: "gittensory_local_status",
        protocolVersion: "2025-03-26",
        compatibilityStatus: "stale",
        token: "github_pat_secret",
        localPath: "/Users/example/private-repo",
      },
      occurredAt: "2026-05-28T00:00:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "old-mcp-user",
      sessionId: "old-mcp-session",
      outcome: "success",
      clientName: "gittensory-mcp",
      clientVersion: "0.1.0",
      metadata: {
        protocolVersion: "2024-11-05",
        compatibilityStatus: "incompatible",
      },
      occurredAt: "2026-05-28T00:00:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "current-mcp-user",
      sessionId: "current-mcp-session",
      outcome: "success",
      clientName: "gittensory-mcp",
      clientVersion: "0.3.0",
      metadata: {
        protocolVersion: "2025-03-26",
      },
      occurredAt: "2026-05-28T00:00:00.000Z",
    });

    const productUsageEvents = await listProductUsageEvents(env, { limit: 20 });
    expect(productUsageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "control_panel", eventName: "command_previewed", outcome: "success" }),
        expect.objectContaining({ surface: "control_panel", eventName: "digest_subscription_stored", outcome: "success" }),
        expect.objectContaining({ surface: "browser_extension", eventName: "extension_session_created", outcome: "success" }),
        expect.objectContaining({ surface: "browser_extension", eventName: "pull_context_viewed", outcome: "success" }),
        expect.objectContaining({ surface: "mcp", eventName: "mcp_tool_called", clientVersion: "0.2.1", metadata: expect.objectContaining({ compatibilityStatus: "stale" }) }),
      ]),
    );
    expect(JSON.stringify(productUsageEvents)).not.toMatch(/oktofeesh1|operator@example.com|gittensory_session|\/Users|github_pat|ghp_|source code|raw trust|wallet|hotkey|private-repo/i);

    const usageRollupRun = await app.request(
      "/v1/internal/jobs/rollup-product-usage/run",
      { method: "POST", headers: internalHeaders, body: JSON.stringify({ day: "2026-05-28" }) },
      env,
    );
    expect(usageRollupRun.status).toBe(200);
    await expect(usageRollupRun.json()).resolves.toMatchObject({
      rollups: [expect.objectContaining({ day: "2026-05-28", status: "partial", totalEvents: productUsageEvents.length })],
    });

    const dailyRollups = await app.request("/v1/app/analytics/daily-rollups?limit=3", { headers: apiHeaders(env) }, env);
    expect(dailyRollups.status).toBe(200);
    await expect(dailyRollups.json()).resolves.toMatchObject({
      status: expect.objectContaining({ status: "partial", latestRollupDay: "2026-05-28" }),
      rollups: [expect.objectContaining({ day: "2026-05-28", activation: expect.any(Object) })],
    });
    const fallbackLimitRollups = await app.request("/v1/app/analytics/daily-rollups?limit=invalid", { headers: apiHeaders(env) }, env);
    expect(fallbackLimitRollups.status).toBe(200);
    await expect(fallbackLimitRollups.json()).resolves.toMatchObject({
      status: expect.objectContaining({ latestRollupDay: "2026-05-28" }),
      rollups: [expect.objectContaining({ day: "2026-05-28" })],
    });
    const defaultLimitRollups = await app.request("/v1/app/analytics/daily-rollups", { headers: apiHeaders(env) }, env);
    expect(defaultLimitRollups.status).toBe(200);
    await expect(defaultLimitRollups.json()).resolves.toMatchObject({
      status: expect.objectContaining({ latestRollupDay: "2026-05-28" }),
      rollups: [expect.objectContaining({ day: "2026-05-28" })],
    });

    const usageOperator = await app.request("/v1/app/operator-dashboard", { headers: apiHeaders(env) }, env);
    expect(usageOperator.status).toBe(200);
    const usageOperatorBody = (await usageOperator.json()) as {
      metrics: Array<{ label: string; value: string }>;
      usageSummary: { totalEvents: number };
      usageRollups: Array<{ day: string }>;
      usageRollupStatus: { status: string };
      mcpCompatibilityAdoption: {
        totalEvents: number;
        activeActors: number;
        staleEvents: number;
        incompatibleEvents: number;
        byClientVersion: Array<{ key: string; count: number }>;
        byProtocolVersion: Array<{ key: string; count: number }>;
        byCompatibilityStatus: Array<{ status: string; count: number }>;
      };
      weeklyValueReport: {
        variant: string;
        summary: string[];
        metrics: Array<{ id: string; value: number; visibility: string }>;
        operatorDetails?: { daily: Array<{ day: string }>; topRouteClasses: Array<{ key: string; count: number }> };
        warnings: string[];
      };
    };
    expect(usageOperatorBody.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Product events", value: String(productUsageEvents.length) }),
        expect.objectContaining({ label: "Active users" }),
        expect.objectContaining({ label: "Activation rollups", value: "partial" }),
        expect.objectContaining({ label: "MCP stale clients", value: "2" }),
      ]),
    );
    expect(usageOperatorBody.usageSummary.totalEvents).toBe(productUsageEvents.length);
    expect(usageOperatorBody.usageRollups).toEqual([expect.objectContaining({ day: "2026-05-28" })]);
    expect(usageOperatorBody.usageRollupStatus.status).toBe("partial");
    expect(usageOperatorBody.mcpCompatibilityAdoption).toMatchObject({
      totalEvents: 4,
      activeActors: 4,
      staleEvents: 1,
      incompatibleEvents: 1,
      byClientVersion: expect.arrayContaining([
        { key: "0.1.0", count: 1 },
        { key: "0.2.1", count: 1 },
        { key: "0.3.0", count: 2 },
      ]),
      byProtocolVersion: expect.arrayContaining([
        { key: "2024-11-05", count: 1 },
        { key: "2025-03-26", count: 2 },
      ]),
      byCompatibilityStatus: expect.arrayContaining([
        { status: "current", count: 2 },
        { status: "incompatible", count: 1 },
        { status: "stale", count: 1 },
      ]),
    });

    const mcpCompatibility = await app.request("/v1/app/analytics/mcp-compatibility?days=7", { headers: apiHeaders(env) }, env);
    expect(mcpCompatibility.status).toBe(200);
    const mcpCompatibilityBody = await mcpCompatibility.json();
    expect(mcpCompatibilityBody).toMatchObject({
      adoption: expect.objectContaining({
        minimumSupportedVersion: "0.2.0",
        latestRecommendedVersion: "0.3.0",
        staleEvents: 1,
        incompatibleEvents: 1,
        totalEvents: 4,
      }),
    });
    expect(JSON.stringify(mcpCompatibilityBody)).not.toMatch(/github_pat|\/Users|private-repo|mcp-user|old-mcp-user|current-mcp-user/i);
    await expect((await app.request("/v1/app/analytics/mcp-compatibility", { headers: apiHeaders(env) }, env)).json()).resolves.toMatchObject({ days: 7 });
    await expect((await app.request("/v1/app/analytics/mcp-compatibility?days=invalid", { headers: apiHeaders(env) }, env)).json()).resolves.toMatchObject({ days: 7 });
    await expect((await app.request("/v1/app/analytics/mcp-compatibility?days=999", { headers: apiHeaders(env) }, env)).json()).resolves.toMatchObject({ days: 90 });
    await expect((await app.request("/v1/app/analytics/mcp-compatibility?days=-5", { headers: apiHeaders(env) }, env)).json()).resolves.toMatchObject({ days: 1 });

    expect(usageOperatorBody.weeklyValueReport).toMatchObject({
      variant: "operator",
      summary: expect.arrayContaining([expect.stringContaining("active user"), expect.stringContaining("PR packet")]),
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: "active_users", visibility: "public" }),
        expect.objectContaining({ id: "product_events", value: productUsageEvents.length, visibility: "operator" }),
      ]),
      operatorDetails: expect.objectContaining({
        daily: [expect.objectContaining({ day: "2026-05-28" })],
        topRouteClasses: expect.any(Array),
      }),
    });

    const publicWeeklyReport = await app.request("/v1/app/analytics/weekly-value-report?variant=public&days=999", { headers: apiHeaders(env) }, env);
    expect(publicWeeklyReport.status).toBe(200);
    const publicWeeklyReportBody = await publicWeeklyReport.json();
    expect(publicWeeklyReportBody).toMatchObject({
      variant: "public",
      publicSafe: true,
      period: expect.objectContaining({ days: 31 }),
      metrics: expect.arrayContaining([expect.objectContaining({ id: "active_users", visibility: "public" })]),
    });
    expect(publicWeeklyReportBody).not.toHaveProperty("operatorDetails");
    expect(JSON.stringify(publicWeeklyReportBody)).not.toMatch(/wallet|hotkey|raw trust|payout|reward estimate|farming|private reviewability|public score estimate|\/Users|github_pat|ghp_/i);

    const defaultWeeklyReport = await app.request("/v1/app/analytics/weekly-value-report", { headers: apiHeaders(env) }, env);
    expect(defaultWeeklyReport.status).toBe(200);
    await expect(defaultWeeklyReport.json()).resolves.toMatchObject({ variant: "public", publicSafe: true });

    const operatorWeeklyReport = await app.request("/v1/app/analytics/weekly-value-report?variant=operator&days=invalid", { headers: apiHeaders(env) }, env);
    expect(operatorWeeklyReport.status).toBe(200);
    await expect(operatorWeeklyReport.json()).resolves.toMatchObject({
      variant: "operator",
      period: expect.objectContaining({ days: 7 }),
      operatorDetails: expect.any(Object),
    });
  });

  it("covers live app auth, validation, and internal job queue edge routes", async () => {
    const app = createApp();
    const sent: Array<{ message: unknown; options?: unknown }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown, options?: unknown) {
          sent.push({ message, options });
        },
      } as unknown as Queue,
    });
    const internalHeaders = { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" };

    const oauthNotConfigured = await app.request("/v1/auth/github/start", {}, env);
    expect(oauthNotConfigured.status).toBe(503);
    await expect(oauthNotConfigured.json()).resolves.toMatchObject({ error: "github_oauth_not_configured" });

    const oauthDenied = await app.request("/v1/auth/github/callback?error=access_denied", {}, env);
    expect(oauthDenied.status).toBe(302);
    expect(oauthDenied.headers.get("location")).toContain("reason=access_denied");
    expect(oauthDenied.headers.get("set-cookie")).toContain("gittensory_oauth_state=");
    const oauthMissingCode = await app.request("/v1/auth/github/callback?state=state-only", {}, env);
    expect(oauthMissingCode.status).toBe(302);
    expect(oauthMissingCode.headers.get("location")).toContain("github_oauth_callback_invalid");

    const invalidDevicePoll = await app.request("/v1/auth/github/device/poll", { method: "POST", body: "{" }, env);
    expect(invalidDevicePoll.status).toBe(400);
    const invalidGitHubSession = await app.request("/v1/auth/github/session", { method: "POST", body: "{" }, env);
    expect(invalidGitHubSession.status).toBe(400);

    const { token: noIdToken } = await createSessionForGitHubUser(env, { login: "jsonbored" });
    const noIdSession = await app.request("/v1/auth/session", { headers: { cookie: `gittensory_session=${noIdToken}` } }, env);
    expect(noIdSession.status).toBe(200);
    await expect(noIdSession.json()).resolves.toMatchObject({
      status: "authenticated",
      login: "jsonbored",
      githubId: null,
      github_id: null,
      roles: ["operator"],
      roleSummary: { onboarding: { status: "ready", primaryRole: "operator" } },
    });

    for (const [path, error] of [
      ["/v1/scoring/preview", "invalid_scoring_preview_request"],
      ["/v1/agent/runs", "invalid_agent_run_request"],
      ["/v1/agent/plan-next-work", "invalid_agent_plan_request"],
      ["/v1/agent/preflight-branch", "invalid_agent_preflight_branch_request"],
      ["/v1/agent/prepare-pr-packet", "invalid_agent_prepare_pr_packet_request"],
      ["/v1/agent/explain-blockers", "invalid_agent_explain_blockers_request"],
    ] as const) {
      const response = await app.request(path, { method: "POST", headers: apiHeaders(env), body: "{" }, env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error });
    }

    const invalidCommandPreview = await app.request("/v1/app/commands/preview", { method: "POST", headers: apiHeaders(env), body: "{" }, env);
    expect(invalidCommandPreview.status).toBe(400);

    const invalidDigestJson = await app.request("/v1/app/digest/subscriptions", { method: "POST", headers: { cookie: `gittensory_session=${noIdToken}` }, body: "{" }, env);
    expect(invalidDigestJson.status).toBe(400);

    const queuedBackfillAll = await app.request("/v1/internal/jobs/backfill-registered-repos", { method: "POST", headers: internalHeaders, body: "{" }, env);
    expect(queuedBackfillAll.status).toBe(202);
    await expect(queuedBackfillAll.json()).resolves.toMatchObject({ ok: true, status: "queued", force: false, mode: "light" });

    const queuedBackfillResume = await app.request(
      "/v1/internal/jobs/backfill-registered-repos",
      { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo", force: true, mode: "resume" }) },
      env,
    );
    expect(queuedBackfillResume.status).toBe(202);
    await expect(queuedBackfillResume.json()).resolves.toMatchObject({ repoFullName: "owner/repo", force: true, mode: "resume" });

    expect((await app.request("/v1/internal/jobs/backfill-repo-segment", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/backfill-repo-segment", { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo", segment: "metadata" }) }, env)).status).toBe(400);
    const queuedSegment = await app.request(
      "/v1/internal/jobs/backfill-repo-segment",
      { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo", segment: "labels", mode: "resume", force: true, cursor: "page-2" }) },
      env,
    );
    expect(queuedSegment.status).toBe(202);
    await expect(queuedSegment.json()).resolves.toMatchObject({ repoFullName: "owner/repo", segment: "labels", mode: "resume" });
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "owner/repo", segment: "labels", cursor: "page-2", force: true }),
        }),
      ]),
    );

    expect((await app.request("/v1/internal/jobs/backfill-repo-segment/run", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/backfill-repo-segment/run", { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo", segment: "metadata" }) }, env)).status).toBe(400);

    expect((await app.request("/v1/internal/jobs/backfill-pr-details", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);
    const queuedPrDetails = await app.request(
      "/v1/internal/jobs/backfill-pr-details",
      { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo", mode: "resume", cursor: "5" }) },
      env,
    );
    expect(queuedPrDetails.status).toBe(202);
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ type: "backfill-pr-details", cursor: 5 }) })]));
    expect((await app.request("/v1/internal/jobs/backfill-pr-details/run", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);

    expect((await app.request("/v1/internal/jobs/build-contributor-decision-packs/run", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/refresh-contributor-activity", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);
    const queuedContributorRefresh = await app.request(
      "/v1/internal/jobs/refresh-contributor-activity",
      { method: "POST", headers: internalHeaders, body: JSON.stringify({ login: "jsonbored", repoFullName: "owner/repo" }) },
      env,
    );
    expect(queuedContributorRefresh.status).toBe(202);
    await expect(queuedContributorRefresh.json()).resolves.toMatchObject({ login: "jsonbored", repoFullName: "owner/repo" });
    expect((await app.request("/v1/internal/jobs/refresh-contributor-activity/run", { method: "POST", headers: internalHeaders, body: "{}" }, env)).status).toBe(400);

    const queuedBurden = await app.request("/v1/internal/jobs/build-burden-forecasts", { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo" }) }, env);
    expect(queuedBurden.status).toBe(202);
    const queuedSignals = await app.request("/v1/internal/jobs/generate-signal-snapshots", { method: "POST", headers: internalHeaders, body: JSON.stringify({ repoFullName: "owner/repo" }) }, env);
    expect(queuedSignals.status).toBe(202);
    expect((await app.request("/v1/internal/repos/owner/repo/settings", { method: "POST", headers: internalHeaders, body: JSON.stringify({ commentMode: "bad" }) }, env)).status).toBe(400);
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

  it("returns 404 for unknown repos and serves cached snapshot with freshness for known repos", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedSignalData(env);

    const unauthenticated = await app.request("/v1/repos/entrius/allways-ui/outcome-patterns", {}, env);
    expect(unauthenticated.status).toBe(401);

    const unknown = await app.request("/v1/repos/ghost/missing/outcome-patterns", { headers: apiHeaders(env) }, env);
    expect(unknown.status).toBe(404);

    // Known but uncached: falls back to compute (no snapshot exists yet).
    const computed = await app.request("/v1/repos/entrius/allways-ui/outcome-patterns", { headers: apiHeaders(env) }, env);
    expect(computed.status).toBe(200);
    const computedBody = (await computed.json()) as {
      source: string;
      freshness: string;
      patterns: { repoFullName: string; evidenceCompleteness: { status: string; pullRequestsAnalyzed: number } };
      dataQuality: unknown;
    };
    expect(computedBody.source).toBe("computed");
    expect(computedBody.freshness).toBe("fresh");
    expect(computedBody.patterns.repoFullName).toBe("entrius/allways-ui");
    expect(computedBody.patterns.evidenceCompleteness.status).toBeDefined();
    expect(computedBody.dataQuality).toBeDefined();

    // Persist a snapshot directly and re-fetch — the endpoint must serve from the snapshot.
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "repo-outcome-patterns",
      targetKey: "entrius/allways-ui",
      repoFullName: "entrius/allways-ui",
      payload: {
        repoFullName: "entrius/allways-ui",
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
        lane: "direct_pr",
        primaryLanguage: "TypeScript",
        sampleSize: 0,
        totals: { analyzed: 0, merged: 0, closedUnmerged: 0, openActive: 0, openStale: 0, maintainerLanePullRequests: 0, outsideContributorPullRequests: 0 },
        outsideContributorMergeRate: 0,
        maintainerLaneMergeRate: 0,
        dimensions: [],
        successPatterns: [],
        riskPatterns: [],
        evidenceCompleteness: { pullRequestsAnalyzed: 0, withFileDetail: 0, withReviewDetail: 0, withCheckDetail: 0, filesCompletenessRatio: 0, reviewsCompletenessRatio: 0, checksCompletenessRatio: 0, fullyDecidedWithDetail: 0, status: "missing" },
        findings: [],
        summary: "fixture",
      } as unknown as Record<string, never>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const cached = await app.request("/v1/repos/entrius/allways-ui/outcome-patterns", { headers: apiHeaders(env) }, env);
    expect(cached.status).toBe(200);
    const cachedBody = (await cached.json()) as { source: string; freshness: string; patterns: { summary: string } };
    expect(cachedBody.source).toBe("snapshot");
    expect(cachedBody.freshness).toBe("fresh");
    expect(cachedBody.patterns.summary).toBe("fixture");
    expect(JSON.stringify(cachedBody)).not.toMatch(/wallet|hotkey|payout|reward estimate|farming/i);
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
      completedAt: new Date().toISOString(),
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
    const { token: noRoleMcpToken } = await createSessionForGitHubUser(env, { login: "new-user", id: 222 });
    const noRoleMcp = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${noRoleMcpToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "no-role", method: "tools/list" }),
      },
      env,
    );
    expect(noRoleMcp.status).toBe(401);

    const { token: operatorMcpToken } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 12345 });
    const forbiddenContributorMcp = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { ...mcpHeaders(env), authorization: `Bearer ${operatorMcpToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: "wrong-login", method: "tools/call", params: { name: "gittensory_get_decision_pack", arguments: { login: "other-user" } } }),
      },
      env,
    );
    expect(forbiddenContributorMcp.status).toBe(200);
    await expect(mcpJson(forbiddenContributorMcp)).resolves.toMatchObject({
      result: {
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining("authenticated GitHub login") })],
      },
    });

    const malformedMcp = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: "not-json",
      },
      env,
    );
    expect(malformedMcp.status).toBeGreaterThanOrEqual(400);

    const missingMethodMcp = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "missing-method", params: { name: "gittensory_get_repo_context" } }),
      },
      env,
    );
    expect(missingMethodMcp.status).toBeGreaterThanOrEqual(400);

    const telemetryDownEnv = withProductUsageInsertFailure(createTestEnv());
    const telemetryDownInitialize = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(telemetryDownEnv),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "telemetry-down",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "gittensory-tests", version: "0.1.0" },
          },
        }),
      },
      telemetryDownEnv,
    );
    expect(telemetryDownInitialize.status).toBe(200);

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
    expect(toolNames).toContain("gittensory_get_issue_quality");
    expect(toolNames).toContain("gittensory_get_burden_forecast");
    expect(toolNames).toContain("gittensory_get_contributor_profile");
    expect(toolNames).toContain("gittensory_get_decision_pack");
    expect(toolNames).toContain("gittensory_explain_repo_decision");
    expect(toolNames).toContain("gittensory_preflight_pr");
    expect(toolNames).toContain("gittensory_preflight_local_diff");
    expect(toolNames).toContain("gittensory_preview_local_pr_score");
    expect(toolNames).toContain("gittensory_get_registry_changes");
    expect(toolNames).toContain("gittensory_get_upstream_drift");
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

    const missingIssueQuality = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "missing-issue-quality", method: "tools/call", params: { name: "gittensory_get_issue_quality", arguments: { owner: "ghost", repo: "missing" } } }),
      },
      env,
    );
    expect(missingIssueQuality.status).toBe(200);
    await expect(mcpJson(missingIssueQuality)).resolves.toMatchObject({ result: { structuredContent: { status: "not_found", repoFullName: "ghost/missing" } } });

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

    const historicalBountyPreflight = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bounty-preflight",
          method: "tools/call",
          params: {
            name: "gittensory_preflight_pr",
            arguments: {
              repoFullName: "entrius/allways-ui",
              title: "Fix dashboard cache refresh after reconnect",
              body: "Fixes #7",
              changedFiles: ["src/cache.ts", "test/cache.test.ts"],
            },
          },
        }),
      },
      env,
    );
    expect(historicalBountyPreflight.status).toBe(200);
    const historicalBountyPreflightPayload = (await mcpJson(historicalBountyPreflight)) as { result: { structuredContent: { findings: Array<{ code: string }> } } };
    expect(historicalBountyPreflightPayload.result.structuredContent.findings.map((finding) => finding.code)).toContain("linked_issue_bounty_historical");

    await persistSignalSnapshot(env, {
      id: "mcp-issue-quality",
      signalType: "issue-quality",
      targetKey: "entrius/allways-ui",
      repoFullName: "entrius/allways-ui",
      payload: {
        repoFullName: "entrius/allways-ui",
        generatedAt: "2026-05-25T00:00:00.000Z",
        lane: { lane: "direct_pr" },
        issues: [{ number: 7, title: "fixture", status: "ready", score: 80, reasons: [], warnings: [] }],
        summary: "fixture",
      } as unknown as Record<string, never>,
      generatedAt: "2026-05-25T00:00:00.000Z",
    });

    const missingBurdenForecast = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "missing-burden", method: "tools/call", params: { name: "gittensory_get_burden_forecast", arguments: { owner: "ghost", repo: "nothing" } } }),
      },
      env,
    );
    expect(missingBurdenForecast.status).toBe(200);
    await expect(mcpJson(missingBurdenForecast)).resolves.toMatchObject({ result: { structuredContent: { status: "not_found", repoFullName: "ghost/nothing" } } });

    await upsertBurdenForecast(env, {
      repoFullName: "entrius/allways-ui",
      payload: { repoFullName: "entrius/allways-ui", level: "low", summary: "mcp fixture", forecast: { projectedReviewLoad: 0, queueGrowthRisk: 0, stalePullRequests: 0, duplicateTrend: 0, reviewablePullRequests: 0 }, findings: [] } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
    });

    const cachedBurdenForecast = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "cached-burden", method: "tools/call", params: { name: "gittensory_get_burden_forecast", arguments: { owner: "entrius", repo: "allways-ui" } } }),
      },
      env,
    );
    expect(cachedBurdenForecast.status).toBe(200);
    await expect(mcpJson(cachedBurdenForecast)).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "ready",
          source: "snapshot",
          repoFullName: "entrius/allways-ui",
          freshness: "fresh",
          report: { level: "low" },
        },
      },
    });

    await upsertRepositoryFromGitHub(env, { name: "mcp-computed-burden", full_name: "entrius/mcp-computed-burden", private: false, owner: { login: "entrius" }, default_branch: "main" });
    const computedBurdenForecast = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "computed-burden", method: "tools/call", params: { name: "gittensory_get_burden_forecast", arguments: { owner: "entrius", repo: "mcp-computed-burden" } } }),
      },
      env,
    );
    expect(computedBurdenForecast.status).toBe(200);
    await expect(mcpJson(computedBurdenForecast)).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "ready",
          source: "computed",
          repoFullName: "entrius/mcp-computed-burden",
          freshness: "fresh",
          report: { repoFullName: "entrius/mcp-computed-burden", level: "low" },
        },
      },
    });

    for (const [name, args] of [
      ["gittensory_get_repo_context", { owner: "entrius", repo: "allways-ui" }],
      ["gittensory_get_issue_quality", { owner: "entrius", repo: "allways-ui" }],
      ["gittensory_get_burden_forecast", { owner: "entrius", repo: "allways-ui" }],
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
      ["gittensory_get_upstream_drift", {}],
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

    const missingAgentRun = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: mcpHeaders(env),
        body: JSON.stringify({ jsonrpc: "2.0", id: "missing-agent-run", method: "tools/call", params: { name: "gittensory_agent_get_run", arguments: { runId: "missing" } } }),
      },
      env,
    );
    expect(missingAgentRun.status).toBe(200);
    expect(JSON.stringify(await mcpJson(missingAgentRun))).toMatch(/Agent run not found|error|isError/i);

    const sessionEnv = createTestEnv({ ADMIN_GITHUB_LOGINS: "oktofeesh1" });
    const { token: mcpSessionToken } = await createSessionForGitHubUser(sessionEnv, { login: "oktofeesh1", id: 12345 });
    const forbiddenSessionTool = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { ...mcpHeaders(sessionEnv), authorization: `Bearer ${mcpSessionToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: "forbidden-session-tool", method: "tools/call", params: { name: "gittensory_get_decision_pack", arguments: { login: "other-user" } } }),
      },
      sessionEnv,
    );
    expect(forbiddenSessionTool.status).toBe(200);
    expect(JSON.stringify(await mcpJson(forbiddenSessionTool))).toMatch(/Forbidden|session can only access/i);

    const mcpUsageEvents = await listProductUsageEvents(env, { limit: 100 });
    expect(mcpUsageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "mcp", eventName: "mcp_request", outcome: "success", clientName: "gittensory-mcp-cli", clientVersion: "0.3.0" }),
        expect.objectContaining({
          surface: "mcp",
          eventName: "mcp_tool_called",
          outcome: "success",
          clientName: "gittensory-mcp-cli",
          clientVersion: "0.3.0",
          metadata: expect.objectContaining({
            toolName: "gittensory_get_bounty_advisory",
            protocolVersion: "2025-03-26",
            compatibilityStatus: "current",
            minimumSupportedVersion: "0.2.0",
            latestRecommendedVersion: "0.3.0",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(mcpUsageEvents)).not.toMatch(/oktofeesh1|\/Users|github_pat|ghp_|source code|wallet|hotkey|raw trust/i);
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

    await upsertUpstreamDriftReport(env, {
      id: "report-registration-maintainer-cut-drift",
      fingerprint: "registration-maintainer-cut-drift",
      severity: "high",
      status: "open",
      summary: "1 registry hyperparameter drift event(s)",
      affectedAreas: ["registry"],
      previousRulesetId: "previous-ruleset",
      currentRulesetId: "current-ruleset",
      payload: {
        registryHyperparameterDrift: {
          totalEvents: 1,
          omittedEvents: 0,
          highImpactCount: 1,
          affectedRepoCount: 1,
          affectedFields: ["maintainerCut"],
          affectedSurfaces: ["maintainer_economics"],
          events: [
            {
              repoFullName: "entrius/allways-ui",
              field: "maintainerCut",
              previous: 0.03,
              current: 0.1,
              severity: "high",
              affectedSurfaces: ["maintainer_economics"],
              summary: "maintainerCut 0.03 -> 0.1",
            },
          ],
        },
      },
      generatedAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
    });
    const driftReadiness = await app.request("/v1/repos/entrius/allways-ui/registration-readiness", { headers: apiHeaders(env) }, env);
    expect(driftReadiness.status).toBe(200);
    await expect(driftReadiness.json()).resolves.toMatchObject({
      warnings: expect.arrayContaining([
        "Upstream registry drift is open for entrius/allways-ui: maintainer cut changed; affected surface(s): maintainer_economics.",
      ]),
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
    expect(unauthenticatedSession.status).toBe(200);
    await expect(unauthenticatedSession.json()).resolves.toMatchObject({ status: "signed_out" });
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
      recommended: { participationMode: "split", issueDiscoveryShare: 0.1, maintainerCut: 0.3 },
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
    "mcp-protocol-version": "2025-03-26",
    "x-gittensory-mcp-package": "@jsonbored/gittensory-mcp",
    "x-gittensory-mcp-version": "0.3.0",
    "x-gittensory-mcp-client": "gittensory-mcp-cli",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

function internalHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`,
    "content-type": "application/json",
  };
}

function withProductUsageInsertFailure(env: Env): Env {
  const db = env.DB as unknown as { prepare(sql: string): unknown; batch(statements: unknown[]): Promise<unknown> };
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.includes("product_usage_events")) throw new Error("product usage insert failed");
        return db.prepare.call(db, sql);
      },
      batch(statements: unknown[]) {
        return db.batch.call(db, statements);
      },
    } as unknown as D1Database,
  };
}

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`,
    "content-type": "application/json",
  };
}

function upstreamContractFetch() {
  const files: Record<string, string> = {
    "gittensor/constants.py": "SRC_TOK_SATURATION_SCALE = 58\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n",
    "gittensor/validator/weights/master_repositories.json": JSON.stringify({
      "JSONbored/gittensory": {
        emission_share: 0.01,
        issue_discovery_share: 0,
        maintainer_cut: 0.3,
        label_multipliers: { feature: 1.5 },
        trusted_label_pipeline: true,
      },
    }),
    "gittensor/validator/weights/programming_languages.json": JSON.stringify({ TypeScript: 1 }),
    "gittensor/validator/oss_contributions/mirror/scoring.py": "score = 1 - exp(-x)\nsolved_by_pr = True\n",
    "gittensor/validator/issue_discovery/scan.py": "branch eligibility required\n",
    "gittensor/utils/mirror/models.py": "solved_by_pr: int\n",
  };
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) return Response.json({ sha: "api-commit" });
    const path = Object.keys(files).find((candidate) => url.includes(`/contents/${candidate}`));
    if (!path) return new Response("not found", { status: 404 });
    return Response.json({
      content: Buffer.from(files[path]!, "utf8").toString("base64"),
      encoding: "base64",
      sha: `api-${path}`,
      download_url: `https://raw.githubusercontent.com/entrius/gittensor/test/${path}`,
    });
  };
}

function withBurdenForecastReadFailure(env: Env): Env {
  const db = env.DB as unknown as { prepare: (sql: string) => unknown; batch: (statements: unknown[]) => Promise<unknown[]> };
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (/burden_forecasts/i.test(sql)) throw new Error("forecast table unavailable");
        return db.prepare(sql);
      },
      batch(statements: unknown[]) {
        return db.batch(statements);
      },
    } as unknown as D1Database,
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
  const freshAt = new Date().toISOString();
  const previousFreshAt = new Date(Date.now() - 60_000).toISOString();

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
    checkedAt: freshAt,
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
    freshAt,
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
      previousFreshAt,
    ),
  );
  await persistRegistrySnapshot(env, snapshot);
  await persistUpstreamRulesetSnapshot(env, {
    id: "upstream-ruleset-seed",
    sourceRepo: "entrius/gittensor",
    sourceRef: "test",
    commitSha: "seed-commit",
    sourceSnapshotIds: [],
    activeModel: "pending_saturation_model",
    registryRepoCount: 1,
    totalEmissionShare: 0.01107,
    semanticHash: "seed-semantic-hash",
    payload: {
      registry: {
        repoCount: 1,
        totalEmissionShare: 0.01107,
        repositories: [
          {
            repo: "entrius/allways-ui",
            emissionShare: 0.01107,
            issueDiscoveryShare: 0,
            maintainerCut: 0,
            labelMultipliers: { bug: 1.1, enhancement: 1, feature: 1.25, refactor: 0.5 },
            trustedLabelPipeline: true,
            defaultLabelMultiplier: null,
            eligibilityMode: null,
          },
        ],
      },
      scoring: { activeModel: "pending_saturation_model", constants: { SRC_TOK_SATURATION_SCALE: 58 }, semanticFlags: { usesExponentialSaturation: true } },
      issueDiscovery: { branchEligibilityRequired: false },
      mirrorLinkage: { solvedByPrRequired: true },
      languageWeights: { count: 1, weights: { TypeScript: 1 }, contentHash: "seed-languages" },
      sourceSnapshots: [],
    },
    warnings: [],
    generatedAt: freshAt,
  });
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
    fetchedAt: freshAt,
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
    fetchedAt: freshAt,
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
        completedAt: freshAt,
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
    checkedAt: freshAt,
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
    filesSyncedAt: freshAt,
    reviewsSyncedAt: freshAt,
    checksSyncedAt: freshAt,
    lastSyncedAt: freshAt,
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
    filesSyncedAt: freshAt,
    reviewsSyncedAt: freshAt,
    checksSyncedAt: freshAt,
    lastSyncedAt: freshAt,
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
