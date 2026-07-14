import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { recordAuditEvent, upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS, buildGateOutcomeBreakdown, classifyGateOutcomeAuditBucket } from "../../src/services/gate-outcome-breakdown";
import { createTestEnv } from "../helpers/d1";

function stubMinerDetection(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

async function seedOwnedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

describe("GET /v1/app/maintainer-dashboard gateOutcomeBreakdown (#2203)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces repo-scoped gate-outcome counts on qualityDashboard for an owner session", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    stubMinerDetection();
    const now = "2026-07-11T12:00:00.000Z";
    await recordAuditEvent(env, {
      eventType: "agent.action.merge",
      actor: "gittensory",
      targetKey: "owner/repo#1",
      outcome: "completed",
      createdAt: now,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      actor: "gittensory",
      targetKey: "owner/repo#2",
      outcome: "success",
      createdAt: now,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.hold",
      actor: "gittensory",
      targetKey: "owner/repo#3",
      outcome: "completed",
      createdAt: now,
    });
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request(
      "/v1/app/maintainer-dashboard",
      { headers: { cookie: `loopover_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      qualityDashboard: {
        gateOutcomeBreakdown: {
          windowDays: number;
          total: number;
          counts: { autoMerged: number; autoClosed: number; held: number };
          rates: { autoMerged: number | null; autoClosed: number | null; held: number | null };
          summary: string;
        };
      };
    };
    expect(body.qualityDashboard.gateOutcomeBreakdown).toMatchObject({
      windowDays: GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS,
      total: 3,
      counts: { autoMerged: 1, autoClosed: 1, held: 1 },
      rates: { autoMerged: 33.3, autoClosed: 33.3, held: 33.3 },
    });
    expect(body.qualityDashboard.gateOutcomeBreakdown.summary).toContain("auto-merged");
  });

  it("excludes non-terminal and non-gate audit rows from gateOutcomeBreakdown totals", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    stubMinerDetection();
    const now = "2026-07-11T12:00:00.000Z";
    await recordAuditEvent(env, {
      eventType: "agent.action.merge",
      actor: "gittensory",
      targetKey: "owner/repo#1",
      outcome: "queued",
      createdAt: now,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      actor: "gittensory",
      targetKey: "owner/repo#2",
      outcome: "denied",
      createdAt: now,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.hold",
      actor: "gittensory",
      targetKey: "owner/repo#3",
      outcome: "denied",
      createdAt: now,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.approve",
      actor: "gittensory",
      targetKey: "owner/repo#4",
      outcome: "completed",
      createdAt: now,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.merge",
      actor: "gittensory",
      targetKey: "owner/repo#5",
      outcome: "success",
      createdAt: now,
    });
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request(
      "/v1/app/maintainer-dashboard",
      { headers: { cookie: `loopover_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      qualityDashboard: {
        gateOutcomeBreakdown: {
          total: number;
          counts: { autoMerged: number; autoClosed: number; held: number };
          summary: string;
        };
      };
    };
    expect(body.qualityDashboard.gateOutcomeBreakdown).toMatchObject({
      total: 1,
      counts: { autoMerged: 1, autoClosed: 0, held: 0 },
    });
    expect(body.qualityDashboard.gateOutcomeBreakdown.summary).toContain("1 gate outcome");
  });

  it("returns an empty gateOutcomeBreakdown when scoped repos have no terminal gate-outcome audit rows", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request(
      "/v1/app/maintainer-dashboard",
      { headers: { cookie: `loopover_session=${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      qualityDashboard: {
        gateOutcomeBreakdown: {
          total: number;
          rates: { autoMerged: number | null; autoClosed: number | null; held: number | null };
          summary: string;
        };
      };
    };
    expect(body.qualityDashboard.gateOutcomeBreakdown.total).toBe(0);
    expect(body.qualityDashboard.gateOutcomeBreakdown.rates).toEqual({
      autoMerged: null,
      autoClosed: null,
      held: null,
    });
    expect(body.qualityDashboard.gateOutcomeBreakdown.summary).toContain("No gate-outcome audit events");
  });
});

describe("classifyGateOutcomeAuditBucket (#2203)", () => {
  it("maps each terminal gate-outcome event type to its bucket and rejects everything else", () => {
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.merge", outcome: "success" })).toBe("autoMerged");
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.merge", outcome: "completed" })).toBe("autoMerged");
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.close", outcome: "success" })).toBe("autoClosed");
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.close", outcome: "completed" })).toBe("autoClosed");
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.hold", outcome: "success" })).toBe("held");
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.hold", outcome: "completed" })).toBe("held");
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.merge", outcome: "dry_run" })).toBeNull();
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.approve", outcome: "completed" })).toBeNull();
  });
});

describe("buildGateOutcomeBreakdown (#2203)", () => {
  it("defaults windowDays when the caller omits it", () => {
    const result = buildGateOutcomeBreakdown({
      generatedAt: "2026-07-11T00:00:00.000Z",
      rollups: [],
    });
    expect(result.windowDays).toBe(GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS);
  });

  it("honors an explicit windowDays override in the summary", () => {
    const result = buildGateOutcomeBreakdown({
      generatedAt: "2026-07-11T00:00:00.000Z",
      windowDays: 14,
      rollups: [{ eventType: "agent.action.hold", outcome: "completed", count: 2 }],
    });
    expect(result.windowDays).toBe(14);
    expect(result.summary).toContain("14 day(s)");
  });
});
