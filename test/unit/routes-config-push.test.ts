import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/orb/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orb/relay")>();
  return { ...actual, pruneRelayPending: vi.fn(actual.pruneRelayPending) };
});

import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { pruneRelayPending } from "../../src/orb/relay";
import { createTestEnv } from "../helpers/d1";

// #7522 (piece 1 of #4902's 3-piece design): the config-push write path. Mirrors routes-kill-switch.test.ts's
// own operator-route test style exactly -- same session/static-token identity setup, same auth-matrix coverage.

function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
}

async function relayRows(env: Env): Promise<Array<{ delivery_id: string; installation_id: number; event_name: string; raw_body: string; kind: string }>> {
  const result = (await env.DB.prepare("select delivery_id, installation_id, event_name, raw_body, kind from orb_relay_pending order by delivery_id").all()) as {
    results: Array<{ delivery_id: string; installation_id: number; event_name: string; raw_body: string; kind: string }>;
  };
  return result.results;
}

describe("config-push operator route (#7522)", () => {
  it("REGRESSION (#7611 review fix): prunes ONCE per request, not once per target installation", async () => {
    vi.mocked(pruneRelayPending).mockClear();
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request(
      "/v1/app/fleet/config-push",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ installationIds: [1, 2, 3, 4, 5], pushId: "push-prune", message: "x" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    // A single request fanning out over 5 installationIds must trigger exactly ONE global TTL-prune scan,
    // not 5 -- the whole point of the fix (pruneRelayPending previously lived inside enqueueConfigPushRelay
    // itself, so it re-ran once per target in the Promise.all fan-out below).
    expect(pruneRelayPending).toHaveBeenCalledTimes(1);
  });

  it("enqueues one orb_relay_pending row per target installation, kind = 'config_push'", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request(
      "/v1/app/fleet/config-push",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          installationIds: [111, 222],
          pushId: "push-1",
          message: "capability X is now available",
          capability: "x",
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, pushId: "push-1", installationCount: 2 });

    const rows = await relayRows(env);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.installation_id)).toEqual([111, 222]);
    for (const row of rows) {
      expect(row.kind).toBe("config_push");
      expect(row.event_name).toBe("config_push");
      expect(JSON.parse(row.raw_body)).toEqual({ pushId: "push-1", message: "capability X is now available", capability: "x" });
    }
  });

  it("is idempotent per (pushId, installation) — re-posting the same push does not duplicate the row", async () => {
    const app = createApp();
    const env = createTestEnv();
    const body = JSON.stringify({ installationIds: [333], pushId: "push-2", message: "deprecation notice" });
    await app.request("/v1/app/fleet/config-push", { method: "POST", headers: apiHeaders(env), body }, env);
    await app.request("/v1/app/fleet/config-push", { method: "POST", headers: apiHeaders(env), body }, env);
    const rows = await relayRows(env);
    expect(rows).toHaveLength(1);
  });

  it("leaves an existing github_webhook row's kind untouched (DB default, not explicitly set)", async () => {
    const env = createTestEnv();
    await env.DB
      .prepare("INSERT INTO orb_relay_pending (delivery_id, installation_id, event_name, raw_body) VALUES (?, ?, ?, ?)")
      .bind("legacy-delivery-1", 999, "pull_request", "{}")
      .run();
    const rows = await relayRows(env);
    expect(rows.find((r) => r.delivery_id === "legacy-delivery-1")?.kind).toBe("github_webhook");
  });

  it("rejects a schema-invalid body (empty installationIds) instead of silently coercing it", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request(
      "/v1/app/fleet/config-push",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ installationIds: [], pushId: "push-3", message: "x" }) },
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_config_push" });
    expect(await relayRows(env)).toHaveLength(0);
  });

  it("rejects a body that isn't valid JSON at all", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/fleet/config-push", { method: "POST", headers: apiHeaders(env), body: "{" }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_config_push" });
  });

  it("is forbidden for a non-operator session and unauthorized with no identity", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
    const body = JSON.stringify({ installationIds: [1], pushId: "push-4", message: "x" });
    const forbidden = await app.request(
      "/v1/app/fleet/config-push",
      { method: "POST", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body },
      env,
    );
    expect(forbidden.status).toBe(403);
    const unauthorized = await app.request("/v1/app/fleet/config-push", { method: "POST", headers: { "content-type": "application/json" }, body }, env);
    expect(unauthorized.status).toBe(401);
    expect(await relayRows(env)).toHaveLength(0);
  });

  it("rejects the shared MCP token", async () => {
    const app = createApp();
    const env = createTestEnv();
    const headers = { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" };
    const res = await app.request(
      "/v1/app/fleet/config-push",
      { method: "POST", headers, body: JSON.stringify({ installationIds: [1], pushId: "push-5", message: "x" }) },
      env,
    );
    expect(res.status).toBe(403);
    expect(await relayRows(env)).toHaveLength(0);
  });

  it("succeeds for an operator session too (not just a static token), and audits the push", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(
      "/v1/app/fleet/config-push",
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ installationIds: [42], pushId: "push-6", message: "x", deprecatesAt: "2026-08-01T00:00:00.000Z" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const audit = (await env.DB
      .prepare("select actor, outcome, metadata_json from audit_events where event_type = 'operator.config_push_enqueued'")
      .first()) as { actor: string; outcome: string; metadata_json: string } | null;
    expect(audit?.actor).toBe("jsonbored");
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toEqual({ installationCount: 1, capability: null });
  });
});
