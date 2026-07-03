import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateMaintenanceAdmission,
  isMaintenanceJobType,
  maintenanceAdmissionDeferMs,
  MAINTENANCE_JOB_TYPES,
  resolveMaintenanceAdmissionConfig,
  type MaintenanceAdmissionConfig,
  type MaintenancePressureSignals,
} from "../../src/selfhost/maintenance-admission";

const CLEAR_SIGNALS: MaintenancePressureSignals = {
  livePendingCount: 0,
  oldestLivePendingAgeMs: null,
  maintenancePendingCount: 0,
  oldestMaintenancePendingAgeMs: null,
  hostLoadAvg1PerCore: null,
};

const CONFIG: MaintenanceAdmissionConfig = {
  enabled: true,
  maxLivePendingCount: 5,
  maxLiveJobAgeMs: 120_000,
  maxMaintenancePendingCount: 15,
  maxHostLoadAvg1PerCore: 1.5,
  deferMs: 180_000,
  maxDeferAgeMs: 4 * 60 * 60_000,
};

describe("isMaintenanceJobType", () => {
  it("classifies every listed maintenance sweep type", () => {
    for (const type of MAINTENANCE_JOB_TYPES) {
      expect(isMaintenanceJobType(type)).toBe(true);
    }
  });

  it("does not classify targeted/foreground job types as maintenance", () => {
    for (const type of [
      "github-webhook",
      "agent-regate-pr",
      "agent-regate-sweep",
      "recapture-preview",
      "backfill-repo-segment",
      "backfill-pr-details",
      "run-agent",
      "submit-draft",
      "retry-orb-relay",
    ]) {
      expect(isMaintenanceJobType(type)).toBe(false);
    }
  });
});

describe("evaluateMaintenanceAdmission", () => {
  const now = 1_000_000_000;

  it("admits when every pressure signal is clear", () => {
    expect(evaluateMaintenanceAdmission(CLEAR_SIGNALS, CONFIG, now - 1_000, now)).toEqual({
      admit: true,
      reason: "pressure_clear",
    });
  });

  it("admits unconditionally when disabled, even under extreme pressure", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, livePendingCount: 999 },
      { ...CONFIG, enabled: false },
      now - 1_000,
      now,
    );
    expect(decision).toEqual({ admit: true, reason: "disabled" });
  });

  it("defers when live pending count exceeds the threshold", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, livePendingCount: 6 },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision).toEqual({ admit: false, reason: "live_pending_high" });
  });

  it("admits when live pending count is AT (not over) the threshold", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, livePendingCount: 5 },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision.admit).toBe(true);
  });

  it("defers when the oldest live job has waited past the max age", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, oldestLivePendingAgeMs: 120_001 },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision).toEqual({ admit: false, reason: "live_job_age_high" });
  });

  it("admits when there is no live job at all (null oldest age)", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, oldestLivePendingAgeMs: null },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision.admit).toBe(true);
  });

  it("defers when the maintenance lane itself is already backed up", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, maintenancePendingCount: 16 },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision).toEqual({ admit: false, reason: "maintenance_pending_high" });
  });

  it("defers when host load per core exceeds the threshold", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, hostLoadAvg1PerCore: 1.51 },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision).toEqual({ admit: false, reason: "host_load_high" });
  });

  it("admits when host load is unavailable (null), never treating null as high", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, hostLoadAvg1PerCore: null },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision.admit).toBe(true);
  });

  it("force-admits via trickle once pending since exceeds the max defer age, even under pressure", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, livePendingCount: 999, hostLoadAvg1PerCore: 99 },
      CONFIG,
      now - CONFIG.maxDeferAgeMs,
      now,
    );
    expect(decision).toEqual({ admit: true, reason: "trickle_max_defer_age" });
  });

  it("does not trickle-admit a job that hasn't waited long enough yet", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, livePendingCount: 999 },
      CONFIG,
      now - (CONFIG.maxDeferAgeMs - 1),
      now,
    );
    expect(decision).toEqual({ admit: false, reason: "live_pending_high" });
  });

  it("checks live pressure before maintenance-lane pressure (priority order)", () => {
    const decision = evaluateMaintenanceAdmission(
      { ...CLEAR_SIGNALS, livePendingCount: 6, maintenancePendingCount: 16 },
      CONFIG,
      now - 1_000,
      now,
    );
    expect(decision.reason).toBe("live_pending_high");
  });
});

