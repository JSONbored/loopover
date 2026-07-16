import { describe, expect, it, vi } from "vitest";
import {
  type AutoApplyContext,
  applyOverrideRecommendation,
  deleteLiveOverride,
  deleteShadowOverride,
  describeOverride,
  evaluateShadowPromotion,
  isStrictlyTightening,
  listOverrideAudit,
  loadOverride,
  loadShadowOverride,
  mergeOverride,
  recordOverrideAudit,
  rowToOverride,
  runAutoApplyRecommendations,
  sanitizeOverridePayload,
  SHADOW_PROMOTION_MIN_DECIDED,
  type StorageEnv,
  type StorageLike,
  toLiveGateThresholdFields,
  authoritativeGateOverride,
  type TunableOverride,
  writeLiveOverride,
  writeShadowOverride,
} from "../../src/review/auto-apply";
import type { TuningRec } from "../../src/review/auto-tune";

describe("live gate threshold projection (#6486)", () => {
  it("prefers live over shadow and projects snake_case fields only", () => {
    const live = { confidenceFloor: 0.9, scopeCap: { files: 10, lines: 300 } };
    const shadow = { override: { confidenceFloor: 0.5 }, validatedUntil: "2099-01-01T00:00:00.000Z" };
    expect(authoritativeGateOverride(live, shadow)).toEqual(live);
    expect(toLiveGateThresholdFields(live)).toEqual({
      confidence_floor: 0.9,
      scope_cap_files: 10,
      scope_cap_lines: 300,
    });
  });

  it("falls through to shadow when live is absent, and returns null when neither is active", () => {
    const shadow = { override: { confidenceFloor: 0.7 }, validatedUntil: null };
    expect(toLiveGateThresholdFields(authoritativeGateOverride(null, shadow))).toEqual({
      confidence_floor: 0.7,
      scope_cap_files: null,
      scope_cap_lines: null,
    });
    expect(toLiveGateThresholdFields(authoritativeGateOverride(null, null))).toBeNull();
    expect(toLiveGateThresholdFields(null)).toBeNull();
  });

  it("projects a scopeCap-only override and rejects an empty override object", () => {
    expect(toLiveGateThresholdFields({ scopeCap: { files: 4, lines: 120 } })).toEqual({
      confidence_floor: null,
      scope_cap_files: 4,
      scope_cap_lines: 120,
    });
    expect(toLiveGateThresholdFields({})).toBeNull();
  });
});

describe("rowToOverride (#273 — D1 row → validated override)", () => {
  it("maps a full row", () => {
    expect(rowToOverride({ confidence_floor: 0.95, scope_cap_files: 5, scope_cap_lines: 200, clear_at: null })).toEqual({
      confidenceFloor: 0.95,
      scopeCap: { files: 5, lines: 200 },
    });
  });
  it("null/empty/invalid rows → null", () => {
    expect(rowToOverride(null)).toBeNull();
    expect(rowToOverride({ confidence_floor: null, scope_cap_files: null, scope_cap_lines: null, clear_at: null })).toBeNull();
    expect(rowToOverride({ confidence_floor: 1.5, scope_cap_files: 0, scope_cap_lines: -1, clear_at: null })).toBeNull(); // out of range
  });
  it("a partial row keeps only the valid fields", () => {
    expect(rowToOverride({ confidence_floor: 0.92, scope_cap_files: null, scope_cap_lines: null, clear_at: null })).toEqual({ confidenceFloor: 0.92 });
    // one half of scopeCap missing → no scopeCap
    expect(rowToOverride({ confidence_floor: null, scope_cap_files: 5, scope_cap_lines: null, clear_at: null })).toBeNull();
  });
  it("a past clear_at is treated as cleared (null)", () => {
    expect(rowToOverride({ confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, clear_at: "2020-01-01T00:00:00Z" }, "2026-06-20T00:00:00Z")).toBeNull();
    // future clear_at still active
    expect(rowToOverride({ confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, clear_at: "2099-01-01T00:00:00Z" }, "2026-06-20T00:00:00Z")?.confidenceFloor).toBe(0.95);
  });
});

describe("sanitizeOverridePayload (#277 — validate untrusted payloads)", () => {
  it("accepts a valid floor + cap", () => {
    expect(sanitizeOverridePayload({ confidenceFloor: 0.95, scopeCap: { files: 3, lines: 100 } })).toEqual({ confidenceFloor: 0.95, scopeCap: { files: 3, lines: 100 } });
  });
  it("rejects non-objects, empty objects, out-of-range floors, non-positive/half caps", () => {
    expect(sanitizeOverridePayload(null)).toBeNull();
    expect(sanitizeOverridePayload("nope")).toBeNull();
    expect(sanitizeOverridePayload({})).toBeNull();
    expect(sanitizeOverridePayload({ confidenceFloor: 1.5 })).toBeNull();
    expect(sanitizeOverridePayload({ confidenceFloor: -0.1 })).toBeNull();
    expect(sanitizeOverridePayload({ scopeCap: { files: 0, lines: 100 } })).toBeNull();
    expect(sanitizeOverridePayload({ scopeCap: { files: 3 } })).toBeNull(); // half a cap
  });
});

describe("describeOverride", () => {
  it("summarizes for logs", () => {
    expect(describeOverride({ confidenceFloor: 0.95, scopeCap: { files: 3, lines: 100 } })).toBe("floor=0.95 cap=3f/100l");
    expect(describeOverride({})).toBe("(empty)");
  });
});

