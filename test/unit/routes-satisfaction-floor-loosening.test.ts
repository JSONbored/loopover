import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

// POST /v1/internal/calibration/loosen-satisfaction-floor (#8121 narrow start): the manual trigger for one
// backtest-gated loosening evaluation. Mirrors routes-internal-decision-calibration.test.ts's bearer-gate
// pattern; the loop's own behavior is covered in satisfaction-floor-loosening-run.test.ts — this file pins
// the route's flag-gate, auth, and response shape only.

const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });
const enabledEnv = () => createTestEnv({ SATISFACTION_FLOOR_AUTOTUNE_ENABLED: "true" as never });

describe("POST /v1/internal/calibration/loosen-satisfaction-floor (#8121)", () => {
  it("404s when the autotune flag is off — the endpoint does not exist on a deploy that has not opted in", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/internal/calibration/loosen-satisfaction-floor", { method: "POST", headers: bearer(env) }, env);
    expect(res.status).toBe(404);
  });

  it("401s without the internal token (the /v1/internal/* middleware gate), even when the flag is on", async () => {
    const app = createApp();
    const env = enabledEnv();
    expect((await app.request("/v1/internal/calibration/loosen-satisfaction-floor", { method: "POST" }, env)).status).toBe(401);
    expect(
      (await app.request("/v1/internal/calibration/loosen-satisfaction-floor", { method: "POST", headers: { authorization: "Bearer nope" } }, env)).status,
    ).toBe(401);
  });

  it("200s with the run result on an empty corpus (no_proposal) — evaluating is always safe, applying is gated", async () => {
    const app = createApp();
    const env = enabledEnv();
    const res = await app.request("/v1/internal/calibration/loosen-satisfaction-floor", { method: "POST", headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false, reason: "no_proposal" });
  });
});
