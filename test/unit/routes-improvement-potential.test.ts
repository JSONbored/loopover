import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildStructuralImprovementAssessment } from "../../src/signals/improvement";
import { createTestEnv } from "../helpers/d1";

// #6748: POST /v1/lint/improvement-potential — the REST mirror of loopover_check_improvement_potential, the one
// deterministic lint tool whose siblings (slop-risk, issue-slop, lint-pr-text, validate-config) all already had
// REST parity. The route parses with the tool's OWN exported shape and returns the tool handler's exact field
// subset, so these pin the ROUTE contract; the scorer's own logic is covered by improvement's tests.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/lint/improvement-potential";
const post = (env: Env, body: unknown) => createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

/** The tool's handler returns only these three fields — the mirror must not leak the rest of the assessment. */
const subset = (input: Parameters<typeof buildStructuralImprovementAssessment>[0]) => {
  const a = buildStructuralImprovementAssessment(input);
  return JSON.parse(JSON.stringify({ improvementScore: a.improvementScore, band: a.band, findings: a.findings }));
};

describe("POST /v1/lint/improvement-potential (#6748)", () => {
  it("returns the tool handler's exact field subset for a structurally-improving change", async () => {
    const env = createTestEnv();
    const body = {
      changedFiles: [{ path: "src/a.ts", additions: 20, deletions: 60 }],
      testFiles: ["test/a.test.ts"],
      patchCoverageDeltaPercent: 4.5,
      complexityDeltas: [{ file: "src/a.ts", line: 10, name: "handler", before: 14, after: 6, delta: -8 }],
      duplicationDeltas: [{ file: "src/a.ts", line: 30, duplicateOfLine: 12, lines: 9 }],
    };
    const response = await post(env, body);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(subset(body));
    // The mirror exposes exactly the tool's three fields — no extra assessment internals.
    expect(Object.keys(payload as object).sort()).toEqual(["band", "findings", "improvementScore"]);
  });

  it("matches the scorer across empty, test-only, and coverage-regression inputs", async () => {
    const env = createTestEnv();
    for (const body of [
      {},
      { changedFiles: [] },
      { changedFiles: [{ path: "src/a.ts" }] },
      { changedFiles: [{ path: "src/a.ts" }], tests: ["ran the suite"] },
      { changedFiles: [{ path: "src/a.ts" }], patchCoverageDeltaPercent: -12 },
      { complexityDeltas: [{ file: "src/a.ts", line: 1, name: "f", before: 2, after: 9, delta: 7 }] },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      await expect(response.json()).resolves.toEqual(subset(body));
    }
  });

  it("rejects input the tool's shape rejects, with 400", async () => {
    const env = createTestEnv();
    for (const body of [
      { changedFiles: [{ path: "" }] },
      { changedFiles: [{ path: "src/a.ts", additions: -1 }] },
      { complexityDeltas: [{ file: "src/a.ts", line: 0, name: "f", before: 1, after: 1, delta: 0 }] },
      { duplicationDeltas: [{ file: "src/a.ts", line: 1, duplicateOfLine: 1, lines: 0 }] },
      { patchCoverageDeltaPercent: "lots" },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_improvement_potential_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("is public-safe: no wallet/hotkey/trust-score terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { changedFiles: [{ path: "src/a.ts" }] })).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });
});