describe("mergeOverride (#partial-overwrite-fix — partial writes are additive, never destructive)", () => {
  it("a floor-only write KEEPS an existing scopeCap (no silent erase)", () => {
    expect(mergeOverride({ scopeCap: { files: 5, lines: 200 } }, { confidenceFloor: 0.95 })).toEqual({ confidenceFloor: 0.95, scopeCap: { files: 5, lines: 200 } });
  });
  it("a new field overrides the old; absent fields fall through to base", () => {
    expect(mergeOverride({ confidenceFloor: 0.9 }, { confidenceFloor: 0.95 })).toEqual({ confidenceFloor: 0.95, scopeCap: undefined });
    expect(mergeOverride(null, { confidenceFloor: 0.95 })).toEqual({ confidenceFloor: 0.95, scopeCap: undefined });
  });
});

describe("isStrictlyTightening (#276 — autonomous loosening is never promotable)", () => {
  it("a floor RAISE / cap SHRINK is tightening", () => {
    expect(isStrictlyTightening({ confidenceFloor: 0.95 }, 0.9)).toBe(true);
    expect(isStrictlyTightening({ scopeCap: { files: 3, lines: 100 } }, undefined, { files: 10, lines: 500 })).toBe(true);
  });
  it("a floor DROP or cap RAISE is NOT tightening (rejected)", () => {
    expect(isStrictlyTightening({ confidenceFloor: 0.8 }, 0.9)).toBe(false);
    expect(isStrictlyTightening({ scopeCap: { files: 20, lines: 100 } }, undefined, { files: 10, lines: 500 })).toBe(false);
  });
  it("a no-op (equal to live) is NOT tightening", () => {
    expect(isStrictlyTightening({ confidenceFloor: 0.9 }, 0.9)).toBe(false);
  });
});

describe("evaluateShadowPromotion (#276 — tighten-only + evidence + soak gate)", () => {
  const base = { override: { confidenceFloor: 0.95 } as TunableOverride, liveFloor: 0.9, decided: 20, validatedUntilIso: "2026-06-19T00:00:00Z", nowIso: "2026-06-20T00:00:00Z" };
  it("promotes a tightening override once evidence + soak are met", () => {
    expect(evaluateShadowPromotion(base)).toEqual({ promote: true, reason: "tightening + evidence + soaked" });
  });
  it("refuses a non-tightening override", () => {
    expect(evaluateShadowPromotion({ ...base, override: { confidenceFloor: 0.8 } }).promote).toBe(false);
  });
  it("refuses on insufficient evidence", () => {
    const r = evaluateShadowPromotion({ ...base, decided: SHADOW_PROMOTION_MIN_DECIDED - 1 });
    expect(r.promote).toBe(false);
    expect(r.reason).toMatch(/insufficient evidence/);
  });
  it("refuses while still soaking", () => {
    const r = evaluateShadowPromotion({ ...base, validatedUntilIso: "2099-01-01T00:00:00Z" });
    expect(r.promote).toBe(false);
    expect(r.reason).toMatch(/still soaking/);
  });
  it("refuses when validated_until is unset (never soaked)", () => {
    expect(evaluateShadowPromotion({ ...base, validatedUntilIso: null }).promote).toBe(false);
  });

  // (#stale-shadow-promotion-fix) The audited failure: a shadow tightening queued while precision was bad
  // (0.2) must NOT be promoted once 24h later the project's OWN freshly-measured precision has recovered back
  // above the risk floor (0.9) that originally triggered it — even though it is still strictly tightening vs
  // the (unchanged) live config, has plenty of evidence, and has fully soaked.
  it("refuses promotion once the underlying merge precision has recovered above the risk floor", () => {
    const r = evaluateShadowPromotion({ ...base, currentMergePrecision: 0.92 });
    expect(r.promote).toBe(false);
    expect(r.reason).toMatch(/recovered/);
  });
  it("still promotes when the current merge precision is still below the risk floor", () => {
    expect(evaluateShadowPromotion({ ...base, currentMergePrecision: 0.5 }).promote).toBe(true);
  });
  it("still promotes when currentMergePrecision is omitted (freshness check is skipped, not blocking)", () => {
    expect(evaluateShadowPromotion(base).promote).toBe(true);
  });
  it("a currentMergePrecision exactly AT the risk floor still refuses (>= boundary)", () => {
    expect(evaluateShadowPromotion({ ...base, currentMergePrecision: 0.9 }).promote).toBe(false);
  });
});

// ── A tiny in-memory D1-shaped store for the store/orchestration tests (the deferred infra seam) ─────────

type Tables = {
  live: Map<string, { confidence_floor: number | null; scope_cap_files: number | null; scope_cap_lines: number | null; clear_at: string | null }>;
  shadow: Map<string, { confidence_floor: number | null; scope_cap_files: number | null; scope_cap_lines: number | null; validated_until: string | null; clear_at?: string | null }>;
  audit: Array<{ project: string; event_type: string; detail: string | null; created_at: string }>;
};

