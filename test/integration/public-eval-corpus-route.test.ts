import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { createSignalStore } from "../../src/review/signal-tracking-wire";

// #9636: the route that makes the verifiability walkthrough's step 1 runnable by a stranger. The
// load-bearing properties are that it needs no Authorization header, that it publishes nothing
// identifying, and that its checksum commits to the bytes the caller just received.

function enabledEnv(): Env {
  return createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
}

async function seed(env: Env, targetKey: string, verdict: "confirmed" | "reversed"): Promise<void> {
  const store = createSignalStore(env);
  await store.recordRuleFired({ ruleId: "ai_consensus_defect", targetKey, outcome: "close", occurredAt: new Date().toISOString(), metadata: { confidence: 0.6 } });
  await store.recordHumanOverride({ ruleId: "ai_consensus_defect", targetKey, verdict, occurredAt: new Date().toISOString() });
}

describe("GET /v1/public/eval-corpus (#9636)", () => {
  it("answers 200 with NO Authorization header -- the whole point of the endpoint", async () => {
    const env = enabledEnv();
    await seed(env, "acme/widgets#1", "confirmed");
    const response = await createApp().request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ruleId: string; caseCount: number; checksum: string; truncated: boolean };
    expect(body.ruleId).toBe("ai_consensus_defect");
    expect(body.caseCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("INVARIANT: the response body never carries a target key, repo, or PR number", async () => {
    const env = enabledEnv();
    await seed(env, "acme/private-widgets#4242", "reversed");
    const response = await createApp().request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, env);
    expect(await response.text()).not.toMatch(/acme|private-widgets|4242|targetKey/i);
  });

  it("the published checksum is recomputable from the published cases alone", async () => {
    const env = enabledEnv();
    await seed(env, "acme/widgets#2", "confirmed");
    const body = (await (await createApp().request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, env)).json()) as {
      checksum: string;
      cases: unknown[];
    };
    // Exactly what a third party runs: hash the canonicalized cases array they were handed.
    const { canonicalJson, sha256Hex } = await import("../../src/review/decision-record");
    expect(await sha256Hex(canonicalJson(body.cases))).toBe(body.checksum);
  });

  it("400s without a ruleId rather than silently picking one", async () => {
    const response = await createApp().request("/v1/public/eval-corpus", {}, enabledEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "rule_id_required" });
  });

  it("404s when LOOPOVER_PUBLIC_STATS is off (default) -- same flag as its siblings", async () => {
    const response = await createApp().request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, createTestEnv());
    expect(response.status).toBe(404);
  });

  it("returns an empty but still-checksummed corpus for a rule with no history", async () => {
    const response = await createApp().request("/v1/public/eval-corpus?ruleId=never_fired", {}, enabledEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { caseCount: number; cases: unknown[]; checksum: string };
    expect(body).toMatchObject({ caseCount: 0, cases: [] });
    // sha256("[]") -- an empty corpus is still committed to, distinguishably.
    expect(body.checksum).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  });

  it("sets the same Cache-Control posture as its public siblings", async () => {
    const response = await createApp().request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, enabledEnv());
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
  });
});
