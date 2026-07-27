import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { buildDecisionRecord, contentDigest, persistDecisionRecord } from "../../src/review/decision-record";

// #9120: the public decision-ledger verify endpoint required an API token in prod despite its own doc comment
// (and every sibling /v1/public/* route's own doc comment) always claiming "unauthenticated by design" --
// verified live: /v1/public/subnet-interface and /v1/public/stats answered 200 with no credentials,
// /v1/public/decision-ledger/verify 401'd. This file pins the fix AND, per the issue's own ask, table-drives
// the full requiresApiToken /v1/public/* exemption list so the next public route added can't silently regress
// the same way -- each entry below is exercised as a real anonymous HTTP request, not a unit test of the
// (unexported) requiresApiToken function itself.
describe("public decision-ledger/decision-records routes answer WITHOUT credentials (#9120)", () => {
  it("GET /v1/public/decision-ledger/verify answers 200 with no Authorization header (the exact route that 401'd in prod)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/public/decision-ledger/verify", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; tipSeq: number; tipHash: string; totalCount: number };
    expect(body.ok).toBe(true);
    // #9122: every response now carries the current tip + total row count for third-party checkpointing.
    expect(body).toHaveProperty("tipSeq");
    expect(body).toHaveProperty("tipHash");
    expect(body).toHaveProperty("totalCount");
  });

  it("GET /v1/public/decision-records/:owner/:repo/:pull answers 200 with no Authorization header and returns the published record verbatim + a digest that re-hashes to the exact stored value (#9123)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { record, recordDigest } = await buildDecisionRecord({
      repoFullName: "acme/widgets",
      pullNumber: 42,
      headSha: "abc1234def",
      baseSha: null,
      action: "close",
      reasonCode: "policy_close:contributor_cap",
      configDigest: await contentDigest({ gatePack: "oss-anti-slop" }),
      gatePack: "oss-anti-slop",
      ciState: null,
      modelIds: null,
      promptDigest: null,
      aiConfidence: null,
      salvageability: null,
    });
    await persistDecisionRecord(env, record, recordDigest);

    const response = await app.request("/v1/public/decision-records/acme/widgets/42", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { record: typeof record; recordDigest: string };
    expect(body.recordDigest).toBe(recordDigest);
    expect(body.record).toEqual(record);
    // The digest is an honest commitment to the exact published body -- an observer can re-hash and compare.
    expect(await contentDigest(body.record)).toBe(body.recordDigest);
  });

  it("GET /v1/public/decision-records/:owner/:repo/:pull answers 404 (not 401) for a PR with no persisted record yet", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/public/decision-records/acme/widgets/999", {}, env);
    expect(response.status).toBe(404);
  });

  it("GET /v1/public/decision-records/:owner/:repo/:pull answers 400 (not 401) for a non-numeric pull segment", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/public/decision-records/acme/widgets/not-a-number", {}, env);
    expect(response.status).toBe(400);
  });

  // #9120's own ask: "a companion test for each currently-exempt /v1/public/* route" -- table-driven, so a
  // future public route that forgets its requiresApiToken exemption fails HERE, not in prod. Every path answers
  // something other than 401 (the specific status varies -- 200/404/503 depending on seed data/feature flags --
  // the only invariant under test is that the auth gate itself never fires).
  const exemptPublicRoutes: Array<[string, string]> = [
    ["subnet-interface", "/v1/public/subnet-interface"],
    ["stats", "/v1/public/stats"],
    ["decision-ledger/verify", "/v1/public/decision-ledger/verify"],
    ["decision-records/:owner/:repo/:pull", "/v1/public/decision-records/acme/widgets/1"],
    ["github/repos/:owner/:repo/stats", "/v1/public/github/repos/acme/widgets/stats"],
    ["repos/:owner/:repo/badge.svg", "/v1/public/repos/acme/widgets/badge.svg"],
    ["repos/:owner/:repo/badge.json", "/v1/public/repos/acme/widgets/badge.json"],
    ["repos/:owner/:repo/quality", "/v1/public/repos/acme/widgets/quality"],
    ["eval-scores", "/v1/public/eval-scores"],
  ];

  it.each(exemptPublicRoutes)("%s answers without credentials (never 401)", async (_name, path) => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(path, {}, env);
    expect(response.status).not.toBe(401);
  });

  it("a genuinely protected /v1/* route (no exemption) DOES 401 with no credentials -- proves the table above is discriminating, not vacuously passing", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/internal/audit-labels", {}, env);
    expect(response.status).toBe(401);
  });
});
