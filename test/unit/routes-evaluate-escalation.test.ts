import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { evaluateEscalation } from "../../src/loop-escalation";
import { createTestEnv } from "../helpers/d1";

// #6754: POST /v1/loop/evaluate-escalation — the REST mirror bringing loopover_evaluate_escalation to the same
// parity its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. The route delegates to
// the pure evaluateEscalation (covered by its own unit tests), so these pin the ROUTE contract: the decision is
// returned unmodified for every precedence arm, and a bad body is rejected.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/loop/evaluate-escalation";

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/loop/evaluate-escalation (#6754)", () => {
  it("returns the escalation decision for a healthy running loop (no escalation)", async () => {
    const env = createTestEnv();
    const response = await post(env, { runStatus: "running", healthStatus: "healthy" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ shouldEscalate: false, action: "none", severity: "none" });
  });

  it("escalates each precedence arm exactly as the pure evaluator does", async () => {
    const env = createTestEnv();
    // One case per precedence branch: killRequested > error/critical > abandoned/customerFlagged > degraded.
    const cases = [
      { runStatus: "running", killRequested: true },
      { runStatus: "error" },
      { runStatus: "running", healthStatus: "critical" },
      { runStatus: "abandoned" },
      { runStatus: "running", customerFlagged: true },
      { runStatus: "running", healthStatus: "degraded" },
      { runStatus: "converged" },
    ] as const;
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      // PARITY: the route must return exactly what the pure evaluator the MCP tool calls returns.
      await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(evaluateEscalation(body))));
    }
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [{}, { runStatus: "bogus" }, { runStatus: "running", healthStatus: "on-fire" }, { runStatus: "running", killRequested: "yes" }]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_evaluate_escalation_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("leaks no wallet/hotkey/trust-score terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { runStatus: "error" })).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
