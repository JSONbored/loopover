import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildTestEvidenceReport } from "../../src/signals/test-evidence";
import { createTestEnv } from "../helpers/d1";

// #6749: POST /v1/lint/test-evidence — the REST mirror bringing loopover_check_test_evidence to the parity its
// same-tier deterministic-lint sibling /v1/lint/slop-risk already has. Route + MCP tool + CLI all delegate to
// the engine's buildTestEvidenceReport, so these pin the ROUTE contract and assert cross-surface parity.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/lint/test-evidence";
const post = (env: Env, body: unknown) => createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/lint/test-evidence (#6749)", () => {
  it("matches the shared builder for every classification arm", async () => {
    const env = createTestEnv();
    const cases = [
      { changedPaths: ["src/a.ts"] }, // code, no tests → absent
      { changedPaths: ["src/a.ts"], testFiles: ["test/a.test.ts"] }, // real test evidence
      { changedPaths: ["src/a.ts"], tests: "ran `go test ./...` locally, no new file" }, // free-text credit
      { changedPaths: ["README.md"] }, // docs-only → signal does not apply
      // ratio >= 0.4 -> strong
      { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"], testFiles: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"] },
      // ratio >= 0.2 but < 0.4 -> adequate
      { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], testFiles: ["test/a.test.ts"] },
      // ratio < 0.2 -> weak (one test across nine changed files)
      { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts", "src/i.ts"], testFiles: ["test/a.test.ts"] },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      // PARITY: the route returns exactly what the MCP tool + CLI derive from the same builder.
      await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(buildTestEvidenceReport(body))));
    }
  });

  it("renders the strong and weak guidance arms from the shared builder", async () => {
    const env = createTestEnv();
    const strong = (await (await post(env, { changedPaths: ["src/a.ts", "src/b.ts"], testFiles: ["test/a.test.ts", "test/b.test.ts"] })).json()) as { classification: string; guidance: string[] };
    expect(strong.classification).toBe("strong");
    expect(strong.guidance.join(" ")).toMatch(/strong/i);

    const weak = (await (await post(env, { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts", "src/i.ts"], testFiles: ["test/a.test.ts"] })).json()) as { classification: string; guidance: string[] };
    expect(weak.classification).toBe("weak");
    expect(weak.guidance.join(" ")).toMatch(/adding another focused test/i);
  });

  it("credits free-text tests evidence only to LIFT an absent verdict, never to loosen a real one", async () => {
    const env = createTestEnv();
    const credited = (await (await post(env, { changedPaths: ["src/a.ts"], tests: "ran the suite locally" })).json()) as { classification: string; guidance: string[] };
    expect(credited.classification).toBe("adequate");
    expect(credited.guidance.join(" ")).toMatch(/free-text/i);

    const absent = (await (await post(env, { changedPaths: ["src/a.ts"] })).json()) as { classification: string };
    expect(absent.classification).toBe("absent");
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [{}, { changedPaths: [] }, { changedPaths: "nope" }, { changedPaths: ["src/a.ts"], tests: 7 }]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_test_evidence_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("uploads no source and leaks no private terms — path metadata only", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { changedPaths: ["src/a.ts"] })).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
