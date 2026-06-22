import { describe, expect, it } from "vitest";
import {
  type AutoApplyContext,
  applyOverrideRecommendation,
  describeOverride,
  evaluateShadowPromotion,
  isStrictlyTightening,
  loadOverride,
  mergeOverride,
  rowToOverride,
  runAutoApplyRecommendations,
  sanitizeOverridePayload,
  SHADOW_PROMOTION_MIN_DECIDED,
  type StorageEnv,
  type StorageLike,
  type TunableOverride,
} from "../../src/review/auto-apply";
import type { TuningRec } from "../../src/review/auto-tune";

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
});

// ── A tiny in-memory D1-shaped store for the store/orchestration tests (the deferred infra seam) ─────────

type Tables = {
  live: Map<string, { confidence_floor: number | null; scope_cap_files: number | null; scope_cap_lines: number | null; clear_at: string | null }>;
  shadow: Map<string, { confidence_floor: number | null; scope_cap_files: number | null; scope_cap_lines: number | null; validated_until: string | null }>;
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
          const [project, cf, scf, scl, vu] = bound as [string, number | null, number | null, number | null, string | null];
          tables.shadow.set(project, { confidence_floor: cf, scope_cap_files: scf, scope_cap_lines: scl, validated_until: vu });
        } else if (sql.startsWith("INSERT OR REPLACE INTO tunables_overrides")) {
          const [project, cf, scf, scl] = bound as [string, number | null, number | null, number | null];
          tables.live.set(project, { confidence_floor: cf, scope_cap_files: scf, scope_cap_lines: scl, clear_at: null });
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
});
