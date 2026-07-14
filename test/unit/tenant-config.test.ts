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
