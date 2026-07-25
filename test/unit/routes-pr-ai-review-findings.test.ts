import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { markAiReviewPublished, putCachedAiReview, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

// #6619: GET /v1/repos/:owner/:repo/pulls/:number/ai-review-findings — the REST mirror of the
// loopover_get_pr_ai_review_findings MCP tool. The route validates, gates on requireContributorAccess, then
// delegates to loadPrAiReviewFindings (whose own logic is covered by pr-ai-review-findings.test.ts). These
// tests therefore pin the ROUTE's contract: each delegated status passes through, and every guard branch
// (invalid number, missing login, non-owning/non-existent PR) is rejected before any data is read.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` });
const PATH = "/v1/repos/acme/widgets/pulls/11/ai-review-findings";

// Seed PR #11 authored by the requesting login (miner1) so the ownership guard (#8659) passes and the pass-through
// tests reach loadPrAiReviewFindings; individual tests override the author when they need a 403.
async function seedRepo(env: Env, aiReviewMode: string, prAuthor = "miner1") {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
  await upsertRepoFocusManifest(env, "acme/widgets", { settings: { aiReviewMode } });
  await upsertPullRequestFromGitHub(env, "acme/widgets", { number: 11, title: "PR 11", state: "open", user: { login: prAuthor }, head: { sha: "sha-1" }, labels: [], body: "x" });
}

describe("GET /v1/repos/:owner/:repo/pulls/:number/ai-review-findings (#6619)", () => {
  it("returns a ready payload with the PR's structured findings", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "advisory");
    await putCachedAiReview(env, "acme/widgets", 11, "sha-1", "advisory", { notes: "Clean review.", reviewerCount: 1 });
    await markAiReviewPublished(env, "acme/widgets", 11, "sha-1");

    const response = await app.request(`${PATH}?login=miner1`, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      repoFullName: "acme/widgets",
      pullNumber: 11,
      login: "miner1",
      headSha: "sha-1",
    });
  });

  it("passes through not_found when the PR has no published review", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "block");

    const response = await app.request(`${PATH}?login=miner1`, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "not_found", findings: [], categoryCounts: {} });
  });

  it("passes through ai_review_off when the repo has AI review disabled", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "off");

    const response = await app.request(`${PATH}?login=miner1`, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ai_review_off", findings: [], categoryCounts: {} });
  });

  it("rejects a non-integer or non-positive PR number with 400, before any auth or data read", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      const response = await app.request(`/v1/repos/acme/widgets/pulls/${bad}/ai-review-findings?login=miner1`, { headers: apiHeaders(env) }, env);
      expect(response.status, `pull number ${bad}`).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_pull_number" });
    }
  });

  it("rejects a missing or blank login query param with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const query of ["", "?login="]) {
      const response = await app.request(`${PATH}${query}`, { headers: apiHeaders(env) }, env);
      expect(response.status, `query "${query}"`).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "login_required" });
    }
  });

  it("rejects an unauthenticated caller (requireContributorAccess gates the contributor-owned data)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "advisory");

    const response = await app.request(`${PATH}?login=miner1`, {}, env);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });

  it("403s the shared, end-user-obtainable mcp token for a contributor's private findings unless fully unscoped", async () => {
    // #2455 precedent: the shared LOOPOVER_MCP_TOKEN must not read an ARBITRARY contributor's private data over
    // HTTP just because it can reach the repo — only the full MCP_READ_REPO_ALLOWLIST wildcard unlocks that.
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    await seedRepo(env, "advisory");

    const response = await app.request(`${PATH}?login=miner1`, { headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });

  it("never leaks wallet/hotkey/trust-score terms in its payload", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "advisory");
    await putCachedAiReview(env, "acme/widgets", 11, "sha-1", "advisory", { notes: "Clean review.", reviewerCount: 1 });
    await markAiReviewPublished(env, "acme/widgets", 11, "sha-1");

    const response = await app.request(`${PATH}?login=miner1`, { headers: apiHeaders(env) }, env);
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });

  it("403s a caller requesting a PR authored by someone else, without leaking its findings (#8659)", async () => {
    // The caller's own session matches `login=miner1`, but PR #11 was authored by other-miner. The route must
    // apply the same ownership guard the MCP tool does and reject with 403 -- not return the other author's data.
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "advisory", "other-miner");
    await putCachedAiReview(env, "acme/widgets", 11, "sha-1", "advisory", { notes: "Private review.", reviewerCount: 1 });
    await markAiReviewPublished(env, "acme/widgets", 11, "sha-1");

    const response = await app.request(`${PATH}?login=miner1`, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("404s when the target PR does not exist, distinct from the 403 for a wrong-author PR (#8659)", async () => {
    // Repo seeded, AI review on, but no PR #99 record: the ownership guard fetches the PR first, so a missing PR
    // is a 404, kept distinct from the 403 an existing-but-not-yours PR returns.
    const app = createApp();
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepoFocusManifest(env, "acme/widgets", { settings: { aiReviewMode: "advisory" } });

    const response = await app.request(`/v1/repos/acme/widgets/pulls/99/ai-review-findings?login=miner1`, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
