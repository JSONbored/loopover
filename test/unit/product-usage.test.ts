import { describe, expect, it } from "vitest";
import {
  getContributorScoringProfile,
  listDigestSubscriptionsForLogin,
  listProductUsageEvents,
  recordAiUsageEvent,
  recordProductUsageEvent,
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
      eventName: "command_previewed",
      route: "/v1/app/commands/preview",
      repoFullName: "<redacted-actor>/private-tool",
      targetKey: "<redacted-actor>:private-tool#136",
      metadata: { command: "packet", viewer: "<redacted-actor>", nested: { note: "for <redacted-actor>" } },
    });
    expect(JSON.stringify(row)).not.toMatch(/Oktofeesh1|gts_session_secret/i);
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
    expect(JSON.stringify(row.metadata)).not.toMatch(/\/Users|github_pat|ghp_|source code|private patch|trustScore|wallet/i);
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
      actor: "maintainer",
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
});