function fakeEnv(): { env: StorageEnv; tables: Tables } {
  const tables: Tables = { live: new Map(), shadow: new Map(), audit: [] };
  const make = (sql: string): ReturnType<StorageLike["prepare"]> => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...vals: unknown[]) {
        bound = vals;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM tunables_overrides_shadow")) {
          const row = tables.shadow.get(bound[0] as string);
          return (row ?? null) as T | null;
        }
        if (sql.includes("FROM tunables_overrides")) {
          const row = tables.live.get(bound[0] as string);
          return (row ?? null) as T | null;
        }
        return null;
      },
      async run(): Promise<unknown> {
        if (sql.startsWith("INSERT OR REPLACE INTO tunables_overrides_shadow")) {
          const [project, cf, scf, scl, vu, clearAt] = bound as [string, number | null, number | null, number | null, string | null, string | null];
          tables.shadow.set(project, { confidence_floor: cf, scope_cap_files: scf, scope_cap_lines: scl, validated_until: vu, clear_at: clearAt ?? null });
        } else if (sql.startsWith("INSERT OR REPLACE INTO tunables_overrides")) {
          const [project, cf, scf, scl, clearAt] = bound as [string, number | null, number | null, number | null, string | null];
          tables.live.set(project, { confidence_floor: cf, scope_cap_files: scf, scope_cap_lines: scl, clear_at: clearAt ?? null });
        } else if (sql.startsWith("DELETE FROM tunables_overrides_shadow")) {
          tables.shadow.delete(bound[0] as string);
        } else if (sql.startsWith("DELETE FROM tunables_overrides")) {
          tables.live.delete(bound[0] as string);
        } else if (sql.startsWith("INSERT INTO override_audit")) {
          const [, project, eventType, detail] = bound as [string, string, string, string];
          tables.audit.push({ project, event_type: eventType, detail, created_at: new Date().toISOString() });
        }
        return {};
      },
      async all<T>(): Promise<{ results?: T[] }> {
        if (sql.includes("FROM override_audit")) {
          const project = bound[0] as string;
          return { results: tables.audit.filter((a) => a.project === project).reverse() as T[] };
        }
        return { results: [] };
      },
    };
    return stmt as unknown as ReturnType<StorageLike["prepare"]>;
  };
  const env: StorageEnv = { DB: { prepare: (sql: string) => make(sql) } };
  return { env, tables };
}

describe("loadOverride (#274 — fail-safe)", () => {
  it("returns the override from D1", async () => {
    const { env, tables } = fakeEnv();
    tables.live.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, clear_at: null });
    expect((await loadOverride(env, "g"))?.confidenceFloor).toBe(0.95);
  });
  it("returns null (base config) on a DB error — a blip never blocks a review", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            async first() {
              throw new Error("d1 down");
            },
          }),
        }),
      },
    } as unknown as StorageEnv;
    expect(await loadOverride(env, "g")).toBeNull();
  });
});

describe("applyOverrideRecommendation (#277 — force vs shadow-soak)", () => {
  it("force=true writes LIVE immediately + audits", async () => {
    const { env, tables } = fakeEnv();
    const res = await applyOverrideRecommendation(env, "g", { confidenceFloor: 0.95 }, { force: true, soakMs: 1000, nowMs: 0 });
    expect(res.applied).toBe(true);
    expect(tables.live.get("g")?.confidence_floor).toBe(0.95);
    expect(tables.audit.some((a) => a.event_type === "override_applied")).toBe(true);
  });
  it("force=false queues to the SHADOW soak with a validated_until deadline", async () => {
    const { env, tables } = fakeEnv();
    const res = await applyOverrideRecommendation(env, "g", { confidenceFloor: 0.95 }, { force: false, soakMs: 1000, nowMs: 0 });
    expect(res.applied).toBe(false);
    expect(res.shadowed).toBe(true);
    expect(res.validatedUntil).toBe(new Date(1000).toISOString());
    expect(tables.shadow.get("g")?.confidence_floor).toBe(0.95);
    expect(tables.live.has("g")).toBe(false);
  });

  // (#audit-before-write-fix) The audited failure: a transient D1 blip on the LIVE write must not leave the
  // apply path with zero audit trail. Proven here by making ONLY the live-table write throw while the audit
  // INSERT succeeds — if the ordering is right (audit-first), the audit row exists despite the write failing.
  it("records the audit row BEFORE the live write, so a write failure still leaves an audit trail", async () => {
    const audit: Array<{ eventType: string }> = [];
    const env: StorageEnv = {
      DB: {
        prepare: (sql: string) => {
          const stmt = {
            bind(...vals: unknown[]) {
              return {
                async first() {
                  return null;
                },
                async run() {
                  if (sql.startsWith("INSERT INTO override_audit")) {
                    audit.push({ eventType: vals[2] as string });
                    return {};
                  }
                  if (sql.startsWith("INSERT OR REPLACE INTO tunables_overrides") && !sql.includes("_shadow")) {
                    throw new Error("d1 write blip"); // the LIVE write fails
                  }
                  return {};
                },
                async all() {
                  return { results: [] };
                },
              };
            },
          };
          return stmt as unknown as ReturnType<StorageLike["prepare"]>;
        },
      },
    };
    await expect(applyOverrideRecommendation(env, "g", { confidenceFloor: 0.95 }, { force: true, soakMs: 1000, nowMs: 0 })).rejects.toThrow("d1 write blip");
    expect(audit.some((a) => a.eventType === "override_applied")).toBe(true);
  });
});

