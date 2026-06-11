import { describe, expect, it } from "vitest";
import { recordProductUsageEvent, summarizeMcpCompatibilityAdoption } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("MCP compatibility adoption summaries", () => {
  it("aggregates MCP-surfaced and CLI-backed API usage without exposing identities", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "mcp-adoption-test-salt" });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "local_branch_analysis_completed",
      actor: "oktofeesh1",
      sessionId: "cli-session",
      clientName: "gittensory-mcp-cli",
      metadata: {
        packageVersion: "0.2.1",
        protocolVersion: "2025-03-26",
      },
      occurredAt: "2026-05-28T00:02:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "other-user",
      sessionId: "mcp-session",
      metadata: {},
      occurredAt: "2026-05-28T00:01:00.000Z",
    });

    const summary = await summarizeMcpCompatibilityAdoption(env);
    expect(summary).toMatchObject({
      totalEvents: 2,
      activeActors: 2,
      activeSessions: 2,
      truncated: false,
      byClientVersion: expect.arrayContaining([
        { key: "0.2.1", count: 1 },
        { key: "unknown", count: 1 },
      ]),
      byCompatibilityStatus: expect.arrayContaining([
        { status: "incompatible", count: 1 },
        { status: "unknown", count: 1 },
      ]),
    });
    expect(JSON.stringify(summary)).not.toMatch(/oktofeesh1|other-user|cli-session|mcp-session/i);

    const capped = await summarizeMcpCompatibilityAdoption(env, undefined, { limit: 1 });
    expect(capped).toMatchObject({
      totalEvents: 2,
      scannedEvents: 1,
      truncated: true,
    });
  });

  it("canonicalizes client version buckets before returning aggregate analytics", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "mcp-adoption-test-salt" });

    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "alice",
      clientName: "gittensory-mcp",
      clientVersion: "0.3.0+alice",
      metadata: { packageVersion: "0.3.0+alice" },
      occurredAt: "2026-05-28T00:03:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "bob",
      clientName: "gittensory-mcp",
      clientVersion: "v0.4.0-beta.1+bob",
      metadata: { packageVersion: "v0.4.0-beta.1+bob" },
      occurredAt: "2026-05-28T00:04:00.000Z",
    });
    await recordProductUsageEvent(env, {
      surface: "mcp",
      eventName: "mcp_request",
      actor: "carol",
      clientName: "gittensory-mcp",
      clientVersion: "canary+carol",
      metadata: { packageVersion: "canary+carol" },
      occurredAt: "2026-05-28T00:05:00.000Z",
    });

    const summary = await summarizeMcpCompatibilityAdoption(env);

    expect(summary.byClientVersion).toContainEqual({ key: "0.3.0", count: 1 });
    expect(summary.byClientVersion).toContainEqual({ key: "0.4.0-beta.1", count: 1 });
    expect(summary.byClientVersion).toContainEqual({ key: "unknown", count: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/alice|bob|carol/i);
  });
});
