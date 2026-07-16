import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #6621: POST /v1/scoring/eligibility-plan — the eligibility-plan sibling of /v1/scoring/explain-breakdown.
// It shares that route's body schema, fetch, and buildScorePreview, then applies deriveEligibilityPlan (whose
// own logic is covered by eligibility-plan's unit tests). These tests pin the ROUTE contract: the derivation is
// returned, contributorLogin is OPTIONAL but gated when supplied, and a bad body is rejected.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/scoring/eligibility-plan";

const post = (app: ReturnType<typeof createApp>, env: Env, body: unknown, headers = apiHeaders(env)) =>
  app.request(PATH, { method: "POST", headers, body: JSON.stringify(body) }, env);

async function seed(env: Env) {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
}

describe("POST /v1/scoring/eligibility-plan (#6621)", () => {
  it("returns an eligibility plan for a branch that needs no linked issue", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seed(env);
    const response = await post(app, env, { repoFullName: "acme/widgets", linkedIssueMode: "none", sourceTokenScore: 40, totalTokenScore: 60 });
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan).toMatchObject({
      eligible: expect.any(Boolean),
      linkedIssueStatus: expect.any(String),
      branchEligibilityStatus: expect.any(String),
    });
  });

  it("reports an ineligible plan with public-safe blockers when a standard linked issue is unvalidated", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seed(env);
    const response = await post(app, env, { repoFullName: "acme/widgets", linkedIssueMode: "standard", sourceTokenScore: 40, totalTokenScore: 60 });
    expect(response.status).toBe(200);
    const plan = (await response.json()) as { eligible: boolean; blockers?: unknown[] };
    expect(plan.eligible).toBe(false);
    expect(Array.isArray(plan.blockers)).toBe(true);
    // Advisory, public-safe output only — never private scoring internals.
    expect(JSON.stringify(plan)).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });

  it("accepts a request with NO contributorLogin — it is optional here, unlike explain-breakdown", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seed(env);
    const response = await post(app, env, { repoFullName: "acme/widgets" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ eligible: expect.any(Boolean) });
  });

  it("fetches contributor evidence + issues when an AUTHORIZED contributorLogin is supplied", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seed(env);
    // The operator api token is trusted, so this passes the gate and exercises the contributor-scoped fetches
    // (evidence + open issues) that the no-login path deliberately skips.
    const response = await post(app, env, { repoFullName: "acme/widgets", contributorLogin: "miner1", linkedIssueMode: "none", sourceTokenScore: 40, totalTokenScore: 60 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ eligible: expect.any(Boolean), branchEligibilityStatus: expect.any(String) });
  });

  it("gates on requireContributorAccess ONLY when contributorLogin is supplied", async () => {
    const app = createApp();
    // The shared mcp token may not read an arbitrary contributor's data without the full read wildcard (#2455).
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    await seed(env);
    const mcpHeaders = { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" };

    const gated = await post(app, env, { repoFullName: "acme/widgets", contributorLogin: "miner1" }, mcpHeaders);
    expect(gated.status).toBe(403);

    // …and the very same token succeeds when it asks for nothing contributor-scoped.
    const ungated = await post(app, env, { repoFullName: "acme/widgets" }, mcpHeaders);
    expect(ungated.status).toBe(200);
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const body of [{ repoFullName: "ab" }, { repoFullName: "acme/widgets", linkedIssueMode: "bogus" }, { notARepo: true }]) {
      const response = await post(app, env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_scoring_preview_request" });
    }
    const malformed = await app.request(PATH, { method: "POST", headers: apiHeaders(env), body: "{not json" }, env);
    expect(malformed.status).toBe(400);
  });
});
