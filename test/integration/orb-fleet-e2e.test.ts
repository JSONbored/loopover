import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFleetAnalytics } from "../../src/orb/analytics";
import { handleOrbIngest } from "../../src/orb/ingest";
import { exportOrbBatch } from "../../src/selfhost/orb-collector";
import { createTestEnv } from "../helpers/d1";

// End-to-end seam test for the Orb fleet pipeline: a self-host instance's review_audit ledger →
// exportOrbBatch (the FLEET_QUERY join + payload) → handleOrbIngest (orb_signals upsert) →
// computeFleetAnalytics. The three stages are unit-tested in isolation, but nothing else asserts they
// COMPOSE on a consistent target_id/repo_hash/pr_hash key — the exact seam where the source filter or
// the gate_decision↔pr_outcome join can silently break before anything fleet-derived is built on it.

// Anonymization OFF so repo_hash/pr_hash are the readable project/target_id; the export gate is satisfied
// for both the current (ORB_ENABLED) and hardwired (GITHUB_APP_PRIVATE_KEY) export paths.
const ORB_ENV = {
  ORB_ENABLED: "true",
  ORB_ANONYMIZE: "false",
  ORB_APP_ID: "orb-e2e",
  ORB_WEBHOOK_SECRET: "e2e-secret",
  GITHUB_APP_PRIVATE_KEY: "e2e-app-key",
} as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const [k, v] of Object.entries(ORB_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.ORB_AIR_GAP;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const PROJECT = "owner/repo";
let rowSeq = 0;

/** A fetch stub that records the single exported request body (always a string). */
function capturingFetch(): { fn: typeof fetch; body: () => string } {
  let captured = "";
  const fn = (async (_url: string, init?: RequestInit) => {
    captured = String(init?.body);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, body: () => captured };
}

/** Seed a complete review_audit "decided PR": a native gate_decision + the realized pr_outcome (+ a reversal). */
async function seedDecidedPr(
  db: D1Database,
  opts: { pr: number; verdict: "merge" | "close"; outcome: "merged" | "closed"; reversal?: "reversal_reverted" | "reversal_reopened" },
): Promise<void> {
  const targetId = `${PROJECT}#${opts.pr}`;
  const at = (hour: number): string => `2026-06-01T0${hour}:00:00Z`;
  const insert = (id: string, eventType: string, decision: string | null, createdAt: string): Promise<unknown> =>
    db
      .prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, ?, ?, 'gittensory-native', ?, 'ready', ?)`)
      .bind(id, PROJECT, targetId, eventType, decision, `sha${opts.pr}`, createdAt)
      .run();
  await insert(`gd-${rowSeq++}`, "gate_decision", opts.verdict, at(1));
  await insert(`po-${rowSeq++}`, "pr_outcome", opts.outcome, at(2));
  if (opts.reversal) await insert(`rev-${rowSeq++}`, opts.reversal, null, at(3));
}

describe("Orb fleet pipeline end-to-end (review_audit → export → ingest → analytics)", () => {
  it("carries 5 clean merges through every stage into a 100%-precision fleet of one", async () => {
    const env = createTestEnv();
    for (let pr = 1; pr <= 5; pr++) await seedDecidedPr(env.DB, { pr, verdict: "merge", outcome: "merged" });

    // Stage 1: export reads the ledger and builds the anonymized batch (captured, not sent).
    const cap = capturingFetch();
    const exported = await exportOrbBatch(env.DB, 200, cap.fn);
    expect(exported).toBe(5);
    const payload = JSON.parse(cap.body()) as { instance_id: string; events: Array<Record<string, unknown>> };
    expect(payload.events).toHaveLength(5);
    expect(payload.events[0]).toMatchObject({
      repo_hash: PROJECT,
      pr_hash: `${PROJECT}#1`,
      gate_verdict: "merge",
      outcome: "merged",
      reversal_flag: "none",
    });

    // Stage 2: the central collector ingests that exact payload into orb_signals.
    expect(await handleOrbIngest(cap.body(), env.DB)).toEqual({ accepted: 5 });

    // Stage 3: analytics aggregates the instance — 5 decided ≥ MIN_DECIDED, all correct merges.
    const fleet = await computeFleetAnalytics(env, { windowDays: 365 });
    expect(fleet.instanceCount).toBe(1);
    expect(fleet.fleet.mergePrecision).toBe(1);
    expect(fleet.fleet.reversalRate).toBe(0);
    expect(fleet.instances[0]?.instanceId).toBe(payload.instance_id);
  });

  it("propagates a human reversal (reverted merge) end-to-end into the fleet's reversal + FP rates", async () => {
    const env = createTestEnv();
    for (let pr = 1; pr <= 5; pr++) await seedDecidedPr(env.DB, { pr, verdict: "merge", outcome: "merged" });
    await seedDecidedPr(env.DB, { pr: 6, verdict: "merge", outcome: "merged", reversal: "reversal_reverted" });

    const cap = capturingFetch();
    expect(await exportOrbBatch(env.DB, 200, cap.fn)).toBe(6);
    const reverted = (JSON.parse(cap.body()) as { events: Array<Record<string, unknown>> }).events.find((e) => e.pr_hash === `${PROJECT}#6`);
    expect(reverted?.reversal_flag).toBe("reverted");

    expect(await handleOrbIngest(cap.body(), env.DB)).toEqual({ accepted: 6 });

    const fleet = await computeFleetAnalytics(env, { windowDays: 365 });
    expect(fleet.instanceCount).toBe(1);
    expect(fleet.fleet.reversalRate).toBeCloseTo(1 / 6, 5);
    expect(fleet.fleet.fpRate).toBeGreaterThan(0); // a reverted merge is a false positive
  });
});
