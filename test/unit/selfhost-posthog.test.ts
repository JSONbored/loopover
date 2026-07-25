import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock posthog-node so the dynamic import inside initPostHog() resolves to a spy-backed client. Hoisted so
// vi.mock can see it, mirroring selfhost-sentry.test.ts's identical @sentry/node mocking pattern.
const mocks = vi.hoisted(() => {
  const captureException = vi.fn();
  const capture = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);
  const shutdown = vi.fn().mockResolvedValue(undefined);
  let lastOptions: any;
  const PostHog = vi.fn(function (this: any, _apiKey: string, options: any) {
    lastOptions = options;
    this.captureException = captureException;
    this.capture = capture;
    this.flush = flush;
    this.shutdown = shutdown;
  });
  return { captureException, capture, flush, shutdown, PostHog, getLastOptions: () => lastOptions };
});
const otelMocks = vi.hoisted(() => ({ currentOtelTraceIds: vi.fn() }));
vi.mock("posthog-node", () => ({ PostHog: mocks.PostHog }));
vi.mock("../../src/selfhost/otel", () => ({
  currentOtelTraceIds: otelMocks.currentOtelTraceIds,
}));

import {
  capturePostHogError,
  capturePostHogReviewFailure,
  flushPostHog,
  forwardStructuredLogToPostHog,
  initPostHog,
  installPostHogStructuredLogForwarding,
  POSTHOG_MONITOR_HEARTBEAT_EVENT,
  resetPostHogForTest,
  resolvePostHogRelease,
  scrubPostHogEvent,
  shutdownPostHog,
  withPostHogMonitor,
} from "../../src/selfhost/posthog";

beforeEach(() => {
  resetPostHogForTest();
  vi.clearAllMocks();
  otelMocks.currentOtelTraceIds.mockReturnValue(undefined);
});

const lastCapturedException = (): Error => mocks.captureException.mock.calls.at(-1)?.[0] as Error;
const lastCapturedProperties = (): Record<string, unknown> => mocks.captureException.mock.calls.at(-1)?.[2] as Record<string, unknown>;
const fakeClassicAccessToken = (): string => `${"github" + "_pat_"}${"a".repeat(24)}`;

