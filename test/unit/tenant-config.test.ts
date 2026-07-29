import { describe, expect, it } from "vitest";

import {
  DEFAULT_TENANT_CONFIG,
  EMPTY_TENANT_CONFIG_STORE,
  getTenantConfig,
  resolveTenantConfig,
  setTenantConfig,
} from "../../packages/loopover-engine/src/tenant-config";

describe("resolveTenantConfig (#4787)", () => {
  it("returns the defaults when given no overrides", () => {
    expect(resolveTenantConfig()).toEqual(DEFAULT_TENANT_CONFIG);
  });

  it("does not share a mutable reference with the defaults (fresh action-class list)", () => {
    const cfg = resolveTenantConfig();
    (cfg.preferences.allowedActionClasses as string[]).push("merge");
    expect(DEFAULT_TENANT_CONFIG.preferences.allowedActionClasses).not.toContain("merge");
  });

  it("applies a recognized autonomy-level override", () => {
    expect(resolveTenantConfig({ autonomyLevel: "auto" }).autonomyLevel).toBe("auto");
  });

  it("falls back to the default autonomy level when the override is unrecognized", () => {
    expect(resolveTenantConfig({ autonomyLevel: "banana" as never }).autonomyLevel).toBe(DEFAULT_TENANT_CONFIG.autonomyLevel);
  });

  it("merges a partial preferences override onto the defaults", () => {
    const cfg = resolveTenantConfig({ preferences: { maxConcurrentLoops: 5 } });
    expect(cfg.preferences.maxConcurrentLoops).toBe(5);
    expect(cfg.preferences.pauseOnFailure).toBe(DEFAULT_TENANT_CONFIG.preferences.pauseOnFailure);
    expect(cfg.preferences.allowedActionClasses).toEqual(DEFAULT_TENANT_CONFIG.preferences.allowedActionClasses);
  });

  it("honors an explicit false pauseOnFailure (not treated as absent) and a custom action-class list", () => {
    const cfg = resolveTenantConfig({ preferences: { pauseOnFailure: false, allowedActionClasses: ["comment"] } });
    expect(cfg.preferences.pauseOnFailure).toBe(false);
    expect(cfg.preferences.allowedActionClasses).toEqual(["comment"]);
  });
});

describe("tenant config store (#4787)", () => {
  it("setTenantConfig returns a NEW store and never mutates the input (immutable update)", () => {
    const s0 = EMPTY_TENANT_CONFIG_STORE;
    const s1 = setTenantConfig(s0, "acme", { autonomyLevel: "auto" });
    expect(s1).not.toBe(s0);
    expect(s0).toEqual({}); // input untouched
    expect(getTenantConfig(s1, "acme").autonomyLevel).toBe("auto");
  });

  it("getTenantConfig returns the defaults for a tenant that has set nothing", () => {
    expect(getTenantConfig(EMPTY_TENANT_CONFIG_STORE, "unknown")).toEqual(DEFAULT_TENANT_CONFIG);
  });

  it("two tenants hold independent configs with no cross-contamination (acceptance)", () => {
    let store = EMPTY_TENANT_CONFIG_STORE;
    store = setTenantConfig(store, "tenant-a", { autonomyLevel: "auto", preferences: { allowedActionClasses: ["open_pr"] } });
    store = setTenantConfig(store, "tenant-b", { autonomyLevel: "off" });
    const a = getTenantConfig(store, "tenant-a");
    const b = getTenantConfig(store, "tenant-b");
    expect(a.autonomyLevel).toBe("auto");
    expect(b.autonomyLevel).toBe("off");
    // Mutating tenant A's resolved list must not affect tenant B or the defaults.
    (a.preferences.allowedActionClasses as string[]).push("delete_repo");
    expect(getTenantConfig(store, "tenant-b").preferences.allowedActionClasses).not.toContain("delete_repo");
    expect(DEFAULT_TENANT_CONFIG.preferences.allowedActionClasses).not.toContain("delete_repo");
  });
});

describe("getTenantConfig same-tenant isolation + maxConcurrentLoops normalization (#9614)", () => {
  it("returns a fresh copy on a HIT — a caller mutating it never rewrites that tenant's stored config", () => {
    const store = setTenantConfig(EMPTY_TENANT_CONFIG_STORE, "acme");
    const first = getTenantConfig(store, "acme");
    // The read-path leak (#9614): before the fix, this pushed straight into the stored object.
    (first.preferences.allowedActionClasses as string[]).push("merge_pr");
    first.preferences.maxConcurrentLoops = 99;

    const second = getTenantConfig(store, "acme");
    expect(second.preferences.allowedActionClasses).toEqual(["open_pr", "comment"]);
    expect(second.preferences.maxConcurrentLoops).toBe(1);
    // No shared mutable reference between reads.
    expect(second.preferences).not.toBe(first.preferences);
    expect(second.preferences.allowedActionClasses).not.toBe(first.preferences.allowedActionClasses);
  });

  it("falls back to a fresh copy of the defaults on a MISS, and mutating it never touches the shared default", () => {
    const a = getTenantConfig(EMPTY_TENANT_CONFIG_STORE, "unknown");
    expect(a).toEqual(DEFAULT_TENANT_CONFIG);
    (a.preferences.allowedActionClasses as string[]).push("x");
    expect(getTenantConfig(EMPTY_TENANT_CONFIG_STORE, "unknown").preferences.allowedActionClasses).toEqual(["open_pr", "comment"]);
    expect(DEFAULT_TENANT_CONFIG.preferences.allowedActionClasses).not.toContain("x");
  });

  it("normalizes a non-finite / negative / fractional maxConcurrentLoops to a non-negative integer", () => {
    for (const [input, expected] of [
      [-5, 0],
      [0.5, 0],
      [3.9, 3],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [2, 2],
    ] as const) {
      expect(resolveTenantConfig({ preferences: { maxConcurrentLoops: input } }).preferences.maxConcurrentLoops).toBe(expected);
    }
    // An absent override inherits the already-valid default (the `??` fallback side).
    expect(resolveTenantConfig().preferences.maxConcurrentLoops).toBe(1);
  });
});
