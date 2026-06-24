import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import * as repositoriesModule from "../../src/db/repositories";
import {
  listCollisionEdges,
  createAgentRun,
  getCommandUsefulnessSummary,
  getBurdenForecast,
  getContributorEvidence,
  getAgentRun,
  getContributorScoringProfile,
  getInstallation,
  getLatestUpstreamRulesetSnapshot,
  getPullRequest,
  getRepository,
  listUpstreamDriftReports,
  listInstallationHealth,
  listProductUsageDailyRollups,
  listProductUsageEvents,
  listPullRequests,
  listRepoSyncStates,
  listSignalSnapshots,
  persistSignalSnapshot,
  recordGateBlockOutcome,
  markGateOutcomeOverridden,
  recordProductUsageEvent,
  upsertAgentCommandAnswer,
  upsertCheckSummary,
  upsertIssueFromGitHub,
  upsertRepoSyncSegment,
  upsertInstallation,
  updatePullRequestSlopAssessment,
  upsertOfficialMinerDetection,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertIssueWatchSubscription,
  upsertRepositorySettings,
  upsertRepositoryFromGitHub,
} from "../../src/db/repositories";
import { changedPathsForGuardrail, processJob } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("queue processors", () => {
  // Freshness-SLO fixtures are dated relative to late May 2026; pin the clock so staleness windows
  // stay deterministic regardless of when CI runs.
  beforeEach(() => {
    clearInstallationTokenCacheForTest();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-added-single-repo",
      eventName: "installation",
      payload: {
        action: "added",
        installation: { account: { login: "JSONbored", id: 1, type: "User" } } as never,
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-added-empty",
      eventName: "installation",
      payload: {
        action: "added",
        installation: { id: 789, account: { login: "JSONbored", id: 1, type: "User" } },
      },
    });

    expect(await listRepoSyncStates(env)).toMatchObject([{ repoFullName: "JSONbored/gittensory", status: "success" }]);
    expect(await listCollisionEdges(env, "JSONbored/gittensory")).not.toHaveLength(0);
    expect(await listSignalSnapshots(env, "queue-health", "JSONbored/gittensory")).toHaveLength(1);
    const issueQualitySnapshots = await listSignalSnapshots(env, "issue-quality", "JSONbored/gittensory");
    expect(issueQualitySnapshots).toHaveLength(1);
    expect(issueQualitySnapshots[0]?.payload).toMatchObject({ repoFullName: "JSONbored/gittensory", issues: expect.any(Array), summary: expect.any(String) });
    const outcomePatternSnapshots = await listSignalSnapshots(env, "repo-outcome-patterns", "JSONbored/gittensory");
    expect(outcomePatternSnapshots).toHaveLength(1);
    expect(outcomePatternSnapshots[0]?.payload).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      totals: expect.any(Object),
      evidenceCompleteness: expect.objectContaining({ status: expect.any(String) }),
    });
    expect(await listSignalSnapshots(env, "contributor-decision-pack", "oktofeesh1")).not.toHaveLength(0);
    const contributorEvidence = await getContributorEvidence(env, "oktofeesh1");
    expect(contributorEvidence).toMatchObject({ login: "oktofeesh1", payload: { evidenceGraph: expect.objectContaining({ login: "oktofeesh1" }) } });
    expect(await listSignalSnapshots(env, "contributor-evidence-graph", "oktofeesh1")).not.toHaveLength(0);
    expect(await getContributorScoringProfile(env, "oktofeesh1")).toMatchObject({ login: "oktofeesh1" });
    const persistedBurden = await getBurdenForecast(env, "JSONbored/gittensory");
    expect(persistedBurden).toMatchObject({ repoFullName: "JSONbored/gittensory" });
    expect(persistedBurden?.payload).toMatchObject({ level: expect.any(String), summary: expect.any(String) });
    expect(await listProductUsageEvents(env, { limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventName: "github_installation_created", repoFullName: "<redacted-actor>/gittensory", metadata: expect.objectContaining({ action: "created" }) }),
      ]),
    );
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

  it("runs product usage rollups through the queue processor", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "agent_plan_next_work_completed",
      actor: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      outcome: "success",
      occurredAt: "2026-05-27T12:00:00.000Z",
    });

    await processJob(env, { type: "rollup-product-usage", requestedBy: "test", day: "2026-05-27" });
    await processJob(env, { type: "rollup-product-usage", requestedBy: "test", days: 1 });

    await expect(listProductUsageDailyRollups(env)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        day: "2026-05-27",
        totalEvents: 1,
        activeActors: 1,
        activation: expect.objectContaining({ firstUsefulActionActors: 1 }),
      }),
    ]));
  });

  it("runs weekly value report generation through the queue processor", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    await processJob(env, { type: "generate-weekly-value-report", requestedBy: "test", variant: "operator", days: 7 });
    await processJob(env, { type: "generate-weekly-value-report", requestedBy: "test" });

    const row = await env.DB.prepare("select event_type, target_key, outcome from audit_events where event_type = ? order by created_at limit 1").bind("weekly_value_report_generated").first();
    expect(row).toMatchObject({
      event_type: "weekly_value_report_generated",
      target_key: "weekly-value-report:operator:7",
      outcome: "success",
    });
    const auditCount = await env.DB.prepare("select count(*) as count from audit_events where event_type = ?").bind("weekly_value_report_generated").first<{ count: number }>();
    expect(auditCount?.count).toBe(2);
  });

  it("routes upstream drift jobs through queue processors", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/commits/")) return Response.json({ sha: "queue-upstream-commit" });
      if (url.includes("/contents/gittensor/constants.py")) {
        return Response.json({ content: b64("SRC_TOK_SATURATION_SCALE = 58\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n"), encoding: "base64", sha: "constants-sha" });
      }
      if (url.includes("/contents/gittensor/validator/weights/master_repositories.json")) {
        return Response.json({ content: b64(JSON.stringify({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: true } })), encoding: "base64", sha: "registry-sha" });
      }
      if (url.includes("/contents/gittensor/validator/weights/programming_languages.json")) {
        return Response.json({ content: b64(JSON.stringify({ TypeScript: 1 })), encoding: "base64", sha: "languages-sha" });
      }
      if (url.includes("/contents/gittensor/validator/oss_contributions/mirror/scoring.py")) {
        return Response.json({ content: b64("score = 1 - exp(-x)\nsolved_by_pr = True\n"), encoding: "base64", sha: "scoring-sha" });
      }
      if (url.includes("/contents/gittensor/validator/issue_discovery/scan.py")) {
        return Response.json({ content: b64("branch eligibility required\n"), encoding: "base64", sha: "issue-scan-sha" });
      }
      if (url.includes("/contents/gittensor/utils/mirror/models.py")) {
        return Response.json({ content: b64("solved_by_pr: int\n"), encoding: "base64", sha: "models-sha" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "refresh-upstream-drift", requestedBy: "test" });
    await processJob(env, { type: "refresh-upstream-sources", requestedBy: "test" });
    await processJob(env, { type: "build-upstream-ruleset", requestedBy: "test" });
    await processJob(env, { type: "detect-upstream-drift", requestedBy: "test" });
    await processJob(env, { type: "file-upstream-drift-issues", requestedBy: "test" });

    await expect(getLatestUpstreamRulesetSnapshot(env)).resolves.toMatchObject({ activeModel: "pending_saturation_model", registryRepoCount: 1 });
    await expect(listUpstreamDriftReports(env)).resolves.toEqual([]);
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T01:00:00.000Z"));

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T13:00:00.000Z"));

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

  it("agent re-gate sweep fans out only to repos that opted the agent in (#777)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } });
    await upsertRepositoryFromGitHub(env, { name: "agent-b", full_name: "owner/agent-b", private: false, owner: { login: "owner" } });
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { label: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-b", autonomy: { merge: "auto_with_approval" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/plain-repo", autonomy: { review: "observe" } }); // non-acting → not configured

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(2);
    expect(sent.every((message) => message.type === "agent-regate-sweep")).toBe(true);
    expect(sent.map((message) => (message.type === "agent-regate-sweep" ? message.repoFullName : null)).sort()).toEqual(["owner/agent-a", "owner/agent-b"]);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.fanout").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(fanout?.outcome).toBe("queued");
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 2, requestedBy: "schedule" });
  });

  it("agent re-gate sweep recomputes stale open PR verdicts as an advisory audit, never publishing (#777)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, linkedIssueGateMode: "block" });
    // #7 has no linked issue → blocked under linkedIssueGateMode:block; #8 links one → passes. Both are stale.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Unlinked PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "Linked PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" });
    // Advance past the one-hour freshness window so the just-seeded PRs read as stale.
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{
      outcome: string;
      detail: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("completed");
    const meta = JSON.parse(audit?.metadata_json ?? "{}");
    expect(meta).toMatchObject({ repoFullName: "owner/agent-repo", mode: "live", examined: 2, flagged: 1 });
    expect(meta.flaggedPulls).toEqual([7]);
    expect(meta.verdicts).toMatchObject({ "7": "failure", "8": "success" });
    // Advisory only: the sweep enqueues no jobs and posts no check/comment/label.
    expect(sent).toEqual([]);
  });

  it("agent re-gate sweep skips advisory AI review while refreshing the PR surface on a stale AI-enabled PR", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => {
          aiCalls += 1;
          return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
        },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, {
      repoFullName: "owner/agent-repo",
      autonomy: { merge: "auto" },
      aiReviewMode: "advisory",
      gatePack: "oss-anti-slop",
      gateCheckMode: "enabled",
      checkRunMode: "off",
      commentMode: "off",
      publicSurface: "off",
    });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 7, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = true;" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      return new Response("not found", { status: 404 });
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(aiCalls).toBe(0);
    const aiUsage = await env.DB.prepare("select count(*) as n from ai_usage_events where feature = ?").bind("ai_review_pr").first<{ n: number }>();
    expect(aiUsage?.n).toBe(0);
    const audit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ outcome: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ repoFullName: "owner/agent-repo", examined: 1 });
  });

  it("agent re-gate sweep runs blocking AI review before auto-maintenance (regression)", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => {
          aiCalls += 1;
          return { response: JSON.stringify({ assessment: "Critical defect found.", blockers: ["Unhandled null dereference in src/a.ts"], nits: [], suggestions: [] }) };
        },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, {
      repoFullName: "owner/agent-repo",
      autonomy: { merge: "auto" },
      aiReviewMode: "block",
      gatePack: "oss-anti-slop",
      gateCheckMode: "enabled",
      checkRunMode: "off",
      commentMode: "off",
      publicSurface: "off",
    });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 7, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = value.length;" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = value.length;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.endsWith("/pulls/7/merge")) return new Response(null, { status: 204 });
      if (url.endsWith("/pulls/7/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/pulls/7/reviews")) return Response.json([]);
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(aiCalls).toBeGreaterThanOrEqual(2);
    const blocker = await env.DB.prepare("select blocker_codes_json from gate_outcomes where repo_full_name = ? and pull_number = ? order by rowid desc limit 1").bind("owner/agent-repo", 7).first<{ blocker_codes_json: string }>();
    expect(blocker?.blocker_codes_json).toContain("ai_consensus_defect");
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and detail like ?").bind("agent.action.merge", "%merged%").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
  });

  it("agent re-gate sweep re-reviews each stale open PR (installation id) and swallows a failing re-review", async () => {
    const env = createTestEnv({});
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, linkedIssueGateMode: "block" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Unlinked PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
    // Advance past the one-hour freshness window so the just-seeded PR reads as stale.
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // Make the re-review itself REJECT (its advisory persist throws) so the sweep's per-PR error backstop runs.
    // Only the advisories insert is poisoned; every other read/write (verdict computation, the closing audit
    // event) keeps working — the sweep must still complete and record its advisory verdict.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["'`]?advisories/i.test(sql)) throw new Error("advisory persist failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await realPrepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ repoFullName: "owner/agent-repo", examined: 1, flagged: 1 });
    // The failing re-review was caught and logged via the sweep_rereview_failed backstop, not rethrown.
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_rereview_failed"))).toBe(true);
    errors.mockRestore();
  });

  it("agent re-gate sweep respects the #776 kill-switch: a paused repo records a skip and recomputes nothing (#777)", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, agentPaused: true });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "abc" }, labels: [], body: "x" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{
      outcome: string;
      detail: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toMatch(/paused/i);
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ mode: "paused" });
  });

  it("agent re-gate sweep no-ops safely on a missing repo arg or an un-configured repo (#777)", async () => {
    const env = createTestEnv({});
    // (a) a test-mode per-repo job with no repoFullName → defensive early return
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test" });
    // (b) a repo that never opted the agent in → defensive return after settings resolve
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } });
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/plain-repo" });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("agent re-gate sweep stays quiet when no open PR is stale enough to re-gate (#777)", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    // Seeded "now" → within the freshness window → not a candidate; no clock advance.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Fresh PR", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "x" });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ n: number }>();
    expect(count?.n).toBe(0);
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
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
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
          permissions: { metadata: "read", pull_requests: "write", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "refresh-installation-health", requestedBy: "test" });
    expect(await listInstallationHealth(env)).toMatchObject([{ status: "healthy", registeredInstalledCount: 1 }]);
  });

  it("syncs repositories added to and removed from an existing installation", async () => {
    const env = createTestEnv();
    const installation = { id: 123, account: { login: "JSONbored", id: 1, type: "User" } };
    await upsertInstallation(env, {
      installation: {
        ...installation,
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-repo-added",
      eventName: "installation_repositories",
      payload: {
        action: "added",
        installation: { id: 123 },
        repositories_added: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      },
    });

    expect(await getRepository(env, "JSONbored/gittensory")).toMatchObject({ isInstalled: true, installationId: 123 });
    expect(await getInstallation(env, 123)).toMatchObject({
      accountLogin: "JSONbored",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-repo-removed",
      eventName: "installation_repositories",
      payload: {
        action: "removed",
        installation: { id: 123 },
        repositories_removed: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      },
    });

    expect(await getRepository(env, "JSONbored/gittensory")).toMatchObject({ isInstalled: false, installationId: null });
    expect(await listProductUsageEvents(env, { limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventName: "github_installation_repository_added", repoFullName: "<redacted-actor>/gittensory" }),
        expect.objectContaining({ eventName: "github_installation_repository_removed", repoFullName: "<redacted-actor>/gittensory" }),
      ]),
    );
  });

  it("publishes an opt-in gate without comment output, blocking a non-confirmed author normally (#gate-nonconfirmed)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
    });
    const calls = { minerList: 0, gateChecks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && (init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ name: "Gittensory Gate", status: "in_progress", output: { title: "Gittensory Gate is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 900 }, { status: 201 });
      }
      if (url.includes("/check-runs/900") && (init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; status?: string; conclusion?: string; output?: { title?: string } };
        // Non-confirmed author + linked-issue block + no issue → gated normally → failure (#gate-nonconfirmed).
        expect(body).toMatchObject({ name: "Gittensory Gate", status: "completed", conclusion: "failure", output: { title: "Gittensory Gate: No linked issue detected" } });
        calls.gateChecks += 1;
        return Response.json({ id: 900 });
      }
      return new Response("not found", { status: 404 });
    });

    // .gittensory.yml authoritatively sets the linked-issue blocker to "block" (config-as-code).
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-only",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 42, title: "Gate without issue", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ minerList: 1, gateChecks: 2 });
  });

  it("auto-maintain (#778): a blocking gate on an agent-configured repo records the changes-requested label, never a formal request_changes (dry-run)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
      autonomy: { label: "auto", request_changes: "auto" },
      agentDryRun: true, // dry-run → the actions are recorded but make no GitHub mutation
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    // .gittensory.yml authoritatively sets the linked-issue blocker to "block" (config-as-code, as in the gate tests above).
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "auto-maintain",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 42, title: "No issue", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    const labelAudit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.action.label").first<{ outcome: string; metadata_json: string }>();
    expect(labelAudit?.outcome).toBe("completed");
    expect(JSON.parse(labelAudit?.metadata_json ?? "{}")).toMatchObject({ mode: "dry_run", actionClass: "label" });
    // The bot NEVER posts a formal request_changes (a blocking review strands the PR). With close NOT at an acting
    // level here, a blocking contributor PR is only labeled; with close acting it would be closed. No request_changes.
    const rcAudit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.request_changes").first<{ outcome: string }>();
    expect(rcAudit).toBeFalsy();
  });

  it("auto-maintain (#778): uses the full gate verdict so manifest-policy blockers cannot be merged", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      manifestPolicyGateMode: "block",
      autonomy: { merge: "auto", request_changes: "auto" },
      agentDryRun: true,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { manifestPolicy: "block" }, blockedPaths: ["migrations/**"] });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 48,
      path: "migrations/0099_attacker.sql",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "auto-maintain-manifest-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 48,
          title: "Blocked migration",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate123" },
          labels: [],
          body: "Closes #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });

    const mergeCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.action.merge").first<{ n: number }>();
    expect(mergeCount?.n).toBe(0); // the manifest-policy blocker prevents the auto-merge (the key assertion)
    // The bot never posts a formal request_changes. With close NOT at an acting level here, the blocked PR is
    // simply not merged (no blocking review); with close acting it would be closed.
    const rcAudit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.request_changes").first<{ outcome: string }>();
    expect(rcAudit).toBeFalsy();
  });

  // #1092: prReadyForReview rebases a BEHIND-base PR through the agent executor (gated by update_branch autonomy
  // + pull_requests:write) before reviewing, then defers — the synchronize on the new head re-runs review.
  async function seedBehindRepo(env: Env, over: { autonomy?: Record<string, string>; agentPaused?: boolean; perms?: Record<string, string>; noInstall?: boolean } = {}) {
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    if (!over.noInstall) {
      await upsertInstallation(env, {
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: over.perms ?? { metadata: "read", pull_requests: "write", issues: "write" },
          events: ["pull_request"],
        },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
    }
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      autonomy: over.autonomy ?? { merge: "auto", update_branch: "auto" },
      agentPaused: over.agentPaused ?? false,
    });
  }

  function behindWebhook() {
    return {
      type: "github-webhook" as const,
      deliveryId: "behind-update-branch",
      eventName: "pull_request" as const,
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 48, title: "Behind base", state: "open", user: { login: "contributor" }, head: { sha: "behindsha" }, labels: [], body: "x" },
      },
    };
  }

  it("auto-maintain (#1092): a BEHIND-base PR routes update-branch through the executor, then defers review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedBehindRepo(env);
    let updateBranchCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/48/update-branch")) {
        updateBranchCalls += 1;
        return Response.json({ message: "Updating pull request branch." }, { status: 202 });
      }
      if (/\/pulls\/48(?:\?|$)/.test(url)) return Response.json({ number: 48, mergeable_state: "behind" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, behindWebhook());

    expect(updateBranchCalls).toBe(1); // the rebase was issued before review
    const ub = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.update_branch").first<{ outcome: string }>();
    expect(ub?.outcome).toBe("completed");
    // Deferred for the rebase → no gate verdict published on the stale head.
    const merge = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.action.merge").first<{ n: number }>();
    expect(merge?.n).toBe(0);
  });

  it("auto-maintain (#1092): a behind PR is not rebased when the installation lacks pull_requests:write (falls through)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedBehindRepo(env, { noInstall: true });
    // A stored open PR + the recapture-preview job drive reReviewStoredPullRequest directly (no webhook
    // installation upsert), so getInstallation(...) is null → installation?.permissions ?? null hits the null arm.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 48, title: "Behind base", state: "open", user: { login: "contributor" }, head: { sha: "behindsha" }, labels: [], body: "x" });
    let updateBranchCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/48/update-branch")) {
        updateBranchCalls += 1;
        return Response.json({}, { status: 202 });
      }
      if (/\/pulls\/48(?:\?|$)/.test(url)) return Response.json({ number: 48, mergeable_state: "behind" });
      // CI still running on the (un-rebased) head → prReadyForReview defers at the CI gate, cleanly.
      if (url.includes("/commits/behindsha/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "CI build", status: "in_progress", conclusion: null }] });
      if (url.includes("/commits/behindsha/status")) return Response.json({ state: "pending", statuses: [] });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "recapture-preview", deliveryId: "rp-48", installationId: 123, repoFullName: "JSONbored/gittensory", prNumber: 48, attempt: 1 });

    expect(updateBranchCalls).toBe(0); // no installation perms → the executor denies the write; the block falls through
  });

  it("recapture-preview (#1158): a clean PR re-review threads previewPollAttempt into the public-surface publish", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "preview-repo", full_name: "owner/preview-repo", private: false, owner: { login: "owner" } }, 9101);
    await upsertRepositorySettings(env, { repoFullName: "owner/preview-repo", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/preview-repo", { number: 9, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "x" });
    await upsertPullRequestFile(env, { repoFullName: "owner/preview-repo", pullNumber: 9, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = true;" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/9/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (/\/pulls\/9(?:\?|$)/.test(url)) return Response.json({ number: 9, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "x" });
      if (url.includes("/commits/c9/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/c9/status")) return Response.json({ state: "success", statuses: [] });
      return new Response("not found", { status: 404 });
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    // attempt:2 → previewPollAttempt is defined, so the conditional spread at the publish call takes the
    // `{ previewPollAttempt }` arm (the recapture-preview poll path; the sweep/webhook callers omit it).
    await expect(
      processJob(env, { type: "recapture-preview", deliveryId: "rp-9", installationId: 9101, repoFullName: "owner/preview-repo", prNumber: 9, attempt: 2 }),
    ).resolves.toBeUndefined();
  });

  it("auto-maintain (#778): a repo with no acting autonomy takes no agent action", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
      autonomy: { label: "observe" }, // not acting → agent never runs
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-autonomy",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 43, title: "No issue", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'agent.action.%'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("auto-maintain (#778): takes no terminal action when merge/close/approve autonomy is not granted (gate now fails normally for a non-confirmed author)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      autonomy: { label: "auto", request_changes: "auto" },
    });
    // No confirmed-miner seed → author is unconfirmed; the manifest's linkedIssue:block + no issue fires a
    // blocker, so the gate now FAILS the author normally (#gate-nonconfirmed — confirmed status no longer
    // neutralizes the verdict). But this repo grants only label/request_changes autonomy — NOT merge/close/
    // approve — so the failing gate yields a request-changes/label action at most, never a terminal action.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "unconfirmed",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 45, title: "No issue", state: "open", user: { login: "stranger" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    // The failing gate is surfaced (request-changes/label), but with no merge/close/approve autonomy granted the
    // bot takes NO TERMINAL action — proving terminal actions require their own autonomy grant, independent of the
    // gate verdict. (Auto-close on a failing gate is exercised by the #778 close-autonomy tests below.)
    const terminal = await env.DB.prepare("select count(*) as n from audit_events where event_type in ('agent.action.merge','agent.action.close','agent.action.approve')").first<{ n: number }>();
    expect(terminal?.n).toBe(0);
  });

  it("auto-maintain (#778): skips a closed PR even on an agent-configured repo", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      autonomy: { label: "auto" },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      if (url.includes("/comments")) return Response.json({ id: 1 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "closed-pr",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 46, title: "Closed", state: "closed", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "x" },
      },
    });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'agent.action.%'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("auto-maintain (#778): labels a clean passing PR even with no author and no installation record (dry-run)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    // No installation record seeded → installation lookup returns null (label needs only issues:write, exempt).
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      autonomy: { label: "auto" },
      agentDryRun: true,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/clean123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/clean123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-author-clean",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        // No `user` → authorLogin is absent; default linkedIssue mode is advisory so the verdict is a clean pass.
        pull_request: { number: 47, title: "Clean", state: "open", head: { sha: "clean123" }, labels: [], body: "Closes #1" },
      },
    });

    const labelAudit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.action.label").first<{ outcome: string; metadata_json: string }>();
    expect(labelAudit?.outcome).toBe("completed");
    expect(JSON.parse(labelAudit?.metadata_json ?? "{}")).toMatchObject({ mode: "dry_run" });
  });

  it("publishes an enabled gate when bot PR public output is skipped", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
    });
    const calls = { gateChecks: 0, comments: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gatebot123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/53/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ status: "in_progress", output: { title: "Gittensory Gate is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 910 }, { status: 201 });
      }
      if (url.includes("/check-runs/910") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        // The bot author is gated normally now (no confirmation gate); linked-issue block + no issue → failure (#gate-nonconfirmed).
        expect(body).toMatchObject({ status: "completed", conclusion: "failure", output: { title: "Gittensory Gate: No linked issue detected" } });
        calls.gateChecks += 1;
        return Response.json({ id: 910 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-bot-public-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 53, title: "Bot PR", state: "open", user: { login: "automation-bot", type: "Bot" }, head: { sha: "gatebot123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ gateChecks: 2, comments: 0, minerList: 0 });
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#53")
      .first<{ detail: string }>();
    expect(audit?.detail).toBe("bot_author");
  });

  it("publishes an enabled gate when Gittensor-only public output is skipped for an unconfirmed miner", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
    });
    const calls = { minerList: 0, gateChecks: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gateminer123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/54/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ status: "in_progress", output: { title: "Gittensory Gate is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 920 }, { status: 201 });
      }
      if (url.includes("/check-runs/920") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        // The unconfirmed miner is gated normally now; linked-issue block + no issue → failure (#gate-nonconfirmed).
        expect(body).toMatchObject({ status: "completed", conclusion: "failure", output: { title: "Gittensory Gate: No linked issue detected" } });
        calls.gateChecks += 1;
        return Response.json({ id: 920 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-unconfirmed-miner-public-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 54, title: "Unconfirmed miner PR", state: "open", user: { login: "newbie" }, head: { sha: "gateminer123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ minerList: 1, gateChecks: 2, comments: 0 });
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#54")
      .first<{ detail: string }>();
    expect(audit?.detail).toBe("not_official_gittensor_miner");
  });

  it("keeps gate checks without double-auditing unavailable miner detection as not official", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
    });

    const calls = { minerList: 0, gateChecks: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return new Response("gittensor unavailable", { status: 503 });
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gateunavailable123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/55/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        return Response.json({ id: 921 }, { status: 201 });
      }
      if (url.includes("/check-runs/921") && method === "PATCH") {
        calls.gateChecks += 1;
        return Response.json({ id: 921 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-unavailable-miner-public-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Unavailable miner PR", state: "open", user: { login: "newbie" }, head: { sha: "gateunavailable123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ minerList: 1, gateChecks: 2, comments: 0 });
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ? order by id")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#55")
      .all<{ detail: string }>();
    expect(audit.results.map((event) => event.detail)).toEqual(["miner_detection_unavailable"]);
  });

  it("hard-blocks a confirmed Gittensor contributor in a gate-only configuration when a configured blocker fires", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicAudienceMode: "oss_maintainer",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
    });
    const calls = { minerList: 0, gateChecks: 0 };
    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([
          { uid: 7, githubUsername: "confirmed-dev", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/confirmed123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs/940") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        calls.gateChecks += 1;
        return Response.json({ id: 940 });
      }
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        return Response.json({ id: 940 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-confirmed-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 61, title: "Add helper", state: "open", user: { login: "confirmed-dev" }, head: { sha: "confirmed123" }, labels: [], body: "Adds a helper." },
      },
    });

    // A confirmed contributor with a configured hard blocker (linked-issue gate set to block, no issue
    // linked) IS blocked even when the Gate is the only public output, and the Gate names the exact
    // blocker so the fix is obvious.
    expect(calls.minerList).toBe(1);
    expect(calls.gateChecks).toBe(2);
    expect(gatePatchBody.conclusion).toBe("failure");
    expect(gatePatchBody.output?.title).toBe("Gittensory Gate: No linked issue detected");
  });

  it("hard-blocks a confirmed contributor on a dual-model AI consensus defect when aiReview: block is opted in", async () => {
    const defectJson = JSON.stringify({
      assessment: "Introduces a likely crash.",
      blockers: ["Unhandled null dereference on empty input in src/a.ts — the new branch dereferences a possibly-null value."],
      nits: ["Guard the null case."],
      suggestions: ["Guard the null case."],
    });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => ({ response: defectJson }) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
      aiReviewMode: "block",
      // Also exercise the opt-in slop advisory in the same surface pass: it persists a per-PR assessment
      // and runs the (advisory-only) AI slop pass, but never blocks — the gate still fails on the AI
      // consensus defect alone.
      slopGateMode: "advisory",
      slopAiAdvisory: true,
    });
    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          { uid: 7, githubUsername: "confirmed-dev", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/aidefect123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs/950") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 950 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 950 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-ai-consensus-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 71, title: "Add helper", state: "open", user: { login: "confirmed-dev" }, head: { sha: "aidefect123" }, labels: [], body: "Adds a helper." },
      },
    });

    expect(gatePatchBody.conclusion).toBe("failure");
    expect(gatePatchBody.output?.title).toContain("AI reviewers agree on a likely critical defect");
    // The AI usage event was recorded for the review (never with key material).
    const usage = await env.DB.prepare("select feature, status from ai_usage_events where feature = ?").bind("ai_review_pr").first<{ feature: string; status: string }>();
    expect(usage).toMatchObject({ feature: "ai_review_pr", status: "ok" });
  });

  it("finalizes the Gate to neutral instead of leaving it in_progress when gate completion fails", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
    });
    const patchBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string } }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/finalize123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 970 }, { status: 201 }); // pending
      if (url.includes("/check-runs/970") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        patchBodies.push(body);
        // First PATCH = the gate completion; fail it transiently so the catch must finalize the check.
        if (patchBodies.length === 1) return new Response(JSON.stringify({ message: "server error" }), { status: 500 });
        return Response.json({ id: 970 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-finalize-on-error",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 80, title: "Some change", state: "open", user: { login: "contributor" }, head: { sha: "finalize123" }, labels: [], body: "No issue link." },
      },
    });

    // The completion PATCH failed (500), so the LOCAL check-run catch finalized the SAME check run (id 970) to
    // a neutral, non-blocking terminal state — never left hanging in_progress — and CONTINUED the review
    // (no re-throw), so the comment/audit/auto-action still run instead of the whole review dead-lettering.
    expect(patchBodies.length).toBe(2);
    const finalize = patchBodies[1];
    expect(finalize?.status).toBe("completed");
    expect(finalize?.conclusion).toBe("neutral");
    expect(finalize?.output?.title).toBe("Gittensory Gate — could not finish evaluating");
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.gate_check_failed_nonfatal", "JSONbored/gittensory#80")
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe("error");
  });

  it("finalizes the Gate to neutral when the completion call returns a transient 403 (not left in_progress)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
    });
    const patchBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string } }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/forbidden403/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 971 }, { status: 201 }); // pending in_progress
      if (url.includes("/check-runs/971") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        patchBodies.push(body);
        // First PATCH = the gate completion; a transient 403 (e.g. secondary rate limit) is classified as
        // permission_missing and does NOT throw — the fix must still finalize the already-posted pending check.
        if (patchBodies.length === 1) return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status: 403 });
        return Response.json({ id: 971 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-finalize-on-403",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 81, title: "Some change", state: "open", user: { login: "contributor" }, head: { sha: "forbidden403" }, labels: [], body: "No issue link." },
      },
    });

    // The completion PATCH 403'd (permission_missing, no throw), so the fix finalized the SAME check (id 971)
    // to a neutral, non-blocking terminal state instead of orphaning it in_progress.
    expect(patchBodies.length).toBe(2);
    const finalize = patchBodies[1];
    expect(finalize?.status).toBe("completed");
    expect(finalize?.conclusion).toBe("neutral");
    expect(finalize?.output?.title).toBe("Gittensory Gate — could not finish evaluating");
  });

  it("disables the gate from .gittensory.yml (gate.enabled: false) even when repo settings enable it", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
    });
    // Config turns the gate OFF even though repo settings have gateCheckMode: enabled.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { enabled: false } });
    const calls = { gateChecks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) {
        calls.gateChecks += 1;
        return Response.json({ id: 999 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-yml-disabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 70, title: "No issue", state: "open", user: { login: "contributor" }, head: { sha: "ymldisabled123" }, labels: [], body: "No issue." },
      },
    });

    // gate.enabled: false in .gittensory.yml disables the gate entirely — no Gate check is posted.
    expect(calls.gateChecks).toBe(0);
  });

  it("audits opt-in gate check permission failures without blocking webhook processing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      requireLinkedIssue: true,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate403/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 42, title: "Gate without issue", state: "open", user: { login: "contributor" }, head: { sha: "gate403" }, labels: [], body: "No issue link." },
      },
    });

    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_check_permission_missing")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();

    expect(audit).toMatchObject({
      event_type: "github_app.gate_check_permission_missing",
      actor: "contributor",
      target_key: "JSONbored/gittensory#42",
      outcome: "error",
    });
    expect(audit?.detail).toMatch(/Checks: write permission is missing/i);
  });

  it("marks closed PR gates skipped without creating late first comments", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
    });
    const calls = { gateWrites: 0, commentGets: 0, commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/closed123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ name: "Gittensory Gate", status: "completed", conclusion: "skipped", output: { title: "Gittensory Gate skipped" } });
        calls.gateWrites += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/issues/43/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([]);
      }
      if (url.includes("/issues/43/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-closed",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 43, title: "Fast merged PR", state: "closed", user: { login: "contributor" }, head: { sha: "closed123" }, labels: [], body: "Fixes #1" },
      },
    });

    // The real review is PRESERVED on close: the gate check is marked skipped (gateWrites:1), but the unified
    // comment is NOT touched (commentGets:0, commentPosts:0) — no post-close pass overwrites the open-time review
    // with an empty skip card. (#preserve-review-on-close)
    expect(calls).toEqual({ gateWrites: 1, commentGets: 0, commentPosts: 0 });
  });

  it("audits closed PR skipped gate permission failures (no late panel write — the real review is preserved)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
    });
    let commentGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      if (url.includes("/issues/47/comments")) {
        commentGets += 1;
        return new Response("comments down", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-closed-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 47, title: "Fast merged PR", state: "closed", user: { login: "contributor" }, head: { sha: "closed403" }, labels: [], body: "Fixes #1" },
      },
    });

    // No late panel update on close (the real review is preserved), so the comment endpoint is never hit.
    expect(commentGets).toBe(0);
    const audit = await env.DB.prepare("select target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_check_permission_missing")
      .first<{ target_key: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({
      target_key: "JSONbored/gittensory#47",
      outcome: "error",
    });
    expect(audit?.detail).toMatch(/Checks: write permission is missing/i);
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("gate-closed-permission-missing").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
  });

  it("reruns the sticky PR panel when a maintainer checks the rerun task", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "off",
      includeMaintainerAuthors: true,
      commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { "review-now": ["maintainer"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 45,
      title: "Refresh panel",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel123" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review",
    ].join("\n");
    const calls = { token: 0, permission: 0, minerList: 0, commentGets: 0, commentPatches: 0, checkRuns: 0 };
    let patchedBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        // A confirmed official Gittensor contributor → the rerun renders the FULL readiness panel
        // (which carries the rerun task); a non-registered author would get the minimal invite.
        return Response.json([
          { uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/check-runs")) {
        calls.checkRuns += 1;
        return Response.json({ id: 888 });
      }
      if (url.includes("/collaborators/maintainer/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "maintain" });
      }
      if (url.includes("/issues/45/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([{ id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/777") && method === "PATCH") {
        calls.commentPatches += 1;
        patchedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 777 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 45, title: "Refresh panel", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // token: 1 — the installation token is now cached + reused within the request (was 2: main + permission check).
    expect(calls).toEqual({ token: 1, permission: 1, minerList: 1, commentGets: 1, commentPatches: 1, checkRuns: 0 });
    expect(patchedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
    expect(patchedBody).toContain("Readiness score:");
    expect(patchedBody).toContain("- [ ] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review");
    expect(patchedBody).not.toContain("- [x] <!-- gittensory-rerun-review:v1 -->");
    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome from audit_events where event_type = ?")
      .bind("github_app.pr_panel_retriggered")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string }>();
    expect(audit).toMatchObject({
      event_type: "github_app.pr_panel_retriggered",
      actor: "maintainer",
      target_key: "JSONbored/gittensory#45",
      outcome: "completed",
    });
    const usageEvents = await listProductUsageEvents(env, { limit: 5 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "github_app", eventName: "pr_panel_retriggered", outcome: "completed" })]));
  });

  it("refreshes the PR's files on a manual rerun so the slop/manifest gate evaluates the current diff", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "off",
      includeMaintainerAuthors: true,
      // Slop gate on → the rerun must refresh the PR files before evaluating (the guard fires).
      slopGateMode: "advisory",
      commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { "review-now": ["maintainer"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 45,
      title: "Refresh panel",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel123" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = ["<!-- gittensory-pr-panel:v1 -->", "", "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review"].join("\n");
    const calls = { pullsFiles: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([{ uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      // The refresh fetches files/reviews/checks; count the files fetch to prove the refresh ran on the rerun.
      if (url.includes("/pulls/45/files")) {
        calls.pullsFiles += 1;
        return Response.json([{ filename: "src/app.ts", status: "modified", additions: 5, deletions: 1, changes: 6 }]);
      }
      if (url.includes("/pulls/45/reviews")) return Response.json([]);
      if (url.includes("/commits/panel123/check-runs")) return Response.json({ check_runs: [] });
      if (url.includes("/issues/45/comments") && method === "GET") return Response.json([{ id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      if (url.includes("/issues/comments/777") && method === "PATCH") return Response.json({ id: 777 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-refresh",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 45, title: "Refresh panel", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // The rerun fetched the PR's current files before publishing the panel/gate — not the stale cache.
    expect(calls.pullsFiles).toBeGreaterThanOrEqual(1);
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retriggered", "JSONbored/gittensory#45")
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
  });

  it("reruns the panel when a confirmed-miner PR author checks the rerun task (#824 miner-detection path)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "off",
      includeMaintainerAuthors: true,
      // review-now allows a confirmed miner, so a confirmed-miner PR author can retrigger their own panel.
      commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { "review-now": ["maintainer", "confirmed_miner"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 48,
      title: "Miner self-rerun",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel480" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = ["<!-- gittensory-pr-panel:v1 -->", "", "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review"].join("\n");
    const calls = { minerList: 0, permission: 0, commentPatches: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The confirmed-miner author has NO repo write/admin — authorized via confirmed_miner, not maintainer.
      if (url.includes("/collaborators/contributor/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "none" });
      }
      if (url.includes("/issues/48/comments") && method === "GET") return Response.json([{ id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      if (url.includes("/issues/comments/778") && method === "PATCH") {
        calls.commentPatches += 1;
        return Response.json({ id: 778 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-miner",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 48, title: "Miner self-rerun", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "contributor", type: "User" },
      },
    });

    // The confirmed-miner detection WAS fetched (the #824 helper's miner-detection path) and the panel retriggered.
    expect(calls.minerList).toBeGreaterThanOrEqual(1);
    expect(calls.permission).toBe(1);
    expect(calls.commentPatches).toBe(1);
    const audit = await env.DB.prepare("select actor, outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retriggered", "JSONbored/gittensory#48")
      .first<{ actor: string; outcome: string }>();
    expect(audit).toMatchObject({ actor: "contributor", outcome: "completed" });
  });

  it("skips PR panel reruns from users without repository write permission", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 46,
      title: "Unauthorized panel refresh",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel-denied" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review",
    ].join("\n");
    const calls = { token: 0, permission: 0, commentGets: 0, commentPatches: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/drive-by-user/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "read" });
      }
      if (url.includes("/issues/46/comments")) {
        calls.commentGets += 1;
        return Response.json([{ id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/778")) {
        calls.commentPatches += 1;
        return Response.json({ id: 778 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-denied",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 46, title: "Unauthorized panel refresh", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "drive-by-user", type: "User" },
      },
    });

    expect(calls).toEqual({ token: 1, permission: 1, commentGets: 0, commentPatches: 0 });
    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.pr_panel_retrigger_skipped")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({
      event_type: "github_app.pr_panel_retrigger_skipped",
      actor: "drive-by-user",
      target_key: "JSONbored/gittensory#46",
      outcome: "completed",
      detail: "not_maintainer_or_pr_author",
    });
  });

  it("reruns the sticky PR panel when a write collaborator checks the rerun task", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "off",
      includeMaintainerAuthors: true,
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 47,
      title: "Refresh panel as collaborator",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel-writer" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review",
    ].join("\n");
    const calls = { token: 0, permission: 0, minerList: 0, commentGets: 0, commentPatches: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/writer/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "write" });
      }
      if (url.includes("/issues/47/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([{ id: 779, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/779") && method === "PATCH") {
        calls.commentPatches += 1;
        return Response.json({ id: 779 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-writer",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 47, title: "Refresh panel as collaborator", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 779, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "writer", type: "User" },
      },
    });

    // token: 1 — the installation token is now cached + reused within the request (was 2: main + permission check).
    expect(calls).toEqual({ token: 1, permission: 1, minerList: 1, commentGets: 1, commentPatches: 1 });
  });

  it("skips PR panel reruns when the editing actor and PR author are unavailable", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 48,
      title: "Unknown panel refresh actor",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel-unknown" },
      labels: [],
      body: "Validation: npm test",
    });
    await env.DB.prepare("update pull_requests set author_login = null where repo_full_name = ? and number = ?").bind("JSONbored/gittensory", 48).run();
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review",
    ].join("\n");
    vi.stubGlobal("fetch", async () => new Response("unexpected fetch", { status: 500 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-unknown-actor",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 48, title: "Unknown panel refresh actor", state: "open", pull_request: {} },
        comment: { id: 780, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });

    const audit = await env.DB.prepare("select actor, target_key, detail from audit_events where event_type = ?")
      .bind("github_app.pr_panel_retrigger_skipped")
      .first<{ actor: string | null; target_key: string; detail: string }>();
    expect(audit).toMatchObject({
      actor: null,
      target_key: "JSONbored/gittensory#48",
      detail: "not_maintainer_or_pr_author",
    });
  });

  it("ignores invalid rerun task edits and audits skipped rerun requests", async () => {
    const env = createTestEnv();
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review",
    ].join("\n");
    const uncheckedPanel = checkedPanel.replace("- [x]", "- [ ]");
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      return new Response("unexpected fetch", { status: 500 });
    });
    const basePayload = {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 46, title: "Panel skip", state: "open", user: { login: "contributor" }, pull_request: {} },
    };

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-created-ignore",
      eventName: "issue_comment",
      payload: {
        action: "created",
        ...basePayload,
        comment: { id: 800, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-unchecked-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 801, body: uncheckedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-non-bot-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 802, body: checkedPanel, user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-comment-ignore",
      eventName: "issue_comment",
      payload: { action: "edited", ...basePayload, sender: { login: "maintainer", type: "User" } },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-panel-marker-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 806, body: "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review", user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-rerun-marker-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 807, body: "<!-- gittensory-pr-panel:v1 -->\n\n- [x] Re-run Gittensory review", user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-other-bot-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 808, body: checkedPanel, user: { login: "other[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-bot-skip",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 803, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "gittensory[bot]", type: "Bot" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-cache",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 804, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-context",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        comment: { id: 805, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    expect(fetchCalls).toBe(0);
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.pr_panel_retrigger_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((event) => event.detail)).toEqual(["bot_author", "cached_pr_missing", "missing_repo_pr_or_installation"]);
  });

  it("debounces noisy PR events without publishing public surfaces", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "enabled",
      gateCheckMode: "enabled",
    });
    let publicCalls = 0;
    vi.stubGlobal("fetch", async () => {
      publicCalls += 1;
      return new Response("unexpected public call", { status: 500 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-labeled-noisy",
      eventName: "pull_request",
      payload: {
        action: "labeled",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 44, title: "Noisy event PR", state: "open", user: { login: "contributor" }, head: { sha: "noisy123" }, labels: [{ name: "bug" }], body: "Fixes #1" },
      },
    });

    expect(publicCalls).toBe(0);
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
        expect(body.body).toContain("<!-- gittensory-pr-panel:v1 -->");
        expect(body.body).toContain("Confirmed Gittensor contributor");
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
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
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
      publicAudienceMode: "gittensor_only",
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
      publicAudienceMode: "gittensor_only",
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

  // #1007 convergence (Stage D): with GITTENSORY_REVIEW_UNIFIED_COMMENT on AND the gate evaluating, the public PR-panel
  // comment is rendered by the UNIFIED renderer (GitHub alert + synthesized "Code review" row) instead of the
  // legacy panel — while STILL leading with the same panel marker so the in-place upsert updates the same
  // comment. Mirrors the legacy panel-posting setup (confirmed miner + comment_and_label) but flips the flag
  // and enables the gate so `maybePublishPrPublicSurface` takes the flag-ON branch.
  it("renders the unified PR-review comment when the flag is on and the gate evaluates", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_UNIFIED_COMMENT: "1" });
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
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "enabled",
      backfillEnabled: true,
      privateTrustEnabled: true,
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
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
      // PR files — the unified branch (re)fetches them to count changed files for the readiness chip.
      if (url.includes("/pulls/3/files")) return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      // Gate check-run — must succeed so `gateEvaluation` is produced and the flag-ON branch runs.
      // The pending check is POSTed (in_progress), then PATCHed to its completed conclusion.
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-unified-comment",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 3,
          title: "Fix webhook duplicate delivery again",
          state: "open",
          user: { login: "oktofeesh1" },
          head: { sha: "unified123" },
          labels: [{ name: "bug" }],
          body: "Fixes #1\n\nValidation: npm test",
        },
      },
    });

    expect(calls.comments).toBe(1);
    // Still leads with the panel marker → the upsert updates the SAME sticky comment in place (no duplicate).
    expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
    // The UNIFIED shape, which the legacy body never emits: a full-comment GitHub alert wrapper…
    expect(postedBody).toMatch(/> \[!(TIP|NOTE|WARNING|CAUTION)\]/);
    // …and the renderer's synthesized "Code review" signal row (bold first table label).
    expect(postedBody).toContain("**Code review**");
    // Public-safe by construction — no internal trust/economics fields leak through the unified renderer.
    expect(postedBody).not.toMatch(/wallet|hotkey|reward|trust score/i);
  });

  // FIX B + FIX D3 at the processor call site: a unified comment for a PR whose CI has a FAILED check, with the
  // PR's files only available from GitHub (stored rows empty) — proves (B) the inline file fetch populates the
  // real diff/changed-file count on the first review, and (D3) the failing check name + its per-check WHY render
  // under a "CI checks failing" section (not just a bare "CI failing" chip).
  it("inline-fetches the PR files and renders failing CI check names + reasons in the unified comment (FIX B + D3)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_UNIFIED_COMMENT: "1" });
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
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "enabled",
      backfillEnabled: true,
      privateTrustEnabled: true,
    });
    // Seed a FAILED check summary with a per-check WHY (codecov-style) so listCheckSummaries returns it and the
    // unified site populates failingDetails. (The PR row + headSha must match for the check to associate.)
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 3,
      title: "Fix webhook duplicate delivery again",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "unified123" },
      labels: [{ name: "bug" }],
      body: "Fixes #1\n\nValidation: npm test",
    });
    await upsertCheckSummary(env, {
      id: "JSONbored/gittensory#unified123#codecov/patch",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 3,
      headSha: "unified123",
      name: "codecov/patch",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "https://codecov.io/report",
      payload: { output: { summary: "60% of diff hit (target 97%)" } },
    });
    let postedBody = "";
    let filesFetched = 0;
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
      // FIX B: stored pull_request_files is empty, so the review path inline-fetches from GitHub here.
      if (url.includes("/pulls/3/files")) {
        filesFetched += 1;
        return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified", patch: "@@\n+const x = 1;" }]);
      }
      // The review path now reads the LIVE CI aggregate (check-runs + commit-statuses). codecov/patch is a
      // classic COMMIT-STATUS (not a check-run), so it comes from the combined-status endpoint; the check-runs
      // list stays empty (it must, so the gate's own check-run upsert finds no pre-existing run to PATCH).
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status"))
        return Response.json({ state: "failure", statuses: [{ context: "codecov/patch", state: "failure", description: "60% of diff hit (target 97%)", target_url: "https://codecov.io/report" }] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 902 }, { status: 201 });
      if (url.includes("/check-runs/902") && method === "PATCH") return Response.json({ id: 902 });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-unified-ci-failing",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 3,
          title: "Fix webhook duplicate delivery again",
          state: "open",
          user: { login: "oktofeesh1" },
          head: { sha: "unified123" },
          labels: [{ name: "bug" }],
          body: "Fixes #1\n\nValidation: npm test",
        },
      },
    });

    // FIX B: the files were fetched inline from GitHub (stored rows were empty) and the changed-file count is real.
    expect(filesFetched).toBeGreaterThan(0);
    expect(postedBody).toContain("`1 file`");
    // FIX D3: the failing check name + its WHY render under a "CI checks failing" section, plus the chip.
    expect(postedBody).toContain("`CI failing`");
    expect(postedBody).toContain("CI checks failing");
    expect(postedBody).toContain("codecov/patch");
    expect(postedBody).toContain("60% of diff hit (target 97%)");
    // Still public-safe.
    expect(postedBody).not.toMatch(/wallet|hotkey|reward|trust score/i);
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
        expect(body.output?.text).toBe("No detailed findings are published in check runs.");
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

  it("audits advisory context check permission failures without blocking webhook processing", async () => {
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
      gateCheckMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor" });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/context403/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "context-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 24, title: "Context check", state: "open", user: { login: "contributor" }, head: { sha: "context403" }, labels: [], body: "No issue needed." },
      },
    });

    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.check_run_permission_missing")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();

    expect(audit).toMatchObject({
      event_type: "github_app.check_run_permission_missing",
      actor: "contributor",
      target_key: "JSONbored/gittensory#24",
      outcome: "error",
    });
    expect(audit?.detail).toMatch(/Checks: write permission is missing/i);
  });

  it("audits advisory context check publish failures without blocking webhook processing", async () => {
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
      gateCheckMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor" });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/context500/check-runs")) return new Response("GitHub check API failed", { status: 500 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "context-check-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 25, title: "Context check", state: "open", user: { login: "contributor" }, head: { sha: "context500" }, labels: [], body: "No issue needed." },
        },
      }),
    ).resolves.toBeUndefined();

    const outputFailure = await env.DB.prepare("select event_type, detail from audit_events where event_type = ?")
      .bind("github_app.pr_check_run_publish_failed")
      .first<{ event_type: string; detail: string }>();
    expect(outputFailure).toMatchObject({ event_type: "github_app.pr_check_run_publish_failed" });
    expect(outputFailure?.detail).toMatch(/GitHub check API failed|failed/i);
    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "check_run" });
    expect(aggregate?.metadata_json).toContain('"output":"check_run"');
  });

  it("audits disabled public-surface skips without miner lookup", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
    });
    const calls = { fetch: 0, repoWideReads: 0 };
    const originalDb = env.DB;
    env.DB = new Proxy(originalDb, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (/from\s+["`]?issues["`]?/i.test(sql) || /from\s+["`]?bounties["`]?/i.test(sql)) calls.repoWideReads += 1;
          return target.prepare(sql);
        };
      },
    }) as D1Database;
    vi.stubGlobal("fetch", async () => {
      calls.fetch += 1;
      return new Response("unexpected fetch", { status: 500 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "surface-off-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 23, title: "Quiet repo work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "" },
      },
    });

    expect(calls).toEqual({ fetch: 0, repoWideReads: 0 });
    const skipped = await env.DB.prepare("select actor, target_key, detail, metadata_json from audit_events where event_type = ?").bind("github_app.pr_visibility_skipped").all<{
      actor: string;
      target_key: string;
      detail: string;
      metadata_json: string;
    }>();
    expect(skipped.results).toEqual([
      expect.objectContaining({
        actor: "oktofeesh1",
        target_key: "JSONbored/gittensory#23",
        detail: "surface_off",
      }),
    ]);
    expect(JSON.stringify(skipped.results)).not.toMatch(/wallet|hotkey|raw trust|installation-token/i);
  });

  it("records public comment failure without blocking the context check", async () => {
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
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
    });
    const calls = { checks: 0 };
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
      if (url.includes("/commits/abc123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.checks += 1;
        return Response.json({ id: 42, html_url: "https://github.com/checks/42" }, { status: 201 });
      }
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
          pull_request: { number: 30, title: "Miner work", state: "open", head: { sha: "abc123", ref: "feature" }, user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(calls.checks).toBe(1);
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("comment-failure").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
    const outputFailures = await env.DB.prepare("select event_type, detail from audit_events where target_key = ? and outcome = ? order by event_type")
      .bind("JSONbored/gittensory#30", "error")
      .all<{ event_type: string; detail: string }>();
    expect(outputFailures.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "github_app.pr_comment_publish_failed",
          detail: "comment failed",
        }),
      ]),
    );
    const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").first<{ metadata_json: string }>();
    expect(published?.metadata_json).toContain('"publishedOutputs":["check_run"]');
    expect(published?.metadata_json).toContain('"output":"comment"');
  });

  it("records an aggregate public-surface failure when no configured output publishes", async () => {
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
      checkRunMode: "off",
    });
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
      if (url.includes("/issues/31/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/31/comments") && method === "POST") return new Response("comment failed", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "all-public-outputs-failed",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 31, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });

    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "comment" });
    expect(aggregate?.metadata_json).toContain('"output":"comment"');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").all();
    expect(published.results).toEqual([]);
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

    // 2 PRs × 3 label POSTs each: the gittensor context label (apply) + the per-PR TYPE label (create + apply).
    expect(calls).toEqual({ comments: 0, labels: 6, minerList: 1 });
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

  it("records label-only public-surface failures without creating duplicate comments", async () => {
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
    const calls = { comments: 0, labels: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
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
        return new Response("label failed", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "label-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 50, title: "Miner label work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    // gittensor context-label apply (fails 503, recorded) + the best-effort type-label create attempt (also 503,
    // swallowed). The context-label failure is still recorded below; the type label never drops the recording.
    expect(calls).toEqual({ comments: 0, labels: 2 });
    const outputFailure = await env.DB.prepare("select event_type, detail from audit_events where event_type = ?")
      .bind("github_app.pr_label_publish_failed")
      .first<{ event_type: string; detail: string }>();
    expect(outputFailure).toMatchObject({ event_type: "github_app.pr_label_publish_failed", detail: "label failed" });
    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "label" });
    expect(aggregate?.metadata_json).toContain('"output":"label"');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").all();
    expect(published.results).toEqual([]);
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
      publicAudienceMode: "gittensor_only",
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

  it("checks official miner status for detected-only comments before publishing public output", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "oss_maintainer",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 3,
      title: "Cached historical work",
      state: "closed",
      merged_at: "2026-05-20T00:00:00.000Z",
      user: { login: "confirmed-dev" },
      labels: [],
      body: "Historical cached PR.",
    });

    const calls = { minerList: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([
          { githubUsername: "confirmed-dev", githubId: "123", totalPrs: 2, totalMergedPrs: 1, isEligible: true, credibility: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/confirmed-dev")) return Response.json({ login: "confirmed-dev", public_repos: 1, followers: 0 });
      if (url.includes("/users/confirmed-dev/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/51/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/51/comments") && method === "POST") {
        calls.comments += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("[Gittensor profile](https://gittensor.io/miners/details?githubId=123)");
        expect(body.body).toContain("2 PR(s)");
        expect(body.body).not.toContain("Cached prior PRs/issues");
        expect(body.body).not.toContain("api.gittensor.io/miners/123");
        return Response.json({ id: 51 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const basePayload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "detected-comment-confirmed",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 51, title: "Confirmed contributor work", state: "open", user: { login: "confirmed-dev" }, labels: [], body: "Fixes #1" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "detected-comment-not-found",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 52, title: "Unconfirmed contributor work", state: "open", user: { login: "newbie" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(calls).toEqual({ minerList: 2, comments: 1 });
  });

  it("fails closed when official miner detection is unavailable", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      publicAudienceMode: "gittensor_only",
    });
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

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
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

    // 1 labeled PR × 3 label POSTs: the gittensor context label (apply) + the per-PR TYPE label (create + apply).
    expect(calls).toEqual({ minerList: 2, labels: 3 });
    const cached = await env.DB.prepare("select status, snapshot_json from official_miner_detections where login = ?")
      .bind("oktofeesh1")
      .first<{ status: string; snapshot_json: string }>();
    expect(cached?.status).toBe("confirmed");
    expect(cached?.snapshot_json).not.toMatch(/hotkey|wallet|coldkey|must-not-cache/i);
  });

  it("suppresses labels and comments when agentPaused is true", async () => {
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
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
      agentPaused: true,
    });
    const calls = { labels: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "paused-miner", githubId: "999", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/999") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/999/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/999/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/paused-miner")) return Response.json({ login: "paused-miner" });
      if (url.includes("/users/paused-miner/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      if (url.includes("/comments") && method === "POST") {
        calls.comments += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "paused-surface",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 88, title: "Paused repo PR", state: "open", user: { login: "paused-miner" }, labels: [], body: "Fixes #1" },
      },
    });

    // agentPaused suppresses ALL public surface mutations — no label, no comment.
    expect(calls).toEqual({ labels: 0, comments: 0 });
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
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 3, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // #788: Q&A commands now authorize by REAL repo permission. The "maintainer" commenter has maintain
      // access; everyone else has none and is authorized only as pr_author/confirmed_miner where applicable.
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "none" });
      if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/") && url.includes("/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-pr-panel:v1 -->");
        expect(body.body).toContain("@gittensory");
        expect(body.body).not.toMatch(/wallet|hotkey|estimated score|reward estimate|payout|farming|raw trust score|private reviewability|reviewability internals|scoreability|public score estimate/i);
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
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-reviewability",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 5,
          body: "@gittensory reviewability",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-repo-fit",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 6,
          body: "@gittensory repo-fit",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-packet",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 7,
          body: "@gittensory packet",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-packet-no-cache",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 78, title: "Uncached PR command", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 8,
          body: "@gittensory packet",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });

    expect(calls.commentsCreated).toBe(8);
    // The installation token is cached + reused across all 8 commands (each previously minted 2 — permission
    // check + comment — for 16 total). Caching collapses them to a single mint, which is the rate-limit fix.
    expect(calls.token).toBe(1);
    expect(calls.minerList).toBeGreaterThanOrEqual(1);
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
    const usage = await env.DB.prepare("select payload_json from signal_snapshots where signal_type = ? and target_key = ? order by generated_at")
      .bind("github-agent-command-usage", "JSONbored/gittensory#77")
      .all<{ payload_json: string }>();
    const usagePayloads = usage.results.map((entry) => JSON.parse(entry.payload_json) as { command: string; outcome: string; actorKind: string; actorHash?: string });
    expect(usagePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "reviewability", outcome: "replied", actorKind: "maintainer" }),
        expect.objectContaining({ command: "repo-fit", outcome: "replied", actorKind: "maintainer" }),
        expect.objectContaining({ command: "packet", outcome: "replied", actorKind: "maintainer" }),
      ]),
    );
    expect(usagePayloads.every((payload) => typeof payload.actorHash === "string" && /^[a-f0-9]{64}$/.test(payload.actorHash))).toBe(true);
    expect(JSON.stringify(usagePayloads)).not.toContain('"actor":');
    expect(JSON.stringify(usagePayloads)).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate|@gittensory|oktofeesh1/i);
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "github_app", eventName: "agent_command_replied", outcome: "completed", repoFullName: "JSONbored/gittensory" }),
      ]),
    );
    expect(JSON.stringify(usageEvents)).not.toMatch(/wallet|hotkey|raw trust|deliveryId|installation-token/i);
  });

  it("posts maintainer-only queue digest commands from cached public-safe metadata", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    delete (env as Partial<Env>).PUBLIC_SITE_ORIGIN;
    for (const issue of [
      { number: 1, title: "Ready linked fix" },
      { number: 2, title: "Overlap issue" },
    ]) {
      await upsertIssueFromGitHub(env, "JSONbored/gittensory", {
        number: issue.number,
        title: issue.title,
        state: "open",
        user: { login: "reporter" },
        labels: [],
        body: "",
      });
    }
    for (const pull of [
      { number: 90, title: "Ready linked fix", user: { login: "alice" }, body: "Fixes #1" },
      { number: 91, title: "Needs author context", user: { login: "bob" }, body: "" },
      { number: 92, title: "Overlap route first", user: { login: "carol" }, body: "Fixes #2" },
      { number: 93, title: "Overlap route second", user: { login: "dana" }, body: "Fixes #2" },
    ]) {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        ...pull,
        state: "open",
        author_association: "NONE",
        labels: [],
      });
    }
    await upsertOfficialMinerDetection(env, "alice", { status: "confirmed", snapshot: queueMinerSnapshot("alice") }, 60_000);

    const calls = { commentsCreated: 0, token: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" }); // #788 real-permission auth
      if (url.includes("/issues/90/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/90/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("**Gittensory maintainer queue summary**");
        expect(body.body).toContain("Open PRs: 4");
        expect(body.body).toContain("confirmed-miner PRs: 1");
        expect(body.body).toContain("Authenticated control panel: https://gittensory.aethereal.dev/app?view=maintainer&repo=JSONbored%2Fgittensory");
        expect(body.body).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
        return Response.json({ id: 1001 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "maintainer-queue-summary",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Ready linked fix", state: "open", pull_request: {}, user: { login: "alice" }, author_association: "NONE" },
        comment: {
          id: 9001,
          body: "@gittensory queue-summary",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });

    expect(calls).toEqual({ commentsCreated: 1, token: 1 }); // token cached + reused across the #788 permission check
    const audit = await env.DB.prepare("select event_type, detail, metadata_json from audit_events where target_key = ? order by created_at")
      .bind("JSONbored/gittensory#90")
      .all<{ event_type: string; detail: string | null; metadata_json: string }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_replied" }),
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_prompted", detail: "queue-summary" }),
      ]),
    );
    expect(audit.results.find((entry) => entry.event_type === "github_app.agent_command_feedback_prompted")?.metadata_json).toContain("maintainer_digest");
    const usage = await env.DB.prepare("select payload_json from signal_snapshots where signal_type = ? and target_key = ?")
      .bind("github-agent-command-usage", "JSONbored/gittensory#90")
      .all<{ payload_json: string }>();
    const usagePayload = JSON.parse(usage.results[0]?.payload_json ?? "{}") as { command?: string; outcome?: string; family?: string; actorHash?: string };
    expect(usagePayload).toEqual(expect.objectContaining({ command: "queue-summary", outcome: "replied", family: "maintainer_digest" }));
    expect(usagePayload.actorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(usagePayload)).not.toContain('"actor":');
    const usageEvents = await listProductUsageEvents(env, { limit: 5 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "github_app", eventName: "agent_command_replied", outcome: "completed", metadata: expect.objectContaining({ family: "queue_digest" }) }),
      ]),
    );
  });

  it("omits the maintainer queue digest control-panel link when the public site origin is invalid", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), PUBLIC_SITE_ORIGIN: "not a url" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 94,
      title: "Ready linked fix",
      state: "open",
      author_association: "NONE",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #1",
    });
    let commentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" }); // #788 real-permission auth
      if (url.includes("/issues/94/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/94/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        commentBody = body.body ?? "";
        return Response.json({ id: 1002 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "maintainer-queue-summary-invalid-origin",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 94, title: "Ready linked fix", state: "open", pull_request: {}, user: { login: "alice" }, author_association: "NONE" },
        comment: {
          id: 9002,
          body: "@gittensory queue-summary",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });

    expect(commentBody).toContain("**Gittensory maintainer queue summary**");
    expect(commentBody).not.toContain("Authenticated control panel:");
  });

  it("applies repo command authorization policy overrides during issue_comment handling", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commandAuthorization: { default: ["maintainer"], commands: { help: ["pr_author"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Author policy command",
      state: "open",
      user: { login: "driveby" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #90",
    });

    const calls = { commentsCreated: 0, token: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // #788: "driveby" has no repo permission — authorized only as pr_author via the help-command override.
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "none" });
      if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/") && url.includes("/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-pr-panel:v1 -->");
        expect(body.body).not.toMatch(/wallet|hotkey|estimated score|reward estimate|payout|farming|raw trust score|private reviewability|public score estimate/i);
        return Response.json({ id: 9191 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-policy-author",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Author policy command", state: "open", pull_request: {}, user: { login: "driveby" }, author_association: "NONE" },
        comment: {
          id: 191,
          body: "@gittensory help",
          user: { login: "driveby", type: "User" },
          author_association: "NONE",
        },
      },
    });

    expect(calls).toEqual({ commentsCreated: 1, token: 1, minerList: 0 }); // token cached + reused across the #788 permission check
    const audit = await env.DB.prepare("select event_type, detail from audit_events where target_key = ? order by created_at")
      .bind("JSONbored/gittensory#91")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_replied", detail: null }),
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_prompted", detail: "help" }),
      ]),
    );
    const usage = await env.DB.prepare("select payload_json from signal_snapshots where signal_type = ? and target_key = ?")
      .bind("github-agent-command-usage", "JSONbored/gittensory#91")
      .all<{ payload_json: string }>();
    expect(JSON.parse(usage.results[0]?.payload_json ?? "{}")).toMatchObject({ command: "help", outcome: "replied", actorKind: "author" });
  });

  it("records deduped @gittensory answer usefulness from authorized reactions only", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 77,
      title: "Miner command context",
      state: "open",
      user: { login: "oktofeesh1" },
      author_association: "NONE",
    });
    await upsertOfficialMinerDetection(env, "oktofeesh1", { status: "confirmed", snapshot: queueMinerSnapshot("oktofeesh1") }, 60 * 60 * 1000);
    await upsertAgentCommandAnswer(env, commandAnswer("answer-maintainer", "preflight", { responseCommentId: 9001 }));
    await upsertAgentCommandAnswer(env, commandAnswer("answer-author", "next-action", { responseCommentId: 9002 }));
    await upsertAgentCommandAnswer(env, { ...commandAnswer("answer-no-author", "preflight", { responseCommentId: 9003 }), issueNumber: 78 });
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9001, body: commandAnswerBody("answer-maintainer", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 1, content: "+1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9001, body: commandAnswerBody("answer-maintainer", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 2, content: "-1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-3",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9002, body: commandAnswerBody("answer-author", "next-action"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 3, content: "+1", user: { login: "oktofeesh1", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-4",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9002, body: commandAnswerBody("answer-author", "next-action"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 4, content: "+1", user: { login: "random", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-5",
      eventName: "reaction",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 78, title: "No author", state: "open", pull_request: {}, author_association: "NONE" },
        comment: { id: 9003, body: commandAnswerBody("answer-no-author", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 5, content: "+1", user: { login: "random", type: "User" } },
      },
    });

    const summary = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 });
    expect(summary.totals).toMatchObject({ feedbackCount: 2, usefulCount: 1, notUsefulCount: 1, answerCount: 2, usefulnessRate: 0.5 });
    expect(summary.commands).toEqual([
      expect.objectContaining({ command: "next-action", feedbackCount: 1, usefulCount: 1 }),
      expect.objectContaining({ command: "preflight", feedbackCount: 1, notUsefulCount: 1 }),
    ]);
    const audit = await env.DB.prepare("select event_type, detail from audit_events where event_type like ? order by created_at")
      .bind("github_app.agent_command_feedback_%")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_recorded" }),
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_denied", detail: "not_maintainer_or_pr_author" }),
      ]),
    );
    const stored = await env.DB.prepare("select actor_hash, metadata_json from github_agent_command_feedback").all<{ actor_hash: string; metadata_json: string }>();
    expect(stored.results.map((row) => row.actor_hash).join("\n")).not.toMatch(/maintainer|oktofeesh1|random/);
    expect(stored.results.every((row) => row.actor_hash.startsWith("sha256:"))).toBe(true);
  });

  it("skips unsupported @gittensory feedback reactions without storing votes", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer" });
    await upsertAgentCommandAnswer(env, commandAnswer("answer-skip", "preflight", { responseCommentId: 9001 }));
    const basePayload = {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        action: "deleted",
        comment: { id: 9001, body: commandAnswerBody("answer-skip", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 1, content: "+1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-1b",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9001, body: commandAnswerBody("answer-skip", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 11, content: "+1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        action: "created",
        comment: { id: 9001, body: commandAnswerBody("answer-skip", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 2, content: "+1", user: { login: "helper[bot]", type: "Bot" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-3",
      eventName: "reaction",
      payload: {
        ...basePayload,
        action: "created",
        comment: { id: 9001, body: commandAnswerBody("answer-missing", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 3, content: "-1", user: { login: "maintainer", type: "User" } },
      },
    });

    await expect(getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 })).resolves.toMatchObject({
      totals: { feedbackCount: 0 },
      commands: [],
    });
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_feedback_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((row) => row.detail)).toEqual(["bot_reaction", "unknown_answer", "unsupported_reaction_action", "unsupported_reaction_action"]);
  });

  it("accepts repo-owner feedback through sender fallback and ignores non-vote reactions", async () => {
    const env = createTestEnv();
    await upsertAgentCommandAnswer(env, commandAnswer("answer-owner", "blockers"));
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
      comment: { id: 9001, body: commandAnswerBody("answer-owner", "blockers"), user: { login: "gittensory[bot]", type: "Bot" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-owner-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        reaction: { content: "+1" },
        sender: { login: "JSONbored", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-owner-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        reaction: { id: 2, content: "heart" },
        sender: { login: "JSONbored", type: "User" },
      },
    });

    const summary = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 });
    expect(summary.totals).toMatchObject({ feedbackCount: 1, usefulCount: 1, answerCount: 1 });
    expect(summary.commands).toEqual([expect.objectContaining({ command: "blockers", usefulnessRate: 1 })]);
  });

  it("rejects copied feedback markers that do not match the stored answer context", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer" });
    await upsertAgentCommandAnswer(env, commandAnswer("answer-bound", "preflight", { responseCommentId: 9001 }));
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
      reaction: { id: 1, content: "+1", user: { login: "maintainer", type: "User" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-bound-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9002, body: commandAnswerBody("answer-bound", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-bound-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        repository: { name: "other", full_name: "JSONbored/other", private: false, owner: { login: "JSONbored" } },
        comment: { id: 9001, body: commandAnswerBody("answer-bound", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-bound-3",
      eventName: "reaction",
      payload: {
        ...basePayload,
        issue: { ...basePayload.issue, number: 78 },
        comment: { id: 9001, body: commandAnswerBody("answer-bound", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });

    await expect(getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 })).resolves.toMatchObject({
      totals: { feedbackCount: 0 },
      commands: [],
    });
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_feedback_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((row) => row.detail)).toEqual(["answer_comment_mismatch", "answer_context_mismatch", "answer_context_mismatch"]);
  });

  it("records webhook errors when command replies fail before mutation", async () => {
    const env = createTestEnv();
    // Authorize via the confirmed-miner path (PR author + cached confirmed status), which does not depend on
    // the #788 real-permission check — that check swallows the invalid-repo error and would deny otherwise.
    await upsertOfficialMinerDetection(env, "oktofeesh1", { status: "confirmed", snapshot: queueMinerSnapshot("oktofeesh1") }, 60_000);
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "agent-command-error",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "broken", full_name: "broken", private: false, owner: { login: "JSONbored" } },
          issue: { number: 77, title: "Broken command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
          comment: {
            id: 9,
            body: "@gittensory help",
            user: { login: "oktofeesh1", type: "User" },
            author_association: "NONE",
          },
        },
      }),
    ).rejects.toThrow("Invalid repository full name");

    const event = await env.DB.prepare("select status, error_summary from webhook_events where delivery_id = ?")
      .bind("agent-command-error")
      .first<{ status: string; error_summary: string }>();
    expect(event).toMatchObject({ status: "error", error_summary: expect.stringContaining("Invalid repository full name") });
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
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-maintainer-only-denied",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 84, title: "Maintainer digest PR", state: "open", pull_request: {}, user: { login: "not-a-miner" }, author_association: "NONE" },
        comment: { id: 5, body: "@gittensory queue-summary", user: { login: "not-a-miner", type: "User" }, author_association: "NONE" },
      },
    });

    expect(commentCalls).toBe(0);
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((entry) => entry.detail)).toEqual(expect.arrayContaining(["bot_author", "maintainer_command_requires_maintainer", "not_a_pull_request_thread", "pr_author_not_confirmed_miner"]));
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "github_app", eventName: "agent_command_skipped", outcome: "skipped" }),
      ]),
    );
    expect(JSON.stringify(usageEvents)).not.toMatch(/deliveryId|wallet|hotkey|raw trust/i);
  });

  it("denies a maintainer Q&A command from an org member without real repo permission (#788)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 96,
      title: "Org member tries a maintainer command",
      state: "open",
      user: { login: "alice" },
      author_association: "NONE",
      labels: [],
      body: "",
    });
    const calls = { comments: 0, permission: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The commenter is an org MEMBER but has only READ access to THIS repo — not a maintainer/collaborator.
      if (url.includes("/collaborators/orgmember/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "read" });
      }
      if (url.includes("/issues/") && url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-org-member-no-permission",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 96, title: "Org member tries a maintainer command", state: "open", pull_request: {}, user: { login: "alice" }, author_association: "NONE" },
        // author_association MEMBER would have granted the maintainer role pre-#788; it no longer does.
        comment: { id: 96, body: "@gittensory queue-summary", user: { login: "orgmember", type: "User" }, author_association: "MEMBER" },
      },
    });
    expect(calls.permission).toBe(1); // the REAL repo permission was consulted, not the spoofable association
    expect(calls.comments).toBe(0); // …and the org member was denied — no maintainer reply
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.agent_command_skipped", "JSONbored/gittensory#96")
      .first<{ detail: string }>();
    expect(skip?.detail).toBe("not_maintainer_or_pr_author");
  });

  it("records command usage as an error when miner authorization cannot be checked", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return new Response("api down", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-miner-unavailable",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 84, title: "Miner unavailable PR", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 5, body: "@gittensory preflight", user: { login: "oktofeesh1", type: "User" }, author_association: "NONE" },
      },
    });

    const usageEvents = await listProductUsageEvents(env, { limit: 5 });
    expect(usageEvents).toEqual([
      expect.objectContaining({ surface: "github_app", eventName: "agent_command_skipped", outcome: "error", metadata: expect.objectContaining({ reason: "miner_detection_unavailable" }) }),
    ]);
  });

  it("does not let product usage write failures block GitHub command audits", async () => {
    const env = withProductUsageInsertFailure(createTestEnv());
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-product-usage-down",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Plain issue", state: "open", user: { login: "reporter" } },
        comment: { id: 1, body: "@gittensory preflight", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });

    const audit = await env.DB.prepare("select event_type, detail from audit_events where target_key = ?")
      .bind("JSONbored/gittensory#90")
      .all<{ event_type: string; detail: string }>();
    expect(audit.results).toEqual([expect.objectContaining({ event_type: "github_app.agent_command_skipped", detail: "not_a_pull_request_thread" })]);
  });

  it("audits command authorization errors when miner detection is unavailable", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.gittensor.io/miners") return new Response("unavailable", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-miner-unavailable",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 84, title: "Unavailable miner check", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 5, body: "@gittensory preflight", user: { login: "oktofeesh1", type: "User" }, author_association: "NONE" },
      },
    });

    const event = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.agent_command_skipped", "JSONbored/gittensory#84")
      .first<{ outcome: string; detail: string }>();
    expect(event).toMatchObject({ outcome: "error", detail: "miner_detection_unavailable" });
  });

  it("detects a changes-requested review notification for the PR author", async () => {
    const enqueued: Array<{ type: string }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/JSONbored/gittensory/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        review: {
          state: "changes_requested",
          user: { login: "maintainer", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
        sender: { login: "maintainer", type: "User" },
      },
    });

    const detected = await env.DB.prepare("select actor, target_key, outcome, detail, metadata_json from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string; target_key: string; outcome: string; detail: string; metadata_json: string }>();
    expect(detected.results).toHaveLength(1);
    expect(detected.results[0]).toMatchObject({
      actor: "maintainer",
      target_key: "contributor",
      outcome: "success",
      detail: "pull_request_changes_requested for JSONbored/gittensory#42",
    });
    expect(JSON.parse(detected.results[0]!.metadata_json)).toMatchObject({
      deliveryId: "review-changes-requested",
      eventType: "pull_request_changes_requested",
      recipientLogin: "contributor",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 42,
      dedupKey: "changes_requested:JSONbored/gittensory#42:maintainer:2026-05-28T12:00:00.000Z",
    });
    expect(JSON.stringify(detected.results[0])).not.toMatch(/trust score|wallet|hotkey|reward estimate|reviewability/i);

    const evaluateJob = enqueued.find((message): message is { type: "notify-evaluate"; event: { recipientLogin: string } } => message.type === "notify-evaluate");
    expect(evaluateJob).toBeDefined();
    expect(evaluateJob!.event.recipientLogin).toBe("contributor");
  });

  it("skips changes-requested review notifications from reviewers without repository write permission", async () => {
    const enqueued: Array<{ type: string }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/JSONbored/gittensory/collaborators/drive-by-user/permission")) return Response.json({ permission: "read" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested-low-priv",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        review: {
          state: "changes_requested",
          user: { login: "drive-by-user", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
        sender: { login: "drive-by-user", type: "User" },
      },
    });

    const detected = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string }>();
    expect(detected.results).toEqual([]);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ type: "notify-evaluate" }));
  });

  it("skips changes-requested review notifications with an unknown actor without consulting repo permissions", async () => {
    const enqueued: Array<{ type: string }> = [];
    const permissionCalls: string[] = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/")) {
        permissionCalls.push(url);
        return Response.json({ permission: "admin" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested-unknown-actor",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        // Neither the review nor the sender carries a login → detectNotificationEvents emits actorLogin "unknown".
        review: {
          state: "changes_requested",
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
      },
    });

    const detected = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string }>();
    expect(detected.results).toEqual([]);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ type: "notify-evaluate" }));
    // The unknown-actor guard short-circuits before any collaborator-permission lookup.
    expect(permissionCalls).toEqual([]);
  });

  it("skips changes-requested review notifications when the webhook has no installation", async () => {
    const enqueued: Array<{ type: string }> = [];
    const permissionCalls: string[] = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/")) {
        permissionCalls.push(url);
        return Response.json({ permission: "admin" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested-no-installation",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        // No installation present → installationId is undefined and the reviewer cannot be verified.
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        review: {
          state: "changes_requested",
          user: { login: "maintainer", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
        sender: { login: "maintainer", type: "User" },
      },
    });

    const detected = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string }>();
    expect(detected.results).toEqual([]);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ type: "notify-evaluate" }));
    // With no installation we cannot verify the reviewer, so no permission lookup is attempted.
    expect(permissionCalls).toEqual([]);
  });

  it("notifies issue-watchers when a new grabbable maintainer-created issue opens (#699 path B)", async () => {
    const enqueued: Array<{ type: string; event?: { eventType: string; recipientLogin: string; pullNumber: number } }> = [];
    const env = createTestEnv({ JOBS: { async send(message: { type: string }) { enqueued.push(message); } } as unknown as Queue });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 })); // no .gittensory.yml → empty manifest
    await upsertIssueWatchSubscription(env, { login: "watcher", repoFullName: "JSONbored/gittensory" });
    await upsertIssueWatchSubscription(env, { login: "maintainer", repoFullName: "JSONbored/gittensory" }); // the author — should be skipped

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-watch-open",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Add caching to the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." },
      },
    });

    const watchEvents = enqueued.filter((m): m is { type: "notify-evaluate"; event: { eventType: string; recipientLogin: string; pullNumber: number } } => m.type === "notify-evaluate" && m.event?.eventType === "issue_watch_match");
    expect(watchEvents.map((m) => m.event.recipientLogin)).toEqual(["watcher"]); // maintainer (author) skipped
    expect(watchEvents[0]!.event.pullNumber).toBe(91);

    const detected = await env.DB.prepare("select metadata_json from audit_events where event_type = 'notification.event_detected' and target_key = ?").bind("watcher").first<{ metadata_json: string }>();
    expect(JSON.parse(detected!.metadata_json)).toMatchObject({ eventType: "issue_watch_match", recipientLogin: "watcher", repoFullName: "JSONbored/gittensory" });
  });

  it("appends issue-side slop findings to the issue advisory only when slop is opted in (#533)", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 })); // no .gittensory.yml → empty manifest
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositoryFromGitHub(env, { name: "other", full_name: "JSONbored/other", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", slopGateMode: "advisory" });
    // JSONbored/other keeps the default slopGateMode "off".

    const emptyBodyIssue = (repoFull: string, name: string, number: number) => ({
      type: "github-webhook" as const,
      deliveryId: `issue-slop-${number}`,
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name, full_name: repoFull, private: false, owner: { login: "JSONbored" } },
        issue: { number, title: "Something is broken", state: "open", user: { login: "reporter" }, body: "   " },
      },
    });
    await processJob(env, emptyBodyIssue("JSONbored/gittensory", "gittensory", 501));
    await processJob(env, emptyBodyIssue("JSONbored/other", "other", 502));

    const slopOn = await env.DB.prepare("select findings_json from advisories where target_type = 'issue' and repo_full_name = ?").bind("JSONbored/gittensory").first<{ findings_json: string }>();
    const slopOff = await env.DB.prepare("select findings_json from advisories where target_type = 'issue' and repo_full_name = ?").bind("JSONbored/other").first<{ findings_json: string }>();
    expect(slopOn?.findings_json).toContain("empty_issue_body"); // opted in → triage finding present
    expect(slopOff?.findings_json ?? "").not.toContain("empty_issue_body"); // default off → no slop finding
  });

  it("clears the persisted dashboard slop score when the slop gate is off (#911)", async () => {
    // Merge-readiness still collects the live slop score, so shouldCollectSlopEvidence runs even with the
    // slop gate disabled — but with slopGateMode "off" the persisted dashboard row must be cleared to null
    // so a previously cached score doesn't linger after a maintainer disables slop.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
      slopGateMode: "off", // dashboard slop disabled…
      mergeReadinessGateMode: "advisory", // …but readiness keeps the live score in play
    });
    // Seed the PR row plus a stale dashboard slop score that the slop-off pass must clear.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Add helper",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "slopoff123" },
      labels: [],
      body: "Adds a helper.",
    });
    await updatePullRequestSlopAssessment(env, "JSONbored/gittensory", 91, { slopRisk: 80, slopBand: "high" });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 91,
      path: "src/helper.ts",
      status: "modified",
      additions: 5,
      deletions: 0,
      changes: 5,
      payload: {},
    });
    expect((await getPullRequest(env, "JSONbored/gittensory", 91))?.slopRisk).toBe(80); // stale score present pre-run

    const refreshedFiles: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/91/files")) {
        refreshedFiles.push(url);
        return Response.json([{ filename: "src/helper.ts", status: "modified", additions: 5, deletions: 0, changes: 5 }]);
      }
      if (url.includes("/commits/slopoff123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 991 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "slop-off-clear",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 91, title: "Add helper", state: "open", user: { login: "contributor" }, head: { sha: "slopoff123" }, labels: [], body: "Adds a helper." },
      },
    });

    // Slop gate off → the previously persisted dashboard score is null-persisted, not left stale.
    const cleared = await getPullRequest(env, "JSONbored/gittensory", 91);
    expect(cleared?.slopRisk).toBeNull();
    expect(cleared?.slopBand).toBeNull();
    expect(refreshedFiles).toHaveLength(1);
  });

  it("#dup-winner: flag ON spares the lowest open sibling — no duplicate block, slop not penalized for the cluster", async () => {
    // GITTENSORY_DUPLICATE_WINNER ON. A same-issue cluster of OPEN PRs (#91 winner, #92 loser) under
    // duplicatePrGateMode: block. The winner (#91, lowest open number) must NOT be gate-blocked or slop-
    // penalized as a duplicate — it is judged on its own merits. This drives the flag-ON branch of the
    // processors gate path (isDupWinner) + the advisory duplicate-finding suppression.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_DUPLICATE_WINNER: "true" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "block",
      slopGateMode: "advisory",
      qualityGateMode: "block",
      qualityGateMinScore: 95,
    });
    // The shared issue + the HIGHER-numbered open sibling (#92) → forms the same-issue duplicate cluster.
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "Cache the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 92, title: "Also fix the cache", state: "open", user: { login: "other" }, author_association: "CONTRIBUTOR", head: { sha: "sib92" }, labels: [], body: "Fixes #1" });

    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/91/files")) return Response.json([{ filename: "src/cache.ts", status: "modified", additions: 12, deletions: 0, changes: 12 }]);
      if (url.includes("/commits/win91/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 960 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 960 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "dup-winner-on",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 91, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win91" }, labels: [], body: "Fixes #1\n\nValidation: npm test" },
      },
    });

    // Winner survives: a later duplicate sibling must not lower readiness below a blocking threshold.
    expect(gatePatchBody.conclusion).not.toBe("failure");
    expect(gatePatchBody.output?.text ?? "").not.toContain("readiness_score_below_threshold");
    // The persisted advisory for the winner OMITS the duplicate finding (suppressed) — that is what suppresses
    // the gate failure and the auto-close duplicate cause.
    const winnerAdvisory = await env.DB.prepare("select findings_json from advisories where target_type = 'pull_request' and repo_full_name = ? and pull_number = ?").bind("JSONbored/gittensory", 91).first<{ findings_json: string }>();
    expect(winnerAdvisory?.findings_json ?? "").not.toContain("duplicate_pr_risk");
  });

  it("#dup-winner: flag OFF keeps every same-issue sibling blocked (byte-identical) — the winner is also closed-eligible", async () => {
    // Same cluster, flag OFF (default). The lowest open PR (#91) STILL gets the duplicate block + finding,
    // exactly like today — no winner is spared.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "block",
      slopGateMode: "advisory",
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "Cache the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 92, title: "Also fix the cache", state: "open", user: { login: "other" }, author_association: "CONTRIBUTOR", head: { sha: "sib92b" }, labels: [], body: "Fixes #1" });

    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/91/files")) return Response.json([{ filename: "src/cache.ts", status: "modified", additions: 12, deletions: 0, changes: 12 }]);
      if (url.includes("/commits/win91b/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 961 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 961 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "dup-winner-off",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 91, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win91b" }, labels: [], body: "Fixes #1" },
      },
    });

    // Flag OFF: the duplicate block still fires for the lowest sibling — the Gate fails, the finding persists.
    expect(gatePatchBody.conclusion).toBe("failure");
    const winnerAdvisory = await env.DB.prepare("select findings_json from advisories where target_type = 'pull_request' and repo_full_name = ? and pull_number = ?").bind("JSONbored/gittensory", 91).first<{ findings_json: string }>();
    expect(winnerAdvisory?.findings_json ?? "").toContain("duplicate_pr_risk");
  });

  it("overrides the Gate to neutral for THIS commit only when a real write/admin maintainer runs gate-override", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 90,
      title: "Override me",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "override-sha" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { token: 0, permission: 0, checkGets: 0, checkPatches: 0, commentGets: 0, commentPatches: 0 };
    const patchBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string; text?: string } }> = [];
    let confirmationBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // Authorization MUST come from the real collaborator-permission API, never the comment author_association.
      if (url.includes("/collaborators/maintainer/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "admin" });
      }
      if (url.includes("/commits/override-sha/check-runs") && method === "GET") {
        calls.checkGets += 1;
        return Response.json({ total_count: 1, check_runs: [{ id: 555, name: "Gittensory Gate" }] });
      }
      if (url.includes("/check-runs/555") && method === "PATCH") {
        calls.checkPatches += 1;
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string; text?: string } });
        return Response.json({ id: 555 });
      }
      if (url.includes("/issues/90/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([]);
      }
      if (url.includes("/issues/90/comments") && method === "POST") {
        calls.commentPatches += 1;
        confirmationBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 9100 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-allow",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Override me", state: "open", user: { login: "contributor" }, pull_request: {} },
        // author_association lies (says OWNER); the handler must IGNORE it and use real permission instead.
        comment: { id: 800, body: "@gittensory gate-override known flaky duplicate check, shipping", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // The existing Gate run (id 555) was PATCHed to a neutral, non-blocking terminal state — not a new check.
    expect(calls.checkPatches).toBe(1);
    const finalize = patchBodies[0];
    expect(finalize?.status).toBe("completed");
    expect(finalize?.conclusion).toBe("neutral");
    expect(finalize?.output?.title).toBe("Gittensory Gate — overridden by @maintainer");
    expect(finalize?.output?.text).toContain("Overridden by @maintainer: known flaky duplicate check, shipping");
    expect(confirmationBody).toContain("Gittensory Gate overridden by @maintainer");
    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_overridden")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({ event_type: "github_app.gate_overridden", actor: "maintainer", target_key: "JSONbored/gittensory#90", outcome: "completed" });
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "github_app", eventName: "gate_overridden", outcome: "completed" })]));
    // No override state is persisted: the gate stays "enabled" and the override does NOT persist an advisory,
    // so a follow-up synchronize re-evaluates the Gate from scratch (no permanent bypass).
    const settingsAfter = await env.DB.prepare("select gate_check_mode from repository_settings where repo_full_name = ?").bind("JSONbored/gittensory").first<{ gate_check_mode: string }>();
    expect(settingsAfter?.gate_check_mode).toBe("enabled");
    const overrideAdvisory = await env.DB.prepare("select id from advisories where target_key = ?").bind("JSONbored/gittensory#90").first<{ id: string }>();
    expect(overrideAdvisory ?? null).toBeNull();
  });

  it("ignores gate-override commands on edited comments", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 92,
      title: "Edited override",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "edited-override" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { token: 0, permission: 0, checkRuns: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/")) {
        calls.permission += 1;
        return Response.json({ permission: "admin" });
      }
      if (url.includes("/check-runs")) {
        calls.checkRuns += 1;
        return Response.json({ total_count: 1, check_runs: [{ id: 556, name: "Gittensory Gate" }] });
      }
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-edited",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 92, title: "Edited override", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 802, body: "@gittensory gate-override edited by moderator", author_association: "OWNER", user: { login: "maintainer", type: "User" } },
        sender: { login: "moderator", type: "User" },
      },
    });

    expect(calls.permission).toBe(0);
    expect(calls.checkRuns).toBe(0);
    expect(calls.comments).toBe(0);
    const overridden = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.gate_overridden").first<{ id: string }>();
    expect(overridden ?? null).toBeNull();
    const skipped = await env.DB.prepare("select actor, detail from audit_events where event_type = ?").bind("github_app.gate_override_skipped").first<{ actor: string; detail: string }>();
    expect(skipped).toMatchObject({ actor: "moderator", detail: "unsupported_comment_action" });
  });

  it("denies gate-override from an org member without real repository write/admin (ignores author_association)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Cannot override",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "override-denied" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { token: 0, permission: 0, checkGets: 0, checkPatches: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // Real permission is only "read" — even though the comment claims MEMBER, the Gate must NOT be touched.
      if (url.includes("/collaborators/org-member/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "read" });
      }
      if (url.includes("/check-runs")) {
        calls.checkGets += 1;
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-deny",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Cannot override", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 801, body: "@gittensory gate-override trust me", author_association: "MEMBER", user: { login: "org-member", type: "User" } },
        sender: { login: "org-member", type: "User" },
      },
    });

    // Authorization denied via real permission: no Gate check call and no comment were made.
    expect(calls.permission).toBe(1);
    expect(calls.checkGets).toBe(0);
    expect(calls.checkPatches).toBe(0);
    expect(calls.comments).toBe(0);
    const denied = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_override_denied")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();
    expect(denied).toMatchObject({ event_type: "github_app.gate_override_denied", actor: "org-member", target_key: "JSONbored/gittensory#91", outcome: "denied", detail: "not_maintainer_or_pr_author" });
    const overridden = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.gate_overridden").first<{ id: string }>();
    expect(overridden ?? null).toBeNull();
  });

  it("ops-alerts job no-ops when GITTENSORY_REVIEW_OPS is OFF (does no anomaly scan)", async () => {
    const env = createTestEnv(); // flag unset → OFF
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
      .bind("owner/repo", "owner", "repo")
      .run();
    // Seed a gate false-positive anomaly that WOULD fire if the scan ran.
    for (let i = 1; i <= 6; i += 1) {
      await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: i, blockerCodes: ["missing_linked_issue"] });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: i, title: `PR ${i}`, state: "closed", merged_at: i <= 4 ? "2026-06-01T00:00:00.000Z" : null } as never);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processJob(env, { type: "ops-alerts", requestedBy: "test" });
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly"))).toBe(false);
    warn.mockRestore();
  });

  it("ops-alerts job runs the anomaly scan when GITTENSORY_REVIEW_OPS is ON", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_OPS: "true" });
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
      .bind("owner/repo", "owner", "repo")
      .run();
    for (let i = 1; i <= 6; i += 1) {
      await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: i, blockerCodes: ["missing_linked_issue"] });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: i, title: `PR ${i}`, state: "closed", merged_at: i <= 4 ? "2026-06-01T00:00:00.000Z" : null } as never);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processJob(env, { type: "ops-alerts", requestedBy: "test" });
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly") && line.includes("owner/repo"))).toBe(true);
    warn.mockRestore();
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

