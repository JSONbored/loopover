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
  capturePostHogAiDegradation,
  capturePostHogAiGeneration,
  capturePostHogError,
  capturePostHogReviewFailure,
  flushPostHog,
  forwardStructuredLogToPostHog,
  initPostHog,
  installPostHogStructuredLogForwarding,
  POSTHOG_AI_DEGRADED_EVENT,
  POSTHOG_MONITOR_HEARTBEAT_EVENT,
  resetPostHogForTest,
  resolvePostHogRelease,
  scrubPostHogEvent,
  setPostHogAnonSecret,
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

  it("disables posthog-node's own exception autocapture (#9133) and installs the before_send scrubber", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    const options = mocks.getLastOptions();
    // #9133: OFF, not Sentry's own default-on posture -- server.ts's installSelfHostCrashHandlers is now the
    // sole, unconditional uncaughtException/unhandledRejection crash contract, so posthog-node must never
    // install its OWN competing listeners for either event (see posthog.ts's own comment for the full "why").
    expect(options.enableExceptionAutocapture).toBe(false);
    expect(options.before_send).toBe(scrubPostHogEvent);
  });

  it("falls back to LOOPOVER_CENTRAL_POSTHOG_KEY when POSTHOG_API_KEY is unset (#8626)", async () => {
    const enabled = await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(true);
    expect(mocks.PostHog).toHaveBeenCalledWith("phc_central", expect.objectContaining({ host: "https://us.i.posthog.com" }));
  });

  it("keeps POSTHOG_API_KEY's precedence when both it and LOOPOVER_CENTRAL_POSTHOG_KEY are set (#8626)", async () => {
    const enabled = await initPostHog({ POSTHOG_API_KEY: "phc_operator", LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(true);
    expect(mocks.PostHog).toHaveBeenCalledWith("phc_operator", expect.anything());
    expect(mocks.PostHog).not.toHaveBeenCalledWith("phc_central", expect.anything());
  });

  it("stays a no-op when neither POSTHOG_API_KEY nor LOOPOVER_CENTRAL_POSTHOG_KEY is set (#8626)", async () => {
    const enabled = await initPostHog({} as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(false);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  // #9142
  it("stays a no-op when ORB_AIR_GAP=true, even with a real key configured", async () => {
    const enabled = await initPostHog({ ORB_AIR_GAP: "true", POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(false);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("stays a no-op when POSTHOG_DISABLED=true, even with a real key configured", async () => {
    const enabled = await initPostHog({ POSTHOG_DISABLED: "true", POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(false);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("treats an explicitly EMPTY POSTHOG_API_KEY as OFF, not falling through to LOOPOVER_CENTRAL_POSTHOG_KEY", async () => {
    const enabled = await initPostHog({ POSTHOG_API_KEY: "", LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(false);
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it("still falls through to LOOPOVER_CENTRAL_POSTHOG_KEY when POSTHOG_API_KEY is genuinely unset (not just blank)", async () => {
    const enabled = await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    expect(enabled).toBe(true);
    expect(mocks.PostHog).toHaveBeenCalledWith("phc_central", expect.anything());
  });
});

// #9142: repo/PR/owner/SHA identifiers must be HMAC'd, never sent in the clear, when the active key is the
// shared LOOPOVER_CENTRAL_POSTHOG_KEY -- an operator's own explicit POSTHOG_API_KEY is unaffected (their own
// private analytics project has no cross-tenant concern).
describe("central-key identifier anonymization (#9142)", () => {
  it("hashes repo/pull/head_sha instead of sending them raw when using the central key, with the injected secret", async () => {
    await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64));
    capturePostHogError(new Error("boom"), { repo: "owner/repo", pull: 7, head_sha: "abc123" });
    const properties = lastCapturedProperties();
    expect(properties.repo).not.toBe("owner/repo");
    expect(properties.repo).toMatch(/^[0-9a-f]{24}$/);
    expect(properties.pull).not.toBe(7);
    expect(properties.pull).toMatch(/^[0-9a-f]{24}$/);
    expect(properties.head_sha).not.toBe("abc123");
    expect(properties.head_sha).toMatch(/^[0-9a-f]{24}$/);
  });

  it("hashes the SAME repo identically across two calls (stable per-instance secret)", async () => {
    await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64));
    capturePostHogError(new Error("boom1"), { repo: "owner/repo" });
    const first = lastCapturedProperties().repo;
    capturePostHogError(new Error("boom2"), { repo: "owner/repo" });
    const second = lastCapturedProperties().repo;
    expect(first).toBe(second);
  });

  it("hashes a DIFFERENT repo to a DIFFERENT value", async () => {
    await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64));
    capturePostHogError(new Error("boom1"), { repo: "owner/repo-a" });
    const a = lastCapturedProperties().repo;
    capturePostHogError(new Error("boom2"), { repo: "owner/repo-b" });
    const b = lastCapturedProperties().repo;
    expect(a).not.toBe(b);
  });

  it("drops (never sends raw) an identifying field when using the central key but no secret has been injected yet (fail closed)", async () => {
    await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    // setPostHogAnonSecret deliberately not called -- simulates the early-boot race before server.ts wires it.
    capturePostHogError(new Error("boom"), { repo: "owner/repo" });
    const properties = lastCapturedProperties();
    expect(properties.repo).toBeUndefined();
  });

  it("leaves repo/pull raw when the active key is the operator's OWN POSTHOG_API_KEY, never the central one", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_operator" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64)); // even if a secret happens to be injected, it must not apply here
    capturePostHogError(new Error("boom"), { repo: "owner/repo", pull: 7 });
    const properties = lastCapturedProperties();
    expect(properties.repo).toBe("owner/repo");
    expect(properties.pull).toBe(7);
  });

  it("leaves repo/pull raw when POSTHOG_API_KEY is set even though LOOPOVER_CENTRAL_POSTHOG_KEY is also present (#8626 precedence)", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_operator", LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64));
    capturePostHogError(new Error("boom"), { repo: "owner/repo" });
    expect(lastCapturedProperties().repo).toBe("owner/repo");
  });

  it("also anonymizes on the capturePostHogAiGeneration success path (#9142 ai.ts context)", async () => {
    await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64));
    capturePostHogAiGeneration({ provider: "ollama", model: "llama3.1", requestKind: "review", latencyMs: 1000, isError: false, context: { repo: "owner/repo", pullNumber: 7 } });
    const call = mocks.capture.mock.calls[0]?.[0];
    expect(call.properties.repo).not.toBe("owner/repo");
    expect(call.properties.repo).toMatch(/^[0-9a-f]{24}$/);
  });

  it("resetPostHogForTest clears both the central-key flag and the injected secret", async () => {
    await initPostHog({ LOOPOVER_CENTRAL_POSTHOG_KEY: "phc_central" } as unknown as NodeJS.ProcessEnv);
    setPostHogAnonSecret("a".repeat(64));
    resetPostHogForTest();
    await initPostHog({ POSTHOG_API_KEY: "phc_operator" } as unknown as NodeJS.ProcessEnv);
    capturePostHogError(new Error("boom"), { repo: "owner/repo" });
    expect(lastCapturedProperties().repo).toBe("owner/repo"); // operator key path, never hashed
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

describe("capturePostHogAiGeneration (#8296)", () => {
  const BASE = { provider: "ollama", model: "llama3.1", requestKind: "review" as const, latencyMs: 1500, isError: false };

  // #10185: trace linking + repo grouping. These are what turn a pile of orphan generations into a
  // reviewable pipeline and an answerable spend question, so both branches of each are pinned.
  it("groups the generation under the AMBIENT OTel trace rather than minting a throwaway one", async () => {
    otelMocks.currentOtelTraceIds.mockReturnValue({ trace_id: "review-trace-1", span_id: "provider-span-1" });
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration(BASE);
    const call = mocks.capture.mock.calls[0]?.[0];
    // The whole point: every provider attempt inside one withReviewPipelineSpan shares this id, so
    // both dual-review legs, the retries, and the RAG embeddings nest under ONE PostHog trace.
    expect(call.properties.$ai_trace_id).toBe("review-trace-1");
    expect(call.properties.$ai_span_id).toBe("provider-span-1");
    expect(call.properties.$ai_span_name).toBe("ai.review/ollama");
  });

  it("falls back to a minted trace id, and omits $ai_span_id, when there is no ambient span", async () => {
    // AI_EMBED / AI_VISION / AI_ADVISORY run outside any review span. An orphan trace is a valid
    // event, not an error -- but it must not claim a span id it does not have.
    otelMocks.currentOtelTraceIds.mockReturnValue(undefined);
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration(BASE);
    const call = mocks.capture.mock.calls[0]?.[0];
    expect(call.properties.$ai_trace_id).toEqual(expect.any(String));
    expect(call.properties.$ai_trace_id).not.toBe("");
    expect("$ai_span_id" in call.properties).toBe(false);
  });

  it("names an embedding span by its own request kind", async () => {
    otelMocks.currentOtelTraceIds.mockReturnValue({ trace_id: "t", span_id: "s" });
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, requestKind: "embedding", provider: "" });
    expect(mocks.capture.mock.calls[0]?.[0].properties.$ai_span_name).toBe("ai.embedding/unknown");
  });

  it("stamps a repo group so AI spend is attributable per repository", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, context: { repo: "owner/repo", pullNumber: 7 } });
    const call = mocks.capture.mock.calls[0]?.[0];
    expect(call.groups).toEqual({ repo: "owner/repo" });
  });

  it("sends no group at all when no repo survives the operational allowlist", async () => {
    // Notably the fail-closed central-key path: when the repo is dropped rather than anonymized,
    // the group must be dropped with it rather than defaulting to some placeholder bucket.
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration(BASE);
    expect("groups" in mocks.capture.mock.calls[0]?.[0]).toBe(false);
  });

  it("is a no-op when PostHog is unconfigured", () => {
    capturePostHogAiGeneration(BASE);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures a well-formed $ai_generation event with token/latency metadata on success", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, inputTokens: 120, outputTokens: 40, totalCostUsd: 0.002, effort: "medium" });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    const call = mocks.capture.mock.calls[0]?.[0];
    expect(call.event).toBe("$ai_generation");
    expect(call.properties.$ai_model).toBe("llama3.1");
    expect(call.properties.$ai_provider).toBe("ollama");
    expect(call.properties.$ai_latency).toBe(1.5); // ms -> seconds
    expect(call.properties.$ai_http_status).toBe(200);
    expect(call.properties.$ai_input_tokens).toBe(120);
    expect(call.properties.$ai_output_tokens).toBe(40);
    expect(call.properties.$ai_is_error).toBe(false);
    expect(call.properties.$ai_total_cost_usd).toBe(0.002);
    expect(call.properties.$ai_model_parameters).toEqual({ effort: "medium" });
    expect("$ai_error" in call.properties).toBe(false);
  });

  it("captures $ai_embedding for an embedding request kind", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, requestKind: "embedding" });
    expect(mocks.capture.mock.calls[0]?.[0].event).toBe("$ai_embedding");
  });

  it("defaults input/output tokens to 0 when omitted or non-finite", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, inputTokens: undefined, outputTokens: Number.NaN });
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.$ai_input_tokens).toBe(0);
    expect(properties.$ai_output_tokens).toBe(0);
  });

  it("omits $ai_total_cost_usd when cost is not supplied or non-finite", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, totalCostUsd: Number.NaN });
    expect("$ai_total_cost_usd" in mocks.capture.mock.calls[0]?.[0].properties).toBe(false);
  });

  it("omits $ai_model_parameters when effort is not supplied", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration(BASE);
    expect("$ai_model_parameters" in mocks.capture.mock.calls[0]?.[0].properties).toBe(false);
  });

  it("falls back to 'unknown' for a blank model/provider", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, model: "", provider: "   " });
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.$ai_model).toBe("unknown");
    expect(properties.$ai_provider).toBe("unknown");
  });

  it("marks a failed generation with $ai_is_error/$ai_http_status/$ai_error, redacted to 500 chars", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, isError: true, error: new Error("x".repeat(600)) });
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.$ai_is_error).toBe(true);
    expect(properties.$ai_http_status).toBe(500);
    expect(properties.$ai_error).toHaveLength(500);
  });

  it("wraps a non-Error thrown value on the error path", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, isError: true, error: "just a string" });
    expect(mocks.capture.mock.calls[0]?.[0].properties.$ai_error).toBe("just a string");
  });

  it("never carries prompt/response content -- no field beyond model/provider ids", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration(BASE);
    const keys = Object.keys(mocks.capture.mock.calls[0]?.[0].properties);
    expect(keys).not.toContain("$ai_input");
    expect(keys).not.toContain("$ai_output_choices");
  });

  it("mints a fresh, real UUID trace id on every call", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration(BASE);
    capturePostHogAiGeneration(BASE);
    const first = mocks.capture.mock.calls[0]?.[0].properties.$ai_trace_id;
    const second = mocks.capture.mock.calls[1]?.[0].properties.$ai_trace_id;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first).not.toBe(second);
  });

  it("merges correlation context (repo/pullNumber) through the shared operational-tag allowlist", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, context: { repo: "owner/repo", pullNumber: 7 } });
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.repo).toBe("owner/repo");
    expect(properties.pullNumber).toBe(7);
  });

  it("drops an unlisted context key (not on OPERATIONAL_TAG_KEYS)", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiGeneration({ ...BASE, context: { notAllowlisted: "should be dropped" } });
    expect("notAllowlisted" in mocks.capture.mock.calls[0]?.[0].properties).toBe(false);
  });

  it("does not gate on POSTHOG_MIN_SEVERITY (unlike capturePostHogError)", async () => {
    process.env.POSTHOG_MIN_SEVERITY = "critical";
    try {
      await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
      capturePostHogAiGeneration({ ...BASE, isError: true, error: new Error("boom") });
      expect(mocks.capture).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.POSTHOG_MIN_SEVERITY;
    }
  });
});

