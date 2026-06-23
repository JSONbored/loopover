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

  it("treats a missing confidenceFloor as 0 (config.confidenceFloor ?? 0)", async () => {
    const env = calibrationEnv([{ id: "a", confidence: 0.5 }], ["a"]); // reverted at 0.5 → suggest 0.52 > floor 0
    const cal = await computeCalibration(env, { slug: "x", secrets: {} }); // no confidenceFloor
    expect(cal.currentFloor).toBe(0);
    expect(cal.recommendedFloor).toBe(0.52);
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
  it("401 when the configured secret env var is not a string (readSecret `?? \"\"`)", async () => {
    // INTERNAL_SECRET is a number → readSecret returns "" → `!expected` → 401
    const r = await handleInternalCalibration(new Request("https://x/c", { headers: { authorization: "Bearer s3cret" } }), env({ INTERNAL_SECRET: 12345 }), cfg);
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

  it("400 (and exercises the no-repo-param `?? \"\"` fallback) when repo is absent", async () => {
    const r = await handleInternalDecision(new Request("https://x/metagraphed/internal/decision?number=5", { headers: auth }), decisionEnv(null), decisionConfig);
    expect(r.status).toBe(400);
  });

  it("401 when no authorization header is sent (header `?? \"\"` fallback)", async () => {
    const r = await handleInternalDecision(new Request(url), decisionEnv(null), decisionConfig); // no headers
    expect(r.status).toBe(401);
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
  it("defaults frozen/holdOnly to false in the response when the gate deps resolve undefined", async () => {
    // health.frozen / health.holdOnly come back undefined → the `?? false` fallbacks (lines 350-351)
    const r = await handleInternalStatus(new Request("https://x/s", { headers: auth }), healthEnv(), healthConfig, {
      validateAgentConfig: () => [],
      isFrozen: async () => undefined as unknown as boolean,
      isHoldOnly: async () => undefined as unknown as boolean,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { health: { frozen: boolean; holdOnly: boolean } };
    expect(body.health.frozen).toBe(false);
    expect(body.health.holdOnly).toBe(false);
  });

  it("defaults the AI-error count to 0 and recent[] to empty when deps/rows are absent", async () => {
    // env whose DB returns undefined `results` everywhere (exercises the `?? []` / `?? 0` fallbacks)
    const emptyEnv = {
      INTERNAL_SECRET: "s3cret",
      DB: {
        prepare() {
          return { bind() { return { first: async () => undefined, all: async () => ({}) }; } };
        },
      },
    } as unknown as Env;
    const r = await handleInternalStatus(new Request("https://x/s", { headers: auth }), emptyEnv, healthConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { health: { aiErrors: number; manualRate: number; reversalRate: number; frozen: boolean; holdOnly: boolean }; counts: { byStatus: Record<string, number> }; recent: unknown[] };
    expect(body.health.aiErrors).toBe(0); // defaultRecentAiErrorCount
    expect(body.health.manualRate).toBe(0); // terminalCount 0 → ternary false branch
    expect(body.health.reversalRate).toBe(0); // recentAutoActions 0 → ternary false branch
    expect(body.health.frozen).toBe(false); // health.frozen ?? false (undefined → false not exercised, but default deps give false)
    expect(body.counts.byStatus).toEqual({});
    expect(body.recent).toEqual([]);
  });
});

// ── timingSafeEqual: native crypto.subtle.timingSafeEqual fast-path (line 99) ─────────────────────

describe("requireInternalAuth via native crypto.subtle.timingSafeEqual", () => {
  it("uses the runtime's timingSafeEqual when present (equal-length, matching token)", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
    const had = "timingSafeEqual" in subtle;
    const calls: number[] = [];
    // Inject a native-style timingSafeEqual that does a real byte compare so the gate still works.
    (subtle as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual = (a, b) => {
      calls.push(1);
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
      return true;
    };
    try {
      const r = await handleInternalCalibration(
        new Request("https://x/c", { headers: { authorization: "Bearer s3cret" } }),
        { ...calibrationEnv([], []), INTERNAL_SECRET: "s3cret" } as unknown as Env,
        { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } },
      );
      expect(r.status).toBe(200); // matched via the native path
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      if (!had) delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });

  it("compares unequal-length tokens byte-wise via the fallback (left shorter → leftBytes[i] ?? 0)", async () => {
    // provided "Bearer s3cre" (12) is SHORTER than expected "Bearer s3cret" (13): the loop reads
    // leftBytes past its end → the `?? 0` fallback on the left operand (line 104).
    const r = await handleInternalCalibration(
      new Request("https://x/c", { headers: { authorization: "Bearer s3cre" } }),
      { ...calibrationEnv([], []), INTERNAL_SECRET: "s3cret" } as unknown as Env,
      { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } },
    );
    expect(r.status).toBe(401);
  });

  it("returns 401 via the native path when lengths differ (skips the native call)", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
    const had = "timingSafeEqual" in subtle;
    (subtle as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual = () => true; // would wrongly pass if called
    try {
      const r = await handleInternalCalibration(
        // provided "Bearer x" length != "Bearer s3cret" length → short-circuits before timingSafeEqual
        new Request("https://x/c", { headers: { authorization: "Bearer x" } }),
        { ...calibrationEnv([], []), INTERNAL_SECRET: "s3cret" } as unknown as Env,
        { slug: "metagraphed", confidenceFloor: 0.9, secrets: { internalSecret: "INTERNAL_SECRET" } },
      );
      expect(r.status).toBe(401);
    } finally {
      if (!had) delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });
});

// ── confidenceOf / decision-parse error paths (lines 271, 392) ────────────────────────────────────

describe("computeCalibration confidenceOf branches", () => {
  it("skips merges with null decision_json and merges whose confidence isn't a number", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                all: async () => {
                  if (sql.includes("status = 'merged'")) {
                    return {
                      results: [
                        { id: "a", decision_json: null }, // confidenceOf → null (if !j)
                        { id: "b", decision_json: "{not json" }, // JSON.parse throws → catch returns null (line 271)
                        { id: "c", decision_json: JSON.stringify({ confidence: "high" }) }, // non-number → null
                        { id: "d", decision_json: JSON.stringify({ confidence: 0.8 }) }, // counted
                      ],
                    };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const cal = await computeCalibration(env, calConfig);
    // only "d" had a numeric confidence and was kept (none reverted)
    expect(cal.keptAvgConfidence).toBe(0.8);
    expect(cal.recommendedFloor).toBeNull();
    expect(cal.note).toMatch(/adequate/);
  });

  it("defaults closesByReason + disputedByReason to [] when those queries return no results", async () => {
    const env = {
      DB: { prepare() { return { bind() { return { all: async () => ({}) }; } }; } }, // every query: undefined results
    } as unknown as Env;
    const cal = await computeCalibration(env, calConfig);
    expect(cal.closesByReason).toEqual([]);
    expect(cal.disputedCloseCount).toBe(0);
    expect(cal.mergedCount).toBe(0);
    expect(cal.revertedCount).toBe(0);
  });

  it("populates closesByReason + disputedCloseCount and tolerates absent rows", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                all: async () => {
                  if (sql.includes("status = 'closed' GROUP BY rc")) return { results: [{ rc: "duplicate", n: 5 }, { rc: "conflict", n: 2 }] };
                  if (sql.includes("reversal_reopened")) return { results: [{ rc: "duplicate", n: 1 }] };
                  return {}; // merged + reverted: undefined results → `?? []` fallback
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const cal = await computeCalibration(env, calConfig);
    expect(cal.mergedCount).toBe(0);
    expect(cal.closesByReason[0]).toEqual({ reasonCode: "duplicate", closes: 5, disputed: 1 });
    expect(cal.closesByReason[1]).toEqual({ reasonCode: "conflict", closes: 2, disputed: 0 });
    expect(cal.disputedCloseCount).toBe(1);
  });
});

describe("handleInternalDecision decision_json parse + nullish target fields", () => {
  it("returns decision:null when the cached decision_json is malformed (catch, line 392)", async () => {
    const row = {
      id: "metagraphed:pull_request:o/r#5",
      project: "metagraphed",
      kind: "pull_request",
      repo: "o/r",
      number: 5,
      status: "manual",
      verdict: null, // exercises `target.verdict ?? null`
      head_sha: null,
      decided_sha: null,
      attempt_count: null, // exercises `attempt_count ?? 0`
      terminal_at: null,
      decision_json: "{broken json", // JSON.parse throws → decision = null
    };
    const r = await handleInternalDecision(new Request(url, { headers: auth }), decisionEnv(row), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { decision: unknown; target: { verdict: unknown; attemptCount: number; headSha: unknown; decidedSha: unknown } };
    expect(body.decision).toBeNull();
    expect(body.target.verdict).toBeNull();
    expect(body.target.attemptCount).toBe(0);
    expect(body.target.headSha).toBeNull();
    expect(body.target.decidedSha).toBeNull();
  });

  it("defaults the audit list to empty when review_audit returns no results", async () => {
    const row = {
      id: "metagraphed:pull_request:o/r#5",
      repo: "o/r",
      number: 5,
      kind: "pull_request",
      status: "merged",
      verdict: "merge",
      head_sha: "abc",
      decided_sha: "abc",
      attempt_count: 2,
      terminal_at: "2026-06-13T00:00:00Z",
      decision_json: null, // skips the parse block entirely (if target.decision_json false branch)
    };
    const env = {
      INTERNAL_SECRET: "s3cret",
      DB: {
        prepare(sql: string) {
          return { bind() { return { first: async () => (sql.includes("SELECT * FROM review_targets") ? row : null), all: async () => ({}) }; } };
        },
      },
    } as unknown as Env;
    const r = await handleInternalDecision(new Request(url, { headers: auth }), env, decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { decision: unknown; audit: unknown[]; target: { terminalAt: unknown } };
    expect(body.decision).toBeNull();
    expect(body.audit).toEqual([]);
    expect(body.target.terminalAt).toBe("2026-06-13T00:00:00Z");
  });

  it("defaults kind to pull_request when ?kind is an unknown value", async () => {
    // exercises the `params.get("kind") === "issue" ? "issue" : "pull_request"` false branch with a non-issue value
    const row = { id: "metagraphed:pull_request:o/r#5", repo: "o/r", number: 5, kind: "pull_request", status: "merged", verdict: "merge", head_sha: "a", decided_sha: "a", attempt_count: 1, terminal_at: null, decision_json: null };
    const r = await handleInternalDecision(new Request("https://x/d?repo=o/r&number=5&kind=bogus", { headers: auth }), decisionEnv(row), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { kind: string } };
    expect(body.target.kind).toBe("pull_request");
  });

  it("treats ?kind=issue as an issue target", async () => {
    const row = { id: "metagraphed:issue:o/r#5", repo: "o/r", number: 5, kind: "issue", status: "merged", verdict: "merge", head_sha: "a", decided_sha: "a", attempt_count: 1, terminal_at: null, decision_json: null };
    const r = await handleInternalDecision(new Request("https://x/d?repo=o/r&number=5&kind=issue", { headers: auth }), decisionEnv(row), decisionConfig);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: { kind: string } };
    expect(body.target.kind).toBe("issue");
  });
});

// ── computeAgentHealth: empty ledger fallbacks (the `?? []` / `?? 0` / ternary false sides) ────────

describe("computeAgentHealth empty-ledger fallbacks", () => {
  it("returns a zeroed snapshot when every query is empty (results undefined, counts undefined)", async () => {
    const emptyEnv = {
      DB: {
        prepare() {
          return { bind() { return { first: async () => undefined, all: async () => ({}) }; } };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(emptyEnv, healthConfig);
    expect(h.byStatus).toEqual({});
    expect(h.byVerdict).toEqual({});
    expect(h.terminalCount).toBe(0);
    expect(h.nonTerminal).toBe(0);
    expect(h.manualRate).toBe(0); // terminalCount 0 → ternary false branch
    expect(h.stuckRetryable).toBe(0); // byStatus.error_retryable ?? 0
    expect(h.failed).toBe(0);
    expect(h.dlqCount).toBe(0); // dlqCountRow?.n ?? dlqTargets.length (both fall through)
    expect(h.dlqTargets).toEqual([]);
    expect(h.reversals).toBe(0);
    expect(h.reversalRate).toBe(0); // recentAutoActions 0 → ternary false branch
  });

  it("computes manualRate with a present terminalCount but no manual rows (byStatus.manual ?? 0 fallback)", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => ({}),
                all: async () => {
                  if (sql.includes("GROUP BY status")) return { results: [{ status: "merged", n: 4 }] }; // terminal but no `manual`
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.terminalCount).toBe(4);
    expect(h.manualRate).toBe(0); // (byStatus.manual ?? 0) / 4
  });

  it("maps recent failed (status='error') rows into failedTargets", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => ({ n: 0 }),
                all: async () => {
                  if (sql.includes("status = 'error' AND updated_at")) return { results: [{ number: 42, repo: "o/r", verdict: null, last_error: "boom" }] };
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.failed).toBe(1);
    expect(h.failedTargets?.[0]).toEqual({ number: 42, repo: "o/r", verdict: null, lastError: "boom" });
  });

  it("uses dlqTargets.length as the dlqCount fallback when the COUNT row lacks n", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => {
                  if (sql.includes("status IN ('merged', 'closed')")) return { n: 1 };
                  if (sql.includes("event_type = 'dead_lettered'") && sql.includes("COUNT(*)")) return {}; // no n → `?? dlqTargets.length`
                  return {};
                },
                all: async () => {
                  // dead-letter display sample (has rows) — and a row with verdict/last_error null
                  if (sql.includes("event_type = 'dead_lettered'")) return { results: [{ number: 7, repo: "o/r", verdict: null, last_error: null }] };
                  return {};
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const h = await computeAgentHealth(env, healthConfig);
    expect(h.dlqTargets).toHaveLength(1);
    expect(h.dlqCount).toBe(1); // fell back to dlqTargets.length
  });
});