describe("runAutoApplyRecommendations (#278 — closes the loop: queue tightening → soak → promote)", () => {
  const tightenRec: TuningRec = { project: "g", severity: "warn", message: "tighten", overridePayload: { confidenceFloor: 0.95 } };
  const ctx = (over: Partial<AutoApplyContext> = {}): AutoApplyContext => ({
    project: "g",
    autoTune: true,
    baseConfidenceFloor: 0.9,
    decided: 20,
    recs: [tightenRec],
    nowMs: Date.parse("2026-06-20T00:00:00Z"),
    ...over,
  });

  it("is a no-op when the project hasn't opted into autoTune", async () => {
    const { env, tables } = fakeEnv();
    await runAutoApplyRecommendations(env, ctx({ autoTune: false }));
    expect(tables.shadow.size).toBe(0);
    expect(tables.live.size).toBe(0);
  });

  it("queues a NEW tightening rec to the shadow soak (does not go live yet)", async () => {
    const { env, tables } = fakeEnv();
    await runAutoApplyRecommendations(env, ctx());
    expect(tables.shadow.get("g")?.confidence_floor).toBe(0.95);
    expect(tables.live.has("g")).toBe(false);
    expect(tables.audit.some((a) => a.event_type === "override_shadowed")).toBe(true);
  });

  it("does NOT queue a non-tightening rec (loosening never auto-applied)", async () => {
    const { env, tables } = fakeEnv();
    const loosen: TuningRec = { project: "g", severity: "warn", message: "loosen", overridePayload: { confidenceFloor: 0.8 } };
    await runAutoApplyRecommendations(env, ctx({ recs: [loosen] }));
    expect(tables.shadow.size).toBe(0);
  });

  it("promotes a SOAKED shadow override to live (tightening + evidence + past deadline)", async () => {
    const { env, tables } = fakeEnv();
    // Pre-seed a shadow override whose soak deadline is in the past.
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx({ recs: [] }));
    expect(tables.live.get("g")?.confidence_floor).toBe(0.95);
    expect(tables.shadow.has("g")).toBe(false);
    expect(tables.audit.some((a) => a.event_type === "override_promoted")).toBe(true);
  });

  it("HOLDS a shadow override that is still soaking (deadline in the future)", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2099-01-01T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx({ recs: [] }));
    expect(tables.live.has("g")).toBe(false);
    expect(tables.shadow.has("g")).toBe(true); // still queued
  });

  it("HOLDS on insufficient evidence even after the soak deadline", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx({ recs: [], decided: SHADOW_PROMOTION_MIN_DECIDED - 1 }));
    expect(tables.live.has("g")).toBe(false);
    expect(tables.shadow.has("g")).toBe(true);
  });

  // (#stale-shadow-promotion-fix) The exact audited scenario: a shadow tightening was queued (and has since
  // soaked past its deadline) when the project's precision was 0.2. By the time the cron re-ticks, the ctx the
  // host passes in carries the FRESHLY-recomputed precision (0.92 — recovered above the 0.9 risk floor). The
  // promotion must be refused even though the soak/evidence/tightening checks would all otherwise pass.
  it("refuses to promote a stale shadow tightening once the project's precision has since recovered", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx({ recs: [], mergePrecision: 0.92 }));
    expect(tables.live.has("g")).toBe(false); // NOT promoted
    expect(tables.shadow.has("g")).toBe(true); // stays queued rather than being silently dropped
  });

  it("still promotes a soaked shadow override when the fresh precision has NOT recovered", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx({ recs: [], mergePrecision: 0.5 }));
    expect(tables.live.get("g")?.confidence_floor).toBe(0.95);
    expect(tables.shadow.has("g")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// BRANCH-COVERAGE TESTS: every remaining if/else, ternary, &&/||/??/?., catch, early-return, and guard. ────
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A StorageEnv whose every prepared-statement op throws — exercises the fail-safe catch arms. */
function throwingEnv(): StorageEnv {
  const stmt = {
    bind() {
      return stmt;
    },
    async first() {
      throw new Error("d1 down");
    },
    async run() {
      throw new Error("d1 down");
    },
    async all() {
      throw new Error("d1 down");
    },
  };
  return { DB: { prepare: () => stmt } } as unknown as StorageEnv;
}

describe("rowToOverride — remaining branches", () => {
  it("a clear_at WITHOUT a nowIso stays active (the nowIso && guard short-circuits)", () => {
    // row.clear_at is set but nowIso is undefined → the `&& nowIso` term is falsy → NOT treated as cleared.
    expect(rowToOverride({ confidence_floor: 0.9, scope_cap_files: null, scope_cap_lines: null, clear_at: "2020-01-01T00:00:00Z" })).toEqual({ confidenceFloor: 0.9 });
  });
  it("a future clear_at with a nowIso stays active (clear_at <= nowIso is false)", () => {
    expect(rowToOverride({ confidence_floor: 0.9, scope_cap_files: null, scope_cap_lines: null, clear_at: "2099-01-01T00:00:00Z" }, "2026-06-20T00:00:00Z")).toEqual({ confidenceFloor: 0.9 });
  });
  it("a valid scope_cap_lines but invalid scope_cap_files drops the whole cap (the && chain)", () => {
    // files <= 0 fails the first half of the cap guard → scopeCap omitted even though lines is valid.
    expect(rowToOverride({ confidence_floor: null, scope_cap_files: 0, scope_cap_lines: 200, clear_at: null })).toBeNull();
  });
  it("a valid scope_cap_files but null scope_cap_lines drops the cap (second half of the && chain)", () => {
    expect(rowToOverride({ confidence_floor: null, scope_cap_files: 5, scope_cap_lines: null, clear_at: null })).toBeNull();
  });
  it("a confidence_floor of exactly 0 and 1 are in-range (boundary)", () => {
    expect(rowToOverride({ confidence_floor: 0, scope_cap_files: null, scope_cap_lines: null, clear_at: null })).toEqual({ confidenceFloor: 0 });
    expect(rowToOverride({ confidence_floor: 1, scope_cap_files: null, scope_cap_lines: null, clear_at: null })).toEqual({ confidenceFloor: 1 });
  });
  it("a cap-only row (no floor) keeps just the cap", () => {
    expect(rowToOverride({ confidence_floor: null, scope_cap_files: 4, scope_cap_lines: 150, clear_at: null })).toEqual({ scopeCap: { files: 4, lines: 150 } });
  });
});

describe("describeOverride — remaining branches", () => {
  it("a cap-only override summarizes just the cap (floor branch skipped)", () => {
    expect(describeOverride({ scopeCap: { files: 4, lines: 150 } })).toBe("cap=4f/150l");
  });
  it("a floor-only override summarizes just the floor (cap branch skipped)", () => {
    expect(describeOverride({ confidenceFloor: 0.9 })).toBe("floor=0.9");
  });
  it("a floor of 0 is still rendered (!= null, not falsy)", () => {
    expect(describeOverride({ confidenceFloor: 0 })).toBe("floor=0");
  });
});

describe("sanitizeOverridePayload — remaining branches", () => {
  it("a NaN-ish floor is rejected (Number.isFinite false arm)", () => {
    expect(sanitizeOverridePayload({ confidenceFloor: "abc" })).toBeNull();
    expect(sanitizeOverridePayload({ confidenceFloor: Number.NaN })).toBeNull();
  });
  it("a floor-only valid payload (scopeCap absent) is accepted", () => {
    expect(sanitizeOverridePayload({ confidenceFloor: 0.92 })).toEqual({ confidenceFloor: 0.92 });
  });
  it("a cap-only valid payload (floor absent) is accepted", () => {
    expect(sanitizeOverridePayload({ scopeCap: { files: 3, lines: 100 } })).toEqual({ scopeCap: { files: 3, lines: 100 } });
  });
  it("a non-integer cap is rejected (Number.isInteger false arm)", () => {
    expect(sanitizeOverridePayload({ scopeCap: { files: 3.5, lines: 100 } })).toBeNull();
    expect(sanitizeOverridePayload({ scopeCap: { files: 3, lines: 100.5 } })).toBeNull();
  });
  it("a negative cap is rejected (<= 0 arm)", () => {
    expect(sanitizeOverridePayload({ scopeCap: { files: -1, lines: 100 } })).toBeNull();
    expect(sanitizeOverridePayload({ scopeCap: { files: 3, lines: -5 } })).toBeNull();
  });
  it("floor boundary values 0 and 1 are accepted", () => {
    expect(sanitizeOverridePayload({ confidenceFloor: 0 })).toEqual({ confidenceFloor: 0 });
    expect(sanitizeOverridePayload({ confidenceFloor: 1 })).toEqual({ confidenceFloor: 1 });
  });
  it("a string-number floor in range is coerced (Number(...) path)", () => {
    expect(sanitizeOverridePayload({ confidenceFloor: "0.5" })).toEqual({ confidenceFloor: 0.5 });
  });
});

describe("mergeOverride — remaining branches", () => {
  it("next.scopeCap WINS over the base scopeCap", () => {
    expect(mergeOverride({ scopeCap: { files: 5, lines: 200 } }, { scopeCap: { files: 2, lines: 50 } })).toEqual({ scopeCap: { files: 2, lines: 50 } });
  });
  it("a base scopeCap survives when next has neither field (next.scopeCap ?? base)", () => {
    expect(mergeOverride({ confidenceFloor: 0.9, scopeCap: { files: 5, lines: 200 } }, {})).toEqual({ confidenceFloor: 0.9, scopeCap: { files: 5, lines: 200 } });
  });
  it("two empty inputs merge to an empty override (both fields undefined, neither assigned)", () => {
    expect(mergeOverride(null, {})).toEqual({});
    expect(mergeOverride({}, {})).toEqual({});
  });
  it("next.confidenceFloor of 0 wins over a base via ?? (0 is not nullish)", () => {
    expect(mergeOverride({ confidenceFloor: 0.9 }, { confidenceFloor: 0 })).toEqual({ confidenceFloor: 0, scopeCap: undefined });
  });
});

describe("isStrictlyTightening — remaining branches", () => {
  it("a floor present with NO liveFloor tightens (liveFloor == null arm)", () => {
    expect(isStrictlyTightening({ confidenceFloor: 0.9 })).toBe(true);
  });
  it("a cap present with NO liveScopeCap tightens (!liveScopeCap arm)", () => {
    expect(isStrictlyTightening({ scopeCap: { files: 3, lines: 100 } })).toBe(true);
  });
  it("a cap loosened on the LINES axis alone is rejected", () => {
    expect(isStrictlyTightening({ scopeCap: { files: 5, lines: 999 } }, undefined, { files: 10, lines: 500 })).toBe(false);
  });
  it("a cap equal to live on both axes is a no-op (not tightening)", () => {
    expect(isStrictlyTightening({ scopeCap: { files: 10, lines: 500 } }, undefined, { files: 10, lines: 500 })).toBe(false);
  });
  it("a floor that drops below live short-circuits to false even if the cap tightens", () => {
    expect(isStrictlyTightening({ confidenceFloor: 0.8, scopeCap: { files: 3, lines: 100 } }, 0.9, { files: 10, lines: 500 })).toBe(false);
  });
  it("a floor no-op + a cap shrink is still tightening (cap drives it)", () => {
    expect(isStrictlyTightening({ confidenceFloor: 0.9, scopeCap: { files: 3, lines: 100 } }, 0.9, { files: 10, lines: 500 })).toBe(true);
  });
  it("an EMPTY override tightens nothing (both guards skipped)", () => {
    expect(isStrictlyTightening({})).toBe(false);
  });
  it("a cap that shrinks files only (lines equal) is tightening", () => {
    expect(isStrictlyTightening({ scopeCap: { files: 3, lines: 500 } }, undefined, { files: 10, lines: 500 })).toBe(true);
  });
});

describe("evaluateShadowPromotion — soak-reason ternary branches", () => {
  const base = { override: { confidenceFloor: 0.95 } as TunableOverride, liveFloor: 0.9, decided: 20, nowIso: "2026-06-20T00:00:00Z" };
  it("an unset validated_until yields a reason WITHOUT an 'until' clause", () => {
    const r = evaluateShadowPromotion({ ...base, validatedUntilIso: null });
    expect(r.promote).toBe(false);
    expect(r.reason).toBe("still soaking");
  });
  it("a future validated_until yields a reason WITH the 'until' clause", () => {
    const r = evaluateShadowPromotion({ ...base, validatedUntilIso: "2099-01-01T00:00:00Z" });
    expect(r.reason).toBe("still soaking until 2099-01-01T00:00:00Z");
  });
});

describe("writeLiveOverride / deleteLiveOverride (D1 writes)", () => {
  it("MERGES over an existing live row (a floor-only write keeps the prior cap)", async () => {
    const { env, tables } = fakeEnv();
    tables.live.set("g", { confidence_floor: 0.9, scope_cap_files: 5, scope_cap_lines: 200, clear_at: null });
    await writeLiveOverride(env, "g", { confidenceFloor: 0.95 });
    expect(tables.live.get("g")).toEqual({ confidence_floor: 0.95, scope_cap_files: 5, scope_cap_lines: 200, clear_at: null });
  });
  it("writes a fresh row when none exists (mergeOverride(null, …)), nulling absent columns", async () => {
    const { env, tables } = fakeEnv();
    await writeLiveOverride(env, "g", { confidenceFloor: 0.95 });
    expect(tables.live.get("g")).toEqual({ confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, clear_at: null });
  });
  it("deleteLiveOverride removes the row", async () => {
    const { env, tables } = fakeEnv();
    tables.live.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, clear_at: null });
    await deleteLiveOverride(env, "g");
    expect(tables.live.has("g")).toBe(false);
  });

  // (#stale-clear-at-fix) Previously the INSERT OR REPLACE column list omitted clear_at entirely, so SQLite's
  // REPLACE (delete-then-insert) unconditionally nulled any existing operator-set expiration on every write.
  it("PRESERVES an existing (non-expired) clear_at across a write instead of silently nulling it", async () => {
    const { env, tables } = fakeEnv();
    tables.live.set("g", { confidence_floor: 0.9, scope_cap_files: null, scope_cap_lines: null, clear_at: "2099-01-01T00:00:00Z" });
    await writeLiveOverride(env, "g", { confidenceFloor: 0.95 });
    expect(tables.live.get("g")?.clear_at).toBe("2099-01-01T00:00:00Z");
    expect(tables.live.get("g")?.confidence_floor).toBe(0.95);
  });

  // (#stale-clear-at-fix) Previously the internal loadOverride() re-read inside writeLiveOverride never passed
  // nowIso, so rowToOverride's `row.clear_at && nowIso && ...` guard short-circuited and an ALREADY-EXPIRED
  // override was merged back in as still active. Passing nowIso through fixes both: the expired floor is not
  // resurrected, and the stale clear_at itself is dropped rather than carried forward.
  it("does NOT resurrect an ALREADY-EXPIRED override (or its stale clear_at) when nowIso is passed", async () => {
    const { env, tables } = fakeEnv();
    tables.live.set("g", { confidence_floor: 0.8, scope_cap_files: null, scope_cap_lines: null, clear_at: "2020-01-01T00:00:00Z" });
    await writeLiveOverride(env, "g", { scopeCap: { files: 3, lines: 100 } }, "2026-06-20T00:00:00Z");
    const row = tables.live.get("g");
    expect(row?.confidence_floor).toBeNull(); // the expired floor is NOT resurrected
    expect(row?.clear_at).toBeNull(); // the lapsed clear_at is not carried forward either
    expect(row?.scope_cap_files).toBe(3); // the new write still applies normally
  });
});