describe("capturePostHogAiDegradation (#10186 — a request that reached NO model)", () => {
  const BASE = {
    reason: "circuit_open" as const,
    provider: "claude-code",
    model: "claude-sonnet-5",
    requestKind: "review" as const,
  };

  it("is a no-op when PostHog is unconfigured", () => {
    capturePostHogAiDegradation(BASE);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("emits a NATIVE event, never a $ai_generation — no model ran, so none may be blamed", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation(BASE);
    const call = mocks.capture.mock.calls[0]?.[0];
    // Booking this as $ai_generation would credit claude-sonnet-5 with a failure it never had -- the exact
    // false signal #10186 exists to remove -- and drag a zero-token, zero-cost row into the spend aggregates.
    expect(call.event).toBe(POSTHOG_AI_DEGRADED_EVENT);
    expect(call.event).not.toBe("$ai_generation");
    expect(call.properties.reason).toBe("circuit_open");
    expect(call.properties.request_kind).toBe("review");
    expect(call.properties.$ai_model).toBe("claude-sonnet-5");
    expect(call.properties.$ai_provider).toBe("claude-code");
    expect(call.properties.$ai_is_error).toBe(true);
    expect(call.properties.environment).toBe("production");
    // Never a spend/token figure: this request consumed neither.
    expect("$ai_total_cost_usd" in call.properties).toBe(false);
    expect("$ai_input_tokens" in call.properties).toBe(false);
  });

  it("shares the ambient OTel trace so a degraded request joins the real attempts around it", async () => {
    otelMocks.currentOtelTraceIds.mockReturnValue({ trace_id: "review-trace-1", span_id: "provider-span-1" });
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation(BASE);
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.$ai_trace_id).toBe("review-trace-1");
    expect(properties.$ai_span_id).toBe("provider-span-1");
    expect(properties.$ai_span_name).toBe("ai.review/claude-code/circuit_open");
  });

  it("falls back to a minted trace id, and omits $ai_span_id, outside any span", async () => {
    otelMocks.currentOtelTraceIds.mockReturnValue(undefined);
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation(BASE);
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.$ai_trace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect("$ai_span_id" in properties).toBe(false);
  });

  it("names the chain that gave up, not just its last member", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation({ ...BASE, reason: "chain_exhausted", providers: ["claude-code", "ollama"] });
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.reason).toBe("chain_exhausted");
    expect(properties.providers).toEqual(["claude-code", "ollama"]);
  });

  it("omits `providers` when absent, and when present-but-empty", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation(BASE);
    capturePostHogAiDegradation({ ...BASE, providers: [] });
    expect("providers" in mocks.capture.mock.calls[0]?.[0].properties).toBe(false);
    expect("providers" in mocks.capture.mock.calls[1]?.[0].properties).toBe(false);
  });

  it("records a bounded error message from an Error, and from a non-Error thrown value", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation({ ...BASE, error: new Error("y".repeat(600)) });
    capturePostHogAiDegradation({ ...BASE, error: "just a string" });
    expect(mocks.capture.mock.calls[0]?.[0].properties.$ai_error).toHaveLength(500);
    expect(mocks.capture.mock.calls[1]?.[0].properties.$ai_error).toBe("just a string");
  });

  it("omits $ai_error entirely when no error was supplied", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation(BASE);
    expect("$ai_error" in mocks.capture.mock.calls[0]?.[0].properties).toBe(false);
  });

  it("falls back to 'unknown' for a blank provider/model rather than emitting an empty label", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation({ ...BASE, provider: "   ", model: "" });
    const { properties } = mocks.capture.mock.calls[0]?.[0];
    expect(properties.$ai_provider).toBe("unknown");
    expect(properties.$ai_model).toBe("unknown");
    expect(properties.$ai_span_name).toBe("ai.review/unknown/circuit_open");
  });

  it("stamps the repo group when there is a repo, and omits `groups` when there is not", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation({ ...BASE, context: { repo: "owner/repo", pullNumber: 7 } });
    capturePostHogAiDegradation(BASE);
    expect(mocks.capture.mock.calls[0]?.[0].groups).toEqual({ repo: "owner/repo" });
    expect("groups" in mocks.capture.mock.calls[1]?.[0]).toBe(false);
  });

  it("never carries prompt/response content", async () => {
    await initPostHog({ POSTHOG_API_KEY: "phc_test_key" } as unknown as NodeJS.ProcessEnv);
    capturePostHogAiDegradation({ ...BASE, error: new Error("boom") });
    const keys = Object.keys(mocks.capture.mock.calls[0]?.[0].properties);
    expect(keys).not.toContain("$ai_input");
    expect(keys).not.toContain("$ai_output_choices");
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
