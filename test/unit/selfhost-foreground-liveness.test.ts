import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isForegroundDeferralStale,
  resolveForegroundLivenessConfig,
  type ForegroundLivenessConfig,
} from "../../src/selfhost/foreground-liveness";

describe("resolveForegroundLivenessConfig", () => {
  const envKeys = [
    "FOREGROUND_LIVENESS_ENABLED",
    "FOREGROUND_LIVENESS_MAX_DEFER_MS",
    "FOREGROUND_LIVENESS_CHECK_INTERVAL_MS",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns protective defaults with no env overrides", () => {
    expect(resolveForegroundLivenessConfig()).toEqual({
      enabled: true,
      maxDeferMs: 600_000,
      checkIntervalMs: 60_000,
    });
  });

  it("reads a custom FOREGROUND_LIVENESS_MAX_DEFER_MS and FOREGROUND_LIVENESS_CHECK_INTERVAL_MS when set", () => {
    process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "120000";
    process.env.FOREGROUND_LIVENESS_CHECK_INTERVAL_MS = "10000";
    const config = resolveForegroundLivenessConfig();
    expect(config.maxDeferMs).toBe(120_000);
    expect(config.checkIntervalMs).toBe(10_000);
  });

  it.each(["0", "false", "off", "no"])("treats FOREGROUND_LIVENESS_ENABLED=%s as disabled", (value) => {
    process.env.FOREGROUND_LIVENESS_ENABLED = value;
    expect(resolveForegroundLivenessConfig().enabled).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "anything-else"])(
    "treats FOREGROUND_LIVENESS_ENABLED=%s as enabled",
    (value) => {
      process.env.FOREGROUND_LIVENESS_ENABLED = value;
      expect(resolveForegroundLivenessConfig().enabled).toBe(true);
    },
  );

  it("keeps liveness enabled when the env var is unset/empty", () => {
    delete process.env.FOREGROUND_LIVENESS_ENABLED;
    expect(resolveForegroundLivenessConfig().enabled).toBe(true);
    process.env.FOREGROUND_LIVENESS_ENABLED = "";
    expect(resolveForegroundLivenessConfig().enabled).toBe(true);
  });

  it("falls back to the default max defer when the value is non-numeric", () => {
    process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "not-a-number";
    expect(resolveForegroundLivenessConfig().maxDeferMs).toBe(600_000);
  });

  it("falls back to the default max defer when the value is below the min (60_000)", () => {
    process.env.FOREGROUND_LIVENESS_MAX_DEFER_MS = "59999";
    expect(resolveForegroundLivenessConfig().maxDeferMs).toBe(600_000);
  });

  it("falls back to the default check interval when the value is non-numeric", () => {
    process.env.FOREGROUND_LIVENESS_CHECK_INTERVAL_MS = "not-a-number";
    expect(resolveForegroundLivenessConfig().checkIntervalMs).toBe(60_000);
  });

  it("falls back to the default check interval when the value is below the min (5_000)", () => {
    process.env.FOREGROUND_LIVENESS_CHECK_INTERVAL_MS = "4999";
    expect(resolveForegroundLivenessConfig().checkIntervalMs).toBe(60_000);
  });
});

describe("isForegroundDeferralStale", () => {
  const now = 1_000_000_000;
  const config: ForegroundLivenessConfig = { enabled: true, maxDeferMs: 600_000, checkIntervalMs: 60_000 };

  it("is stale once the pending age is at or beyond maxDeferMs", () => {
    expect(isForegroundDeferralStale(config, now - config.maxDeferMs - 1, now)).toBe(true);
  });

  it("is stale exactly AT the boundary (>=, not >)", () => {
    expect(isForegroundDeferralStale(config, now - config.maxDeferMs, now)).toBe(true);
  });

  it("is not stale when the pending age is below maxDeferMs", () => {
    expect(isForegroundDeferralStale(config, now - (config.maxDeferMs - 1), now)).toBe(false);
  });

  it("is never stale when disabled, even for a huge age (config.enabled && short-circuit)", () => {
    const disabled: ForegroundLivenessConfig = { ...config, enabled: false };
    expect(isForegroundDeferralStale(disabled, now - config.maxDeferMs * 100, now)).toBe(false);
  });
});