describe("writeShadowOverride / loadShadowOverride / deleteShadowOverride", () => {
  it("MERGES over an existing shadow row (additive, never destructive)", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: null, scope_cap_files: 5, scope_cap_lines: 200, validated_until: "2026-06-19T00:00:00Z" });
    await writeShadowOverride(env, "g", { confidenceFloor: 0.95 }, "2026-06-25T00:00:00Z");
    // clear_at: null is now asserted explicitly (previously the INSERT OR REPLACE column list dropped clear_at
    // entirely, so the written row never carried it — the fix now writes it through on every shadow write).
    expect(tables.shadow.get("g")).toEqual({ confidence_floor: 0.95, scope_cap_files: 5, scope_cap_lines: 200, validated_until: "2026-06-25T00:00:00Z", clear_at: null });
  });
  it("writes a fresh shadow row when none exists (existing?.override ?? null arm)", async () => {
    const { env, tables } = fakeEnv();
    await writeShadowOverride(env, "g", { scopeCap: { files: 2, lines: 40 } }, "2026-06-25T00:00:00Z");
    expect(tables.shadow.get("g")).toEqual({ confidence_floor: null, scope_cap_files: 2, scope_cap_lines: 40, validated_until: "2026-06-25T00:00:00Z", clear_at: null });
  });
  it("loadShadowOverride returns the override + validatedUntil when present", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-25T00:00:00Z" });
    expect(await loadShadowOverride(env, "g")).toEqual({ override: { confidenceFloor: 0.95 }, validatedUntil: "2026-06-25T00:00:00Z" });
  });
  it("loadShadowOverride returns null when there is no row (!row arm)", async () => {
    const { env } = fakeEnv();
    expect(await loadShadowOverride(env, "missing")).toBeNull();
  });
  // (#stale-clear-at-fix) The shadow table has the same column-drop bug as the live table.
  it("PRESERVES an existing clear_at across a shadow write instead of silently nulling it", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.9, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z", clear_at: "2099-01-01T00:00:00Z" });
    await writeShadowOverride(env, "g", { confidenceFloor: 0.95 }, "2026-06-25T00:00:00Z");
    expect(tables.shadow.get("g")?.clear_at).toBe("2099-01-01T00:00:00Z");
  });
  it("loadShadowOverride returns null when the row maps to an EMPTY override (rowToOverride → null arm)", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: null, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-25T00:00:00Z" });
    expect(await loadShadowOverride(env, "g")).toBeNull();
  });
  it("loadShadowOverride returns null on a DB error (catch arm)", async () => {
    expect(await loadShadowOverride(throwingEnv(), "g")).toBeNull();
  });
  it("deleteShadowOverride removes the row", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "x" });
    await deleteShadowOverride(env, "g");
    expect(tables.shadow.has("g")).toBe(false);
  });
});

