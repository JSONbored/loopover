import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TENANT_CONFIG,
  EMPTY_TENANT_CONFIG_STORE,
  getTenantConfig,
  resolveTenantConfig,
  setTenantConfig,
} from "../dist/index.js";
import type { TenantConfig, TenantConfigStore } from "../dist/index.js";

test("resolveTenantConfig: defaults, autonomy override (recognized/unrecognized), explicit pauseOnFailure", () => {
  assert.deepEqual(resolveTenantConfig(), DEFAULT_TENANT_CONFIG);
  assert.equal(resolveTenantConfig({ autonomyLevel: "auto" }).autonomyLevel, "auto");
  assert.equal(
    resolveTenantConfig({ autonomyLevel: "banana" as never }).autonomyLevel,
    DEFAULT_TENANT_CONFIG.autonomyLevel,
  );
  assert.equal(resolveTenantConfig({ preferences: { pauseOnFailure: false } }).preferences.pauseOnFailure, false);
});

test("#9614: maxConcurrentLoops normalizes an explicit override (finiteNonNegativeInt); absent inherits the default 1", () => {
  const norm = (v: number) => resolveTenantConfig({ preferences: { maxConcurrentLoops: v } }).preferences.maxConcurrentLoops;
  assert.equal(norm(-5), 0);
  assert.equal(norm(0.5), 0);
  assert.equal(norm(Number.NaN), 0);
  assert.equal(norm(Number.POSITIVE_INFINITY), 0);
  assert.equal(norm(3), 3);
  assert.equal(resolveTenantConfig({ preferences: { pauseOnFailure: true } }).preferences.maxConcurrentLoops, 1);
});

test("#9614: allowedActionClasses drops non-string override entries and copies the default when absent", () => {
  const cfg = resolveTenantConfig({
    preferences: { allowedActionClasses: ["open_pr", 42, null, "comment"] as unknown as string[] },
  });
  assert.deepEqual(cfg.preferences.allowedActionClasses, ["open_pr", "comment"]);
  assert.deepEqual(resolveTenantConfig().preferences.allowedActionClasses, DEFAULT_TENANT_CONFIG.preferences.allowedActionClasses);
});

test("#9614: getTenantConfig returns a caller-owned deep copy on the HIT path — mutating it never reaches the store", () => {
  const store = setTenantConfig(EMPTY_TENANT_CONFIG_STORE, "acme", { preferences: { allowedActionClasses: ["open_pr"] } });
  const first = getTenantConfig(store, "acme");
  (first.preferences.allowedActionClasses as string[]).push("merge_pr");
  first.preferences.maxConcurrentLoops = 99;
  first.autonomyLevel = "auto";
  const second = getTenantConfig(store, "acme");
  assert.deepEqual(second.preferences.allowedActionClasses, ["open_pr"]);
  assert.equal(second.preferences.maxConcurrentLoops, 1);
  assert.equal(second.autonomyLevel, "suggest");
});

test("#9614: getTenantConfig returns fresh defaults on the MISS path", () => {
  assert.deepEqual(getTenantConfig(EMPTY_TENANT_CONFIG_STORE, "unknown"), DEFAULT_TENANT_CONFIG);
});

test("#9614: setTenantConfig deep-freezes the stored entry (config, preferences, action-class array)", () => {
  const store: TenantConfigStore = setTenantConfig(EMPTY_TENANT_CONFIG_STORE, "acme", {});
  const stored = (store as Record<string, TenantConfig>)["acme"]!;
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.preferences), true);
  assert.equal(Object.isFrozen(stored.preferences.allowedActionClasses), true);
});
