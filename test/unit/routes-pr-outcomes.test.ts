import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { insertNotificationDeliveryIfAbsent } from "../../src/db/repositories";
import { buildContributorPrOutcomes } from "../../src/signals/contributor-pr-outcomes";
import { createTestEnv } from "../helpers/d1";

// #6747: GET /v1/contributors/:login/pr-outcomes — the REST mirror bringing loopover_pr_outcome to the same
// /v1/contributors/:login/... family its self-scoped open-pr-monitor sibling already has. The route delegates to
// the shared buildContributorPrOutcomes builder (also called by the MCP tool and the CLI), so these pin the ROUTE
// contract: a contributor reads only their OWN outcomes (a cross-login session is 403), an operator token may read
// any login, the payload equals the builder's, and a malformed ?limit is rejected rather than clamped.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` });

async function seedMerged(env: Env, login: string, pullNumber: number) {
  await insertNotificationDeliveryIfAbsent(env, {
    dedupKey: `pull_request_merged:owner/repo#${pullNumber}:${login}`,
    channel: "badge",
    recipientLogin: login,
    eventType: "pull_request_merged",
    repoFullName: "owner/repo",
    pullNumber,
    title: `Merged: owner/repo#${pullNumber}`,
    body: `Your pull request owner/repo#${pullNumber} merged. Merged contributions strengthen your standing on owner/repo.`,
    deeplink: `https://github.com/owner/repo/pull/${pullNumber}`,
    actorLogin: login,
  });
}

async function setup() {
  const app = createApp();
  const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "attacker" });
  const { token } = await createSessionForGitHubUser(env, { login: "attacker", id: 7 });
  const sessionHeaders = { authorization: `Bearer ${token}` };
  return { app, env, sessionHeaders };
}

describe("GET /v1/contributors/:login/pr-outcomes (#6747)", () => {
  it("returns the contributor's own merged-PR outcome history", async () => {
    const { app, env, sessionHeaders } = await setup();
    await seedMerged(env, "attacker", 7);
    await seedMerged(env, "attacker", 8);
    const res = await app.request("/v1/contributors/attacker/pr-outcomes", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { login: string; count: number; outcomes: Array<{ pullNumber: number; outcome: string }> };
    expect(payload.login).toBe("attacker");
    expect(payload.count).toBe(2);
    expect(payload.outcomes.every((o) => o.outcome === "merged")).toBe(true);
    // PARITY: the route returns exactly what the shared builder the MCP tool + CLI also call returns.
    expect(payload).toEqual(JSON.parse(JSON.stringify(await buildContributorPrOutcomes(env, "attacker"))));
  });

  it("is self-scoped: a session cannot read another login's outcomes", async () => {
    const { app, env, sessionHeaders } = await setup();
    await seedMerged(env, "victim", 1);
    const res = await app.request("/v1/contributors/victim/pr-outcomes", { headers: sessionHeaders }, env);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
  });

  it("lets an operator token read any login's outcomes", async () => {
    const { app, env } = await setup();
    await seedMerged(env, "victim", 1);
    const res = await app.request("/v1/contributors/victim/pr-outcomes", { headers: apiHeaders(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ login: "victim", count: 1 });
  });

  it("applies a valid ?limit, and returns exactly what the builder returns for that limit", async () => {
    const { app, env, sessionHeaders } = await setup();
    await seedMerged(env, "attacker", 7);
    await seedMerged(env, "attacker", 8);
    const res = await app.request("/v1/contributors/attacker/pr-outcomes?limit=1", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { count: number };
    expect(payload.count).toBe(1);
    expect(payload).toEqual(JSON.parse(JSON.stringify(await buildContributorPrOutcomes(env, "attacker", 1))));
  });

  it("rejects a malformed ?limit with 400 rather than clamping it", async () => {
    const { app, env, sessionHeaders } = await setup();
    // One case per arm of the guard: non-integer, below range, above range, and a fractional value.
    for (const limit of ["abc", "0", "101", "1.5", ""]) {
      const res = await app.request(`/v1/contributors/attacker/pr-outcomes?limit=${limit}`, { headers: sessionHeaders }, env);
      expect(res.status, `limit=${limit}`).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_limit" });
    }
  });

  it("returns an empty history (not an error) for a contributor with no merged PRs", async () => {
    const { app, env, sessionHeaders } = await setup();
    const res = await app.request("/v1/contributors/attacker/pr-outcomes", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ login: "attacker", count: 0, outcomes: [] });
  });

  it("leaks no wallet/hotkey/trust-score/reward terms", async () => {
    const { app, env, sessionHeaders } = await setup();
    await seedMerged(env, "attacker", 7);
    const text = JSON.stringify(await (await app.request("/v1/contributors/attacker/pr-outcomes", { headers: sessionHeaders }, env)).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward|payout|\$/i);
  });
});