describe("recordOverrideAudit / listOverrideAudit", () => {
  it("records an audit row with the serialized detail", async () => {
    const { env, tables } = fakeEnv();
    await recordOverrideAudit(env, "g", "override_applied", { force: true });
    expect(tables.audit.at(-1)).toMatchObject({ project: "g", event_type: "override_applied", detail: JSON.stringify({ force: true }) });
  });
  it("SWALLOWS a DB error but logs it at error level (telemetry never breaks the apply path, but is never silent)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordOverrideAudit(throwingEnv(), "g", "x", {})).resolves.toBeUndefined();
      const errLog = errorSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("override_audit_write_failed"));
      expect(errLog).toBeTruthy();
    } finally {
      errorSpy.mockRestore();
    }
  });
  it("lists audit rows newest-first, mapped to the public shape", async () => {
    const { env } = fakeEnv();
    await recordOverrideAudit(env, "g", "first", { n: 1 });
    await recordOverrideAudit(env, "g", "second", { n: 2 });
    const rows = await listOverrideAudit(env, "g");
    expect(rows.map((r) => r.eventType)).toEqual(["second", "first"]);
    expect(rows[0]?.detail).toBe(JSON.stringify({ n: 2 }));
    expect(typeof rows[0]?.createdAt).toBe("string");
  });
  it("returns [] when the query yields no results array (res.results ?? [] arm)", async () => {
    // An env whose .all() returns an object with NO `results` key → the ?? [] fallback fires.
    const env = {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async all() {
            return {};
          },
        }),
      },
    } as unknown as StorageEnv;
    expect(await listOverrideAudit(env, "g")).toEqual([]);
  });
  it("returns [] on a DB error (catch arm)", async () => {
    expect(await listOverrideAudit(throwingEnv(), "g")).toEqual([]);
  });
  it("honors a custom limit (defaulted param override)", async () => {
    const { env } = fakeEnv();
    // The default is 50; passing an explicit limit exercises the defaulted-param's non-default path. The
    // in-memory store ignores LIMIT, so we just assert it does not throw and returns the rows.
    await recordOverrideAudit(env, "g", "evt", {});
    expect((await listOverrideAudit(env, "g", 5)).length).toBe(1);
  });
});

