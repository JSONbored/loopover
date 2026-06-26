import { describe, expect, it } from "vitest";
import {
  getContributorScoringProfile,
  listDigestSubscriptionsForLogin,
  listProductUsageDailyRollups,
  listProductUsageEvents,
  recordAiUsageEvent,
  recordProductUsageEvent,
  rollupProductUsageDaily,
  getProductUsageRollupStatus,
  summarizeProductUsageEvents,
  upsertDigestSubscription,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("product usage events", () => {
  it("hashes actors and sessions before persistence", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    const recorded = await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      actor: "Oktofeesh1",
      sessionId: "gts_session_secret",
      route: "/v1/app/commands/preview",
      repoFullName: "oktofeesh1/private-tool",
      targetKey: "Oktofeesh1:private-tool#136",
      outcome: "success",
      clientName: "Oktofeesh1-mcp",
      clientVersion: "0.3.0+Oktofeesh1",
      metadata: { command: "packet", viewer: "Oktofeesh1", nested: { note: "for oktofeesh1" } },
    });

    expect(recorded.actorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.actorHash).not.toBe(recorded.sessionHash);

    const [row] = await listProductUsageEvents(env);
    expect(row).toBeDefined();
    if (!row) throw new Error("expected product usage event");
    expect(row).toMatchObject({
      surface: "control_panel",
      role: "unknown",
      eventName: "command_previewed",
      route: "/v1/app/commands/preview",
      repoFullName: "<redacted-actor>/private-tool",
      targetKey: "<redacted-actor>:private-tool#136",
      clientName: "<redacted-actor>-mcp",
      clientVersion: "0.3.0+<redacted-actor>",
      metadata: { command: "packet", viewer: "<redacted-actor>", nested: { note: "for <redacted-actor>" } },
    });
    expect(JSON.stringify(row)).not.toMatch(/Oktofeesh1|gts_session_secret/i);
  });

  it("redacts short actor names from persisted telemetry without corrupting unrelated words", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "local_branch_analysis_completed",
      actor: "ab",
      repoFullName: "ab/private-tool",
      targetKey: "ab:private-tool#139",
      metadata: {
        viewer: "ab",
        note: "for ab, but cabin stays readable",
        "ab": "owner key redacted too",
      },
    });

    const [row] = await listProductUsageEvents(env);
    expect(row).toBeDefined();
    if (!row) throw new Error("expected product usage event");
    expect(row.repoFullName).toBe("<redacted-actor>/private-tool");
    expect(row.targetKey).toBe("<redacted-actor>:private-tool#139");
    expect(row.metadata).toMatchObject({
      viewer: "<redacted-actor>",
      note: "for <redacted-actor>, but cabin stays readable",
      "<redacted-actor>": "owner key redacted too",
    });
    expect(JSON.stringify(row)).not.toMatch(/"ab"|\bab\/|\bab:|for ab\b/i);
  });

  it("redacts short actor components from metadata keys and camelCase values", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "local_branch_analysis_completed",
      actor: "bob",
      repoFullName: "bob/private-tool",
      targetKey: "bob:JSONbored/gittensory:feature-x",
      metadata: {
        viewer: "bob",
        note: "for bob, but bobcat stays readable",
        bobKey: "owner key redacted too",
        nested: { forBob: "bob owns this" },
      },
    });

    const [row] = await listProductUsageEvents(env);
    expect(row).toBeDefined();
    if (!row) throw new Error("expected product usage event");
    expect(row.repoFullName).toBe("<redacted-actor>/private-tool");
    expect(row.targetKey).toBe("<redacted-actor>:JSONbored/gittensory:feature-x");
    expect(row.metadata).toMatchObject({
      viewer: "<redacted-actor>",
      note: "for <redacted-actor>, but bobcat stays readable",
      "<redacted-actor>Key": "owner key redacted too",
      nested: { "for<redacted-actor>": "<redacted-actor> owns this" },
    });
    expect(row.metadata).not.toHaveProperty("bobKey");
    expect(JSON.stringify(row)).not.toMatch(/\bbob\b|bobKey|forBob/i);
  });

  it("bounds actor redaction patterns while still covering long valid handles", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const actor = "a".repeat(200);

    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "local_branch_analysis_completed",
      actor,
      repoFullName: `${actor}/private-tool`,
      targetKey: `${actor}:private-tool#139`,
      metadata: { viewer: actor },
    });

    const [row] = await listProductUsageEvents(env);
    expect(row).toBeDefined();
    if (!row) throw new Error("expected product usage event");
    expect(row.repoFullName).toBe("<redacted-actor>/private-tool");
    expect(row.targetKey).toBe("<redacted-actor>:private-tool#139");
    expect(row.metadata).toMatchObject({ viewer: "<redacted-actor>" });
    expect(JSON.stringify(row)).not.toContain(actor);
  });

  it("redacts sensitive metadata before it reaches D1", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "local_branch_analysis_completed",
      actor: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      targetKey: "JSONbored/gittensory#136",
      metadata: {
        command: "packet",
        authorization: "Bearer github_pat_secret",
        token: "ghp_1234567890abcdef",
        body: "source code should never be analytics metadata",
        diff: "+ private patch",
        cwd: "/Users/example/private/project",
        nested: {
          localPath: "/Users/example/private/project/file.ts",
          rootPath: "/root/work/private/project/file.ts",
          varPath: "/var/log/private/app.log",
          values: ["see /Users/example/private/file.ts", "github_pat_1234567890abcdef"],
          safe: "kept",
        },
        trustScore: 1,
        note: "No raw trust or wallet data here.",
      },
    });

    const [row] = await listProductUsageEvents(env);
    expect(row).toBeDefined();
    if (!row) throw new Error("expected product usage event");
    expect(row.metadata).toMatchObject({
      command: "packet",
      nested: { values: ["see <redacted-path>", "<redacted-token>"], safe: "kept" },
      note: "<redacted>",
    });
    expect(row.metadata).not.toHaveProperty("authorization");
    expect(row.metadata).not.toHaveProperty("token");
    expect(row.metadata).not.toHaveProperty("body");
    expect(row.metadata).not.toHaveProperty("diff");
    expect(row.metadata).not.toHaveProperty("cwd");
    expect(JSON.stringify(row.metadata)).not.toMatch(/\/Users|\/root\/|\/var\/|github_pat|ghp_|source code|private patch|trustScore|wallet/i);
  });

  it("persists normalized role on the event row and strips private scoreability metadata", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    const recorded = await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      role: "maintainer",
      actor: "oktofeesh1",
      metadata: {
        role: "owner",
        privateScoreability: "must not persist",
        reviewability: "private context",
        farming: "optimization tactic",
        prompt: "raw prompt text",
        sourceContents: "file contents",
      },
    });

    expect(recorded.role).toBe("maintainer");
    const [row] = await listProductUsageEvents(env);
    expect(row?.role).toBe("maintainer");
    expect(row?.metadata).not.toHaveProperty("privateScoreability");
    expect(row?.metadata).not.toHaveProperty("reviewability");
    expect(row?.metadata).not.toHaveProperty("farming");
    expect(row?.metadata).not.toHaveProperty("prompt");
    expect(row?.metadata).not.toHaveProperty("sourceContents");
    expect(JSON.stringify(row)).not.toMatch(/wallet|hotkey|raw trust|reward estimate|farming|privateScoreability|reviewability/i);
  });

  it("infers miner role for MCP usage when role is omitted", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const recorded = await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_tool_called",
      actor: "miner-user",
      metadata: { toolName: "gittensory_get_repo_context" },
    });
    expect(recorded.role).toBe("miner");
  });

  it("does not use API credentials as hash salt fallback", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "", GITTENSORY_API_TOKEN: "private-api-token" });

    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "credential_salt_regression",
      actor: "oktofeesh1",
      sessionId: "session-id",
    });

    const [row] = await listProductUsageEvents(env);
    expect(row).toMatchObject({ actorHash: null, sessionHash: null });
  });

  it("normalizes invalid event fields and bounds unusual metadata shapes", async () => {
    const env = createTestEnv({ GITTENSORY_API_TOKEN: "" });
    await recordProductUsageEvent(env, {
      surface: "invalid" as never,
      eventName: "",
      actor: "no-salt-user",
      sessionId: "no-salt-session",
      outcome: "unknown" as never,
      latencyMs: Number.NaN,
      clientName: "mcp-client Bearer abcdefghijklmnop",
      clientVersion: "/Users/example/.local/bin/tool",
      metadata: {
        nothing: undefined,
        callback: () => "ignore",
        symbol: Symbol("ignore"),
        nil: null,
        enabled: true,
        finite: 4,
        infinite: Number.POSITIVE_INFINITY,
        big: BigInt(42),
        at: new Date("2026-05-31T00:00:00.000Z"),
        list: [1, undefined, "Bearer abcdefghijklmnop", Number.NaN],
        deep: { a: { b: { c: { d: "truncated" } } } },
        "": "dropped",
        keyed: { "": "dropped", dropped: undefined, callback: () => "ignore", kept: "ok" },
      },
    });

    const [row] = await listProductUsageEvents(env, { sinceIso: "2026-01-01T00:00:00.000Z" });
    expect(row).toBeDefined();
    if (!row) throw new Error("expected product usage event");
    expect(row).toMatchObject({
      surface: "api",
      eventName: "unknown",
      outcome: "success",
      actorHash: null,
      sessionHash: null,
      latencyMs: null,
      clientName: "mcp-client Bearer <redacted-token>",
      clientVersion: "<redacted-path>",
    });
    expect(row.metadata).toMatchObject({
      nil: null,
      enabled: true,
      finite: 4,
      infinite: null,
      big: "42",
      at: "2026-05-31T00:00:00.000Z",
      list: [1, "Bearer <redacted-token>", null],
      deep: { a: { b: { c: "[truncated]" } } },
      keyed: { kept: "ok" },
    });
    expect(row.metadata).not.toHaveProperty("nothing");
    expect(row.metadata).not.toHaveProperty("callback");
    expect(row.metadata).not.toHaveProperty("symbol");
    expect(Object.prototype.hasOwnProperty.call(row.metadata, "")).toBe(false);
    expect(row.metadata.keyed).toEqual({ kept: "ok" });
  });

  it("accepts the full product surface and outcome catalogs", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const surfaces = ["api", "mcp", "github_app", "control_panel", "browser_extension", "internal"] as const;
    const outcomes = ["success", "denied", "error", "queued", "completed", "skipped"] as const;

    for (const [index, surface] of surfaces.entries()) {
      await recordProductUsageEvent(env, {
        surface,
        eventName: `surface_${surface}`,
        outcome: outcomes[index],
        metadata: { surface },
      });
    }

    const events = await listProductUsageEvents(env, { limit: 10 });
    expect(events.map((event) => event.surface)).toEqual(expect.arrayContaining([...surfaces]));
    expect(events.map((event) => event.outcome)).toEqual(expect.arrayContaining([...outcomes]));
  });

  it("keeps adjacent persistence parser fallbacks covered", async () => {
    const env = createTestEnv();
    await expect(getContributorScoringProfile(env, "missing-user")).resolves.toBeNull();
    await upsertDigestSubscription(env, { login: "oktofeesh1", email: "paused@example.com", status: "paused" });
    await expect(listDigestSubscriptionsForLogin(env, "oktofeesh1")).resolves.toEqual([
      expect.objectContaining({ status: "paused", email: "paused@example.com" }),
    ]);
    await expect(
      recordAiUsageEvent(env, {
        feature: "test",
        model: "none",
        status: "skipped",
        estimatedNeurons: -4,
      }),
    ).resolves.toBeUndefined();
  });

  it("summarizes recent events without counting stale records", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_tool_called",
      actor: "oktofeesh1",
      outcome: "success",
      occurredAt: "2026-05-31T00:00:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "agent_command_replied",
      actor: "repo-owner",
      outcome: "completed",
      occurredAt: "2026-05-31T12:00:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "stale_event",
      actor: "old-user",
      outcome: "success",
      occurredAt: "2026-05-01T00:00:00.000Z",
    });

    const summary = await summarizeProductUsageEvents(env, "2026-05-30T00:00:00.000Z");
    expect(summary).toMatchObject({ totalEvents: 2, activeActors: 2 });
    expect(summary.bySurface).toEqual(
      expect.arrayContaining([
        { surface: "mcp", count: 1 },
        { surface: "github_app", count: 1 },
      ]),
    );
    expect(summary.byOutcome).toEqual(expect.arrayContaining([{ outcome: "success", count: 1 }, { outcome: "completed", count: 1 }]));
    expect(summary.byEvent).toEqual(expect.arrayContaining([{ eventName: "mcp_tool_called", count: 1 }, { eventName: "agent_command_replied", count: 1 }]));

    const fullSummary = await summarizeProductUsageEvents(env);
    expect(fullSummary).toMatchObject({ totalEvents: 3, activeActors: 3, since: undefined });
    expect(fullSummary.bySurface).toEqual(
      expect.arrayContaining([
        { surface: "mcp", count: 1 },
        { surface: "github_app", count: 1 },
        { surface: "api", count: 1 },
      ]),
    );
  });

  it("builds idempotent daily activation rollups and absorbs late events", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const day = "2026-05-30";
    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "auth_session_created",
      actor: "oktofeesh1",
      outcome: "success",
      occurredAt: `${day}T01:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "oktofeesh1",
      outcome: "success",
      route: "/mcp",
      metadata: { rpcMethod: "tools/list" },
      occurredAt: `${day}T01:05:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "agent_pr_packet_completed",
      actor: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      outcome: "success",
      route: "/v1/agent/prepare-pr-packet",
      metadata: { command: "packet" },
      occurredAt: `${day}T01:10:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "github_installation_created",
      actor: "repo-owner",
      repoFullName: "JSONbored/gittensory",
      outcome: "completed",
      metadata: { action: "created" },
      occurredAt: `${day}T02:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "agent_command_replied",
      actor: "repo-owner",
      repoFullName: "JSONbored/gittensory",
      outcome: "completed",
      metadata: { command: "blockers", actorKind: "maintainer" },
      occurredAt: `${day}T02:05:00.000Z`,
    });

    await expect(getProductUsageRollupStatus(env, { nowIso: "2026-05-31T00:00:00.000Z" })).resolves.toMatchObject({
      status: "incomplete",
      missingDays: [day],
    });

    const firstRun = await rollupProductUsageDaily(env, { day, nowIso: "2026-05-31T00:10:00.000Z" });
    expect(firstRun.rollups).toHaveLength(1);
    expect(firstRun.rollups[0]).toMatchObject({
      day,
      status: "complete",
      totalEvents: 5,
      activeActors: 2,
      activeRepos: 1,
      activation: {
        loginActors: 1,
        doctorPassActors: 1,
        firstUsefulActionActors: 2,
        fullyActivatedActors: 1,
        githubInstalledRepos: 1,
        githubFirstCommandRepos: 1,
        githubUsefulMaintainerRepos: 1,
        githubActivatedRepos: 1,
      },
    });
    expect(firstRun.rollups[0]?.byCommand).toEqual(expect.arrayContaining([{ key: "blockers", count: 1 }, { key: "packet", count: 1 }]));
    expect(firstRun.rollups[0]?.byTool).toEqual([]);
    expect(firstRun.rollups[0]?.byRouteClass).toEqual(expect.arrayContaining([{ key: "agent", count: 1 }, { key: "mcp", count: 1 }]));

    const secondRun = await rollupProductUsageDaily(env, { day, nowIso: "2026-05-31T00:20:00.000Z" });
    expect(secondRun.rollups[0]?.totalEvents).toBe(5);
    await expect(listProductUsageDailyRollups(env)).resolves.toHaveLength(1);

    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      actor: "late-user",
      repoFullName: "JSONbored/gittensory",
      outcome: "success",
      metadata: { command: "reviewability" },
      occurredAt: `${day}T23:55:00.000Z`,
    });
    await expect(getProductUsageRollupStatus(env, { nowIso: "2026-05-31T00:25:00.000Z" })).resolves.toMatchObject({
      status: "stale",
      staleDays: [day],
    });
    const lateRun = await rollupProductUsageDaily(env, { day, nowIso: "2026-05-31T00:30:00.000Z" });
    expect(lateRun.rollups[0]).toMatchObject({
      totalEvents: 6,
      activeActors: 3,
      sourceEventCount: 6,
      activation: expect.objectContaining({ firstUsefulActionActors: 3 }),
    });
    await expect(listProductUsageDailyRollups(env)).resolves.toEqual([expect.objectContaining({ day, totalEvents: 6 })]);
    await expect(getProductUsageRollupStatus(env, { nowIso: "2026-05-31T00:40:00.000Z" })).resolves.toMatchObject({ status: "ready", warnings: [] });
  });

  it("retains low-frequency bounded events in byEvent on a high-diversity day (no top-20 truncation)", async () => {
    const env = createTestEnv();
    const day = "2026-05-30";
    // 20 distinct filler events, each recorded twice (count 2), occupy the highest-frequency slots.
    for (let i = 0; i < 20; i++) {
      const eventName = `filler_event_${String(i).padStart(2, "0")}`;
      await recordProductUsageEvent(env, { surface: "control_panel", eventName, actor: "user", outcome: "success", occurredAt: `${day}T00:00:00.000Z` });
      await recordProductUsageEvent(env, { surface: "control_panel", eventName, actor: "user", outcome: "success", occurredAt: `${day}T01:00:00.000Z` });
    }
    // A low-frequency flagship event the weekly report looks up by exact name (count 1, ranks 21st).
    await recordProductUsageEvent(env, { surface: "control_panel", eventName: "agent_pr_packet_completed", actor: "user", outcome: "success", occurredAt: `${day}T05:00:00.000Z` });

    const run = await rollupProductUsageDaily(env, { day, nowIso: "2026-05-31T00:10:00.000Z" });
    // Without the fix, byEvent was frequency-truncated to the top 20 and dropped this event.
    expect(run.rollups[0]?.byEvent).toEqual(expect.arrayContaining([{ eventName: "agent_pr_packet_completed", count: 1 }]));
    expect((run.rollups[0]?.byEvent ?? []).length).toBe(21);
  });

  it("builds empty role and retention rollups for days without product usage", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const result = await rollupProductUsageDaily(env, { day: "2026-06-01", nowIso: "2026-06-02T00:00:00.000Z" });

    expect(result.rollups[0]).toMatchObject({
      day: "2026-06-01",
      status: "complete",
      totalEvents: 0,
      activeActors: 0,
      byRole: [],
      activationByRole: [],
      activationBySurface: [],
      retention: [
        { window: "previous_7_days", capped: false, activeActors: 0, retainedActors: 0, retentionRate: 0, byRole: [], bySurface: [] },
        { window: "previous_30_days", capped: false, activeActors: 0, retainedActors: 0, retentionRate: 0, byRole: [], bySurface: [] },
      ],
    });
  });

  it("recomputes single-role retention rollups when late product usage makes a day stale", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const day = "2026-06-12";
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "agent_pr_packet_completed",
      actor: "single-miner",
      outcome: "success",
      metadata: { role: "miner" },
      occurredAt: "2026-06-05T12:00:00.000Z",
    });
    await rollupProductUsageDaily(env, { day: "2026-06-05", nowIso: "2026-06-06T00:00:00.000Z" });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "agent_pr_packet_completed",
      actor: "single-miner",
      outcome: "success",
      metadata: { role: "miner" },
      occurredAt: `${day}T01:00:00.000Z`,
    });

    const firstRun = await rollupProductUsageDaily(env, { day, nowIso: "2026-06-13T00:00:00.000Z" });
    expect(firstRun.rollups[0]).toMatchObject({
      byRole: [{ role: "miner", count: 1, activeActors: 1, activeRepos: 0 }],
      activationByRole: [expect.objectContaining({ role: "miner", firstUsefulActionActors: 1 })],
      activationBySurface: [expect.objectContaining({ surface: "api", firstUsefulActionActors: 1 })],
      retention: expect.arrayContaining([
        expect.objectContaining({
          window: "previous_7_days",
          activeActors: 1,
          retainedActors: 1,
          byRole: [{ role: "miner", activeActors: 1, retainedActors: 1, retentionRate: 1 }],
        }),
      ]),
    });

    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "github_installation_created",
      actor: "late-owner",
      repoFullName: "JSONbored/gittensory",
      outcome: "completed",
      occurredAt: `${day}T23:00:00.000Z`,
    });
    await expect(getProductUsageRollupStatus(env, { nowIso: "2026-06-13T00:10:00.000Z" })).resolves.toMatchObject({ status: "stale", staleDays: [day] });

    const rerun = await rollupProductUsageDaily(env, { day, nowIso: "2026-06-13T00:20:00.000Z" });
    expect(rerun.rollups[0]).toMatchObject({
      totalEvents: 2,
      activeActors: 2,
      byRole: expect.arrayContaining([
        { role: "miner", count: 1, activeActors: 1, activeRepos: 0 },
        { role: "owner", count: 1, activeActors: 1, activeRepos: 1 },
      ]),
      retention: expect.arrayContaining([
        expect.objectContaining({
          window: "previous_7_days",
          activeActors: 2,
          retainedActors: 1,
          retentionRate: 0.5,
          byRole: expect.arrayContaining([
            { role: "miner", activeActors: 1, retainedActors: 1, retentionRate: 1 },
            { role: "owner", activeActors: 1, retainedActors: 0, retentionRate: 0 },
          ]),
        }),
      ]),
    });
    expect(JSON.stringify(rerun.rollups[0])).not.toMatch(/single-miner|late-owner|fixed-test-salt/i);
  });

  it("normalizes explicit role metadata variants into aggregate buckets", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const day = "2026-06-14";
    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      actor: "multi-role-actor",
      outcome: "success",
      metadata: {
        roles: [
          "miners",
          "maintainers",
          "owner",
          "owners",
          "repo-owner",
          "repo owners",
          "repository-owner",
          "repository owners",
          "operator",
          "operators",
          "author",
          "contributors",
          "outside contributor",
          "outside-contributors",
          "unknown",
        ],
      },
      occurredAt: `${day}T01:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      actor: "reviewer-actor",
      outcome: "success",
      metadata: { actorKind: "reviewer" },
      occurredAt: `${day}T02:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      actor: "none-actor",
      outcome: "success",
      metadata: { audience: "none" },
      occurredAt: `${day}T03:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "command_previewed",
      actor: "invalid-role-actor",
      outcome: "success",
      metadata: { role: "not-a-product-role" },
      occurredAt: `${day}T04:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "pr_public_surface_published",
      actor: "public-surface-actor",
      outcome: "success",
      occurredAt: `${day}T05:00:00.000Z`,
    });

    const result = await rollupProductUsageDaily(env, { day, nowIso: "2026-06-15T00:00:00.000Z" });

    expect(result.rollups[0]?.byRole).toEqual(
      expect.arrayContaining([
        { role: "owner", count: 1, activeActors: 1, activeRepos: 0 },
        { role: "operator", count: 1, activeActors: 1, activeRepos: 0 },
        { role: "miner", count: 1, activeActors: 1, activeRepos: 0 },
        { role: "contributor", count: 2, activeActors: 2, activeRepos: 0 },
        { role: "maintainer", count: 2, activeActors: 2, activeRepos: 0 },
        { role: "unknown", count: 3, activeActors: 3, activeRepos: 0 },
      ]),
    );
    expect(JSON.stringify(result.rollups[0])).not.toMatch(/multi-role-actor|reviewer-actor|none-actor|invalid-role-actor|public-surface-actor|fixed-test-salt/i);
  });

  it("builds role activation and coarse retention rollups without exposing actors", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const day = "2026-06-10";
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "miner-retained",
      outcome: "success",
      metadata: { role: "miner" },
      occurredAt: "2026-06-04T12:00:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "agent_command_replied",
      actor: "maintainer-retained",
      outcome: "completed",
      metadata: { command: "blockers", actorKind: "maintainer" },
      occurredAt: "2026-06-06T12:00:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "control_panel",
      eventName: "auth_session_created",
      actor: "miner-retained",
      outcome: "success",
      metadata: { role: "miner" },
      occurredAt: `${day}T01:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "miner-retained",
      outcome: "success",
      metadata: { role: "miner" },
      occurredAt: `${day}T01:05:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "agent_pr_packet_completed",
      actor: "miner-retained",
      outcome: "success",
      metadata: { role: "miner" },
      occurredAt: `${day}T01:10:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "agent_command_replied",
      actor: "maintainer-retained",
      repoFullName: "JSONbored/gittensory",
      outcome: "completed",
      metadata: { command: "blockers", actorKind: "maintainer" },
      occurredAt: `${day}T02:00:00.000Z`,
    });
    await recordProductUsageEvent(env, {
      surface: "github_app",
      eventName: "github_installation_created",
      actor: "new-owner",
      repoFullName: "JSONbored/gittensory",
      outcome: "completed",
      occurredAt: `${day}T03:00:00.000Z`,
    });

    const result = await rollupProductUsageDaily(env, { day, nowIso: "2026-06-11T00:00:00.000Z" });

    expect(result.rollups[0]).toMatchObject({
      day,
      totalEvents: 5,
      activeActors: 3,
      byRole: expect.arrayContaining([
        { role: "miner", count: 3, activeActors: 1, activeRepos: 0 },
        { role: "maintainer", count: 1, activeActors: 1, activeRepos: 1 },
        { role: "owner", count: 1, activeActors: 1, activeRepos: 1 },
      ]),
      activationByRole: expect.arrayContaining([
        expect.objectContaining({ role: "miner", loginActors: 1, doctorPassActors: 1, firstUsefulActionActors: 1, fullyActivatedActors: 1 }),
        expect.objectContaining({ role: "maintainer", githubUsefulMaintainerRepos: 1 }),
        expect.objectContaining({ role: "owner", githubInstalledRepos: 1 }),
      ]),
      activationBySurface: expect.arrayContaining([
        expect.objectContaining({ surface: "mcp", doctorPassActors: 1 }),
        expect.objectContaining({ surface: "github_app", githubInstalledRepos: 1, githubUsefulMaintainerRepos: 1 }),
      ]),
      retention: expect.arrayContaining([
        expect.objectContaining({
          window: "previous_7_days",
          activeActors: 3,
          retainedActors: 2,
          retentionRate: 0.6667,
          capped: false,
          byRole: expect.arrayContaining([
            { role: "miner", activeActors: 1, retainedActors: 1, retentionRate: 1 },
            { role: "maintainer", activeActors: 1, retainedActors: 1, retentionRate: 1 },
            { role: "owner", activeActors: 1, retainedActors: 0, retentionRate: 0 },
          ]),
          bySurface: expect.arrayContaining([
            { surface: "mcp", activeActors: 1, retainedActors: 1, retentionRate: 1 },
            { surface: "github_app", activeActors: 2, retainedActors: 1, retentionRate: 0.5 },
          ]),
        }),
      ]),
    });
    expect(JSON.stringify(result.rollups[0])).not.toMatch(/miner-retained|maintainer-retained|new-owner|fixed-test-salt/i);
  });

  it("classifies rollup route classes and rejects failed activation signals", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const day = "2026-05-27";
    const routeFixtures = [
      { eventName: "health_ping", route: "/health", actor: "health-user", outcome: "success" },
      { eventName: "auth_session_created", route: "/v1/auth/session", actor: "auth-user", outcome: "success" },
      { eventName: "mcp_request", route: "/mcp", actor: "mcp-user", outcome: "error" },
      { eventName: "command_previewed", route: "/v1/app/commands/preview", actor: "panel-user", outcome: "success", metadata: { command: "packet" } },
      { eventName: "agent_pr_packet_completed", route: "/v1/agent/prepare-pr-packet", actor: "denied-agent", outcome: "denied", metadata: { command: "packet" } },
      { eventName: "pull_context_viewed", route: "/v1/extension/pull-context", actor: "extension-user", outcome: "success" },
      { eventName: "github_installation_created", route: "/v1/github/webhook", actor: "github-user", outcome: "completed" },
      { eventName: "repair_data_fidelity_completed", route: "/v1/internal/jobs/repair-data-fidelity", actor: "internal-user", outcome: "completed" },
      { eventName: "repo_snapshot_opened", route: "/v1/repos/JSONbored/gittensory", actor: "repo-user", outcome: "success" },
      { eventName: "api_report_viewed", route: "/v1/reports/summary", actor: "api-user", outcome: "success", metadata: { toolName: "summary" } },
      { eventName: "route_missing", actor: "unknown-user", outcome: "success" },
    ] as const;
    for (const [index, fixture] of routeFixtures.entries()) {
      await recordProductUsageEvent(env, {
        surface: "api",
        eventName: fixture.eventName,
        actor: fixture.actor,
        route: "route" in fixture ? fixture.route : undefined,
        outcome: fixture.outcome,
        metadata: "metadata" in fixture ? fixture.metadata : undefined,
        occurredAt: `${day}T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }

    const result = await rollupProductUsageDaily(env, { day, nowIso: "2026-05-28T00:00:00.000Z" });

    expect(result.rollups[0]).toMatchObject({
      day,
      status: "complete",
      totalEvents: routeFixtures.length,
      activation: {
        loginActors: 1,
        doctorPassActors: 0,
        firstUsefulActionActors: 2,
        fullyActivatedActors: 0,
        githubInstalledRepos: 0,
        githubFirstCommandRepos: 0,
        githubUsefulMaintainerRepos: 0,
        githubActivatedRepos: 0,
      },
    });
    expect(result.rollups[0]?.byRouteClass).toEqual(
      expect.arrayContaining([
        { key: "agent", count: 1 },
        { key: "api", count: 1 },
        { key: "auth", count: 1 },
        { key: "browser_extension", count: 1 },
        { key: "control_panel", count: 1 },
        { key: "github_app", count: 1 },
        { key: "health", count: 1 },
        { key: "internal", count: 1 },
        { key: "mcp", count: 1 },
        { key: "repository", count: 1 },
        { key: "unknown", count: 1 },
      ]),
    );
    expect(result.rollups[0]?.byTool).toEqual([{ key: "summary", count: 1 }]);
    expect(JSON.stringify(result.rollups[0])).not.toMatch(/health-user|denied-agent|fixed-test-salt/i);
  });

  it("normalizes rollup windows and corrupted persisted rollup rows", async () => {
    const env = createTestEnv();

    const clampedLow = await rollupProductUsageDaily(env, { days: 0, nowIso: "2026-05-27T12:00:00.000Z" });
    expect(clampedLow.rollups.map((rollup) => rollup.day)).toEqual(["2026-05-27"]);
    expect(clampedLow.rollups[0]?.status).toBe("partial");

    const clampedHigh = await rollupProductUsageDaily(env, { days: 99, nowIso: "2026-05-27T12:00:00.000Z" });
    expect(clampedHigh.rollups).toHaveLength(31);
    expect(clampedHigh.rollups[0]?.day).toBe("2026-04-27");
    expect(clampedHigh.rollups.at(-1)?.day).toBe("2026-05-27");

    const invalidDay = await rollupProductUsageDaily(env, { day: "not-a-day", nowIso: "2026-05-27T12:00:00.000Z" });
    expect(invalidDay.rollups[0]?.day).toBe("2026-05-27");

    const invalidGeneratedAt = await rollupProductUsageDaily(env, { day: "not-a-day", nowIso: "not-an-iso" });
    expect(invalidGeneratedAt.requestedDays[0]).toBe(invalidGeneratedAt.rollups[0]?.day);
    expect(invalidGeneratedAt.rollups[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await env.DB.prepare(
      "insert into product_usage_daily_rollups (day, status, total_events, active_actors, active_sessions, active_repos, source_event_count, max_event_capacity, first_event_at, last_event_at, surfaces_json, outcomes_json, events_json, repos_json, commands_json, tools_json, route_classes_json, activation_json, generated_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("2026-04-26", "corrupt", 7, 2, 1, 1, 7, 5000, null, null, "{bad-json", "{bad-json", "[]", "[]", "[]", "[]", "[]", "{bad-json", "2026-05-27T00:00:00.000Z", "2026-05-27T00:00:00.000Z")
      .run();

    const persisted = await listProductUsageDailyRollups(env, { fromDay: "2026-04-26", limit: 40 });
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          day: "2026-04-26",
          status: "incomplete",
          totalEvents: 7,
          bySurface: [],
          byOutcome: [],
          activation: {
            loginActors: 0,
            doctorPassActors: 0,
            firstUsefulActionActors: 0,
            fullyActivatedActors: 0,
            githubInstalledRepos: 0,
            githubFirstCommandRepos: 0,
            githubUsefulMaintainerRepos: 0,
            githubActivatedRepos: 0,
          },
        }),
      ]),
    );
  });

  it("marks rollup days incomplete when raw usage exceeds the worker event cap", async () => {
    const env = createTestEnv();
    const day = "2026-05-29";
    const startMs = Date.parse(`${day}T00:00:00.000Z`);
    await env.DB.batch(
      Array.from({ length: 5001 }, (_, index) =>
        env.DB.prepare(
          "insert into product_usage_events (id, surface, role, event_name, route, actor_hash, session_hash, repo_full_name, target_key, outcome, latency_ms, client_name, client_version, metadata_json, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          `cap-event-${index}`,
          "api",
          "miner",
          "agent_pr_packet_completed",
          "/v1/agent/prepare-pr-packet",
          null,
          null,
          "JSONbored/gittensory",
          null,
          "success",
          null,
          null,
          null,
          "{}",
          new Date(startMs + index * 1000).toISOString(),
        ),
      ),
    );

    const result = await rollupProductUsageDaily(env, { day, nowIso: "2026-05-30T00:10:00.000Z" });

    expect(result.rollups[0]).toMatchObject({
      day,
      status: "incomplete",
      totalEvents: 5001,
      sourceEventCount: 5001,
      maxEventCapacity: 5000,
      byEvent: [{ eventName: "agent_pr_packet_completed", count: 5000 }],
      byRepo: [{ key: "JSONbored/gittensory", count: 5000 }],
      activation: expect.objectContaining({ firstUsefulActionActors: 0 }),
    });
    await expect(getProductUsageRollupStatus(env, { nowIso: "2026-05-30T00:20:00.000Z" })).resolves.toMatchObject({
      status: "incomplete",
      incompleteDays: [day],
    });
  });

  it("marks retention windows capped when previous usage exceeds the retention scan cap", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    const day = "2026-06-20";
    const previousDay = "2026-06-10";
    const previousStartMs = Date.parse(`${previousDay}T00:00:00.000Z`);
    await env.DB.batch(
      Array.from({ length: 5001 }, (_, index) =>
        env.DB.prepare(
          "insert into product_usage_events (id, surface, role, event_name, route, actor_hash, session_hash, repo_full_name, target_key, outcome, latency_ms, client_name, client_version, metadata_json, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          `retention-cap-event-${index}`,
          "mcp",
          "miner",
          "mcp_request",
          "/mcp",
          index === 5000 ? "retained-actor-hash" : `previous-actor-${index}`,
          null,
          null,
          null,
          "success",
          null,
          null,
          null,
          JSON.stringify({ role: "miner" }),
          new Date(previousStartMs + index * 1000).toISOString(),
        ),
      ),
    );
    await env.DB.prepare(
      "insert into product_usage_events (id, surface, role, event_name, route, actor_hash, session_hash, repo_full_name, target_key, outcome, latency_ms, client_name, client_version, metadata_json, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "retention-cap-current-event",
        "mcp",
        "miner",
        "mcp_request",
        "/mcp",
        "retained-actor-hash",
        null,
        null,
        null,
        "success",
        null,
        null,
        null,
        JSON.stringify({ role: "miner" }),
        `${day}T01:00:00.000Z`,
      )
      .run();

    const result = await rollupProductUsageDaily(env, { day, nowIso: "2026-06-21T00:00:00.000Z" });

    expect(result.rollups[0]).toMatchObject({
      day,
      status: "complete",
      totalEvents: 1,
      retention: expect.arrayContaining([
        expect.objectContaining({
          window: "previous_30_days",
          capped: true,
          activeActors: 1,
          retainedActors: 1,
          retentionRate: 1,
          byRole: [{ role: "miner", activeActors: 1, retainedActors: 1, retentionRate: 1 }],
          bySurface: [{ surface: "mcp", activeActors: 1, retainedActors: 1, retentionRate: 1 }],
        }),
      ]),
    });
  });
});