describe("initPostHog", () => {
  it("stays a no-op when POSTHOG_API_KEY is unset", async () => {
    const enabled = await initPostHog({} as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(false);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("stays a no-op when POSTHOG_API_KEY is blank/whitespace", async () => {
    expect(await initPostHog({ POSTHOG_API_KEY: "   " } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("activates with the configured key and default host when POSTHOG_HOST is unset", async () => {
    const enabled = await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(true);
    expect(mocks.PostHog).toHaveBeenCalledWith("phc_test_key", expect.objectContaining({ host: "https://us.i.posthog.com" }));
  });

  it("uses POSTHOG_HOST when set", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key", POSTHOG_HOST: "https://eu.i.posthog.com" } as unknown as NodeJS.ProcessEnv);
    expect(mocks.PostHog).toHaveBeenCalledWith("phc_test_key", expect.objectContaining({ host: "https://eu.i.posthog.com" }));
  });

  it("enables exception autocapture and installs the before_send scrubber", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const options = mocks.getLastOptions();
    expect(options.enableExceptionAutocapture).toBe(true);
    expect(options.before_send).toBe(scrubPostHogEvent);
  });
});

describe("resolvePostHogRelease", () => {
  it("prefers an explicit POSTHOG_RELEASE override", () => {
    expect(resolvePostHogRelease({ POSTHOG_RELEASE: "1.2.3", LOOPOVER_VERSION: "9.9.9" } as unknown as NodeJS.ProcessEnv)).toBe("1.2.3");
  });
  it("falls back to LOOPOVER_VERSION when POSTHOG_RELEASE is unset", () => {
    expect(resolvePostHogRelease({ LOOPOVER_VERSION: "9.9.9" } as unknown as NodeJS.ProcessEnv)).toBe("9.9.9");
  });
  it("is undefined when neither is set", () => {
    expect(resolvePostHogRelease({} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("scrubPostHogEvent — redact secrets before an event leaves the box", () => {
  it("passes null through unchanged", () => {
    expect(scrubPostHogEvent(null)).toBeNull();
  });

  it("redacts secret-keyed properties, recurses, and leaves safe fields", () => {
    const event = scrubPostHogEvent({
      event: "$exception",
      properties: {
        jobId: "j1",
        apiKey: "shh",
        nested: { secretToken: "deep" },
      },
    } as any)!;
    expect((event.properties as any).apiKey).toBe("[redacted]");
    expect((event.properties as any).jobId).toBe("j1");
    expect((event.properties as any).nested.secretToken).toBe("[redacted]");
  });

  it("is safe when properties is absent", () => {
    expect(() => scrubPostHogEvent({ event: "x" } as any)).not.toThrow();
    expect(scrubPostHogEvent({ event: "x" } as any)).toEqual({ event: "x" });
  });

  it("redacts a real credential-shaped value embedded in a property string", () => {
    const fakeToken = fakeClassicAccessToken();
    const event = scrubPostHogEvent({
      event: "$exception",
      properties: { note: `token leaked: ${fakeToken} at /home/alice/project` },
    } as any)!;
    expect((event.properties as any).note).not.toContain(fakeToken);
    expect((event.properties as any).note).toContain("<redacted-path>");
  });

  it("scrubs the event name string too", () => {
    const fakeToken = fakeClassicAccessToken();
    const event = scrubPostHogEvent({ event: `leaked ${fakeToken}`, properties: {} } as any)!;
    expect(event.event).not.toContain(fakeToken);
  });

  it("leaves a non-string event name untouched", () => {
    const event = scrubPostHogEvent({ event: 123 as unknown as string, properties: {} } as any)!;
    expect(event.event).toBe(123);
  });

  it("returns null (fail-closed) when scrubbing itself throws", () => {
    const properties: Record<string, unknown> = {};
    Object.defineProperty(properties, "poison", {
      enumerable: true,
      get(): never {
        throw new Error("boom during scrub");
      },
    });
    expect(scrubPostHogEvent({ event: "x", properties } as any)).toBeNull();
  });
});

describe("capturePostHogError", () => {
  it("is a no-op when PostHog is unconfigured", () => {
    capturePostHogError(new Error("boom"));
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("captures with a named error and operational properties when configured", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"), { repo: "owner/repo", pull: 7 }, "my_event");
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const captured = lastCapturedException();
    expect(captured.name).toBe("my_event");
    expect(captured.message).toBe("boom");
    const properties = lastCapturedProperties();
    expect(properties.repo).toBe("owner/repo");
    expect(properties.pull).toBe(7);
  });

  it("captures without a custom name when eventName is omitted", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"));
    expect(lastCapturedException().message).toBe("boom");
  });

  it("wraps a non-Error thrown value", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError("a string error", undefined, "my_event");
    expect(lastCapturedException()).toBeInstanceOf(Error);
    expect(lastCapturedException().message).toBe("a string error");
  });

  it("respects POSTHOG_MIN_SEVERITY -- suppressed above error", async () => {
    process.env.POSTHOG_MIN_SEVERITY = "critical";
    try {
      await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
      capturePostHogError(new Error("boom"));
      expect(mocks.captureException).not.toHaveBeenCalled();
    } finally {
      delete process.env.POSTHOG_MIN_SEVERITY;
    }
  });

  it("hashes an installation id in the context instead of leaking the raw value", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"), { installation_id: 12345 });
    const properties = lastCapturedProperties();
    expect(properties.installation_id).toBeUndefined();
    expect(properties.installationId).toBeUndefined();
  });

  it("attaches otel trace ids to properties when present", async () => {
    otelMocks.currentOtelTraceIds.mockReturnValue({ trace_id: "t1", span_id: "s1" });
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"));
    const properties = lastCapturedProperties();
    expect(properties.trace_id).toBe("t1");
    expect(properties.span_id).toBe("s1");
  });

  it("does not overwrite an already-present repo when only repository is normalized", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"), { repo: "explicit/repo", repository: "should-be-ignored/repo" });
    expect(lastCapturedProperties().repo).toBe("explicit/repo");
  });

  it("resolves the per-repo severity threshold from a repository-only context (no repo field)", async () => {
    process.env.POSTHOG_REPO_MIN_SEVERITY = JSON.stringify({ "owner/repo": "critical" });
    try {
      await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
      capturePostHogError(new Error("boom"), { repository: "owner/repo" });
      expect(mocks.captureException).not.toHaveBeenCalled();
    } finally {
      delete process.env.POSTHOG_REPO_MIN_SEVERITY;
    }
  });

  it("attaches the resolved release when POSTHOG_RELEASE is configured", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key", POSTHOG_RELEASE: "loopover-orb@1.2.3" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"));
    expect(lastCapturedProperties().release).toBe("loopover-orb@1.2.3");
  });

  it("omits release when neither POSTHOG_RELEASE nor LOOPOVER_VERSION is set", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"));
    expect(lastCapturedProperties().release).toBeUndefined();
  });
});

describe("capturePostHogReviewFailure", () => {
  it("is a no-op when PostHog is unconfigured", () => {
    capturePostHogReviewFailure(new Error("review failed"));
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("captures at error grade with kind: review_failure tagged", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogReviewFailure(new Error("review failed"), { repo: "owner/repo" }, "review_event");
    expect(lastCapturedException().name).toBe("review_event");
    expect(lastCapturedProperties().kind).toBe("review_failure");
  });

  it("attaches the resolved release when configured", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key", LOOPOVER_VERSION: "9.9.9" } as unknown as NodeJS.ProcessEnv);
    capturePostHogReviewFailure(new Error("review failed"));
    expect(lastCapturedProperties().release).toBe("9.9.9");
  });

  it("respects POSTHOG_MIN_SEVERITY -- suppressed above error", async () => {
    process.env.POSTHOG_MIN_SEVERITY = "critical";
    try {
      await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
      capturePostHogReviewFailure(new Error("review failed"));
      expect(mocks.captureException).not.toHaveBeenCalled();
    } finally {
      delete process.env.POSTHOG_MIN_SEVERITY;
    }
  });
});

describe("forwardStructuredLogToPostHog", () => {
  it("is a no-op when PostHog is unconfigured", () => {
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "x" }));
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("ignores non-string and non-JSON-object lines", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(42);
    forwardStructuredLogToPostHog("not json");
    forwardStructuredLogToPostHog("[1,2,3]");
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("ignores a line that starts with { but fails to parse", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog("{not valid json");
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("includes the repo#pr location suffix in a field-only log's summary", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", repo: "owner/repo", pullNumber: 5 }));
    expect(lastCapturedException().message).toContain("(owner/repo#5)");
  });

  it("includes just the repo when a field-only log has no pullNumber", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", repo: "owner/repo" }));
    expect(lastCapturedException().message).toContain("(owner/repo)");
  });

  it("redacts a secret-keyed field inside a nested object value when summarizing", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "close_breaker_engaged", details: { apiKey: "shh", floor: 0.8 } }));
    expect(lastCapturedException().message).toContain("[redacted]");
    expect(lastCapturedException().message).not.toContain("shh");
  });

  it("redacts inside an array-valued summarized field", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "x", affectedTargets: ["a", "b"] }));
    expect(lastCapturedException().message).toContain("affectedTargets=");
  });

  it("caps deeply-nested summarized values at the redaction depth guard", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    let deep: unknown = { apiKey: "shh" };
    for (let i = 0; i < 8; i++) deep = { a: deep };
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "x", deep }));
    expect(lastCapturedException().message).toContain("[redacted]");
  });

  it("falls back to obj.error when message is absent", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "job_dead", error: "the error string" }));
    expect(lastCapturedException().message).toBe("the error string");
  });

  it("forwards an explicit level:error JSON line", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "job_dead", message: "bad thing" }));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(lastCapturedException().name).toBe("job_dead");
    expect(lastCapturedException().message).toBe("bad thing");
  });

  it("ignores a level:warn line when not from the error sink", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "warn", event: "x" }), false);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("defaults to error level when fromErrorSink is true and no explicit level is present", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ event: "x" }), true);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("is skipped entirely when there is no severity signal at all (no level, not from error sink)", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ event: "x" }), false);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("folds a sub-event (ev) into the synthetic error name", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "rag_failure", ev: "upsert_error" }));
    expect(lastCapturedException().name).toBe("rag_failure/upsert_error");
  });

  it("summarizes salient fields when no message/error is present", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "close_breaker_engaged", project: "x", closePrecision: 0.6 }));
    expect(lastCapturedException().message).toContain("project=x");
  });

  it("falls back to a context pointer when there is truly nothing to summarize", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error" }));
    expect(lastCapturedException().message).toBe("(no message — see the log context)");
  });

  it("normalizes an unrecognized level word (e.g. a log CATEGORY, not a severity) to info, never promoting it to error", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "debug", event: "x" }));
    // info < the default "error" threshold, so this stays suppressed -- proves debug did NOT get promoted.
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("normalizes fatal to critical severity", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "fatal", event: "x", message: "very bad" }));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("uses a repository-only field for the location suffix (no repo field)", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", repository: "owner/repo" }));
    expect(lastCapturedException().message).toContain("(owner/repo)");
  });

  it("attaches the resolved release when configured", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key", POSTHOG_RELEASE: "loopover-orb@1.2.3" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToPostHog(JSON.stringify({ level: "error", event: "x" }));
    expect(lastCapturedProperties().release).toBe("loopover-orb@1.2.3");
  });
});