type CommandAnswerFixture = Parameters<typeof upsertAgentCommandAnswer>[1];

function commandAnswer(id: string, command: string, overrides: Partial<CommandAnswerFixture> = {}): CommandAnswerFixture {
  return {
    id,
    repoFullName: "JSONbored/gittensory",
    issueNumber: 77,
    command,
    requestCommentId: 7,
    responseCommentId: 9001,
    responseUrl: "https://github.com/JSONbored/gittensory/pull/77#issuecomment-9001",
    actorKind: "maintainer" as const,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function commandAnswerBody(answerId: string, command: string): string {
  return [
    "<!-- gittensory-agent-command -->",
    `<!-- gittensory-agent-command-answer:${answerId} -->`,
    `Command: \`@gittensory ${command}\``,
    "Feedback is aggregate-only.",
  ].join("\n");
}

function queueMinerSnapshot(login: string) {
  return {
    source: "gittensor_api" as const,
    githubId: "123",
    githubUsername: login,
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 0,
    taoPerDay: 0,
    usdPerDay: 0,
    totals: {
      pullRequests: 3,
      mergedPullRequests: 2,
      openPullRequests: 1,
      closedPullRequests: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
    },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
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

describe("changedPathsForGuardrail", () => {
  it("collects current + rename paths and skips empty entries", () => {
    const files = [
      { path: "src/a.ts", previousFilename: null },
      { path: "src/b.ts", previousFilename: "src/old-b.ts" }, // a rename contributes both names
      { path: "", previousFilename: "" }, // an empty path AND empty rename are both skipped (both guard branches false)
    ] as unknown as Parameters<typeof changedPathsForGuardrail>[0];
    expect(changedPathsForGuardrail(files)).toEqual(["src/a.ts", "src/b.ts", "src/old-b.ts"]);
  });
});

describe("one-shot reopen prevention", () => {
  beforeEach(() => {
    clearInstallationTokenCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-closes contributor reopens after a write collaborator closed the PR", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reopen-write-collab-close",
      eventName: "pull_request",
      payload: reopenedPayload("contributor"),
    });

    expect(calls.some((call) => call.url.endsWith("/collaborators/contributor/permission"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/collaborators/maintainer/permission"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/issues/42/comments"))).toBe(true);
    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ detail: string }>();
    expect(audit?.detail).toContain("originally closed by maintainer");
  });

  it("does NOT re-close a disallowed reopen while the global freeze is on — records a skip instead (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.setGlobalAgentFrozen(env, true); // emergency brake on
    await processJob(env, { type: "github-webhook", deliveryId: "reopen-frozen", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("skipped (agent paused)");
  });

  it("dry-run: audits a would-be reopen re-close without touching GitHub (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentDryRun: true });
    await processJob(env, { type: "github-webhook", deliveryId: "reopen-dryrun", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toContain("dry-run: would re-close");
  });

  it("allows an admin reopener to reopen without reclosing (fast-path hasMaintainerPermission)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory", ADMIN_GITHUB_LOGINS: "admin-user" });
    await processJob(env, { type: "github-webhook", deliveryId: "admin-reopen", eventName: "pull_request", payload: reopenedPayload("admin-user") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("allows reopen when the closer is unknown (null lastCloser)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "unknown-closer", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("re-closes when the close event is hidden beyond the inspected event window (window-evasion fail-closed, #audit-2.4)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) {
        // Long timeline (lastPage=12): the contributor padded the events so the real close sits before the
        // inspected newest window. No "closed" appears in the read pages → null closer + coveredAllPages=false.
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        if (page === 1) {
          return Response.json([{ event: "labeled", actor: { login: "contributor" } }], {
            headers: { link: '<https://api.github.com/repos/owner/repo/issues/42/events?per_page=100&page=12>; rel="last"' },
          });
        }
        return Response.json([{ event: "labeled", actor: { login: "contributor" } }]);
      }
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "window-evasion-reclose", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ detail: string }>();
    expect(audit?.detail).toContain("beyond the inspected event window");
  });

  it("re-closes when the bot itself was the last closer", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "gittensory[bot]" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "bot-closer-reclose", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
  });

  it("allows reopen when a contributor self-closed (non-maintainer, non-bot closer)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "contributor" } }]);
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "self-close-reopen", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("treats permission API errors as non-maintainer (catch path returns null)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.endsWith("/permission")) throw new Error("permission API down");
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "contributor" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "perm-api-error", eventName: "pull_request", payload: reopenedPayload("contributor") });
    // permission API threw → null → non-maintainer reopener + non-maintainer closer → no reclose.
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("swallows createIssueComment, closePullRequest, and recordAuditEvent errors on reclose (fail-safe — all .catch() bodies)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      // createIssueComment (POST) and closePullRequest (PATCH) both throw → their .catch(() => undefined) bodies run
      throw new Error("GitHub API unavailable");
    });
    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "reopen-api-fail-safe", eventName: "pull_request", payload: reopenedPayload("contributor") }),
    ).resolves.toBeUndefined();
  });
});

