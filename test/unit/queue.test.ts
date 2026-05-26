import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listCollisionEdges,
  getContributorEvidence,
  getContributorScoringProfile,
  listInstallationHealth,
  listPullRequests,
  listRepoSyncStates,
  listSignalSnapshots,
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
        permissions: { checks: "write", metadata: "read", pull_requests: "read", issues: "read" },
        events: ["issues", "pull_request", "repository"],
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
          permissions: { checks: "write", metadata: "read", pull_requests: "read", issues: "read" },
          events: ["issues", "pull_request", "repository"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "refresh-installation-health", requestedBy: "test" });
    expect(await listInstallationHealth(env)).toMatchObject([{ status: "healthy", registeredInstalledCount: 1 }]);
  });

  it("processes GitHub webhook jobs for PRs, issues, comments-off, comment-attempt, and deleted installs", async () => {
    const env = createTestEnv();
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
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      return new Response("not found", { status: 404 });
    });

    const basePayload = {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { checks: "write", metadata: "read", pull_requests: "read" },
        events: ["issues", "pull_request", "repository"],
      },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

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
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
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
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
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
  });

  it("records webhook processing errors when GitHub check creation fails", async () => {
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

    await expect(processJob(env, { type: "github-webhook", deliveryId: "check-fail", eventName: "pull_request", payload })).rejects.toThrow();
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
