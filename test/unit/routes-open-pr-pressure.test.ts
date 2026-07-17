import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { simulateOpenPrPressure, type OpenPrPressureInput } from "../../src/services/open-pr-pressure-scenarios";
import { createTestEnv } from "../helpers/d1";

// #6751: POST /v1/lint/open-pr-pressure — the REST mirror of loopover_simulate_open_pr_pressure. The route
// parses with the tool's OWN exported simulateOpenPrPressureShape and delegates to the same pure
// simulateOpenPrPressure (whose ranking is covered by its own tests), so these pin the ROUTE contract:
// the simulation returned unmodified, and the shape's rejections.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/lint/open-pr-pressure";
const post = (env: Env, body: unknown) => createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

const SIGNALS = {
  openIssues: 12,
  openPullRequests: 9,
  unlinkedPullRequests: 3,
  stalePullRequests: 2,
  draftPullRequests: 1,
  maintainerAuthoredPullRequests: 1,
  collisionClusters: 1,
  ageBuckets: { under7Days: 4, days7To30: 3, over30Days: 2 },
  likelyReviewablePullRequests: 5,
};
const QUEUE_HEALTH = {
  repoFullName: "acme/widgets",
  generatedAt: "2026-07-17T00:00:00.000Z",
  burdenScore: 42.5,
  level: "high" as const,
  summary: "Queue is backed up.",
  signals: SIGNALS,
  findings: [],
};
const VALID = {
  repoFullName: "acme/widgets",
  generatedAt: "2026-07-17T00:00:00.000Z",
  queueHealth: QUEUE_HEALTH,
  roleContext: { maintainerLane: false },
  contributorOpenPrCount: 3,
};

describe("POST /v1/lint/open-pr-pressure (#6751)", () => {
  it("returns exactly what the pure simulator returns (parity)", async () => {
    const env = createTestEnv();
    const response = await post(env, VALID);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(simulateOpenPrPressure(VALID as unknown as OpenPrPressureInput))));
  });

  it("covers each queue-health level and both role lanes", async () => {
    const env = createTestEnv();
    for (const level of ["low", "medium", "high", "critical"] as const) {
      for (const maintainerLane of [true, false]) {
        const body = { ...VALID, queueHealth: { ...QUEUE_HEALTH, level }, roleContext: { maintainerLane } };
        const response = await post(env, body);
        expect(response.status, `${level}/${maintainerLane}`).toBe(200);
        await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(simulateOpenPrPressure(body as unknown as OpenPrPressureInput))));
      }
    }
  });

  it("treats contributorOpenPrCount as optional and queueHealth as nullable, exactly like the tool's shape", async () => {
    const env = createTestEnv();
    const { contributorOpenPrCount: _omitted, ...withoutCount } = VALID;
    expect((await post(env, withoutCount)).status).toBe(200);
    // The shape declares queueHealth .nullable() — a repo with no computed health must still simulate.
    const nullHealth = { ...VALID, queueHealth: null };
    const response = await post(env, nullHealth);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(simulateOpenPrPressure(nullHealth as unknown as OpenPrPressureInput))));
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [
      {},
      { ...VALID, repoFullName: "ab" },
      { ...VALID, queueHealth: { ...QUEUE_HEALTH, level: "bogus" } },
      { ...VALID, queueHealth: { ...QUEUE_HEALTH, burdenScore: Number.POSITIVE_INFINITY } },
      { ...VALID, roleContext: {} },
      { ...VALID, contributorOpenPrCount: -1 },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_open_pr_pressure_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("is public-safe: no wallet/hotkey/trust-score terms in the simulation", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, VALID)).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });
});