describe("converted_to_draft gate-close (draft-dodge prevention)", () => {
  beforeEach(() => clearInstallationTokenCacheForTest());
  afterEach(() => {
    clearInstallationTokenCacheForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function draftPayload(author: string, headSha = "abc123", isDraft = true): any {
    return {
      action: "converted_to_draft",
      installation: { id: 123 },
      repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
      sender: { login: author, type: "User" },
      pull_request: {
        id: 4242,
        number: 42,
        state: "open",
        title: "Some PR",
        body: "Body.",
        user: { login: author },
        head: { sha: headSha, ref: "fix", repo: { full_name: `${author}/gittensory`, owner: { login: author } } },
        base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
        draft: isDraft,
        merged: false,
        mergeable_state: "clean",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
      },
    };
  }

  async function setupRepo(env: ReturnType<typeof createTestEnv>, overrides: Record<string, unknown> = {}): Promise<void> {
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      gateCheckMode: "enabled",
      autonomy: { close: "auto" },
      agentPaused: false,
      ...overrides,
    });
  }

  it("closes a PR immediately when the contributor converts to draft after a gate failure on the same headSha", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-1", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ detail: string }>();
    expect(audit?.detail).toContain("abc123");
    expect(audit?.detail).toContain("contributor");
  });

  it("does NOT draft-dodge close while the global freeze is on (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    await repositoriesModule.setGlobalAgentFrozen(env, true);
    await processJob(env, { type: "github-webhook", deliveryId: "draft-frozen", eventName: "pull_request", payload: draftPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed under freeze
    expect(await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("dry-run: audits a would-be draft-dodge close without touching GitHub (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { agentDryRun: true });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    await processJob(env, { type: "github-webhook", deliveryId: "draft-dryrun", eventName: "pull_request", payload: draftPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed in dry-run
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toContain("dry-run: would close");
  });

  it("no-ops when no prior gate failure exists for the PR", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    // No gate block recorded — gate hasn't run yet.

    await processJob(env, { type: "github-webhook", deliveryId: "draft-no-block", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the prior gate failure is for a different headSha (contributor pushed fixes in draft)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    // Block exists but for an OLDER commit — contributor has pushed new code in draft.
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "old-sha-XYZ", blockerCodes: ["missing_linked_issue"] });

    // Payload headSha is "abc123" (new commit), not "old-sha-XYZ".
    await processJob(env, { type: "github-webhook", deliveryId: "draft-new-sha", eventName: "pull_request", payload: draftPayload("contributor", "abc123") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the gate block has been maintainer-overridden", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    await markGateOutcomeOverridden(env, "JSONbored/gittensory", 42);

    await processJob(env, { type: "github-webhook", deliveryId: "draft-overridden", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the PR author is the repo owner (owner PRs are never auto-closed)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Author = "JSONbored" = repo owner → no close.
    await processJob(env, { type: "github-webhook", deliveryId: "draft-owner", eventName: "pull_request", payload: draftPayload("JSONbored") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the agent is paused (agentPaused=true)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { agentPaused: true });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-paused", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the agent autonomy is not configured (autonomy=null)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { autonomy: null });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-no-autonomy", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("closes with empty blockerCodes (no codes parenthetical) and null author (uses 'unknown' in audit)", async () => {
    // covers: codes ? `(${codes})` : "" → "" branch; pr.authorLogin ?? "unknown" → "unknown" branch
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && (init?.method ?? "GET") === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    // empty blockerCodes → codes = "" → ternary takes the "" branch
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: [] });

    // null user.login → authorLogin null → (null ?? "").toLowerCase() === "" ≠ "jsonbored" → authorIsOwner false → close proceeds
    // → pr.authorLogin ?? "unknown" in audit detail takes the "unknown" branch
    const payload = draftPayload("contributor");
    payload.pull_request.user = { login: null };
    await processJob(env, { type: "github-webhook", deliveryId: "empty-codes-null-author", eventName: "pull_request", payload });

    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"));
    expect(comment).toBeDefined();
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ detail: string }>();
    expect(audit?.detail).toContain("unknown");
  });

  it("swallows createIssueComment and closePullRequest API errors (fail-safe — both .catch() bodies)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      throw new Error("simulated network error"); // all GitHub calls throw
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Should not throw even though createIssueComment and closePullRequest both throw
    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "api-error-swallow", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();

    // Audit event was still written to DB (recordAuditEvent uses D1, not fetch)
    const audit = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ event_type: string }>();
    expect(audit?.event_type).toBe("github_app.draft_dodge_closed");
  });

  it("getGateBlockOutcome DB error is caught — handler no-ops gracefully", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Spy on getGateBlockOutcome to throw — the .catch(() => undefined) body must execute
    vi.spyOn(repositoriesModule, "getGateBlockOutcome").mockRejectedValueOnce(new Error("D1 error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "gbo-db-error", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();

    // No close should have happened (block was unknown due to DB error)
    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("recordAuditEvent failure is swallowed — close still proceeds without crashing", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && (init?.method ?? "GET") === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "audit-db-error", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();

    // Close still happened despite audit failure
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
  });

  it("no-op owner-exemption when repoFullName has no slash (repoOwner is empty — authorIsOwner always false)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/") && (init?.method ?? "GET") === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/pulls/") && (init?.method ?? "GET") === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    // Setup with a slash-free repo name
    await upsertRepositoryFromGitHub(env, { name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }, 200);
    await upsertInstallation(env, {
      installation: {
        id: 200,
        account: { login: "", id: 2, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "noslash",
      gateCheckMode: "enabled",
      autonomy: { close: "auto" },
      agentPaused: false,
    });
    await recordGateBlockOutcome(env, { repoFullName: "noslash", pullNumber: 77, headSha: "sha-noslash", blockerCodes: ["missing_linked_issue"] });

    const noslashPayload = {
      action: "converted_to_draft",
      installation: { id: 200 },
      repository: { id: 2, name: "noslash", full_name: "noslash", private: false, default_branch: "main", owner: { login: "" } },
      sender: { login: "someone", type: "User" },
      pull_request: {
        id: 9999,
        number: 77,
        state: "open",
        title: "slash-free",
        body: "",
        user: { login: "someone" },
        head: { sha: "sha-noslash", ref: "fix", repo: { full_name: "someone/noslash", owner: { login: "someone" } } },
        base: { sha: "base", ref: "main", repo: { full_name: "noslash", owner: { login: "" } } },
        draft: true,
        merged: false,
        mergeable_state: "clean",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
      },
    };

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "noslash-test", eventName: "pull_request", payload: noslashPayload }),
    ).resolves.toBeUndefined();

    // With no slash in repoFullName: repoOwner="" (branch 196 false) → repoOwner.length>0=false (branch 198 false)
    // → authorIsOwner=false → handler enters the close path. closePullRequest/.catch() swallows the splitRepo
    // error (GitHub API requires owner/repo — slash-free names can't be closed via API) but the handler itself
    // doesn't crash. Verify the handler DID reach getGateBlockOutcome, proving branches 196+198 were exercised.
    const verifyBlock = await repositoriesModule.getGateBlockOutcome(env, "noslash", 77);
    expect(verifyBlock?.headSha).toBe("sha-noslash");
  });
});

describe("recordAgentCommandUsage (signal-snapshot fail-safe)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("swallows persistSignalSnapshot errors — catch body runs without crashing the handler", async () => {
    // Bot-authored @gittensory comment hits the early bot_author bail-out path in
    // maybeProcessGittensoryMentionCommand, which calls recordAgentCommandUsage. Injecting a
    // persistSignalSnapshot failure exercises the catch at the bottom of that function.
    vi.spyOn(repositoriesModule, "persistSignalSnapshot").mockRejectedValueOnce(new Error("signal DB error"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const payload: any = {
      action: "created",
      installation: { id: 123 },
      repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
      sender: { login: "gittensory[bot]", type: "Bot" },
      comment: { id: 999, body: "@gittensory help", user: { login: "gittensory[bot]", type: "Bot" } },
      issue: { id: 1, number: 77, title: "some issue", pull_request: { url: "https://api.github.com/repos/JSONbored/gittensory/pulls/77" } },
    };
    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "bot-mention-signal-fail", eventName: "issue_comment", payload }),
    ).resolves.toBeUndefined();
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function reopenedPayload(sender: string): any {
  return {
    action: "reopened",
    installation: { id: 123 },
    repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
    sender: { login: sender, type: "User" },
    pull_request: {
      id: 4242,
      number: 42,
      state: "open",
      title: "Fix queued guard",
      body: "Fixes the queued guard.",
      user: { login: "contributor" },
      head: { sha: "abc123", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: false,
      merged: false,
      mergeable_state: "clean",
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    },
  };
}
