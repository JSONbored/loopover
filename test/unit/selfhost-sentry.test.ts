import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @sentry/node so the dynamic import inside initSentry() resolves to spies. Hoisted so vi.mock can see it.
const mocks = vi.hoisted(() => {
  const scope = { setContext: vi.fn(), setLevel: vi.fn(), setTag: vi.fn(), setFingerprint: vi.fn() };
  return {
    scope,
    init: vi.fn(),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
  };
});
const otelMocks = vi.hoisted(() => ({
  currentOtelTraceIds: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  init: mocks.init,
  withScope: mocks.withScope,
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
  flush: mocks.flush,
}));
vi.mock("../../src/selfhost/otel", () => ({
  currentOtelTraceIds: otelMocks.currentOtelTraceIds,
}));

import {
  initSentry,
  captureError,
  captureReviewFailure,
  flushSentry,
  forwardStructuredLogToSentry,
  installStructuredLogForwarding,
  resolveSentryRelease,
  scrubEvent,
  resetSentryForTest,
} from "../../src/selfhost/sentry";

beforeEach(() => {
  resetSentryForTest();
  vi.clearAllMocks();
  otelMocks.currentOtelTraceIds.mockReturnValue(undefined);
});

// The structured-log forwarder captures a synthetic Error via captureException (name = event slug, message = the
// value) so issues show a real "type: value", never "(No error message)". This reads back the last captured Error.
const lastCapturedError = (): Error =>
  mocks.captureException.mock.calls.at(-1)?.[0] as Error;

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
  it("resolves the Sentry release from explicit env, then the baked image version, ignoring blanks", () => {
    expect(
      resolveSentryRelease({
        SENTRY_RELEASE: " custom-release ",
        GITTENSORY_VERSION: "gittensory-selfhost@0.1.0",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("custom-release");
    expect(
      resolveSentryRelease({
        SENTRY_RELEASE: "  ",
        GITTENSORY_VERSION: " gittensory-selfhost@0.1.0 ",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("gittensory-selfhost@0.1.0");
    expect(resolveSentryRelease({} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("returns true and wires init with defaults (?? right-hand branches) + the scrubber as beforeSend", async () => {
    expect(
      await initSentry({
        SENTRY_DSN: "https://k@o.ingest/1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    const opts = mocks.init.mock.calls[0]![0];
    expect(opts.environment).toBe("production");
    expect(opts.release).toBeUndefined();
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

  it("uses the image-baked version as the release fallback and ignores blank overrides", async () => {
    expect(
      resolveSentryRelease({
        SENTRY_RELEASE: "  ",
        GITTENSORY_VERSION: " gittensory-selfhost@0.1.0 ",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("gittensory-selfhost@0.1.0");

    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_RELEASE: "",
      GITTENSORY_VERSION: "gittensory-selfhost@0.1.0",
    } as unknown as NodeJS.ProcessEnv);
    expect(mocks.init.mock.calls[0]![0].release).toBe(
      "gittensory-selfhost@0.1.0",
    );
  });

  it("prefers an explicit nonblank SENTRY_RELEASE over GITTENSORY_VERSION", () => {
    expect(
      resolveSentryRelease({
        SENTRY_RELEASE: "custom@sha",
        GITTENSORY_VERSION: "gittensory-selfhost@0.1.0",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("custom@sha");
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

  it("captureReviewFailure sets error level + repo/PR/SHA tags, skipping null/undefined, and works without context", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureReviewFailure(new Error("rev"), {
      repo: "o/r",
      pr: 7,
      head_sha: "abc",
      owner: null,
    });
    expect(mocks.scope.setLevel).toHaveBeenCalledWith("error");
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

  it("adds active OTEL trace ids to captured Sentry events", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    otelMocks.currentOtelTraceIds.mockReturnValue({
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      span_id: "bbbbbbbbbbbbbbbb",
    });

    captureError(new Error("boom"), { kind: "job_dead" });
    expect(mocks.scope.setTag).toHaveBeenCalledWith("trace_id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("span_id", "bbbbbbbbbbbbbbbb");
    expect(mocks.scope.setContext).toHaveBeenCalledWith("otel", {
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      span_id: "bbbbbbbbbbbbbbbb",
    });

    mocks.scope.setTag.mockClear();
    mocks.scope.setContext.mockClear();
    captureReviewFailure(new Error("review"), { repo: "o/r", pr: 9 });
    expect(mocks.scope.setTag).toHaveBeenCalledWith("trace_id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("span_id", "bbbbbbbbbbbbbbbb");
    expect(mocks.scope.setContext).toHaveBeenCalledWith("otel", {
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      span_id: "bbbbbbbbbbbbbbbb",
    });
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

describe("forwardStructuredLogToSentry — central console.log → Sentry error forwarding (#1468)", () => {
  it("is a no-op when Sentry is off", () => {
    forwardStructuredLogToSentry(
      JSON.stringify({ level: "error", event: "x" }),
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("ignores non-strings, non-JSON-object strings, and unparseable JSON when enabled", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(42); // not a string
    forwardStructuredLogToSentry({ level: "error" }); // not a string
    forwardStructuredLogToSentry("plain log line"); // doesn't start with "{"
    forwardStructuredLogToSentry(""); // empty string (charCodeAt(0) is NaN)
    forwardStructuredLogToSentry("{not valid json"); // throws → caught
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("skips routine (non-error) structured logs", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({ level: "audit", event: "job_complete" }),
    );
    forwardStructuredLogToSentry(
      JSON.stringify({ event: "regate_sweep_throttled" }),
    ); // no level
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("titles a no-message error log with event + a SHORT (repo#pr) location, not a field dump", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "gate_check_permission_missing",
        repository: "JSONbored/awesome-claude",
        pullNumber: 4240,
        deliveryId: "regate-sweep:JSONbored/awesome-claude#4240",
      }),
    );
    expect(mocks.scope.setLevel).toHaveBeenCalledWith("error");
    expect(mocks.scope.setTag).toHaveBeenCalledWith(
      "event",
      "gate_check_permission_missing",
    );
    // No message/error → captureException with value = the PR location (a real value, NOT "(No error message)");
    // the long deliveryId stays in the tags/context only.
    expect(lastCapturedError().name).toBe("gate_check_permission_missing");
    expect(lastCapturedError().message).toBe("(JSONbored/awesome-claude#4240)");
  });

  it("leads the title with the real error detail + indexes filterable tags + fingerprints by event (#observability)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "orb_broker_unavailable",
        error: "The operation was aborted due to timeout",
        repo: "JSONbored/gittensory",
        installationId: 143010787,
      }),
    );
    // The issue carries the actual failure as the exception VALUE (no hunting through the context blob).
    expect(lastCapturedError().name).toBe("orb_broker_unavailable");
    expect(lastCapturedError().message).toBe("The operation was aborted due to timeout");
    // The present log dimensions become filterable tags.
    expect(mocks.scope.setTag).toHaveBeenCalledWith("repo", "JSONbored/gittensory");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("installationId", "143010787");
    // Recurrences of one failure group into a single issue by event.
    expect(mocks.scope.setFingerprint).toHaveBeenCalledWith(["gittensory-log", "orb_broker_unavailable"]);
  });

  it("indexes self-host AI provider dimensions as Sentry tags", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "selfhost_ai_provider_failed",
        provider: "codex",
        model: "gpt-5.5",
        effort: "high",
        timeoutMs: 240000,
        error: "subscription_cli_timeout",
      }),
    );
    expect(lastCapturedError().name).toBe("selfhost_ai_provider_failed");
    expect(lastCapturedError().message).toBe("subscription_cli_timeout");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("provider", "codex");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("model", "gpt-5.5");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("effort", "high");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("timeoutMs", "240000");
  });

  it("indexes trace ids already present on structured error logs", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "selfhost_job_dead",
        trace_id: "cccccccccccccccccccccccccccccccc",
        span_id: "dddddddddddddddd",
      }),
    );
    expect(mocks.scope.setTag).toHaveBeenCalledWith("trace_id", "cccccccccccccccccccccccccccccccc");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("span_id", "dddddddddddddddd");
  });

  it("forwards a level:fatal log titled by message (no event ⇒ no tag)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({ level: "fatal", message: "boom" }),
    );
    expect(mocks.scope.setLevel).toHaveBeenCalledWith("fatal");
    expect(mocks.scope.setTag).not.toHaveBeenCalled();
    expect(lastCapturedError().name).toBe("GittensoryLog");
    expect(lastCapturedError().message).toBe("boom");
  });

  it("summarizes salient fields when neither event nor message is present", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(JSON.stringify({ level: "error", code: 500 }));
    expect(lastCapturedError().name).toBe("GittensoryLog");
    expect(lastCapturedError().message).toBe("code=500");
  });

  it("uses a bare event title when a no-message error log has no repo to locate it", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({ level: "error", event: "relay_drained_error" }),
    );
    expect(lastCapturedError().name).toBe("relay_drained_error");
    expect(lastCapturedError().message).toBe("(no message — see the log context)");
  });

  it("summarizes salient fields (count/projects) alongside the repo location", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "closehold_backlog",
        repo: "JSONbored/gittensory",
        count: 2,
        projects: ["a", "b"],
      }),
    );
    // The repo locates it AND its salient fields are summarized, so the issue shows real data, not "(no message)".
    expect(lastCapturedError().name).toBe("closehold_backlog");
    expect(lastCapturedError().message).toBe(
      '(JSONbored/gittensory) count=2, projects=["a","b"]',
    );
  });

  it("summarizes a field-only error log (close_breaker_engaged), skipping nulls + long blobs", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "close_breaker_engaged",
        project: "JSONbored/gittensory",
        closePrecision: 0.6,
        floor: 0.8,
        extra: null,
        note: "x".repeat(100),
      }),
    );
    // project/closePrecision/floor are summarized; the null `extra` and the 100-char `note` are skipped.
    expect(lastCapturedError().name).toBe("close_breaker_engaged");
    expect(lastCapturedError().message).toBe(
      "project=JSONbored/gittensory, closePrecision=0.6, floor=0.8",
    );
  });

  it("does not promote secret-keyed scalar fields into no-message titles (regression)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "attacker_controlled_error",
        token: "gts_SUPER_SECRET_TOKEN_12345",
        apiKey: "shh",
        repository: "owner/repo",
        pullNumber: 7,
        project: "safe-project",
      }),
    );

    expect(lastCapturedError().name).toBe("attacker_controlled_error");
    expect(lastCapturedError().message).toBe(
      "(owner/repo#7) project=safe-project",
    );
    expect(lastCapturedError().message).not.toContain(
      "gts_SUPER_SECRET_TOKEN_12345",
    );
    expect(lastCapturedError().message).not.toContain("shh");
  });

  it("redacts nested secret-keyed values before summarizing object fields", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "provider_metadata_failed",
        provider: { name: "github", token: "nested-secret" },
        attempts: [
          { name: "first", privateKey: "nested-key" },
          "retry",
        ],
      }),
    );

    expect(lastCapturedError().name).toBe("provider_metadata_failed");
    expect(lastCapturedError().message).toBe(
      'provider={"name":"github","token":"[redacted]"}, attempts=[{"name":"first","privateKey":"[redacted]"},"retry"]',
    );
    expect(lastCapturedError().message).not.toContain("nested-secret");
    expect(lastCapturedError().message).not.toContain("nested-key");
  });

  it("redacts deeply nested summary objects instead of serializing past the depth cap", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "deep_provider_metadata_failed",
        meta: { a: { b: { c: { d: { e: { f: { token: "deep-secret" } } } } } } },
      }),
    );

    expect(lastCapturedError().name).toBe("deep_provider_metadata_failed");
    expect(lastCapturedError().message).toBe(
      'meta={"a":{"b":{"c":{"d":{"e":{"f":"[redacted]"}}}}}}',
    );
    expect(lastCapturedError().message).not.toContain("deep-secret");
  });
});

