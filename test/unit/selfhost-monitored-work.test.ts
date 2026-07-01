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
  runOrbExportWithMonitor,
  runScheduledLoopWithMonitor,
  type OrbRelayDrainState,
} from "../../src/selfhost/monitored-work";
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
});
