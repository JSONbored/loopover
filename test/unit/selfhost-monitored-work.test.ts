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
  isOrbRelayRegistrationAlerting,
  ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS,
  registerOrbRelayWithMonitor,
  runOrbExportWithMonitor,
  runScheduledLoopWithMonitor,
  type OrbRelayDrainState,
} from "../../src/selfhost/monitored-work";
import { drainOrbRelay, type OrbRelayRegistrationState } from "../../src/orb/broker-client";
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
        state: { pendingAck: [], lastDrainAtMs: null },
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
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"], lastDrainAtMs: null };
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

  it("REGRESSION (#audit-orb-relay-enqueue-isolation): an enqueue that throws for one event does not abort the rest of the batch", async () => {
    const state: OrbRelayDrainState = { pendingAck: [], lastDrainAtMs: null };
    const drain = vi.fn().mockResolvedValue([
      { deliveryId: "ok-1", eventName: "pull_request", rawBody: "{}" },
      { deliveryId: "throws-2", eventName: "issues", rawBody: "{}" },
      { deliveryId: "ok-3", eventName: "check_suite", rawBody: "{}" },
    ]);
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce("queued")
      .mockRejectedValueOnce(new Error("D1 write error"))
      .mockResolvedValueOnce("queued");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drainOrbRelayWithMonitor({
      state,
      relayEnv: {},
      env: {} as Env,
      drain,
      enqueue,
    });

    // All 3 events were attempted -- ok-3 was still reached even though throws-2 (the 2nd) rejected.
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenNthCalledWith(3, {}, "ok-3", "check_suite", "{}");
    // throws-2 is NOT acked (the relay redelivers it next drain), but both successful events are.
    expect(state.pendingAck).toEqual(["ok-1", "ok-3"]);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("orb_relay_enqueue_threw"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "orb_relay_enqueue_threw", eventName: "issues", error: "D1 write error" });
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_orb_webhook_total{event="pull_request",result="queued"} 1');
    expect(metrics).toContain('gittensory_orb_webhook_total{event="issues",result="enqueue_failed"} 1');
    expect(metrics).toContain('gittensory_orb_webhook_total{event="check_suite",result="queued"} 1');
    errors.mockRestore();
  });

  it("logs a non-Error enqueue rejection by stringifying it (the false ternary arm)", async () => {
    const state: OrbRelayDrainState = { pendingAck: [], lastDrainAtMs: null };
    const drain = vi.fn().mockResolvedValue([{ deliveryId: "throws-1", eventName: "pull_request", rawBody: "{}" }]);
    const enqueue = vi.fn().mockRejectedValueOnce("not an Error instance");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drainOrbRelayWithMonitor({ state, relayEnv: {}, env: {} as Env, drain, enqueue });

    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("orb_relay_enqueue_threw"));
    expect(JSON.parse(logged!)).toMatchObject({ error: "not an Error instance" });
    errors.mockRestore();
  });

  it("clears previous Orb relay acks and stays quiet when the broker has no events", async () => {
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"], lastDrainAtMs: null };
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
      nowMs: 5_000,
    });

    expect(state.pendingAck).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(await renderMetrics()).toContain('gittensory_orb_relay_drains_total{result="empty"} 1');
    // An empty poll still proves the broker round-trip succeeded -- stamped even with zero events.
    expect(state.lastDrainAtMs).toBe(5_000);
  });

  it("stamps lastDrainAtMs with the real clock when no nowMs override is given", async () => {
    const state: OrbRelayDrainState = { pendingAck: [], lastDrainAtMs: null };
    const before = Date.now();

    await drainOrbRelayWithMonitor({
      state,
      relayEnv: {},
      env: {} as Env,
      drain: vi.fn().mockResolvedValue([]),
      enqueue: vi.fn(),
    });

    expect(state.lastDrainAtMs).toBeGreaterThanOrEqual(before);
  });

  it("does not stamp drain progress when the production broker drain gets a non-ok response", async () => {
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"], lastDrainAtMs: 1_000 };

    await expect(
      drainOrbRelayWithMonitor({
        state,
        relayEnv: { ORB_ENROLLMENT_SECRET: "s" },
        env: {} as Env,
        drain: (relayEnv, ack) => drainOrbRelay(relayEnv, ack, (async () => new Response("down", { status: 503 })) as typeof fetch),
        enqueue: vi.fn(),
        nowMs: 5_000,
      }),
    ).rejects.toThrow("orb_relay_drain_http_503");

    expect(state.pendingAck).toEqual(["previous-delivery"]);
    expect(state.lastDrainAtMs).toBe(1_000);
  });

  it("preserves pending Orb relay acks and skips the drain-progress stamp when the broker drain throws", async () => {
    const state: OrbRelayDrainState = { pendingAck: ["previous-delivery"], lastDrainAtMs: null };
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
    expect(state.lastDrainAtMs).toBeNull();
  });

  describe("isOrbRelayRegistrationAlerting", () => {
    it("does not alert below the failure streak with no drain-progress evidence yet (a lone boot-time hiccup)", () => {
      expect(isOrbRelayRegistrationAlerting({ consecutiveFailures: 1, drainLastAtMs: null, nowMs: 1_000 })).toBe(false);
      expect(isOrbRelayRegistrationAlerting({ consecutiveFailures: 2, drainLastAtMs: null, nowMs: 1_000 })).toBe(false);
    });

    it("does not alert below the failure streak while a known drain is still fresh", () => {
      expect(
        isOrbRelayRegistrationAlerting({ consecutiveFailures: 1, drainLastAtMs: 1_000, nowMs: 1_000 + ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS }),
      ).toBe(false); // exactly at the window boundary — not yet OVER it
    });

    it("alerts once the consecutive-failure streak reaches the threshold, regardless of drain freshness", () => {
      expect(isOrbRelayRegistrationAlerting({ consecutiveFailures: 3, drainLastAtMs: Date.now(), nowMs: Date.now() })).toBe(true);
      expect(isOrbRelayRegistrationAlerting({ consecutiveFailures: 4, drainLastAtMs: null, nowMs: 1_000 })).toBe(true);
    });

    it("alerts once a known last-drain timestamp goes stale past the no-progress window, even below the streak threshold", () => {
      expect(
        isOrbRelayRegistrationAlerting({ consecutiveFailures: 1, drainLastAtMs: 0, nowMs: ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS + 1 }),
      ).toBe(true);
    });

    it("defaults nowMs to the real clock when omitted", () => {
      expect(isOrbRelayRegistrationAlerting({ consecutiveFailures: 0, drainLastAtMs: Date.now() })).toBe(false);
      expect(isOrbRelayRegistrationAlerting({ consecutiveFailures: 0, drainLastAtMs: Date.now() - ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS - 1 })).toBe(true);
    });
  });

  describe("registerOrbRelayWithMonitor", () => {
    const freshState = (): OrbRelayRegistrationState => ({ registered: false, lastAttemptAtMs: null, attempts: 0, consecutiveFailures: 0 });

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
      // A first-try success is not a recovery -- no recovered series at all.
      expect(await renderMetrics()).not.toContain('result="recovered"');
    });

    it("logs a distinct recovered event and records the recovered metric when registration succeeds after prior failures", async () => {
      const log = vi.fn();
      const state = freshState();
      state.attempts = 3; // two prior failed attempts before this one succeeded
      const register = vi.fn().mockResolvedValue({ status: "registered" });

      await registerOrbRelayWithMonitor({ env: { ORB_RELAY_MODE: "pull" }, state, register, log });

      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: "selfhost_orb_relay_register_recovered", mode: "pull", attempts: 3 }),
      );
      expect(await renderMetrics()).toContain('gittensory_orb_relay_register_total{mode="pull",result="recovered"} 1');
    });

    it("warns (not errors) on a single pull-mode failure below the streak threshold with no drain-progress evidence yet", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 1;
        state.consecutiveFailures = 1;
        const register = vi.fn().mockResolvedValue({ status: "failed", reason: "http_500" });

        await registerOrbRelayWithMonitor({ env: { ORB_RELAY_MODE: "pull" }, state, register });

        expect(warnSpy).toHaveBeenCalledWith(
          JSON.stringify({ level: "warn", event: "selfhost_orb_relay_register_failed", mode: "pull", error: "http_500", attempts: 1, consecutiveFailures: 1 }),
        );
        expect(errorSpy).not.toHaveBeenCalled();
        expect(await renderMetrics()).toContain('gittensory_orb_relay_register_total{mode="pull",result="failed"} 1');
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("stays a warning while orb_relay_drained keeps firing, even across several failures under the streak threshold", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 1;
        state.consecutiveFailures = 1; // one hiccup, still under ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK
        const drainState: OrbRelayDrainState = { pendingAck: [], lastDrainAtMs: 1_000 }; // relay drained recently
        const register = vi.fn().mockResolvedValue({ status: "failed", reason: "timeout" });

        await registerOrbRelayWithMonitor({
          env: { ORB_RELAY_MODE: "pull" },
          state,
          register,
          drainState,
          nowMs: 1_000 + 60_000, // well inside ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS
        });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("escalates a pull-mode failure to an error once the consecutive-failure streak crosses the threshold", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 3;
        state.consecutiveFailures = 3; // == ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK
        const drainState: OrbRelayDrainState = { pendingAck: [], lastDrainAtMs: 1_000 }; // still draining fine
        const register = vi.fn().mockResolvedValue({ status: "failed", reason: "http_500" });

        await registerOrbRelayWithMonitor({ env: { ORB_RELAY_MODE: "pull" }, state, register, drainState, nowMs: 2_000 });

        expect(errorSpy).toHaveBeenCalledWith(
          JSON.stringify({ level: "error", event: "selfhost_orb_relay_register_failed", mode: "pull", error: "http_500", attempts: 3, consecutiveFailures: 3 }),
        );
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("escalates a pull-mode failure to an error once the drain loop has gone quiet past the no-progress window", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const state = freshState();
        state.attempts = 1;
        state.consecutiveFailures = 1; // below the streak threshold on its own
        const drainState: OrbRelayDrainState = { pendingAck: [], lastDrainAtMs: 0 };
        const register = vi.fn().mockResolvedValue({ status: "failed", reason: "timeout" });

        await registerOrbRelayWithMonitor({
          env: { ORB_RELAY_MODE: "pull" },
          state,
          register,
          drainState,
          nowMs: ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS + 1,
        });

        expect(errorSpy).toHaveBeenCalledWith(
          JSON.stringify({ level: "error", event: "selfhost_orb_relay_register_failed", mode: "pull", error: "timeout", attempts: 1, consecutiveFailures: 1 }),
        );
        expect(warnSpy).not.toHaveBeenCalled();
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
        state.consecutiveFailures = 1;
        const register = vi.fn().mockResolvedValue({ status: "failed" });

        await registerOrbRelayWithMonitor({ env: {}, state, register });

        expect(errorSpy).toHaveBeenCalledWith(
          JSON.stringify({ level: "error", event: "selfhost_orb_relay_register_failed", mode: "push", error: "unknown", attempts: 1, consecutiveFailures: 1 }),
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