describe("runAutoApplyRecommendations — remaining branches", () => {
  const tightenRec: TuningRec = { project: "g", severity: "warn", message: "tighten", overridePayload: { confidenceFloor: 0.95 } };
  const ctx = (over: Partial<AutoApplyContext> = {}): AutoApplyContext => ({
    project: "g",
    autoTune: true,
    baseConfidenceFloor: 0.9,
    decided: 20,
    recs: [tightenRec],
    nowMs: Date.parse("2026-06-20T00:00:00Z"),
    ...over,
  });

  it("filters out recs WITHOUT an overridePayload (the type-guard filter, payload == null arm)", async () => {
    const { env, tables } = fakeEnv();
    const noPayload: TuningRec = { project: "g", severity: "info", message: "no payload" };
    await runAutoApplyRecommendations(env, ctx({ recs: [noPayload] }));
    expect(tables.shadow.size).toBe(0);
    expect(tables.live.size).toBe(0);
  });

  it("does NOT queue a second rec when one is ALREADY soaking (alreadyShadowed truthy → skip queue)", async () => {
    const { env, tables } = fakeEnv();
    // A shadow that is still soaking AND not promotable → the queue block is skipped, and it stays put.
    tables.shadow.set("g", { confidence_floor: 0.93, scope_cap_files: null, scope_cap_lines: null, validated_until: "2099-01-01T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx());
    // The pre-existing shadow row is untouched (no overwrite from the incoming 0.95 rec).
    expect(tables.shadow.get("g")?.confidence_floor).toBe(0.93);
    expect(tables.live.has("g")).toBe(false);
  });

  it("promotes the EXISTING soaked shadow even while a fresh rec is offered (alreadyShadowed branch feeds promotion)", async () => {
    const { env, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.96, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z" });
    await runAutoApplyRecommendations(env, ctx()); // a rec is present but a shadow is already queued
    expect(tables.live.get("g")?.confidence_floor).toBe(0.96);
    expect(tables.shadow.has("g")).toBe(false);
  });

  it("uses the LIVE override floor (not the base) as the tightening reference", async () => {
    const { env, tables } = fakeEnv();
    // Live floor 0.95 already >= the rec's 0.95 → the rec does NOT tighten vs live → nothing queued.
    tables.live.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, clear_at: null });
    await runAutoApplyRecommendations(env, ctx());
    expect(tables.shadow.size).toBe(0);
  });

  it("queues against the LIVE override when the rec tightens beyond it", async () => {
    const { env, tables } = fakeEnv();
    tables.live.set("g", { confidence_floor: 0.93, scope_cap_files: null, scope_cap_lines: null, clear_at: null });
    await runAutoApplyRecommendations(env, ctx({ recs: [{ project: "g", severity: "warn", message: "m", overridePayload: { confidenceFloor: 0.97 } }] }));
    expect(tables.shadow.get("g")?.confidence_floor).toBe(0.97);
  });

  it("queues against the BASE scope cap when the rec shrinks it (liveCap from ctx.baseScopeCap)", async () => {
    const { env, tables } = fakeEnv();
    await runAutoApplyRecommendations(
      env,
      ctx({ baseScopeCap: { files: 10, lines: 500 }, recs: [{ project: "g", severity: "warn", message: "m", overridePayload: { scopeCap: { files: 3, lines: 100 } } }] }),
    );
    expect(tables.shadow.get("g")).toMatchObject({ scope_cap_files: 3, scope_cap_lines: 100 });
  });

  it("is a no-op with an empty recs list and no pending shadow (both blocks skipped)", async () => {
    const { env, tables } = fakeEnv();
    await runAutoApplyRecommendations(env, ctx({ recs: [] }));
    expect(tables.shadow.size).toBe(0);
    expect(tables.live.size).toBe(0);
  });

  it("FAILS SAFE: a thrown store error is logged and swallowed (outer catch arm)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // loadOverride catches its own error → null, but loadShadowOverride also catches → null, so to force the
      // OUTER catch we make a store whose first() throws a NON-Error so even the inner catches can't shield the
      // later writeShadowOverride().run() throw. Simpler: throwingEnv() makes run() throw inside the queue path.
      await expect(runAutoApplyRecommendations(throwingEnv(), ctx())).resolves.toBeUndefined();
      const errLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("auto_apply_error"));
      expect(errLog).toBeTruthy();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs the shadowed event when it queues a new tightening rec (auto_apply_shadowed branch)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { env } = fakeEnv();
      await runAutoApplyRecommendations(env, ctx());
      const shadowedLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("auto_apply_shadowed"));
      expect(shadowedLog).toBeTruthy();
    } finally {
      logSpy.mockRestore();
    }
  });

  // (#audit-before-write-fix) Same ordering guarantee as applyOverrideRecommendation's force branch, but for
  // the PROMOTION path: audits before writing live, so a write failure mid-promotion still leaves a trail.
  it("promotion audits BEFORE writing live, so a write failure still records the promotion attempt", async () => {
    const { env: baseEnv, tables } = fakeEnv();
    tables.shadow.set("g", { confidence_floor: 0.95, scope_cap_files: null, scope_cap_lines: null, validated_until: "2026-06-19T00:00:00Z" });
    const env: StorageEnv = {
      DB: {
        prepare: (sql: string) => {
          if (sql.startsWith("INSERT OR REPLACE INTO tunables_overrides") && !sql.includes("_shadow")) {
            return {
              bind: () => ({
                async run() {
                  throw new Error("d1 write blip"); // the LIVE write fails during promotion
                },
              }),
            } as unknown as ReturnType<StorageLike["prepare"]>;
          }
          return baseEnv.DB.prepare(sql);
        },
      },
    };
    await runAutoApplyRecommendations(env, ctx({ recs: [] })); // fails safe: throws are caught, never rethrown
    expect(tables.audit.some((a) => a.event_type === "override_promoted")).toBe(true);
    // the write (and the subsequent delete) never completed, so the shadow row is still queued
    expect(tables.shadow.has("g")).toBe(true);
    expect(tables.live.has("g")).toBe(false);
  });

  it("breaks after the FIRST tightening rec (only one pending soak at a time)", async () => {
    const { env, tables } = fakeEnv();
    const recs: TuningRec[] = [
      { project: "g", severity: "warn", message: "a", overridePayload: { confidenceFloor: 0.95 } },
      { project: "g", severity: "warn", message: "b", overridePayload: { confidenceFloor: 0.99 } },
    ];
    await runAutoApplyRecommendations(env, ctx({ recs }));
    // Only the FIRST tightening rec is queued (the loop breaks); the 0.99 rec is not written.
    expect(tables.shadow.get("g")?.confidence_floor).toBe(0.95);
  });

  it("skips a non-tightening rec then queues a later tightening one (continue arm of the loop)", async () => {
    const { env, tables } = fakeEnv();
    const recs: TuningRec[] = [
      { project: "g", severity: "warn", message: "loosen", overridePayload: { confidenceFloor: 0.8 } }, // skipped (continue)
      { project: "g", severity: "warn", message: "tighten", overridePayload: { confidenceFloor: 0.97 } }, // queued
    ];
    await runAutoApplyRecommendations(env, ctx({ recs }));
    expect(tables.shadow.get("g")?.confidence_floor).toBe(0.97);
  });
});