describe("maintenanceAdmissionDeferMs", () => {
  it("returns at least the base defer and at most double it (base + jitter)", () => {
    const value = maintenanceAdmissionDeferMs(CONFIG, "seed-a");
    expect(value).toBeGreaterThanOrEqual(CONFIG.deferMs);
    expect(value).toBeLessThanOrEqual(CONFIG.deferMs * 2);
  });

  it("is deterministic for the same seed", () => {
    expect(maintenanceAdmissionDeferMs(CONFIG, "seed-b")).toBe(maintenanceAdmissionDeferMs(CONFIG, "seed-b"));
  });

  it("varies (in general) across different seeds", () => {
    const values = new Set(
      Array.from({ length: 10 }, (_, i) => maintenanceAdmissionDeferMs(CONFIG, `seed-${i}`)),
    );
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("resolveMaintenanceAdmissionConfig", () => {
  const envKeys = [
    "MAINTENANCE_ADMISSION_ENABLED",
    "MAINTENANCE_ADMISSION_MAX_LIVE_PENDING",
    "MAINTENANCE_ADMISSION_MAX_LIVE_AGE_MS",
    "MAINTENANCE_ADMISSION_MAX_PENDING",
    "MAINTENANCE_ADMISSION_MAX_HOST_LOAD",
    "MAINTENANCE_ADMISSION_DEFER_MS",
    "MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS",
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
    expect(resolveMaintenanceAdmissionConfig()).toEqual({
      enabled: true,
      maxLivePendingCount: 5,
      maxLiveJobAgeMs: 120_000,
      maxMaintenancePendingCount: 15,
      maxHostLoadAvg1PerCore: 1.5,
      deferMs: 180_000,
      maxDeferAgeMs: 4 * 60 * 60_000,
    });
  });

  it("reads every knob from the environment when set", () => {
    process.env.MAINTENANCE_ADMISSION_MAX_LIVE_PENDING = "10";
    process.env.MAINTENANCE_ADMISSION_MAX_LIVE_AGE_MS = "60000";
    process.env.MAINTENANCE_ADMISSION_MAX_PENDING = "30";
    process.env.MAINTENANCE_ADMISSION_MAX_HOST_LOAD = "2.25";
    process.env.MAINTENANCE_ADMISSION_DEFER_MS = "5000";
    process.env.MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS = "3600000";
    const config = resolveMaintenanceAdmissionConfig();
    expect(config.maxLivePendingCount).toBe(10);
    expect(config.maxLiveJobAgeMs).toBe(60_000);
    expect(config.maxMaintenancePendingCount).toBe(30);
    expect(config.maxHostLoadAvg1PerCore).toBe(2.25);
    expect(config.deferMs).toBe(5_000);
    expect(config.maxDeferAgeMs).toBe(3_600_000);
  });

  it.each(["0", "false", "off", "no"])("treats MAINTENANCE_ADMISSION_ENABLED=%s as disabled", (value) => {
    process.env.MAINTENANCE_ADMISSION_ENABLED = value;
    expect(resolveMaintenanceAdmissionConfig().enabled).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "anything-else"])(
    "treats MAINTENANCE_ADMISSION_ENABLED=%s as enabled",
    (value) => {
      process.env.MAINTENANCE_ADMISSION_ENABLED = value;
      expect(resolveMaintenanceAdmissionConfig().enabled).toBe(true);
    },
  );

  it("falls back to the default host-load threshold on an invalid float", () => {
    process.env.MAINTENANCE_ADMISSION_MAX_HOST_LOAD = "not-a-number";
    expect(resolveMaintenanceAdmissionConfig().maxHostLoadAvg1PerCore).toBe(1.5);
  });

  it("falls back to the default host-load threshold on a negative float", () => {
    process.env.MAINTENANCE_ADMISSION_MAX_HOST_LOAD = "-1";
    expect(resolveMaintenanceAdmissionConfig().maxHostLoadAvg1PerCore).toBe(1.5);
  });
});
