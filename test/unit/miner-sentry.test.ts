import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  withScope: vi.fn((callback: (scope: { setContext: (name: string, ctx: unknown) => void }) => void) =>
    callback({ setContext: vi.fn() }),
  ),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

vi.mock("@sentry/node", () => sentryMock);

import {
  captureMinerError,
  captureMinerErrorAndFlush,
  flushMinerSentry,
  initMinerSentry,
  resetMinerSentryForTesting,
} from "../../packages/loopover-miner/lib/sentry";

beforeEach(() => {
  vi.clearAllMocks();
  sentryMock.withScope.mockImplementation((callback: (scope: { setContext: (name: string, ctx: unknown) => void }) => void) =>
    callback({ setContext: vi.fn() }),
  );
  sentryMock.flush.mockResolvedValue(true);
});

afterEach(() => {
  resetMinerSentryForTesting();
});

describe("loopover-miner opt-in Sentry (#6011)", () => {
  describe("off state (no DSN)", () => {
    it("stays fully off when LOOPOVER_MINER_SENTRY_DSN is unset", async () => {
      expect(await initMinerSentry({})).toBe(false);
      expect(sentryMock.init).not.toHaveBeenCalled();
      expect(() => captureMinerError(new Error("x"))).not.toThrow();
      expect(sentryMock.captureException).not.toHaveBeenCalled();
      await expect(flushMinerSentry()).resolves.toBeUndefined();
      expect(sentryMock.flush).not.toHaveBeenCalled();
    });

    it("REGRESSION: an empty-string DSN is treated the same as unset (never activates)", async () => {
      expect(await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "" })).toBe(false);
      expect(sentryMock.init).not.toHaveBeenCalled();
    });

    it("captureMinerError never throws even when called before initMinerSentry (default off state)", () => {
      expect(() => captureMinerError("a plain string, not an Error")).not.toThrow();
      expect(() => captureMinerError(new Error("boom"), { kind: "test" })).not.toThrow();
    });

    it("defaults to process.env when no env argument is passed", async () => {
      const original = process.env.LOOPOVER_MINER_SENTRY_DSN;
      delete process.env.LOOPOVER_MINER_SENTRY_DSN;
      try {
        expect(await initMinerSentry()).toBe(false);
      } finally {
        if (original === undefined) delete process.env.LOOPOVER_MINER_SENTRY_DSN;
        else process.env.LOOPOVER_MINER_SENTRY_DSN = original;
      }
    });
  });

  describe("activated state (DSN set)", () => {
    it("initializes @sentry/node with the DSN and defaults environment to production", async () => {
      expect(await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" })).toBe(true);
      expect(sentryMock.init).toHaveBeenCalledWith({
        dsn: "https://key@sentry.example/1",
        environment: "production",
      });
    });

    it("passes through an explicit LOOPOVER_MINER_SENTRY_ENVIRONMENT instead of the production default", async () => {
      await initMinerSentry({
        LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1",
        LOOPOVER_MINER_SENTRY_ENVIRONMENT: "staging",
      });
      expect(sentryMock.init).toHaveBeenCalledWith({
        dsn: "https://key@sentry.example/1",
        environment: "staging",
      });
    });

    it("captureMinerError wraps a non-Error value and forwards it via Sentry.captureException", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      captureMinerError("plain string reason");
      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
      const captured = sentryMock.captureException.mock.calls[0]?.[0] as Error;
      expect(captured).toBeInstanceOf(Error);
      expect(captured.message).toBe("plain string reason");
    });

    it("captureMinerError forwards a real Error instance as-is (not re-wrapped)", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      const original = new Error("real error");
      captureMinerError(original);
      expect(sentryMock.captureException).toHaveBeenCalledWith(original);
    });

    it("sets scope context only when context is provided (both sides of the branch)", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      const setContext = vi.fn();
      sentryMock.withScope.mockImplementationOnce((callback: (scope: { setContext: typeof setContext }) => void) =>
        callback({ setContext }),
      );
      captureMinerError(new Error("with context"), { kind: "test_kind", repoFullName: "acme/widgets" });
      expect(setContext).toHaveBeenCalledWith("miner", { kind: "test_kind", repoFullName: "acme/widgets" });

      const setContext2 = vi.fn();
      sentryMock.withScope.mockImplementationOnce((callback: (scope: { setContext: typeof setContext2 }) => void) =>
        callback({ setContext: setContext2 }),
      );
      captureMinerError(new Error("no context"));
      expect(setContext2).not.toHaveBeenCalled();
    });

    it("REGRESSION: captureMinerError never throws even when Sentry.withScope itself throws", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      sentryMock.withScope.mockImplementationOnce(() => {
        throw new Error("sentry sdk internal failure");
      });
      expect(() => captureMinerError(new Error("boom"))).not.toThrow();
    });

    it("flushMinerSentry calls Sentry.flush with the given timeout, defaulting to 2000ms", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      await flushMinerSentry();
      expect(sentryMock.flush).toHaveBeenCalledWith(2000);

      await flushMinerSentry(500);
      expect(sentryMock.flush).toHaveBeenCalledWith(500);
    });

    it("REGRESSION: flushMinerSentry never throws or rejects even when Sentry.flush itself rejects", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      sentryMock.flush.mockRejectedValueOnce(new Error("flush timed out"));
      await expect(flushMinerSentry()).resolves.toBeUndefined();
    });
  });

  it("resetMinerSentryForTesting returns an activated instance to the default-off no-op", async () => {
    await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
    resetMinerSentryForTesting();
    captureMinerError(new Error("after reset"));
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    await flushMinerSentry();
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  describe("captureMinerErrorAndFlush (the crash-path convenience wrapper for installCliSignalHandlers)", () => {
    it("REGRESSION (#6011 follow-up): captures AND flushes, so a crash-path caller can await it before exiting instead of a bare capture that only queues the event", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      const error = new Error("crash");
      await captureMinerErrorAndFlush(error, { kind: "uncaughtException" });
      expect(sentryMock.captureException).toHaveBeenCalledWith(error);
      expect(sentryMock.flush).toHaveBeenCalledWith(2000);
    });

    it("resolves cleanly (no throw) when Sentry is off", async () => {
      await expect(captureMinerErrorAndFlush(new Error("x"))).resolves.toBeUndefined();
      expect(sentryMock.captureException).not.toHaveBeenCalled();
      expect(sentryMock.flush).not.toHaveBeenCalled();
    });

    it("still resolves cleanly when the underlying flush rejects", async () => {
      await initMinerSentry({ LOOPOVER_MINER_SENTRY_DSN: "https://key@sentry.example/1" });
      sentryMock.flush.mockRejectedValueOnce(new Error("flush timed out"));
      await expect(captureMinerErrorAndFlush(new Error("crash"))).resolves.toBeUndefined();
    });
  });
});
