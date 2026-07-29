import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildOpenApiSpec } from "../../src/openapi/spec";
import { MAX_ORB_INGEST_BODY_BYTES } from "../../src/orb/ingest";
import { createTestEnv } from "../helpers/d1";

// #9708: the two telemetry-ingest routes' PUBLISHED operations disagreed with their handlers -- AMS declared a
// 202 it never returns (its real status is 200) and omitted 413; ORB was a legacy registerPath block declaring
// only 200/400 with NO security stanza at all, despite carrying its own ORB_INGEST_TOKEN bearer. This test pins,
// for BOTH routes, that the handler's real 401/413/200 statuses are exactly what the OpenAPI document declares.

const AUTH = { authorization: "Bearer fleet-secret" };

const ROUTES = [
  {
    path: "/v1/ams/ingest",
    tokenEnv: "AMS_INGEST_TOKEN" as const,
    // AMS batch shape (camelCase).
    validBody: JSON.stringify({ instanceId: "abc0", events: [{ repoHash: "rhash", prHash: "phash", decision: "merged" }] }),
  },
  {
    path: "/v1/orb/ingest",
    tokenEnv: "ORB_INGEST_TOKEN" as const,
    // ORB batch shape (snake_case) -- a first-contact instance ingests successfully (registered=0).
    validBody: JSON.stringify({ instance_id: "abc0", events: [{ repo_hash: "rhash", pr_hash: "phash", outcome: "merged", reversal_flag: "none" }] }),
  },
];

describe("ingest routes: handler status <-> OpenAPI declaration parity (#9708)", () => {
  const app = createApp();

  for (const route of ROUTES) {
    const authedEnv = () => createTestEnv({ [route.tokenEnv]: "fleet-secret" } as Partial<Env>);

    it(`${route.path}: 401 with no bearer, 413 when oversized, 200 for a valid authenticated batch`, async () => {
      // No bearer -> 401 (the collector fails closed).
      const noAuth = await app.request(route.path, { method: "POST", headers: { "content-type": "application/json" }, body: route.validBody }, authedEnv());
      expect(noAuth.status).toBe(401);

      // Over the 1 MiB readOrbIngestBody ceiling -> 413.
      const oversized = await app.request(route.path, { method: "POST", headers: AUTH, body: "x".repeat(MAX_ORB_INGEST_BODY_BYTES + 16) }, authedEnv());
      expect(oversized.status).toBe(413);

      // Valid authenticated batch -> 200 (never the AMS 202 the spec used to claim).
      const ok = await app.request(route.path, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: route.validBody }, authedEnv());
      expect(ok.status).toBe(200);
    });

    it(`${route.path}: the OpenAPI document declares each observed status (200, 401, 413), and never 202`, () => {
      const responses = buildOpenApiSpec().paths[route.path]?.post?.responses ?? {};
      const declared = Object.keys(responses);
      expect(declared).toEqual(expect.arrayContaining(["200", "401", "413"]));
      expect(declared).not.toContain("202");
    });
  }

  it("/v1/orb/ingest carries its OrbBearer security stanza (it had none as a legacy registerPath block)", () => {
    const op = buildOpenApiSpec().paths["/v1/orb/ingest"]?.post;
    expect(op?.security).toEqual([{ OrbBearer: [] }]);
    // 403 (instance_unauthenticated) is a real ORB-only status the AMS route never returns.
    expect(Object.keys(op?.responses ?? {})).toContain("403");
  });
});
