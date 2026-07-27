import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSelfHostCrashHandlers,
  resetSelfHostCrashHandlersForTest,
  type ProcessLike,
} from "../../src/selfhost/process-lifecycle";

type Listener = (...args: unknown[]) => void;

/** A fake `process` that captures the last-registered listener per event so tests can invoke it directly --
 *  mirrors packages/loopover-miner/lib/process-lifecycle.ts's own test helper (miner-process-lifecycle.test.ts). */
function makeFakeProcess() {
  const handlers = new Map<string, Listener>();
  const exit = vi.fn();
  const proc: ProcessLike = {
    on(event: string, listener: Listener) {
      handlers.set(event, listener);
      return proc;
    },
    exit,
  };
  return { proc, handlers, exit };
}

const SIGNAL_EVENTS = ["uncaughtException", "unhandledRejection"];

/** Run `fn`, then strip any listeners it added to the REAL process (only relevant to the default-process test). */
function withRealProcessCleanup(fn: () => void) {
  const before = new Map(SIGNAL_EVENTS.map((event) => [event, new Set(process.rawListeners(event))]));
  try {
    fn();
  } finally {
    for (const event of SIGNAL_EVENTS) {
      for (const listener of process.rawListeners(event)) {
        if (!before.get(event)?.has(listener)) process.removeListener(event, listener as Listener);
      }
    }
  }
}

beforeEach(() => resetSelfHostCrashHandlersForTest());
afterEach(() => {
  resetSelfHostCrashHandlersForTest();
  vi.restoreAllMocks();
});

describe("self-host process crash handlers (#9133)", () => {
  it("installs uncaughtException/unhandledRejection once and reports whether it did", () => {
    const { proc } = makeFakeProcess();
    expect(installSelfHostCrashHandlers({ process: proc, log: vi.fn(), exit: vi.fn() })).toBe(true);
    // Already installed, no force -> no-op.
    expect(installSelfHostCrashHandlers({ process: proc, log: vi.fn(), exit: vi.fn() })).toBe(false);
    // force reinstalls.
    expect(installSelfHostCrashHandlers({ process: proc, log: vi.fn(), exit: vi.fn(), force: true })).toBe(true);
  });

  it("logs a structured fatal line and exits 1 on an uncaught exception", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    const log = vi.fn();
    installSelfHostCrashHandlers({ process: proc, log, exit });

    const error = new Error("kaboom");
    await handlers.get("uncaughtException")?.(error);

    const logged = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({ level: "fatal", event: "selfhost_uncaughtException" });
    expect(logged.error).toContain(error.stack);
    expect(exit).toHaveBeenCalledWith(1);
  });

  // REGRESSION (#9133): this is the exact bug the issue fixes -- an unhandled rejection must terminate the
  // process exactly like an uncaught exception does, independent of whether telemetry is configured. Before
  // this fix, server.ts registered NO handler of its own for this event at all.
  it("REGRESSION (#9133): logs a structured fatal line and exits 1 on an unhandled rejection, same as uncaughtException", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    const log = vi.fn();
    installSelfHostCrashHandlers({ process: proc, log, exit });

    await handlers.get("unhandledRejection")?.("a rejected reason, not necessarily an Error");

    const logged = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({
      level: "fatal",
      event: "selfhost_unhandledRejection",
      error: "a rejected reason, not necessarily an Error",
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("falls back to an Error's message when it has no stack", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    const log = vi.fn();
    installSelfHostCrashHandlers({ process: proc, log, exit });

    const error = new Error("stackless");
    Object.defineProperty(error, "stack", { value: undefined });
    await handlers.get("uncaughtException")?.(error);

    const logged = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(logged.error).toBe("stackless");
  });

  it("calls the injected captureError with the error and a kind tag for both event types (telemetry configured)", async () => {
    const { proc, handlers } = makeFakeProcess();
    const captureError = vi.fn();
    installSelfHostCrashHandlers({ process: proc, log: vi.fn(), exit: vi.fn(), captureError });

    const error = new Error("kaboom");
    await handlers.get("uncaughtException")?.(error);
    expect(captureError).toHaveBeenCalledWith(error, { kind: "uncaughtException" });

    await handlers.get("unhandledRejection")?.("plain reason");
    expect(captureError).toHaveBeenCalledWith("plain reason", { kind: "unhandledRejection" });
  });

  it("defaults captureError and flush to no-ops when telemetry is NOT configured, and still exits 1 (the other arm)", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    installSelfHostCrashHandlers({ process: proc, log: vi.fn(), exit });

    await expect(handlers.get("uncaughtException")?.(new Error("no telemetry"))).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockClear();
    await expect(handlers.get("unhandledRejection")?.("no telemetry either")).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("AWAITS flush before exiting -- exit() must not fire while telemetry is still draining", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    let resolveFlush: () => void = () => {};
    const flushPending = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    const flush = vi.fn(() => flushPending);
    installSelfHostCrashHandlers({ process: proc, log: vi.fn(), flush });

    const handled = handlers.get("uncaughtException")?.(new Error("kaboom"));
    await Promise.resolve(); // let the handler's synchronous-until-await portion run
    expect(exit).not.toHaveBeenCalled(); // flush() has not resolved yet

    resolveFlush();
    await handled;
    expect(exit).toHaveBeenCalledWith(1); // only fires once the awaited flush actually resolved
  });

  it("actually invokes console.error as the default log sink when none is injected", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installSelfHostCrashHandlers({ process: proc, exit });

    await handlers.get("uncaughtException")?.(new Error("default log sink"));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("default log sink"));
    errorSpy.mockRestore();
  });

  it("uses console.error as the default log sink and process.exit as the default exit", () => {
    withRealProcessCleanup(() => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(installSelfHostCrashHandlers({ force: true })).toBe(true);
      for (const event of SIGNAL_EVENTS) {
        expect(process.rawListeners(event).length).toBeGreaterThan(0);
      }
      errorSpy.mockRestore();
    });
  });

  it("truncates a very long error description to 4000 chars so a runaway stack can't blow out the log line", async () => {
    const { proc, handlers } = makeFakeProcess();
    const log = vi.fn();
    installSelfHostCrashHandlers({ process: proc, log, exit: vi.fn() });

    await handlers.get("unhandledRejection")?.("x".repeat(10_000));

    const logged = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(logged.error.length).toBe(4000);
  });
});
