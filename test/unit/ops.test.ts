import { describe, expect, it } from "vitest";
import {
  computeAgentHealth,
  computeCalibration,
  handleInternalCalibration,
  handleInternalDecision,
  handleInternalStatus,
  type OpsAgentConfig,
} from "../../src/review/ops";

// ── computeCalibration (ported from reviewbot test/calibration.test.ts) ──────────────────────────

function calibrationEnv(merged: Array<{ id: string; confidence: number }>, revertedIds: string[]): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () =>
                sql.includes("FROM review_targets")
                  ? { results: merged.map((m) => ({ id: m.id, decision_json: JSON.stringify({ verdict: "merge", confidence: m.confidence }) })) }
                  : { results: revertedIds.map((target_id) => ({ target_id })) },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

const calConfig: OpsAgentConfig = { slug: "metagraphed", confidenceFloor: 0.9, secrets: {} };

describe("computeCalibration", () => {
  it("recommends raising the floor above the highest-confidence reverted merge", async () => {
    const env = calibrationEnv([{ id: "a", confidence: 0.95 }, { id: "b", confidence: 0.92 }, { id: "c", confidence: 0.99 }], ["b"]);
    const cal = await computeCalibration(env, calConfig);
    expect(cal.revertedCount).toBe(1);
    expect(cal.revertedMaxConfidence).toBe(0.92);
    expect(cal.recommendedFloor).toBe(0.94); // 0.92 + 0.02
  });

  it("recommends no change when nothing was reverted", async () => {
    const env = calibrationEnv([{ id: "a", confidence: 0.95 }], []);
    const cal = await computeCalibration(env, calConfig);
    expect(cal.recommendedFloor).toBeNull();
    expect(cal.note).toMatch(/adequate/);
  });

  it("recommends no change when the floor already sits above the reverted merges", async () => {
    const env = calibrationEnv([{ id: "a", confidence: 0.85 }], ["a"]); // reverted at 0.85, floor 0.9 already higher
    const cal = await computeCalibration(env, calConfig);
    expect(cal.recommendedFloor).toBeNull();
  });
});

describe("handleInternalCalibration", () => {
  const cfg: OpsAgentConfig = { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } };
  const env = (extra: Record<string, unknown>) => ({ ...calibrationEnv([], []), ...extra }) as unknown as Env;

  it("404 when no internalSecret is configured", async () => {
    const r = await handleInternalCalibration(new Request("https://x/c"), env({}), { slug: "x", secrets: {} });
    expect(r.status).toBe(404);
  });
  it("401 on a bad bearer", async () => {
    const r = await handleInternalCalibration(new Request("https://x/c", { headers: { authorization: "Bearer nope" } }), env({ INTERNAL_SECRET: "s3cret" }), cfg);
    expect(r.status).toBe(401);
  });
  it("200 + calibration for the correct token", async () => {
    const r = await handleInternalCalibration(new Request("https://x/c", { headers: { authorization: "Bearer s3cret" } }), env({ INTERNAL_SECRET: "s3cret" }), cfg);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { calibration: { currentFloor: number } };
    expect(body.calibration.currentFloor).toBe(0.9);
  });
});

// ── handleInternalDecision (ported from reviewbot test/decision-endpoint.test.ts) ────────────────

function decisionEnv(targetRow: Record<string, unknown> | null): Env {
  return {
    INTERNAL_SECRET: "s3cret",
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => (sql.includes("SELECT * FROM review_targets") ? targetRow : null),
              all: async () => ({ results: sql.includes("review_audit") ? [{ event_type: "reviewed", decision: "manual", summary: "needs human", created_at: "2026-06-13T00:00:00Z" }] : [] }),
            };
          },
        };
      },
    },
  } as unknown as Env;
}

const decisionConfig: OpsAgentConfig = { slug: "metagraphed", secrets: { internalSecret: "INTERNAL_SECRET" } };
const auth = { authorization: "Bearer s3cret" };
const url = "https://x/metagraphed/internal/decision?repo=o/r&number=5";

