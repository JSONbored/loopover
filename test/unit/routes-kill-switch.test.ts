import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/repositories")>();
  return {
    ...actual,
    getGlobalAgentFrozenState: vi.fn(actual.getGlobalAgentFrozenState),
    setGlobalAgentFrozen: vi.fn(actual.setGlobalAgentFrozen),
  };
});

import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getGlobalAgentFrozenState, setGlobalAgentFrozen } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #2359: setGlobalAgentFrozen previously had zero callers anywhere in src/ — the only way to flip the DB-backed
// global kill-switch was raw SQL. These tests cover the new operator-only route pair that makes it operable.

function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
}

async function auditRows(env: Env): Promise<Array<{ actor: string; outcome: string; metadata_json: string }>> {
  const result = (await env.DB.prepare("select actor, outcome, metadata_json from audit_events where event_type = 'operator.kill_switch_set' order by created_at desc").all()) as {
    results: Array<{ actor: string; outcome: string; metadata_json: string }>;
  };
  return result.results;
}

describe("kill-switch operator route (#2359)", () => {
  beforeEach(() => {
    vi.mocked(getGlobalAgentFrozenState).mockClear();
    vi.mocked(setGlobalAgentFrozen).mockClear();
  });

  it("GET returns the seeded-default unfrozen state for a trusted static token", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/kill-switch", { headers: apiHeaders(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ frozen: false, updatedBy: null });
  });

  it("GET is forbidden for an authenticated session without the operator role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const res = await app.request("/v1/app/kill-switch", { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(res.status).toBe(403);
  });

  it("GET is unauthorized with no identity at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/kill-switch", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects the shared MCP token without changing the global kill-switch", async () => {
    const app = createApp();
    const env = createTestEnv();
    const headers = { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" };

    const read = await app.request("/v1/app/kill-switch", { headers }, env);
    expect(read.status).toBe(403);

    const write = await app.request("/v1/app/kill-switch", { method: "POST", headers, body: JSON.stringify({ frozen: true }) }, env);
    expect(write.status).toBe(403);
    await expect(getGlobalAgentFrozenState(env)).resolves.toMatchObject({ frozen: false, updatedBy: null });
    expect(setGlobalAgentFrozen).not.toHaveBeenCalled();
  });

  it("GET surfaces a clear 503 (never a falsely reassuring unfrozen) when the singleton row is missing", async () => {
    const app = createApp();
    const env = createTestEnv();
    await env.DB.prepare("DELETE FROM global_agent_controls WHERE id = 'singleton'").run();
    const res = await app.request("/v1/app/kill-switch", { headers: apiHeaders(env) }, env);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "kill_switch_read_failed" });
  });

  it("POST freezes and unfreezes the fleet for an operator session, verifying the write and auditing it", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const headers = { cookie: `gittensory_session=${token}`, "content-type": "application/json" };

    const freeze = await app.request("/v1/app/kill-switch", { method: "POST", headers, body: JSON.stringify({ frozen: true }) }, env);
    expect(freeze.status).toBe(200);
    await expect(freeze.json()).resolves.toMatchObject({ ok: true, frozen: true, updatedBy: "jsonbored" });

    const readBack = await app.request("/v1/app/kill-switch", { headers: apiHeaders(env) }, env);
    await expect(readBack.json()).resolves.toMatchObject({ frozen: true });

    const unfreeze = await app.request("/v1/app/kill-switch", { method: "POST", headers, body: JSON.stringify({ frozen: false }) }, env);
    expect(unfreeze.status).toBe(200);
    await expect(unfreeze.json()).resolves.toMatchObject({ ok: true, frozen: false, updatedBy: "jsonbored" });

    const audits = await auditRows(env);
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => JSON.parse(row.metadata_json).frozen)).toEqual([false, true]);
    expect(audits.every((row) => row.actor === "jsonbored" && row.outcome === "completed")).toBe(true);
  });

  it("POST rejects a schema-invalid body instead of silently coercing it", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const headers = { cookie: `gittensory_session=${token}`, "content-type": "application/json" };
    const res = await app.request("/v1/app/kill-switch", { method: "POST", headers, body: JSON.stringify({ frozen: "yes" }) }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_kill_switch_update" });
    expect(setGlobalAgentFrozen).not.toHaveBeenCalled();
  });

  it("POST rejects a body that isn't valid JSON at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/kill-switch", { method: "POST", headers: apiHeaders(env), body: "{" }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_kill_switch_update" });
    expect(setGlobalAgentFrozen).not.toHaveBeenCalled();
  });

  it("POST is forbidden for a non-operator session and unauthorized with no identity", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const forbidden = await app.request(
      "/v1/app/kill-switch",
      { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ frozen: true }) },
      env,
    );
    expect(forbidden.status).toBe(403);
    const unauthorized = await app.request("/v1/app/kill-switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frozen: true }) }, env);
    expect(unauthorized.status).toBe(401);
    expect(setGlobalAgentFrozen).not.toHaveBeenCalled();
  });

  it("POST surfaces a 503 (not a false success) when the post-write verification read fails", async () => {
    const app = createApp();
    const env = createTestEnv();
    vi.mocked(getGlobalAgentFrozenState).mockRejectedValueOnce(new Error("D1 hiccup"));
    const res = await app.request("/v1/app/kill-switch", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ frozen: true }) }, env);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "kill_switch_verify_failed" });
    expect(setGlobalAgentFrozen).toHaveBeenCalledTimes(1);
  });

  it("POST surfaces a 502 (not a false success) when the read-after-write observes a value that doesn't match the write", async () => {
    const app = createApp();
    const env = createTestEnv();
    vi.mocked(getGlobalAgentFrozenState).mockResolvedValueOnce({ frozen: false, updatedAt: null, updatedBy: null });
    const res = await app.request("/v1/app/kill-switch", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ frozen: true }) }, env);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "kill_switch_write_unconfirmed", requested: true, observed: false });
  });
});