describe("installStructuredLogForwarding — central console sink instrumentation (#1468)", () => {
  const makeConsole = () => {
    const base = { log: vi.fn(), error: vi.fn() };
    return { target: { ...base }, base };
  };

  it("forwards structured level:error logs emitted through console.error (regression)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const { target, base } = makeConsole();

    installStructuredLogForwarding(target);
    target.error(
      JSON.stringify({
        level: "error",
        event: "orb_broker_unavailable",
        installationId: 1,
      }),
    );

    expect(lastCapturedError().name).toBe("orb_broker_unavailable");
    expect(lastCapturedError().message).toBe("installationId=1");
    expect(base.error).toHaveBeenCalledTimes(1);
  });

  it("keeps forwarding structured level:error logs emitted through console.log", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const { target, base } = makeConsole();

    installStructuredLogForwarding(target);
    target.log(JSON.stringify({ level: "error", event: "gate_check_failed" }));

    expect(lastCapturedError().name).toBe("gate_check_failed");
    expect(lastCapturedError().message).toBe("(no message — see the log context)");
    expect(base.log).toHaveBeenCalledTimes(1);
  });

  it("forwards a NO-LEVEL structured log emitted through console.error (the error sink defaults to error)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const { target } = makeConsole();
    installStructuredLogForwarding(target);
    // No `level` field — previously dropped on the floor; now console.error forwards it as error (short location).
    target.error(
      JSON.stringify({ event: "selfhost_ai_provider_failed", repo: "o/r" }),
    );
    expect(lastCapturedError().name).toBe("selfhost_ai_provider_failed");
    expect(lastCapturedError().message).toBe("(o/r)");
  });

  it("does NOT forward a no-level log through console.log (stdout is not error by default)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const { target } = makeConsole();
    installStructuredLogForwarding(target);
    target.log(JSON.stringify({ event: "job_complete" }));
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("keeps skipping an EXPLICIT level:warn through console.error (explicit level wins over the sink default)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const { target } = makeConsole();
    installStructuredLogForwarding(target);
    target.error(
      JSON.stringify({ level: "warn", event: "orb_broker_degraded" }),
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("does not recursively forward if the Sentry path logs while forwarding", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const { target, base } = makeConsole();
    installStructuredLogForwarding(target);
    mocks.captureException.mockImplementationOnce(() => {
      target.error(JSON.stringify({ level: "error", event: "recursive" }));
    });

    target.error(JSON.stringify({ level: "error", event: "outer" }));

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(lastCapturedError().name).toBe("outer");
    expect(base.error).toHaveBeenCalledTimes(2);
  });
});