describe("installPostHogStructuredLogForwarding", () => {
  it("forwards console.error lines as error-sink by default", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const target = { log: vi.fn(), error: vi.fn() };
    installPostHogStructuredLogForwarding(target);
    target.error(JSON.stringify({ event: "x" }));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("forwards console.log lines only when they carry an explicit level:error", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const target = { log: vi.fn(), error: vi.fn() };
    installPostHogStructuredLogForwarding(target);
    target.log(JSON.stringify({ event: "x" }));
    expect(mocks.captureException).not.toHaveBeenCalled();
    target.log(JSON.stringify({ level: "error", event: "y" }));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("still calls the original console method", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const originalLog = vi.fn();
    const target = { log: originalLog, error: vi.fn() };
    installPostHogStructuredLogForwarding(target);
    target.log("plain text");
    expect(originalLog).toHaveBeenCalledWith("plain text");
  });

  it("guards against re-entrant forwarding when capture itself logs", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    mocks.captureException.mockImplementationOnce(() => {
      target.error(JSON.stringify({ event: "recursive" }));
    });
    const target = { log: vi.fn(), error: vi.fn() };
    installPostHogStructuredLogForwarding(target);
    expect(() => target.error(JSON.stringify({ level: "error", event: "outer" }))).not.toThrow();
  });
});

