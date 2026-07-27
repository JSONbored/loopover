import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupResourceCount,
  closeAllCleanupResources,
  installCliSignalHandlers,
  registerCleanupResource,
  resetProcessLifecycleForTesting,
} from "../../packages/loopover-miner/lib/process-lifecycle";

type Listener = (...args: unknown[]) => void;

/** A fake `process` that captures the last-registered listener per event so tests can invoke it directly. */
function makeFakeProcess() {
  const handlers = new Map<string, Listener>();
  const exit = vi.fn();
  const proc = {
    on(event: string, listener: Listener) {
      handlers.set(event, listener);
      return proc;
    },
    exit,
  };
  return { proc, handlers, exit };
}

const SIGNAL_EVENTS = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];

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

beforeEach(() => {
  resetProcessLifecycleForTesting();
});

afterEach(() => {
  resetProcessLifecycleForTesting();
  vi.restoreAllMocks();
});

describe("loopover-miner process lifecycle / crash-safety (#4826)", () => {
  it("registerCleanupResource ignores null and undefined but still returns a callable no-op", () => {
    expect(cleanupResourceCount()).toBe(0);
    expect(() => registerCleanupResource(null)()).not.toThrow();
    expect(() => registerCleanupResource(undefined)()).not.toThrow();
    expect(cleanupResourceCount()).toBe(0);
  });

  it("registers a resource and unregisters it via the returned handle", () => {
    const resource = { close: vi.fn() };
    const unregister = registerCleanupResource(resource);
    expect(cleanupResourceCount()).toBe(1);
    unregister();
    expect(cleanupResourceCount()).toBe(0);
    // Idempotent: a second unregister is harmless and does not close anything.
    unregister();
    expect(resource.close).not.toHaveBeenCalled();
  });

  it("closeAllCleanupResources closes both object and function resources, then empties the registry", () => {
    const store = { close: vi.fn() };
    const fnResource = vi.fn();
    registerCleanupResource(store);
    registerCleanupResource(fnResource);
    expect(cleanupResourceCount()).toBe(2);

    closeAllCleanupResources();

    expect(store.close).toHaveBeenCalledTimes(1);
    expect(fnResource).toHaveBeenCalledTimes(1);
    expect(cleanupResourceCount()).toBe(0);
  });

  it("swallows a failing close and reports it via onError, without stopping the other closes", () => {
    const boom = {
      close: () => {
        throw new Error("close failed");
      },
    };
    const ok = { close: vi.fn() };
    registerCleanupResource(boom);
    registerCleanupResource(ok);
    const onError = vi.fn();

    closeAllCleanupResources({ onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("close failed");
    expect(ok.close).toHaveBeenCalledTimes(1);
    expect(cleanupResourceCount()).toBe(0);
  });

  it("swallows a failing close even when no onError handler is provided", () => {
    registerCleanupResource(() => {
      throw new Error("nope");
    });
    expect(() => closeAllCleanupResources()).not.toThrow();
    expect(() => closeAllCleanupResources({ onError: "not-a-function" as unknown as () => void })).not.toThrow();
  });

  it("installs SIGINT/SIGTERM/uncaughtException/unhandledRejection once and reports whether it did", () => {
    const { proc } = makeFakeProcess();
    expect(installCliSignalHandlers({ process: proc, log: vi.fn(), exit: vi.fn() })).toBe(true);
    // Already installed, no force -> no-op.
    expect(installCliSignalHandlers({ process: proc, log: vi.fn(), exit: vi.fn() })).toBe(false);
    // force reinstalls.
    expect(installCliSignalHandlers({ process: proc, log: vi.fn(), exit: vi.fn(), force: true })).toBe(true);
  });

  it("on SIGINT closes registered resources and exits 130, using the default log + exit", () => {
    const { proc, handlers, exit } = makeFakeProcess();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = { close: vi.fn() };
    registerCleanupResource(store);

    installCliSignalHandlers({ process: proc });
    handlers.get("SIGINT")?.();

    expect(store.close).toHaveBeenCalledTimes(1);
    expect(cleanupResourceCount()).toBe(0);
    expect(exit).toHaveBeenCalledWith(130);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("received SIGINT"));
  });

  it("on SIGTERM exits 143 through the injected exit + log", () => {
    const { proc, handlers } = makeFakeProcess();
    const log = vi.fn();
    const exit = vi.fn();
    installCliSignalHandlers({ process: proc, log, exit });

    handlers.get("SIGTERM")?.();

    expect(exit).toHaveBeenCalledWith(143);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("received SIGTERM"));
  });

  it("logs an uncaught exception's stack and exits non-zero", async () => {
    const { proc, handlers } = makeFakeProcess();
    const log = vi.fn();
    const exit = vi.fn();
    installCliSignalHandlers({ process: proc, log, exit });

    const error = new Error("kaboom");
    await handlers.get("uncaughtException")?.(error);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("uncaught exception"));
    expect(log.mock.calls[0]?.[0] as string).toContain(error.stack);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("falls back to an error's message when it has no stack", async () => {
    const { proc, handlers } = makeFakeProcess();
    const log = vi.fn();
    installCliSignalHandlers({ process: proc, log, exit: vi.fn() });

    const error = new Error("stackless");
    Object.defineProperty(error, "stack", { value: undefined });
    await handlers.get("uncaughtException")?.(error);

    expect(log.mock.calls[0]?.[0] as string).toContain("stackless");
  });

  it("stringifies a non-Error unhandled rejection reason and exits non-zero", async () => {
    const { proc, handlers } = makeFakeProcess();
    const log = vi.fn();
    const exit = vi.fn();
    installCliSignalHandlers({ process: proc, log, exit });

    await handlers.get("unhandledRejection")?.("plain string reason");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("plain string reason"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("REGRESSION (#6011): calls the injected captureError for uncaughtException/unhandledRejection but NOT for a clean SIGINT/SIGTERM exit", async () => {
    const { proc, handlers } = makeFakeProcess();
    const captureError = vi.fn();
    installCliSignalHandlers({ process: proc, log: vi.fn(), exit: vi.fn(), captureError });

    const error = new Error("kaboom");
    await handlers.get("uncaughtException")?.(error);
    expect(captureError).toHaveBeenCalledWith(error, { kind: "uncaughtException" });

    await handlers.get("unhandledRejection")?.("plain reason");
    expect(captureError).toHaveBeenCalledWith("plain reason", { kind: "unhandledRejection" });

    captureError.mockClear();
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    expect(captureError).not.toHaveBeenCalled(); // a clean signal exit is not an error
  });

  it("REGRESSION (#6011 follow-up): AWAITS captureError before exiting -- exit() must not fire while a flush is still in flight", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    let resolveCapture: () => void = () => {};
    const capturePending = new Promise<void>((resolve) => {
      resolveCapture = resolve;
    });
    const captureError = vi.fn(() => capturePending);
    installCliSignalHandlers({ process: proc, log: vi.fn(), captureError });

    const handled = handlers.get("uncaughtException")?.(new Error("kaboom"));
    // Still pending: captureError (the flush) has not resolved yet, so exit() must not have fired.
    await Promise.resolve(); // let the handler's synchronous-until-await portion run
    expect(exit).not.toHaveBeenCalled();

    resolveCapture();
    await handled;
    expect(exit).toHaveBeenCalledWith(1); // only fires once the awaited captureError actually resolved
  });

  it("defaults captureError to a no-op when none is injected, matching every pre-existing caller", async () => {
    const { proc, handlers, exit } = makeFakeProcess();
    installCliSignalHandlers({ process: proc, log: vi.fn(), exit });
    await expect(handlers.get("uncaughtException")?.(new Error("no capture hook"))).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports a cleanup failure that happens during signal handling via the log", () => {
    const { proc, handlers } = makeFakeProcess();
    const log = vi.fn();
    registerCleanupResource(() => {
      throw new Error("cleanup boom");
    });
    installCliSignalHandlers({ process: proc, log, exit: vi.fn() });

    handlers.get("SIGINT")?.();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("cleanup error while exiting: "));
    expect(log.mock.calls.some((call) => String(call[0]).includes("cleanup boom"))).toBe(true);
  });

  it("defaults to the real process when none is injected", () => {
    withRealProcessCleanup(() => {
      expect(installCliSignalHandlers({ log: vi.fn(), exit: vi.fn(), force: true })).toBe(true);
      for (const event of SIGNAL_EVENTS) {
        expect(process.rawListeners(event).length).toBeGreaterThan(0);
      }
    });
  });
});