describe("handleInternalDecision", () => {
  it("404 when no internalSecret is configured", async () => {
    const cfg: OpsAgentConfig = { slug: "x", secrets: {} };
    const r = await handleInternalDecision(new Request(url), decisionEnv(null), cfg);
    expect(r.status).toBe(404);
  });

  it("401 on a bad bearer", async () => {
    const r = await handleInternalDecision(new Request(url, { headers: { authorization: "Bearer nope" } }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(401);
  });

  it("400 when repo/number are missing or malformed", async () => {
    const r = await handleInternalDecision(new Request("https://x/metagraphed/internal/decision?repo=bad", { headers: auth }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(400);
  });

  it("404 when the target doesn't exist", async () => {
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(404);
  });

  it("returns the cached decision + audit trail for an existing target", async () => {
    const row = {
      id: "metagraphed:pull_request:o/r#5",
      project: "metagraphed",
      kind: "pull_request",
      repo: "o/r",
      number: 5,
      status: "manual",
      attempt_count: 1,
      terminal_at: null,
      decided_sha: "abc",
      decision_json: JSON.stringify({ verdict: "manual", summary: "ownership-sensitive", confidence: 0.4 }),
    };
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(row), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { status: string; attemptCount: number }; decision: { verdict: string }; audit: unknown[] };
    expect(body.target.status).toBe("manual");
    expect(body.target.attemptCount).toBe(1);
    expect(body.decision.verdict).toBe("manual");
    expect(body.audit).toHaveLength(1);
  });
});

// ── computeAgentHealth + handleInternalStatus (native D1 + injected gate deps) ────────────────────

function healthEnv(): Env {
  return {
    INTERNAL_SECRET: "s3cret",
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes("status IN ('merged', 'closed')")) return { n: 2 }; // recent auto-actions denominator
                if (sql.includes("event_type = 'dead_lettered'") && sql.includes("COUNT(*)")) return { n: 0 };
                return { n: 0 };
              },
              all: async () => {
                if (sql.includes("GROUP BY status")) return { results: [{ status: "merged", n: 8 }, { status: "manual", n: 2 }, { status: "queued", n: 1 }] };
                if (sql.includes("GROUP BY verdict")) return { results: [{ verdict: "merge", n: 8 }, { verdict: "manual", n: 2 }] };
                if (sql.includes("reversal_reverted")) return { results: [{ number: 99, repo: "o/r", status: "merged", event_type: "reversal_reverted" }] };
                if (sql.includes("event_type IN ('reviewed', 'shadow_reviewed')")) return { results: [{ target_id: "t1", decision: "merge", summary: "ok", created_at: "2026-06-13T00:00:00Z" }] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

const healthConfig: OpsAgentConfig = { slug: "gittensory", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } };

describe("computeAgentHealth (native D1, default gate deps)", () => {
  it("computes terminal/manual-rate/reversals from the ledger; defaults to no config issues / unfrozen", async () => {
    const h = await computeAgentHealth(healthEnv(), healthConfig);
    expect(h.byStatus.merged).toBe(8);
    expect(h.nonTerminal).toBe(1); // queued
    expect(h.terminalCount).toBe(10); // merged 8 + manual 2
    expect(h.manualRate).toBe(0.2);
    expect(h.reversals).toBe(1);
    expect(h.reversalRate).toBe(0.5); // 1 reversal / 2 recent auto-actions
    expect(h.configIssues).toEqual([]);
    expect(h.frozen).toBe(false);
    expect(h.holdOnly).toBe(false);
  });

  it("threads injected gate deps (config invariants + kill-switch + circuit-breaker)", async () => {
    const h = await computeAgentHealth(healthEnv(), healthConfig, {
      validateAgentConfig: () => ["bad slug"],
      isFrozen: async () => true,
      isHoldOnly: async () => true,
    });
    expect(h.configIssues).toEqual(["bad slug"]);
    expect(h.frozen).toBe(true);
    expect(h.holdOnly).toBe(true);
  });
});

describe("handleInternalStatus", () => {
  it("401 on a bad bearer", async () => {
    const r = await handleInternalStatus(new Request("https://x/s", { headers: { authorization: "Bearer nope" } }), healthEnv(), healthConfig);
    expect(r.status).toBe(401);
  });
  it("200 + health snapshot for the correct token, folding the injected AI-error count", async () => {
    const r = await handleInternalStatus(new Request("https://x/s", { headers: auth }), healthEnv(), healthConfig, {
      validateAgentConfig: () => [],
      isFrozen: async () => false,
      isHoldOnly: async () => false,
      recentAiErrorCount: async () => 4,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { health: { manualRate: number; aiErrors: number }; recent: unknown[] };
    expect(body.health.manualRate).toBe(0.2);
    expect(body.health.aiErrors).toBe(4);
    expect(body.recent).toHaveLength(1);
  });
});
