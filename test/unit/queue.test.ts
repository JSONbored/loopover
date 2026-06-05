import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  getRepository,
  listUpstreamDriftReports,
  listInstallationHealth,
  listProductUsageDailyRollups,
  listProductUsageEvents,
  listPullRequests,
  listRepoSyncStates,
  listSignalSnapshots,
  persistSignalSnapshot,
  recordProductUsageEvent,
  upsertAgentCommandAnswer,
  upsertIssueFromGitHub,
  upsertRepoSyncSegment,
  upsertInstallation,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  upsertRepositorySettings,
  upsertRepositoryFromGitHub,
} from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("queue processors", () => {
  // Freshness-SLO fixtures are dated relative to late May 2026; pin the clock so staleness windows
  // stay deterministic regardless of when CI runs.
  beforeEach(() => {
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

  it("publishes an opt-in gate check without requiring comment output", async () => {
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
        expect(body).toMatchObject({ name: "Gittensory Gate", status: "completed", conclusion: "success", output: { title: "Gittensory Gate passed" } });
        calls.gateChecks += 1;
        return Response.json({ id: 900 });
      }
      return new Response("not found", { status: 404 });
    });

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

    expect(calls).toEqual({ minerList: 0, gateChecks: 2 });
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

    expect(calls).toEqual({ gateWrites: 1, commentGets: 1, commentPosts: 0 });
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
    const calls = { fetch: 0 };
    vi.stubGlobal("fetch", async () => {
      calls.fetch += 1;
      return new Response("unexpected fetch", { status: 500 });
    });

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

    expect(calls.fetch).toBe(0);
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

    expect(calls).toEqual({ comments: 0, labels: 1 });
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
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 3, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
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
    expect(calls.token).toBe(8);
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

    expect(calls).toEqual({ commentsCreated: 1, token: 1 });
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

    expect(calls).toEqual({ commentsCreated: 1, token: 1, minerList: 0 });
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
            user: { login: "maintainer", type: "User" },
            author_association: "OWNER",
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
