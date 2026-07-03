import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSentryMonitor: vi.fn(
    async (_name: string, _context: Record<string, unknown>, callback: () => Promise<unknown>) =>
      callback(),
  ),
}));

vi.mock("../../src/selfhost/sentry", () => ({
  withSentryMonitor: mocks.withSentryMonitor,
}));

import {
  drainOrbRelayWithMonitor,
  registerOrbRelayWithMonitor,
  runOrbExportWithMonitor,
  runScheduledLoopWithMonitor,
  type OrbRelayDrainState,
} from "../../src/selfhost/monitored-work";
import type { OrbRelayRegistrationState } from "../../src/orb/broker-client";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

beforeEach(() => {
  vi.clearAllMocks();
  resetMetrics();
});

describe("self-host monitored recurring work", () => {
  it("runs the scheduled loop through the Sentry monitor with cron context", async () => {
    const scheduled = vi.fn().mockResolvedValue("done");

    await expect(runScheduledLoopWithMonitor("*/2 * * * *", scheduled)).resolves.toBe(
      "done",
    );

    expect(mocks.withSentryMonitor).toHaveBeenCalledWith(
      "scheduled-loop",
      { jobType: "scheduled-loop", cron: "*/2 * * * *" },
      expect.any(Function),
    );
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it("logs Orb export counts only when the batch exported work", async () => {
    const exportBatch = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const log = vi.fn();

    await runOrbExportWithMonitor(exportBatch, log);
    expect(mocks.withSentryMonitor).toHaveBeenLastCalledWith(
      "orb-export",
      { jobType: "orb-export" },
      expect.any(Function),
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "selfhost_orb_export", exported: 3 }),
    );

    log.mockClear();
    await runOrbExportWithMonitor(exportBatch, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("uses console.log as the default export and relay drain logger", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runOrbExportWithMonitor(async () => 1);
      await drainOrbRelayWithMonitor({
        state: { pendingAck: [] },
        relayEnv: {},
        env: {} as Env,
        drain: vi.fn().mockResolvedValue([
          { deliveryId: "queued-1", eventName: "pull_request", rawBody: "{}" },
        ]),
        enqueue: vi.fn().mockResolvedValue("queued"),
      });

      expect(consoleLog).toHaveBeenCalledWith(
        JSON.stringify({ event: "selfhost_orb_export", exported: 1 }),
      );
      expect(consoleLog).toHaveBeenCalledWith(
        JSON.stringify({ event: "orb_relay_drained", count: 1 }),
      );
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("drains Orb relay events and retains acks only for durably handled deliveries", async () => {
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"] };
    const relayEnv = {
      ORB_ENROLLMENT_SECRET: "secret",
      ORB_BROKER_URL: "https://orb.example",
    };
    const env = {} as Env;
    const drain = vi.fn().mockResolvedValue([
      { deliveryId: "queued-1", eventName: "pull_request", rawBody: "{}" },
      { deliveryId: "failed-1", eventName: "push", rawBody: "{}" },
      { deliveryId: "duplicate-1", eventName: "check_suite", rawBody: "{}" },
    ]);
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce("queued")
      .mockResolvedValueOnce("enqueue_failed")
      .mockResolvedValueOnce("duplicate");
    const log = vi.fn();

    await drainOrbRelayWithMonitor({
      state,
      relayEnv,
      env,
      drain,
      enqueue,
      log,
    });

    expect(mocks.withSentryMonitor).toHaveBeenCalledWith(
      "orb-relay-drain",
      { jobType: "orb-relay-drain", pendingAckCount: 1 },
      expect.any(Function),
    );
    expect(drain).toHaveBeenCalledWith(relayEnv, ["previous-delivery"]);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      env,
      "queued-1",
      "pull_request",
      "{}",
    );
    expect(enqueue).toHaveBeenNthCalledWith(2, env, "failed-1", "push", "{}");
    expect(enqueue).toHaveBeenNthCalledWith(
      3,
      env,
      "duplicate-1",
      "check_suite",
      "{}",
    );
    expect(state.pendingAck).toEqual(["queued-1", "duplicate-1"]);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "orb_relay_drained", count: 3 }),
    );
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_orb_relay_drains_total{result="events"} 1');
    expect(metrics).toContain('gittensory_orb_webhook_total{event="pull_request",result="queued"} 1');
    expect(metrics).toContain('gittensory_orb_webhook_total{event="other",result="enqueue_failed"} 1');
    expect(metrics).toContain('gittensory_orb_webhook_total{event="check_suite",result="duplicate"} 1');
  });

  it("clears previous Orb relay acks and stays quiet when the broker has no events", async () => {
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"] };
    const drain = vi.fn().mockResolvedValue([]);
    const enqueue = vi.fn();
    const log = vi.fn();

    await drainOrbRelayWithMonitor({
      state,
      relayEnv: {},
      env: {} as Env,
      drain,
      enqueue,
      log,
    });

    expect(state.pendingAck).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(await renderMetrics()).toContain('gittensory_orb_relay_drains_total{result="empty"} 1');
  });

  it("preserves pending Orb relay acks when the broker drain throws before delivery state is known", async () => {
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"] };
    const drain = vi.fn().mockRejectedValue(new Error("broker down"));

    await expect(
      drainOrbRelayWithMonitor({
        state,
        relayEnv: {},
        env: {} as Env,
        drain,
        enqueue: vi.fn(),
      }),
    ).rejects.toThrow("broker down");

    expect(state.pendingAck).toEqual(["previous-delivery"]);
  });

  describe("registerOrbRelayWithMonitor", () => {
    const freshState = (): OrbRelayRegistrationState => ({ registered: false, lastAttemptAtMs: null, attempts: 0 });

    it("logs and records the registered metric on the first successful attempt", async () => {
      const log = vi.fn();
      const state = freshState();
      state.attempts = 1; // the injected register() already bumped attempts before returning
      const register = vi.fn().mockResolvedValue({ status: "registered" });

      await registerOrbRelayWithMonitor({ env: { ORB_RELAY_MODE: "push" }, state, register, log });

      expect(mocks.withSentryMonitor).toHaveBeenCalledWith(
        "orb-relay-register",
        { jobType: "orb-relay-register" },
        expect.any(Function),
      );
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: "selfhost_orb_relay_register", mode: "push", attempts: 1 }),
      );
      expect(await renderMetrics()).toContain('gittensory_orb_relay_register_total{mode="push",result="registered"} 1');
    });

    it("logs a distinct recovered event when registration succeeds after prior failures", async () => {
      const log = vi.fn();
      const state = freshState();
      state.attempts = 3; // two prior failed attempts before this one succeeded
      const register = vi.fn().mockResolvedValue({ status: "registered" });

      await registerOrbRelayWithMonitor({ env: { ORB_RELAY_MODE: "pull" }, state, register, log });

      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: "selfhost_orb_relay_register_recovered", mode: "pull", attempts: 3 }),
      );
    });

    it("warns (not errors) on a pull-mode failure, and records the failed metric", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 1;
        const register = vi.fn().mockResolvedValue({ status: "failed", reason: "http_500" });

        await registerOrbRelayWithMonitor({ env: { ORB_RELAY_MODE: "pull" }, state, register });

        expect(warnSpy).toHaveBeenCalledWith(
          JSON.stringify({ level: "warn", event: "selfhost_orb_relay_register_failed", mode: "pull", error: "http_500", attempts: 1 }),
        );
        expect(errorSpy).not.toHaveBeenCalled();
        expect(await renderMetrics()).toContain('gittensory_orb_relay_register_total{mode="pull",result="failed"} 1');
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("errors (not warns) on a push-mode failure, defaulting the reason to 'unknown' when absent", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 1;
        const register = vi.fn().mockResolvedValue({ status: "failed" });

        await registerOrbRelayWithMonitor({ env: {}, state, register });

        expect(errorSpy).toHaveBeenCalledWith(
          JSON.stringify({ level: "error", event: "selfhost_orb_relay_register_failed", mode: "push", error: "unknown", attempts: 1 }),
        );
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("stays silent (no log, no metric) for skipped / already-registered / backoff outcomes", async () => {
      const log = vi.fn();
      for (const status of ["skipped", "already_registered", "backoff"] as const) {
        const register = vi.fn().mockResolvedValue({ status });
        await registerOrbRelayWithMonitor({ env: {}, state: freshState(), register, log });
      }
      expect(log).not.toHaveBeenCalled();
      expect(await renderMetrics()).not.toContain("gittensory_orb_relay_register_total");
    });

    it("uses console.log as the default logger", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 1;
        await registerOrbRelayWithMonitor({
          env: { ORB_RELAY_MODE: "push" },
          state,
          register: vi.fn().mockResolvedValue({ status: "registered" }),
        });
        expect(consoleLog).toHaveBeenCalledWith(
          JSON.stringify({ event: "selfhost_orb_relay_register", mode: "push", attempts: 1 }),
        );
      } finally {
        consoleLog.mockRestore();
      }
    });
  });
});
