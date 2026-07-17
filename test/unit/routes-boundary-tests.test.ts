import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildBoundaryTestGenerationFinding, buildBoundaryTestGenerationSpec } from "../../src/signals/boundary-test-generation";
import { createTestEnv } from "../helpers/d1";

// #6750: POST /v1/lint/boundary-tests — the REST mirror bringing loopover_suggest_boundary_tests to the parity
// its same-tier advisory-lint sibling /v1/lint/slop-risk already has. The builders' own logic is covered by
// boundary-test-generation's own tests; these pin the ROUTE contract: the tool handler's filtering reproduced
// exactly, the finding/spec pairing, schema parity, and 400s.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/lint/boundary-tests";
const post = (env: Env, body: unknown) => createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);
const TOUCH = { path: "src/a.ts", kind: "array_index_bounds" as const };

describe("POST /v1/lint/boundary-tests (#6750)", () => {
  it("returns the finding + spec the tool's own handler would build, for a boundary touch with no test evidence", async () => {
    const env = createTestEnv();
    const body = { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [TOUCH] };
    const response = await post(env, body);
    expect(response.status).toBe(200);
    // PARITY: identical to the MCP tool's own composition over the same builders.
    const finding = buildBoundaryTestGenerationFinding({ touches: [TOUCH], tests: undefined, testFiles: undefined });
    await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify({ finding, spec: finding ? buildBoundaryTestGenerationSpec([TOUCH]) : null })));
    const payload = (await (await post(env, body)).json()) as { finding: unknown; spec: { action?: string } | null };
    expect(payload.finding).toBeTruthy();
    expect(payload.spec?.action).toBe("scaffold_boundary_tests");
  });

  it("drops touches whose path is not in the changed set (the handler's own filter)", async () => {
    const env = createTestEnv();
    const payload = (await (await post(env, {
      changedFiles: [{ path: "src/a.ts" }],
      boundaryTouches: [{ path: "src/somewhere-else.ts", kind: "null_or_undefined_branch" }],
    })).json()) as { finding: unknown; spec: unknown };
    // The only touch is filtered out, so there is no gap to report.
    expect(payload.finding).toBeNull();
    expect(payload.spec).toBeNull();
  });

  it("reports no gap when test evidence exists, and returns a null spec with a null finding", async () => {
    const env = createTestEnv();
    for (const body of [
      { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [TOUCH], testFiles: ["test/a.test.ts"] },
      { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [TOUCH], tests: ["ran the suite locally"] },
      { changedFiles: [{ path: "src/a.ts" }] }, // no touches at all
    ]) {
      const payload = (await (await post(env, body)).json()) as { finding: unknown; spec: unknown };
      expect(payload.finding, JSON.stringify(body)).toBeNull();
      expect(payload.spec, JSON.stringify(body)).toBeNull();
    }
  });

  it("accepts exactly what the MCP tool's shape accepts, and 400s what it rejects", async () => {
    const env = createTestEnv();
    expect((await post(env, { changedFiles: [] })).status).toBe(200); // empty changedFiles is valid for the tool
    for (const body of [{}, { changedFiles: [{ path: "" }] }, { changedFiles: [{ path: "src/a.ts", extra: 1 }] }, { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [{ path: "src/a.ts", kind: "bogus" }] }]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_boundary_tests_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("returns criteria/hints only — never generated test code — and no private terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [TOUCH] })).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
    expect(text).not.toMatch(/\bit\(|\bdescribe\(|\bexpect\(/); // no scaffolded test code crosses the boundary
  });
});
