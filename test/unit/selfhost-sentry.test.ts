import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @sentry/node so the dynamic import inside initSentry() resolves to spies. Hoisted so vi.mock can see it.
const mocks = vi.hoisted(() => {
  const scope = { setContext: vi.fn(), setLevel: vi.fn(), setTag: vi.fn() };
  return {
    scope,
    init: vi.fn(),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
  };
});
vi.mock("@sentry/node", () => ({
  init: mocks.init,
  withScope: mocks.withScope,
  captureException: mocks.captureException,
  flush: mocks.flush,
}));

import {
  initSentry,
  captureError,
  captureReviewFailure,
  flushSentry,
  scrubEvent,
  resetSentryForTest,
} from "../../src/selfhost/sentry";

beforeEach(() => {
  resetSentryForTest();
  vi.clearAllMocks();
});

describe("scrubEvent — redact secrets before an event leaves the box", () => {
  it("redacts secret-keyed fields in headers/contexts/extra, recurses, and leaves safe fields", () => {
    const ev = scrubEvent({
      request: { headers: { authorization: "Bearer abc", "x-trace": "ok" } },
      contexts: {
        gittensory: {
          jobId: "j1",
          apiKey: "shh",
          nested: { secretToken: "deep" },
        },
      },
      extra: { note: "fine" },
    }) as any;
    expect(ev.request.headers.authorization).toBe("[redacted]");
    expect(ev.request.headers["x-trace"]).toBe("ok");
    expect(ev.contexts.gittensory.apiKey).toBe("[redacted]");
    expect(ev.contexts.gittensory.jobId).toBe("j1");
    expect(ev.contexts.gittensory.nested.secretToken).toBe("[redacted]");
    expect(ev.extra.note).toBe("fine");
  });

  it("is safe when headers/contexts/extra are absent (the !obj branch)", () => {
    expect(() => scrubEvent({})).not.toThrow();
  });

  it("stops at the depth guard without infinite recursion, still redacting shallow secrets", () => {
    let deep: any = { secretToken: "x" };
    for (let i = 0; i < 8; i++) deep = { a: deep };
    const ev = scrubEvent({ extra: { token: "shallow", deep } }) as any;
    expect(ev.extra.token).toBe("[redacted]");
  });
});

describe("disabled when SENTRY_DSN is unset (modular opt-out → complete no-op)", () => {
  it("initSentry returns false; capture/flush are safe no-ops and never touch the SDK", async () => {
    expect(await initSentry({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    captureError(new Error("x"), { a: 1 });
    captureReviewFailure(new Error("y"), { repo: "o/r" });
    await flushSentry();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });
});

describe("enabled when SENTRY_DSN is set", () => {
  it("returns true and wires init with defaults (?? right-hand branches) + the scrubber as beforeSend", async () => {
    expect(
      await initSentry({
        SENTRY_DSN: "https://k@o.ingest/1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    const opts = mocks.init.mock.calls[0]![0];
    expect(opts.environment).toBe("production");
    expect(opts.tracesSampleRate).toBe(0);
    expect(
      opts.beforeSend({ extra: { sessionToken: "s" } }).extra.sessionToken,
    ).toBe("[redacted]");
  });

  it("honors explicit env (?? left-hand branches)", async () => {
    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_ENVIRONMENT: "staging",
      SENTRY_RELEASE: "v9",
      SENTRY_TRACES_SAMPLE_RATE: "0.5",
      PUBLIC_API_ORIGIN: "https://self.host",
    } as unknown as NodeJS.ProcessEnv);
    const opts = mocks.init.mock.calls[0]![0];
    expect(opts.environment).toBe("staging");
    expect(opts.release).toBe("v9");
    expect(opts.tracesSampleRate).toBe(0.5);
    expect(opts.serverName).toBe("https://self.host");
  });

  it("captureError sends with context, and without context skips setContext", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureError(new Error("boom"), { kind: "job_dead" });
    expect(mocks.scope.setContext).toHaveBeenCalledWith("gittensory", {
      kind: "job_dead",
    });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    mocks.scope.setContext.mockClear();
    captureError("plain string with no context");
    expect(mocks.scope.setContext).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });

  it("captureReviewFailure sets warning level + repo/PR/SHA tags, skipping null/undefined, and works without context", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureReviewFailure(new Error("rev"), {
      repo: "o/r",
      pr: 7,
      head_sha: "abc",
      owner: null,
    });
    expect(mocks.scope.setLevel).toHaveBeenCalledWith("warning");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("repo", "o/r");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("pr", "7");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("head_sha", "abc");
    expect(mocks.scope.setTag).not.toHaveBeenCalledWith(
      "owner",
      expect.anything(),
    );
    captureReviewFailure("string failure, no context");
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });

  it("flushSentry delegates to Sentry.flush with the timeout", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    await flushSentry(123);
    expect(mocks.flush).toHaveBeenCalledWith(123);
  });

  it("flushSentry swallows a flush rejection (never breaks shutdown)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    mocks.flush.mockRejectedValueOnce(new Error("network"));
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});