describe("withPostHogMonitor", () => {
  it("just runs the callback when PostHog is unconfigured", async () => {
    const result = await withPostHogMonitor("orb-export", undefined, async () => "ok");
    expect(result).toBe("ok");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("emits an ok heartbeat on success", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const result = await withPostHogMonitor("orb-export", { jobType: "orb-export" }, async () => "done");
    expect(result).toBe("done");
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: POSTHOG_MONITOR_HEARTBEAT_EVENT, properties: expect.objectContaining({ monitor: "orb-export", status: "ok" }) }),
    );
  });

  it("emits an error heartbeat AND captures the exception on failure, then rethrows", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const boom = new Error("orb export failed");
    await expect(withPostHogMonitor("orb-export", { jobType: "orb-export" }, async () => { throw boom; })).rejects.toThrow("orb export failed");
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: POSTHOG_MONITOR_HEARTBEAT_EVENT, properties: expect.objectContaining({ monitor: "orb-export", status: "error" }) }),
    );
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-Error thrown value on failure", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    await expect(withPostHogMonitor("orb-export", undefined, async () => { throw "a string failure"; })).rejects.toBe("a string failure");
    expect(lastCapturedException()).toBeInstanceOf(Error);
    expect(lastCapturedException().message).toBe("a string failure");
  });
});

describe("flushPostHog / shutdownPostHog", () => {
  it("flushPostHog is a no-op when unconfigured", async () => {
    await flushPostHog();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("flushPostHog calls the client's flush when configured", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    await flushPostHog();
    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });

  it("flushPostHog swallows a flush rejection", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    mocks.flush.mockRejectedValueOnce(new Error("flush failed"));
    await expect(flushPostHog()).resolves.toBeUndefined();
  });

  it("shutdownPostHog is a no-op when unconfigured", async () => {
    await shutdownPostHog();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });

  it("shutdownPostHog calls the client's shutdown when configured", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    await shutdownPostHog();
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdownPostHog swallows a shutdown rejection", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    mocks.shutdown.mockRejectedValueOnce(new Error("shutdown failed"));
    await expect(shutdownPostHog()).resolves.toBeUndefined();
  });
});

describe("resetPostHogForTest", () => {
  it("resets active state so a subsequent capture is a no-op again", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    resetPostHogForTest();
    capturePostHogError(new Error("boom"));
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
});
