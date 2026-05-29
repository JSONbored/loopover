import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listCollisionEdges,
  createAgentRun,
  getContributorEvidence,
  getAgentRun,
  getContributorScoringProfile,
  listInstallationHealth,
  listPullRequests,
  listRepoSyncStates,
  listSignalSnapshots,
  persistSignalSnapshot,
  upsertRepoSyncSegment,
  upsertInstallation,
  upsertPullRequestFromGitHub,
  upsertRepositorySettings,
  upsertRepositoryFromGitHub,
} from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("queue processors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("processes registry, backfill, installation health, and signal snapshot jobs", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("api.gittensor.io") || url.includes("mirror.gittensor.io")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("master_repositories.json")) {
        return Response.json({
          "JSONbored/gittensory": {
            emission_share: 0.01,
            issue_discovery_share: 0,
            label_multipliers: { bug: 1.1 },
            trusted_label_pipeline: true,
          },
        });
      }
      if (url.includes("constants.py")) {
        return new Response("OSS_EMISSION_SHARE = 0.90\nMIN_TOKEN_SCORE_FOR_BASE_SCORE = 5\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n");
      }
      if (url.includes("programming_languages.json")) return Response.json({ TypeScript: 1 });
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: true,
          default_branch: "main",
          language: "TypeScript",
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?")) return Response.json([{ name: "bug" }]);
      if (url.includes("/issues?")) {
        return Response.json([{ number: 1, title: "Webhook duplicate delivery", state: "open", user: { login: "reporter" }, labels: [{ name: "bug" }], body: "Bug." }]);
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([{ number: 2, title: "Fix webhook duplicate delivery", state: "open", user: { login: "oktofeesh1" }, labels: [{ name: "bug" }], body: "Fixes #1" }]);
      }
      if (url.includes("/pulls?state=closed")) return Response.json([]);
      if (url.includes("/pulls/2/files")) return Response.json([]);
      if (url.includes("/pulls/2/reviews")) return Response.json([]);
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      return Response.json({ check_runs: [] });
    });

    await processJob(env, { type: "refresh-registry", requestedBy: "test" });
    await processJob(env, { type: "refresh-scoring-model", requestedBy: "test" });
    await processJob(env, { type: "backfill-registered-repos", requestedBy: "test", repoFullName: "JSONbored/gittensory", force: true });
    await processJob(env, { type: "generate-signal-snapshots", requestedBy: "test", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "build-contributor-evidence", requestedBy: "test", login: "oktofeesh1" });
    await processJob(env, { type: "build-contributor-decision-packs", requestedBy: "test", login: "oktofeesh1" });
    await processJob(env, { type: "refresh-contributor-activity", requestedBy: "test", login: "oktofeesh1", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "build-contributor-evidence", requestedBy: "test" });
    await processJob(env, { type: "build-contributor-decision-packs", requestedBy: "test" });
    await processJob(env, { type: "build-burden-forecasts", requestedBy: "test", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "refresh-contributor-activity", requestedBy: "test", login: "oktofeesh1" });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-created",
      eventName: "installation",
      payload: {
        action: "created",
        installation: { id: 456, account: { login: "JSONbored", id: 1, type: "User" } },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }],
      },
    });

    expect(await listRepoSyncStates(env)).toMatchObject([{ repoFullName: "JSONbored/gittensory", status: "success" }]);
    expect(await listCollisionEdges(env, "JSONbored/gittensory")).not.toHaveLength(0);
    expect(await listSignalSnapshots(env, "queue-health", "JSONbored/gittensory")).toHaveLength(1);
    expect(await listSignalSnapshots(env, "contributor-decision-pack", "oktofeesh1")).not.toHaveLength(0);
    expect(await getContributorEvidence(env, "oktofeesh1")).toMatchObject({ login: "oktofeesh1" });
    expect(await getContributorScoringProfile(env, "oktofeesh1")).toMatchObject({ login: "oktofeesh1" });
  });

  it("runs queued agent jobs through the queue processor", async () => {
    const queued: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          queued.push(message);
        },
      } as unknown as Queue,
    });
    await createAgentRun(env, {
      id: "agent-run-queue",
      objective: "Plan next work",
      actorLogin: "oktofeesh1",
      surface: "api",
      mode: "copilot",
      status: "queued",
      dataQualityStatus: "unknown",
      payload: { kind: "plan_next_work", login: "oktofeesh1" },
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });

    await processJob(env, { type: "run-agent", requestedBy: "api", runId: "agent-run-queue" });

    await expect(getAgentRun(env, "agent-run-queue")).resolves.toMatchObject({ status: "needs_snapshot_refresh" });
    expect(queued).toContainEqual({ type: "build-contributor-decision-packs", requestedBy: "api", login: "oktofeesh1" });
  });

  it("fans out all-repo backfill jobs into repo-scoped queue messages", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", force: true, mode: "full" });

    expect(sent).toEqual([
      { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "JSONbored/gittensory", force: true, mode: "full" },
      { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "we-promise/sure", force: true, mode: "full" },
    ]);
    expect(await listRepoSyncStates(env)).toEqual([]);
  });

  it("falls back to inline all-repo backfill when no registered repositories exist", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", mode: "light" });

    expect(sent).toEqual([]);
    expect(await listRepoSyncStates(env)).toEqual([]);
  });

  it("routes repo-scoped API backfills into open-data segment jobs", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "JSONbored/gittensory", force: false, mode: "resume" });

    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "JSONbored/gittensory", mode: "resume", force: false }),
      ]),
    );
  });

  it("repairs incomplete fidelity through queue-backed repo jobs", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "labels"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_issues"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_pull_requests"));

    await processJob(env, { type: "repair-data-fidelity", requestedBy: "schedule" });

    expect(sent.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-registered-repos", repoFullName: "we-promise/sure", mode: "resume" }),
        expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }),
      ]),
    );
  });

  it("marks fidelity repair completed when only signal refreshes are needed", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    for (const repoFullName of ["JSONbored/gittensory", "we-promise/sure"]) {
      await upsertRepoSyncSegment(env, completeSegment(repoFullName, "labels"));
      await upsertRepoSyncSegment(env, completeSegment(repoFullName, "open_issues"));
      await upsertRepoSyncSegment(env, completeSegment(repoFullName, "open_pull_requests"));
    }

    await processJob(env, { type: "repair-data-fidelity", requestedBy: "api" });

    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }) },
      { message: expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "we-promise/sure" }), options: { delaySeconds: 70 } },
    ]);
    const audit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("sync.fidelity_repair").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ repairCount: 0, signalRefreshCount: 2, freshnessSlo: { status: "fresh", repairRecommended: false } });
    const sloAudit = await env.DB.prepare("select detail, outcome, metadata_json from audit_events where event_type = ?").bind("signals.freshness_slo").first<{
      detail: string;
      outcome: string;
      metadata_json: string;
    }>();
    expect(sloAudit).toMatchObject({ detail: "fresh", outcome: "completed" });
    expect(JSON.parse(sloAudit?.metadata_json ?? "{}")).toMatchObject({ status: "fresh", affectedAreas: [] });
    expect(sloAudit?.metadata_json).not.toMatch(/JSONbored|we-promise|github|token|secret/i);
  });

  it("queues signal repair and emits alertable audit state when freshness SLOs breach", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "labels"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_issues"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_pull_requests"));
    await persistSignalSnapshot(env, {
      id: "stale-queue-health",
      signalType: "queue-health",
      targetKey: "JSONbored/gittensory",
      repoFullName: "JSONbored/gittensory",
      payload: {},
      generatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    });

    await processJob(env, { type: "repair-data-fidelity", requestedBy: "api" });

    expect(sent).toEqual([{ message: expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }) }]);
    const repairAudit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("sync.fidelity_repair").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(repairAudit?.outcome).toBe("queued");
    expect(JSON.parse(repairAudit?.metadata_json ?? "{}")).toMatchObject({
      repairCount: 0,
      signalRefreshCount: 1,
      freshnessSlo: { status: "degraded", repairRecommended: true, affectedAreas: ["signal_snapshot"], launchBlockingCount: 0 },
    });
    const sloAudit = await env.DB.prepare("select detail, outcome, metadata_json from audit_events where event_type = ?").bind("signals.freshness_slo").first<{
      detail: string;
      outcome: string;
      metadata_json: string;
    }>();
    expect(sloAudit).toMatchObject({ detail: "degraded", outcome: "queued" });
    expect(JSON.parse(sloAudit?.metadata_json ?? "{}")).toMatchObject({ status: "degraded", affectedAreas: ["signal_snapshot"], launchBlockingCount: 0 });
    expect(sloAudit?.metadata_json).not.toMatch(/JSONbored|gittensory|token|secret/i);
  });

  it("fans out signal snapshot generation instead of doing all repo work inline", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    await processJob(env, { type: "generate-signal-snapshots", requestedBy: "schedule" });

    expect(sent).toEqual([
      expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }),
      expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "we-promise/sure" }),
    ]);
  });

  it("routes repo-scoped backfill jobs into resumable segment and detail processors", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-05-25T01:00:00.000Z" },
            repository: {
              issues: { totalCount: 0 },
              openPullRequests: { totalCount: 0 },
              mergedPullRequests: { totalCount: 0 },
              closedPullRequests: { totalCount: 0 },
              labels: { totalCount: 0 },
            },
          },
        });
      }
      if (url.includes("/issues?") || url.includes("/labels?") || url.includes("/pulls?")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "backfill-repo-segment", requestedBy: "api", repoFullName: "JSONbored/gittensory", segment: "open_issues" });
    await processJob(env, { type: "backfill-pr-details", requestedBy: "api", repoFullName: "JSONbored/gittensory" });

    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "JSONbored/gittensory" })]));
    expect(await listRepoSyncStates(env)).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "JSONbored/gittensory" })]));
  });

  it("covers optional queue payload branches for fanout, segment, and detail jobs", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-05-25T01:00:00.000Z" },
            repository: {
              issues: { totalCount: 0 },
              openPullRequests: { totalCount: 0 },
              mergedPullRequests: { totalCount: 0 },
              closedPullRequests: { totalCount: 0 },
              labels: { totalCount: 0 },
            },
          },
        });
      }
      if (url.includes("/labels?") || url.includes("/pulls?") || url.includes("/issues?")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api" });
    await processJob(env, { type: "backfill-repo-segment", requestedBy: "api", repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", cursor: "2", force: true });
    await processJob(env, { type: "backfill-pr-details", requestedBy: "api", repoFullName: "JSONbored/gittensory", mode: "resume", cursor: 2 });

    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-registered-repos", repoFullName: "JSONbored/gittensory" })]));
  });

  it("marks installation health from queued installation metadata", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "refresh-installation-health", requestedBy: "test" });
    expect(await listInstallationHealth(env)).toMatchObject([{ status: "healthy", registeredInstalledCount: 1 }]);
  });

  it("processes GitHub webhook jobs for PRs, issues, comments-off, comment-attempt, and deleted installs", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 1,
      title: "Prior merged work",
      state: "closed",
      merged_at: "2026-05-01T00:00:00.000Z",
      user: { login: "oktofeesh1" },
      labels: [{ name: "bug" }],
      body: "Fixes #1",
    });
    const visibleCalls = { comments: 0, labelsCreated: 0, labelsApplied: 0, checks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-pr-intelligence -->");
        expect(body.body).toContain("Confirmed Gittensor miner: yes");
        expect(body.body).not.toMatch(/reviewability|likely_duplicate|reward|scoreability|estimated score|wallet|hotkey|trust score|payout|farming/i);
        visibleCalls.comments += 1;
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      if (url.includes("/issues/3/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/labels") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { labels?: string[] };
        expect(body.labels).toEqual(["gittensor"]);
        visibleCalls.labelsApplied += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      if (url.includes("/repos/JSONbored/gittensory/labels") && !url.includes("/issues/") && method === "GET") return Response.json([]);
      if (url.includes("/repos/JSONbored/gittensory/labels") && !url.includes("/issues/") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
        expect(body.name).toBe("gittensor");
        visibleCalls.labelsCreated += 1;
        return Response.json({ name: "gittensor" }, { status: 201 });
      }
      if (url.includes("/check-runs")) {
        visibleCalls.checks += 1;
        return new Response("checks disabled", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    const basePayload = {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository"],
      },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSignalLevel: "standard",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      backfillEnabled: true,
      privateTrustEnabled: true,
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-off",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: {
          number: 2,
          title: "Fix webhook duplicate delivery",
          state: "open",
          user: { login: "oktofeesh1" },
          labels: [{ name: "bug" }],
          body: "Fixes #1",
        },
      },
    });
    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 2 })]));

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      backfillEnabled: true,
      privateTrustEnabled: true,
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-comment-attempt",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        ...basePayload,
        pull_request: {
          number: 3,
          title: "Fix webhook duplicate delivery again",
          state: "open",
          user: { login: "oktofeesh1" },
          labels: [{ name: "bug" }],
          body: "Fixes #1",
        },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-comment-undetected",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: {
          number: 4,
          title: "New contributor work",
          state: "open",
          user: { login: "newbie" },
          labels: [],
          body: "Fixes #1",
        },
      },
    });

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSignalLevel: "minimal",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      backfillEnabled: true,
      privateTrustEnabled: true,
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-comment-no-author",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: {
          number: 5,
          title: "Anonymous webhook work",
          state: "open",
          labels: [],
          body: "Fixes #1",
        },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue",
      eventName: "issues",
      payload: {
        action: "opened",
        ...basePayload,
        issue: {
          number: 1,
          title: "Webhook duplicate delivery",
          state: "open",
          user: { login: "reporter" },
          labels: [{ name: "bug" }],
          body: "Duplicate delivery should be idempotent.",
        },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "deleted",
      eventName: "installation",
      payload: { action: "deleted", installation: { id: 123 } },
    });

    expect(visibleCalls).toEqual({ comments: 1, labelsCreated: 1, labelsApplied: 1, checks: 0 });
    const skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by created_at").bind("github_app.pr_visibility_skipped").all<{
      detail: string;
    }>();
    expect(skipped.results.map((event) => event.detail)).toEqual(expect.arrayContaining(["not_official_gittensor_miner", "missing_author"]));
  });

  it("skips bots and maintainer authors, and keeps explicitly enabled checks minimal", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
    });
    const calls = { minerList: 0, checks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", hotkey: "must-not-cache", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/abc123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { output?: { title?: string; text?: string } };
        expect(body.output).toMatchObject({ title: "Gittensory context checked", text: "No detailed findings are published in check runs." });
        calls.checks += 1;
        return Response.json({ id: 99 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "bot-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: { number: 20, title: "Dependency update", state: "open", user: { login: "renovate[bot]", type: "Bot" }, labels: [], body: "" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "maintainer-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: { number: 21, title: "Maintainer work", state: "open", user: { login: "jsonbored" }, author_association: "OWNER", labels: [], body: "" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "check-enabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: { number: 22, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, head: { sha: "abc123" }, labels: [], body: "No issue needed." },
      },
    });

    expect(calls).toEqual({ minerList: 1, checks: 1 });
    const skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by created_at").bind("github_app.pr_visibility_skipped").all<{
      detail: string;
    }>();
    expect(skipped.results.map((event) => event.detail)).toEqual(expect.arrayContaining(["bot_author", "maintainer_author"]));
  });

  it("records webhook processing when public comment publishing fails after miner confirmation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "comment_only",
      autoLabelEnabled: true,
      createMissingLabel: true,
      checkRunMode: "off",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/30/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/30/comments") && method === "POST") return new Response("comment failed", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "comment-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 30, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("pr_public_surface_failed"));
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("comment-failure").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").all();
    expect(published.results).toEqual([]);
    errorSpy.mockRestore();
  });

  it("keeps repository and PR webhook processing internal when installation context is absent", async () => {
    const env = createTestEnv();
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "repositories-without-installation",
      eventName: "repository",
      payload: {
        action: "created",
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }],
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-without-installation",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 44, title: "Internal-only PR", state: "open", user: { login: "oktofeesh1" }, labels: [] },
      },
    });

    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 44, body: null })]));
    const events = await env.DB.prepare("select delivery_id, status from webhook_events where delivery_id in (?, ?) order by delivery_id")
      .bind("pr-without-installation", "repositories-without-installation")
      .all<{ delivery_id: string; status: string }>();
    expect(events.results).toEqual([
      { delivery_id: "pr-without-installation", status: "processed" },
      { delivery_id: "repositories-without-installation", status: "processed" },
    ]);
  });

  it("uses cached confirmed miner detection for label-only public surfaces", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
    });
    const calls = { comments: 0, labels: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/labels") && method === "GET") return Response.json([]);
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "label-only",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 45, title: "Miner label-only work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "label-only-cached",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 46, title: "Miner label-only follow-up", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(calls).toEqual({ comments: 0, labels: 2, minerList: 1 });
    const cacheAudit = await env.DB.prepare("select event_type, detail from audit_events where actor = ? order by created_at")
      .bind("oktofeesh1")
      .all<{ event_type: string; detail: string | null }>();
    expect(cacheAudit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", detail: "confirmed" }),
      ]),
    );
    const cached = await env.DB.prepare("select status from official_miner_detections where login = ?").bind("oktofeesh1").first<{ status: string }>();
    expect(cached?.status).toBe("confirmed");
    const snapshot = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("oktofeesh1").first<{ snapshot_json: string }>();
    expect(snapshot?.snapshot_json).not.toContain("must-not-cache");
  });

  it("keeps GitHub-history-only contributors quiet through not_found cache hits and expiry", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 9,
      title: "Historical merged work",
      state: "closed",
      merged_at: "2026-05-22T00:00:00.000Z",
      user: { login: "newbie" },
      author_association: "NONE",
      labels: [{ name: "feature" }],
      body: "Previously merged.",
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "off",
    });
    const calls = { minerList: 0, publicOutput: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens") || url.includes("/comments") || url.includes("/labels")) {
        calls.publicOutput += 1;
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    for (const number of [47, 48]) {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: `not-found-cache-${number}`,
        eventName: "pull_request",
        payload: {
          ...basePayload,
          pull_request: { number, title: "Contributor work", state: "open", user: { login: "newbie" }, labels: [], body: "Fixes #1" },
        },
      });
    }
    await env.DB.prepare("update official_miner_detections set expires_at = ? where login = ?").bind("2000-01-01T00:00:00.000Z", "newbie").run();
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "not-found-cache-expired",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 49, title: "Contributor follow-up", state: "open", user: { login: "newbie" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(calls).toEqual({ minerList: 2, publicOutput: 0 });
    const audit = await env.DB.prepare("select event_type, detail from audit_events where actor = ? order by created_at")
      .bind("newbie")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", detail: "not_found" }),
        expect.objectContaining({ event_type: "github_app.pr_visibility_skipped", detail: "not_official_gittensor_miner" }),
      ]),
    );
    const cached = await env.DB.prepare("select status from official_miner_detections where login = ?").bind("newbie").first<{ status: string }>();
    expect(cached?.status).toBe("not_found");
  });

  it("fails closed when official miner detection is unavailable", async () => {
    const env = createTestEnv();
    const payload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
      pull_request: {
        number: 10,
        title: "Check run failure path",
        state: "open",
        user: { login: "oktofeesh1" },
        head: { sha: "abc123" },
        labels: [],
        body: "Fixes #1",
      },
    };

    const calls = { minerList: 0 };
    vi.stubGlobal("fetch", async () => {
      calls.minerList += 1;
      return new Response("gittensor unavailable", { status: 503 });
    });

    await expect(processJob(env, { type: "github-webhook", deliveryId: "miner-unavailable", eventName: "pull_request", payload })).resolves.toBeUndefined();
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "miner-unavailable-cached",
        eventName: "pull_request",
        payload: { ...payload, pull_request: { ...payload.pull_request, number: 11 } },
      }),
    ).resolves.toBeUndefined();
    expect(calls.minerList).toBe(1);
    const audit = await env.DB.prepare("select event_type, outcome, detail from audit_events where target_key = ?")
      .bind("JSONbored/gittensory#10")
      .all<{ event_type: string; outcome: string; detail: string }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", outcome: "completed", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_unavailable", outcome: "error", detail: expect.stringContaining("Gittensor API failed") }),
        expect.objectContaining({ event_type: "github_app.pr_visibility_skipped", outcome: "completed", detail: "miner_detection_unavailable" }),
      ]),
    );
    const cachedAudit = await env.DB.prepare("select event_type, outcome, detail from audit_events where target_key = ?")
      .bind("JSONbored/gittensory#11")
      .all<{ event_type: string; outcome: string; detail: string }>();
    expect(cachedAudit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", outcome: "completed", detail: "unavailable" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_unavailable", outcome: "error", detail: expect.stringContaining("Gittensor API failed") }),
        expect.objectContaining({ event_type: "github_app.pr_visibility_skipped", outcome: "completed", detail: "miner_detection_unavailable" }),
      ]),
    );
    const cached = await env.DB.prepare("select status from official_miner_detections where login = ?").bind("oktofeesh1").first<{ status: string }>();
    expect(cached?.status).toBe("unavailable");
  });

  it("recovers confirmed miners after the unavailable cache window expires", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
    });
    let officialSource: "down" | "confirmed" = "down";
    const calls = { minerList: 0, labels: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        if (officialSource === "down") return new Response("gittensor unavailable", { status: 503 });
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", hotkey: "must-not-cache", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/labels") && method === "GET") return Response.json([]);
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    for (const number of [12, 13]) {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: `miner-unavailable-recovery-${number}`,
        eventName: "pull_request",
        payload: {
          ...basePayload,
          pull_request: { number, title: "Miner recovery", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      });
    }
    expect(calls).toEqual({ minerList: 1, labels: 0 });
    await env.DB.prepare("update official_miner_detections set expires_at = ? where login = ?").bind("2000-01-01T00:00:00.000Z", "oktofeesh1").run();
    officialSource = "confirmed";

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "miner-unavailable-recovered",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 14, title: "Miner recovery confirmed", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(calls).toEqual({ minerList: 2, labels: 1 });
    const cached = await env.DB.prepare("select status, snapshot_json from official_miner_detections where login = ?")
      .bind("oktofeesh1")
      .first<{ status: string; snapshot_json: string }>();
    expect(cached?.status).toBe("confirmed");
    expect(cached?.snapshot_json).not.toMatch(/hotkey|wallet|coldkey|must-not-cache/i);
  });

  it("responds to authorized @gittensory mention commands with one public-safe comment", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 77,
      title: "Miner command context",
      state: "open",
      user: { login: "oktofeesh1" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #1",
    });
    const calls = { commentsCreated: 0, token: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 3, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/issues/77/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/77/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-agent-command -->");
        expect(body.body).toContain("@gittensory");
        expect(body.body).not.toMatch(/wallet|hotkey|estimated score|reward estimate|payout|farming|raw trust score/i);
        return Response.json({ id: 1001 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-miner-context",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 1,
          body: "@gittensory miner-context",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-blockers",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 2,
          body: "@gittensory blockers",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-help",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 3,
          body: "@gittensory help",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-author-next-action",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 4,
          body: "@gittensory next-action",
          user: { login: "oktofeesh1", type: "User" },
          author_association: "NONE",
        },
      },
    });

    expect(calls).toEqual({ commentsCreated: 4, token: 4, minerList: 1 });
    const audit = await env.DB.prepare("select event_type, detail from audit_events where target_key = ? order by created_at")
      .bind("JSONbored/gittensory#77")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_replied" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", detail: "confirmed" }),
      ]),
    );
  });

  it("skips unauthorized, bot, and non-PR @gittensory mention commands without public output", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    let commentCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/issues/")) {
        commentCalls += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
    };
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-none",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 79, title: "No command", state: "open", pull_request: {}, user: { login: "reporter" } },
        comment: { id: 0, body: "plain comment", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-missing-fields",
      eventName: "issue_comment",
      payload: {
        action: "created",
        comment: { id: 9, body: "@gittensory preflight", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-non-pr",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 80, title: "Plain issue", state: "open", user: { login: "reporter" } },
        comment: { id: 1, body: "@gittensory preflight", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-bot",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 81, title: "Bot PR", state: "open", pull_request: {}, user: { login: "renovate[bot]" } },
        comment: { id: 2, body: "@gittensory preflight", user: { login: "renovate[bot]", type: "Bot" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-unauthorized",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 82, title: "Unauthorized PR", state: "open", pull_request: {}, user: { login: "not-a-miner" }, author_association: "NONE" },
        comment: { id: 3, body: "@gittensory preflight", user: { login: "not-a-miner", type: "User" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-no-pr-author",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 83, title: "Unknown author PR", state: "open", pull_request: {}, author_association: "NONE" },
        comment: { id: 4, body: "@gittensory preflight", user: { login: "commenter", type: "User" } },
      },
    });

    expect(commentCalls).toBe(0);
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((entry) => entry.detail)).toEqual(expect.arrayContaining(["bot_author", "not_a_pull_request_thread", "pr_author_not_confirmed_miner"]));
  });
});

function completeSegment(repoFullName: string, segment: "labels" | "open_issues" | "open_pull_requests") {
  return {
    repoFullName,
    segment,
    status: "complete" as const,
    sourceKind: "test" as const,
    mode: "resume" as const,
    fetchedCount: 1,
    expectedCount: 1,
    pageCount: 1,
    completedAt: "2026-05-25T00:00:00.000Z",
    warnings: [],
  };
}

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}
