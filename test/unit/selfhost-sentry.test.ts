import { describe, it, expect, vi, beforeEach } from "vitest";
import { hostname } from "node:os";

// Mock @sentry/node so the dynamic import inside initSentry() resolves to spies. Hoisted so vi.mock can see it.
const mocks = vi.hoisted(() => {
  const scope = {
    setContext: vi.fn(),
    setLevel: vi.fn(),
    setTag: vi.fn(),
    setFingerprint: vi.fn(),
    addEventProcessor: vi.fn(),
  };
  const client = { id: "sentry-client" };
  return {
    client,
    scope,
    init: vi.fn(() => client),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    captureCheckIn: vi.fn((checkIn: { checkInId?: string }) => checkIn.checkInId ?? "check-in-id"),
    flush: vi.fn().mockResolvedValue(true),
    SentryContextManager: vi.fn(function (this: { kind: string }) {
      this.kind = "context-manager";
    }),
    validateOpenTelemetrySetup: vi.fn(),
  };
});
const sentryOtelMocks = vi.hoisted(() => ({
  SentrySampler: vi.fn(function (this: { client: unknown }, client: unknown) {
    this.client = client;
  }),
  SentryPropagator: vi.fn(function (this: { kind: string }) {
    this.kind = "propagator";
  }),
  SentrySpanProcessor: vi.fn(function (this: { kind: string }) {
    this.kind = "span-processor";
  }),
}));
const otelMocks = vi.hoisted(() => ({
  currentOtelTraceIds: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  init: mocks.init,
  withScope: mocks.withScope,
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
  captureCheckIn: mocks.captureCheckIn,
  flush: mocks.flush,
  SentryContextManager: mocks.SentryContextManager,
  validateOpenTelemetrySetup: mocks.validateOpenTelemetrySetup,
}));
vi.mock("@sentry/opentelemetry", () => ({
  SentrySampler: sentryOtelMocks.SentrySampler,
  SentryPropagator: sentryOtelMocks.SentryPropagator,
  SentrySpanProcessor: sentryOtelMocks.SentrySpanProcessor,
}));
vi.mock("../../src/selfhost/otel", () => ({
  currentOtelTraceIds: otelMocks.currentOtelTraceIds,
  openTelemetryTraceExportEnabled: (env: NodeJS.ProcessEnv) =>
    Boolean(env.OTEL_TRACES_EXPORTER?.includes("otlp") && env.OTEL_EXPORTER_OTLP_ENDPOINT),
}));

import {
  buildSentryOpenTelemetryBridge,
  initSentry,
  captureError,
  captureReviewFailure,
  flushSentry,
  forwardStructuredLogToSentry,
  installStructuredLogForwarding,
  resolveSentryRelease,
  resolveSentryTracesSampleRate,
  resolveSentryMonitorSlug,
  scrubEvent,
  resetSentryForTest,
  withSentryMonitor,
  SENTRY_MONITOR_NAMES,
  SENTRY_OPERATIONAL_SUBSYSTEMS,
  SENTRY_OPERATIONAL_TAG_KEYS,
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
const scrubbedEvent = <T>(event: T): T => {
  const scrubbed = scrubEvent(event);
  expect(scrubbed).not.toBeNull();
  return scrubbed as T;
};
const lastInitOptions = (): any =>
  (mocks.init.mock.calls.at(-1) as unknown[] | undefined)?.[0] as any;
const fakeClassicAccessToken = (): string => `${"github" + "_pat_"}${"a".repeat(24)}`;
const fakeQueryTokenKey = (): string => "github" + "_token";

describe("scrubEvent — redact secrets before an event leaves the box", () => {
  it("redacts secret-keyed fields in headers/contexts/extra, recurses, and leaves safe fields", () => {
    const ev = scrubbedEvent({
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
    expect(scrubEvent({})).toEqual({});
  });

  it("stops at the depth guard without infinite recursion, still redacting shallow secrets", () => {
    let deep: any = { secretToken: "x" };
    for (let i = 0; i < 8; i++) deep = { a: deep };
    let deepArray: any = { secretToken: "x" };
    for (let i = 0; i < 7; i++) deepArray = [deepArray];
    const ev = scrubbedEvent({
      extra: { token: "shallow", deep, deepArray },
    }) as any;
    let deepCursor = ev.extra.deep;
    for (let i = 0; i < 5; i++) deepCursor = deepCursor.a;
    let arrayCursor = ev.extra.deepArray;
    for (let i = 0; i < 5; i++) arrayCursor = arrayCursor[0];
    expect(ev.extra.token).toBe("[redacted]");
    expect(deepCursor.a).toBe("[redacted]");
    expect(arrayCursor[0]).toBe("[redacted]");
  });

  it("drops request bodies, denies unknown contexts, and scrubs PR/private payload fields (#1000)", () => {
    const fakeToken = fakeClassicAccessToken();
    const ev = scrubbedEvent({
      request: {
        headers: { authorization: `Bearer ${"a".repeat(16)}`, "x-trace": "ok" },
        data: { prompt: "review this diff" },
        body: "raw request body",
        cookies: { session: "abc" },
      },
      contexts: {
        gittensory: {
          safeReason: "provider unavailable",
          pullRequestTitle: "PR title with private rubric",
          reviewText: "raw review body",
          repoConfig: "private repo config",
          nested: { apiKey: "provider secret" },
        },
        mystery: { repoConfig: "should not leave" },
        runtime: { name: "node" },
      },
      extra: {
        diff: "@@ raw diff",
        note: `wallet raw score /home/alice/project ${fakeToken}`,
        attempts: 2,
        nil: null,
        values: ["hotkey", { apiKey: "nested" }, 3, null],
      },
      tags: { repo: "owner/repo", authToken: "token" },
    }) as any;

    expect(ev.request.data).toBeUndefined();
    expect(ev.request.body).toBeUndefined();
    expect(ev.request.cookies).toBeUndefined();
    expect(ev.request.headers.authorization).toBe("[redacted]");
    expect(ev.request.headers["x-trace"]).toBe("ok");
    expect(ev.contexts.mystery).toBeUndefined();
    expect(ev.contexts.runtime.name).toBe("node");
    expect(ev.contexts.gittensory.pullRequestTitle).toBe("[redacted]");
    expect(ev.contexts.gittensory.reviewText).toBe("[redacted]");
    expect(ev.contexts.gittensory.repoConfig).toBe("[redacted]");
    expect(ev.contexts.gittensory.nested.apiKey).toBe("[redacted]");
    expect(ev.extra.diff).toBe("[redacted]");
    expect(ev.extra.note).not.toContain(fakeToken);
    expect(ev.extra.note).not.toMatch(/wallet|raw score|\/home\/alice/i);
    expect(ev.extra.note).toContain("<redacted-path>");
    expect(ev.extra.attempts).toBe(2);
    expect(ev.extra.nil).toBeNull();
    expect(ev.extra.values).toEqual([
      "private context",
      { apiKey: "[redacted]" },
      3,
      null,
    ]);
    expect(ev.tags.repo).toBe("owner/repo");
    expect(ev.tags.authToken).toBe("[redacted]");
  });

  it("preserves contexts.review repo/pr while redacting review text fields (#1824, PR #1881 regression)", () => {
    const ev = scrubbedEvent({
      contexts: {
        review: {
          repo: "owner/repo",
          pr: 7,
          head_sha: "abc123",
          operation: "gate_decision",
          reviewText: "private review body",
          reviewBody: "also private",
          commentBody: "private comment",
          comment_text: "private comment text",
        },
      },
    }) as any;

    expect(ev.contexts.review.repo).toBe("owner/repo");
    expect(ev.contexts.review.pr).toBe(7);
    expect(ev.contexts.review.head_sha).toBe("abc123");
    expect(ev.contexts.review.operation).toBe("gate_decision");
    expect(ev.contexts.review.reviewText).toBe("[redacted]");
    expect(ev.contexts.review.reviewBody).toBe("[redacted]");
    expect(ev.contexts.review.commentBody).toBe("[redacted]");
    expect(ev.contexts.review.comment_text).toBe("[redacted]");
  });

  it("scrubs request URL/query fields and deletes top-level user data", () => {
    const queryTokenKey = fakeQueryTokenKey();
    const ev = scrubbedEvent({
      request: {
        url: `https://self.host/review?${queryTokenKey}=abc123&repo=owner%2Frepo`,
        query_string: `${queryTokenKey}=abc123&path=/home/alice/project&safe=ok`,
        query: { [queryTokenKey]: "abc123", safe: "ok" },
      },
      user: { id: "123", email: "person@example.com" },
    }) as any;

    const url = new URL(ev.request.url);
    const query = new URLSearchParams(ev.request.query_string);
    expect(url.searchParams.get(queryTokenKey)).toBe("[redacted]");
    expect(url.searchParams.get("repo")).toBe("owner/repo");
    expect(query.get(queryTokenKey)).toBe("[redacted]");
    expect(query.get("path")).toBe("<redacted-path>");
    expect(query.get("safe")).toBe("ok");
    expect(ev.request.query[queryTokenKey]).toBe("[redacted]");
    expect(ev.request.query.safe).toBe("ok");
    expect(ev.user).toBeUndefined();
  });

  it("scrubs breadcrumbs, exception metadata, messages, and transaction names", () => {
    const ev = scrubbedEvent({
      message: "gate prompt leaked with Bearer abcdefghijklmnop",
      transaction: "review /Users/alice/private",
      breadcrumbs: [
        {
          message: "prompt mentions hotkey",
          data: { responseBody: "raw provider body", safe: "kept" },
        },
      ],
      exception: {
        values: [
          {
            value: "codex failed with eyJaaaaaaaa.bbbbbbbb.cccccccc",
            stacktrace: {
              frames: [
                {
                  filename: "/tmp/repo/file.ts",
                  vars: { token: "abc", safe: "value" },
                },
              ],
            },
          },
        ],
      },
    }) as any;

    expect(ev.message).not.toMatch(/gate prompt|Bearer abc/i);
    expect(ev.transaction).toContain("<redacted-path>");
    expect(ev.breadcrumbs[0].message).not.toMatch(/hotkey/i);
    expect(ev.breadcrumbs[0].data.responseBody).toBe("[redacted]");
    expect(ev.breadcrumbs[0].data.safe).toBe("kept");
    expect(ev.exception.values[0].value).not.toMatch(/eyJaaaaaaaa/i);
    expect(ev.exception.values[0].stacktrace.frames[0].filename).toContain("<redacted-path>");
    expect(ev.exception.values[0].stacktrace.frames[0].vars.token).toBe("[redacted]");
    expect(ev.exception.values[0].stacktrace.frames[0].vars.safe).toBe("value");
  });

  // Regression (#1825): the Orb broker's enrollment id/secret (createOpaqueToken("orbenr"/"orbsec"),
  // src/orb/broker.ts) are bare opaque tokens with no "secret"/"token"-NAMED field for the key-based redaction
  // to catch when a broker error message quotes one directly (e.g. an error string embedding the failed
  // Authorization value) — the VALUE-based SECRET_VALUE pattern must recognize the orbenr_/orbsec_ shape too.
  it("redacts a bare Orb enrollment id/secret value from an exception message (#1825)", () => {
    const fakeEnrollId = `orbenr_${"c".repeat(64)}`;
    const fakeSecret = `orbsec_${"d".repeat(64)}`;
    const ev = scrubbedEvent({
      exception: {
        values: [{ value: `Orb broker rejected enrollment ${fakeEnrollId} using secret ${fakeSecret}` }],
      },
    }) as any;
    expect(ev.exception.values[0].value).not.toContain(fakeEnrollId);
    expect(ev.exception.values[0].value).not.toContain(fakeSecret);
    expect(ev.exception.values[0].value).toBe("Orb broker rejected enrollment [redacted] using secret [redacted]");
  });

  it("scrubs transaction span descriptions and data before sending transaction events", () => {
    const queryTokenKey = fakeQueryTokenKey();
    const ev = scrubbedEvent({
      spans: [
        {
          description: `GET /hooks?${queryTokenKey}=abc123&safe=ok`,
          data: {
            callbackUrl: `https://self.host/callback?${queryTokenKey}=abc123&safe=ok`,
            relativeUrl: `/callback?${queryTokenKey}=abc123&safe=ok`,
            noQueryUrl: "https://self.host/callback",
            query_string: `${queryTokenKey}=abc123&path=/home/alice/project`,
            prompt: "raw prompt",
          },
        },
      ],
    }) as any;

    const callbackUrl = new URL(ev.spans[0].data.callbackUrl);
    expect(ev.spans[0].description).not.toContain("abc123");
    expect(callbackUrl.searchParams.get(queryTokenKey)).toBe("[redacted]");
    expect(callbackUrl.searchParams.get("safe")).toBe("ok");
    expect(ev.spans[0].data.relativeUrl).toContain(
      `${queryTokenKey}=%5Bredacted%5D`,
    );
    expect(ev.spans[0].data.noQueryUrl).toBe("https://self.host/callback");
    expect(new URLSearchParams(ev.spans[0].data.query_string).get("path")).toBe(
      "<redacted-path>",
    );
    expect(ev.spans[0].data.prompt).toBe("[redacted]");
  });

  it("drops the event when scrubbing itself fails instead of sending it unscrubbed", () => {
    const event = {
      get request() {
        throw new Error("getter failed");
      },
    };

    expect(scrubEvent(event)).toBeNull();
  });

  it("drops raw installation ids before hashing is available and uses a stable hash after init", async () => {
    const noHasherEvent = scrubbedEvent({
      extra: { installationId: 143010787 },
    }) as any;
    expect(noHasherEvent.extra.installationId).toBeUndefined();
    expect(noHasherEvent.extra.installation_id_hash).toBeUndefined();

    const invalidEvent = scrubbedEvent({
      extra: { installation_id: "not-an-installation" },
    }) as any;
    expect(invalidEvent.extra.installation_id).toBeUndefined();
    expect(invalidEvent.extra.installation_id_hash).toBeUndefined();

    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    const ev = scrubbedEvent({
      tags: { installationId: 143010787, repo: "owner/repo" },
      contexts: { log: { installation_id: "143010787" } },
    }) as any;

    expect(ev.tags.installationId).toBeUndefined();
    expect(ev.tags.installation_id_hash).toBe("68b9c2136087c5ca");
    expect(ev.contexts.log.installation_id).toBeUndefined();
    expect(ev.contexts.log.installation_id_hash).toBe("68b9c2136087c5ca");
  });
});

describe("disabled when SENTRY_DSN is unset (modular opt-out → complete no-op)", () => {
  it("initSentry returns false; capture/flush are safe no-ops and never touch the SDK", async () => {
    expect(await initSentry({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    captureError(new Error("x"), { a: 1 });
    captureReviewFailure(new Error("y"), { repo: "o/r" });
    await expect(
      withSentryMonitor(
        "scheduled-loop",
        { jobType: "scheduled-loop" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
    await flushSentry();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.captureCheckIn).not.toHaveBeenCalled();
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

  it("resolves a positive Sentry trace sample rate and treats unset/zero/invalid as disabled", () => {
    expect(resolveSentryTracesSampleRate({} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveSentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: " " } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveSentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveSentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "-1" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveSentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "nope" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveSentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0.25" } as unknown as NodeJS.ProcessEnv)).toBe(0.25);
    expect(resolveSentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "9" } as unknown as NodeJS.ProcessEnv)).toBe(1);
  });

  it("returns true and wires init with defaults (?? right-hand branches) + the scrubber as beforeSend", async () => {
    expect(
      await initSentry({
        SENTRY_DSN: "https://k@o.ingest/1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    const opts = lastInitOptions();
    expect(opts.environment).toBe("production");
    expect(opts.release).toBeUndefined();
    expect(opts.tracesSampleRate).toBeUndefined();
    expect(opts.skipOpenTelemetrySetup).toBeUndefined();
    expect(
      opts.beforeSend({ extra: { sessionToken: "s" } }).extra.sessionToken,
    ).toBe("[redacted]");
    expect(
      opts.beforeSendTransaction({
        contexts: { unknown: { token: "s" }, trace: { op: "job" } },
      }).contexts,
    ).toEqual({ trace: { op: "job" } });
  });

  it("honors explicit env (?? left-hand branches)", async () => {
    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_ENVIRONMENT: "staging",
      SENTRY_RELEASE: "v9",
      SENTRY_TRACES_SAMPLE_RATE: "0.5",
      SENTRY_SERVER_NAME: "gittensory-us-east",
    } as unknown as NodeJS.ProcessEnv);
    const opts = lastInitOptions();
    expect(opts.environment).toBe("staging");
    expect(opts.release).toBe("v9");
    expect(opts.tracesSampleRate).toBe(0.5);
    expect(opts.skipOpenTelemetrySetup).toBe(true);
    expect(opts.serverName).toBe("gittensory-us-east");
  });

  it("defaults serverName to the OS hostname (not the API-origin URL) when SENTRY_SERVER_NAME is unset/blank", async () => {
    await initSentry({ SENTRY_DSN: "d", SENTRY_SERVER_NAME: "  ", PUBLIC_API_ORIGIN: "https://self.host" } as unknown as NodeJS.ProcessEnv);
    expect(lastInitOptions().serverName).toBe(hostname());
  });

  it("uses the custom OpenTelemetry setup when OTLP traces are enabled even if Sentry trace export is off", async () => {
    await initSentry({
      SENTRY_DSN: "d",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
    } as unknown as NodeJS.ProcessEnv);
    const opts = lastInitOptions();
    expect(opts.tracesSampleRate).toBeUndefined();
    expect(opts.skipOpenTelemetrySetup).toBe(true);
  });

  it("builds the Sentry OpenTelemetry bridge, adding the span processor only when Sentry traces are sampled", async () => {
    await expect(buildSentryOpenTelemetryBridge()).resolves.toBeUndefined();

    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    let bridge = await buildSentryOpenTelemetryBridge();
    expect(sentryOtelMocks.SentrySampler).not.toHaveBeenCalled();
    expect(sentryOtelMocks.SentryPropagator).toHaveBeenCalledTimes(1);
    expect(mocks.SentryContextManager).toHaveBeenCalledTimes(1);
    expect(sentryOtelMocks.SentrySpanProcessor).not.toHaveBeenCalled();
    bridge?.validate?.();
    expect(mocks.validateOpenTelemetrySetup).toHaveBeenCalledTimes(1);

    resetSentryForTest();
    vi.clearAllMocks();
    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_TRACES_SAMPLE_RATE: "0.5",
    } as unknown as NodeJS.ProcessEnv);
    bridge = await buildSentryOpenTelemetryBridge();
    expect(bridge?.sampler).toBeInstanceOf(sentryOtelMocks.SentrySampler);
    expect(bridge?.spanProcessor).toBeInstanceOf(sentryOtelMocks.SentrySpanProcessor);
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
    expect(lastInitOptions().release).toBe(
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

  it("captureError sends with context, tags operational fields, and without context skips setContext", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureError(new Error("boom"), { kind: "job_dead" });
    expect(mocks.scope.setContext).toHaveBeenCalledWith("gittensory", {
      kind: "job_dead",
    });
    expect(mocks.scope.setTag).toHaveBeenCalledWith("kind", "job_dead");
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    mocks.scope.setContext.mockClear();
    mocks.scope.setTag.mockClear();
    captureError(new Error("invalid install"), {
      kind: "job_dead",
      installation_id: "not-an-installation",
    });
    expect(mocks.scope.setContext).toHaveBeenCalledWith("gittensory", {
      kind: "job_dead",
    });
    expect(mocks.scope.setTag).toHaveBeenCalledWith("kind", "job_dead");
    mocks.scope.setContext.mockClear();
    captureError("plain string with no context");
    expect(mocks.scope.setContext).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledTimes(3);
  });

  it("captureReviewFailure sets error level + repo/PR/SHA tags, skipping null/undefined, and works without context", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureReviewFailure(new Error("rev"), {
      repo: "o/r",
      pr: 7,
      head_sha: "abc",
      installationId: 1,
      operation: "gate_decision",
      decision_outcome: "failure",
      owner: null,
    });
    expect(mocks.scope.setLevel).toHaveBeenCalledWith("error");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("repo", "o/r");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("pr", "7");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("head_sha", "abc");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("installation_id_hash", "21ab41515eeee762");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("operation", "gate_decision");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("decision_outcome", "failure");
    expect(mocks.scope.setContext).toHaveBeenCalledWith("review", expect.objectContaining({
      installation_id_hash: "21ab41515eeee762",
    }));
    expect(mocks.scope.setContext).not.toHaveBeenCalledWith("review", expect.objectContaining({
      installationId: 1,
    }));
    expect(mocks.scope.setTag).not.toHaveBeenCalledWith(
      "owner",
      expect.anything(),
    );
    captureReviewFailure("string failure, no context");
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });

  it("captureError with an eventName renames the captured Error so the Sentry title isn't the generic 'Error', and groups it by that same name (#5010)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureError(new Error("self-host queue processing lease expired"), { kind: "job_dead" }, "processing_timeout");
    expect(lastCapturedError().name).toBe("processing_timeout");
    expect(lastCapturedError().message).toBe("self-host queue processing lease expired");
    expect(mocks.scope.setFingerprint).toHaveBeenCalledWith(["gittensory-error", "processing_timeout"]);
  });

  it("captureError without an eventName leaves a caught exception's own name untouched, and never overrides Sentry's default grouping", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    class HttpError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "HttpError";
      }
    }
    captureError(new HttpError("merge already in progress"), { kind: "agent_merge_blocked" });
    expect(lastCapturedError().name).toBe("HttpError");
    expect(mocks.scope.setFingerprint).not.toHaveBeenCalled();
  });

  it("captureReviewFailure with an eventName renames the captured Error and groups it the same way captureError does (#5010) -- this is what consolidates the same failure captured from two different call sites (GITTENSORY-5/10, GITTENSORY-C/W) into one issue", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureReviewFailure(new Error("AI review inconclusive — no usable verdict for the PR head"), { repo: "o/r" }, "ai_review_inconclusive");
    expect(lastCapturedError().name).toBe("ai_review_inconclusive");
    expect(mocks.scope.setFingerprint).toHaveBeenCalledWith(["gittensory-review-failure", "ai_review_inconclusive"]);
  });

  it("captureReviewFailure without an eventName never overrides Sentry's default grouping", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureReviewFailure(new Error("rev"), { repo: "o/r" });
    expect(mocks.scope.setFingerprint).not.toHaveBeenCalled();
  });

  it("captureError/captureReviewFailure with an eventName still names a non-Error value's synthesized Error", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    captureError("plain string failure", undefined, "boot");
    expect(lastCapturedError().name).toBe("boot");
    expect(lastCapturedError().message).toBe("plain string failure");
    captureReviewFailure("plain string review failure", undefined, "ai_review_failed");
    expect(lastCapturedError().name).toBe("ai_review_failed");
  });

  it("captureError/captureReviewFailure with an eventName never mutate caught errors that reject name writes", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);

    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    captureError(timeoutError, { kind: "fetch_timeout" }, "github_fetch_failed");

    expect(timeoutError.name).toBe("TimeoutError");
    expect(lastCapturedError()).not.toBe(timeoutError);
    expect(lastCapturedError().name).toBe("github_fetch_failed");
    expect(lastCapturedError().message).toBe("signal timed out");
    expect(lastCapturedError().cause).toBe(timeoutError);

    const frozenError = Object.freeze(new Error("review failed"));
    captureReviewFailure(frozenError, { repo: "o/r" }, "ai_review_failed");

    expect(frozenError.name).toBe("Error");
    expect(lastCapturedError()).not.toBe(frozenError);
    expect(lastCapturedError().name).toBe("ai_review_failed");
    expect(lastCapturedError().message).toBe("review failed");
    expect(lastCapturedError().cause).toBe(frozenError);
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

  it("builds stable environment-aware monitor slugs", () => {
    expect(resolveSentryMonitorSlug("scheduled-loop", "Prod East/1")).toBe(
      "gittensory-selfhost-prod-east-1-scheduled-loop",
    );
    expect(resolveSentryMonitorSlug("orb-export", " !!! ")).toBe(
      "gittensory-selfhost-production-orb-export",
    );
    expect(resolveSentryMonitorSlug("orb-relay-drain", "x".repeat(60))).toBe(
      `gittensory-selfhost-${"x".repeat(48)}-orb-relay-drain`,
    );
    expect(resolveSentryMonitorSlug("queue-dead-letter-revive", "prod")).toBe(
      "gittensory-selfhost-prod-queue-dead-letter-revive",
    );
  });

  it("records dead-letter-revive check-ins on the 30-minute schedule (#1824)", async () => {
    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_ENVIRONMENT: "prod",
    } as unknown as NodeJS.ProcessEnv);

    await expect(
      withSentryMonitor(
        "queue-dead-letter-revive",
        { jobType: "queue-dead-letter-revive" },
        async () => 3,
      ),
    ).resolves.toBe(3);

    expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
      1,
      { monitorSlug: "gittensory-selfhost-prod-queue-dead-letter-revive", status: "in_progress" },
      expect.objectContaining({
        schedule: { type: "interval", value: 30, unit: "minute" },
        checkinMargin: 10,
        maxRuntime: 5,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      }),
    );
    expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        monitorSlug: "gittensory-selfhost-prod-queue-dead-letter-revive",
        status: "ok",
        checkInId: "check-in-id",
        duration: expect.any(Number),
      }),
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("derives the dead-letter-revive schedule from an operator's configured interval override (#1824 regression)", async () => {
    process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = String(90 * 60_000);
    try {
      await initSentry({
        SENTRY_DSN: "d",
        SENTRY_ENVIRONMENT: "prod",
      } as unknown as NodeJS.ProcessEnv);

      await withSentryMonitor("queue-dead-letter-revive", { jobType: "queue-dead-letter-revive" }, async () => 1);

      expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
        1,
        { monitorSlug: "gittensory-selfhost-prod-queue-dead-letter-revive", status: "in_progress" },
        expect.objectContaining({
          schedule: { type: "interval", value: 90, unit: "minute" },
          checkinMargin: 30,
        }),
      );
    } finally {
      delete process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS;
    }
  });

  it("floors an operator's dead-letter-revive interval override to at least 1 minute for the monitor schedule", async () => {
    process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS = "1000";
    try {
      await initSentry({
        SENTRY_DSN: "d",
        SENTRY_ENVIRONMENT: "prod",
      } as unknown as NodeJS.ProcessEnv);

      await withSentryMonitor("queue-dead-letter-revive", { jobType: "queue-dead-letter-revive" }, async () => 1);

      expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
        1,
        { monitorSlug: "gittensory-selfhost-prod-queue-dead-letter-revive", status: "in_progress" },
        expect.objectContaining({
          schedule: { type: "interval", value: 1, unit: "minute" },
          checkinMargin: 5,
        }),
      );
    } finally {
      delete process.env.QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS;
    }
  });

  it("records successful Sentry cron monitor check-ins with the configured schedule", async () => {
    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_ENVIRONMENT: "Self Host",
    } as unknown as NodeJS.ProcessEnv);

    await expect(
      withSentryMonitor(
        "scheduled-loop",
        { jobType: "scheduled-loop" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");

    expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
      1,
      { monitorSlug: "gittensory-selfhost-self-host-scheduled-loop", status: "in_progress" },
      expect.objectContaining({
        schedule: { type: "interval", value: 2, unit: "minute" },
        checkinMargin: 3,
        maxRuntime: 2,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      }),
    );
    expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        monitorSlug: "gittensory-selfhost-self-host-scheduled-loop",
        status: "ok",
        checkInId: "check-in-id",
        duration: expect.any(Number),
      }),
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("records failed Sentry cron monitor check-ins with sanitized context", async () => {
    await initSentry({
      SENTRY_DSN: "d",
      SENTRY_ENVIRONMENT: "prod",
    } as unknown as NodeJS.ProcessEnv);
    const longText = "x".repeat(200);

    await expect(
      withSentryMonitor(
        "orb-export",
        {
          jobType: "orb-export",
          repo: "JSONbored/gittensory",
          exported: 7,
          dryRun: false,
          token: "secret",
          privateKey: "key",
          badNumber: Number.NaN,
          nested: { ignored: true },
          empty: null,
          missing: undefined,
          longText,
        },
        async () => {
          throw new Error("export failed");
        },
      ),
    ).rejects.toThrow("export failed");

    expect(mocks.captureCheckIn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        monitorSlug: "gittensory-selfhost-prod-orb-export",
        status: "error",
        checkInId: "check-in-id",
        duration: expect.any(Number),
      }),
    );
    expect(mocks.scope.setLevel).toHaveBeenCalledWith("error");
    expect(mocks.scope.setTag).toHaveBeenCalledWith(
      "monitor",
      "gittensory-selfhost-prod-orb-export",
    );
    expect(mocks.scope.setTag).toHaveBeenCalledWith("jobType", "orb-export");
    expect(mocks.scope.setTag).toHaveBeenCalledWith(
      "kind",
      "sentry_monitor_orb-export",
    );
    expect(mocks.scope.setTag).toHaveBeenCalledWith("subsystem", "scheduled");
    expect(mocks.scope.setFingerprint).toHaveBeenCalledWith([
      "gittensory-sentry-monitor",
      "orb-export",
    ]);
    expect(mocks.scope.setContext).toHaveBeenCalledWith("sentry_monitor", {
      monitor: "orb-export",
      monitorSlug: "gittensory-selfhost-prod-orb-export",
      jobType: "orb-export",
      repo: "JSONbored/gittensory",
      exported: 7,
      dryRun: false,
      longText: `${"x".repeat(157)}...`,
    });
    expect(JSON.stringify(mocks.scope.setContext.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(mocks.scope.setContext.mock.calls)).not.toContain("key");
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("records monitor failures without context and normalizes non-Error throws", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);

    await expect(
      withSentryMonitor("orb-relay-drain", undefined, async () => {
        throw "relay failed";
      }),
    ).rejects.toBe("relay failed");

    expect(mocks.scope.setContext).toHaveBeenCalledWith("sentry_monitor", {
      monitor: "orb-relay-drain",
      monitorSlug: "gittensory-selfhost-production-orb-relay-drain",
    });
    expect((mocks.captureException.mock.calls.at(-1)?.[0] as Error).message).toBe(
      "relay failed",
    );
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

  it("leads the title with the real error detail + indexes filterable hashed tenant tags + fingerprints by event (#observability)", async () => {
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
    expect(mocks.scope.setTag).toHaveBeenCalledWith("installation_id_hash", "68b9c2136087c5ca");
    expect(mocks.scope.setTag).not.toHaveBeenCalledWith("installationId", expect.anything());
    expect(mocks.scope.setContext).toHaveBeenCalledWith("log", expect.objectContaining({
      installation_id_hash: "68b9c2136087c5ca",
    }));
    expect(mocks.scope.setContext).not.toHaveBeenCalledWith("log", expect.objectContaining({
      installationId: 143010787,
    }));
    // Recurrences of one failure group into a single issue by event.
    expect(mocks.scope.setFingerprint).toHaveBeenCalledWith(["gittensory-log", "orb_broker_unavailable"]);
  });

  it("strips the synthetic wrapper stack so the issue culprit is not forwardStructuredLogToSentry", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({ level: "error", event: "orb_broker_unavailable", message: "timeout" }),
    );

    const stack = lastCapturedError().stack ?? "";
    expect(stack).not.toMatch(/\n\s+at /);
    expect(stack).toBe("orb_broker_unavailable: timeout");
  });

  it("sets the issue culprit transaction to the event slug, and skips it when there is no event", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({ level: "error", event: "orb_broker_unavailable", message: "timeout" }),
    );

    const processor = mocks.scope.addEventProcessor.mock.calls.at(-1)?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(processor({})).toEqual({ transaction: "orb_broker_unavailable" });

    vi.clearAllMocks();
    forwardStructuredLogToSentry(JSON.stringify({ level: "error", message: "timeout" }));
    expect(mocks.scope.addEventProcessor).not.toHaveBeenCalled();
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

  it("normalizes repository log alias to repo tag (#1881 nit)", async () => {
    await initSentry({ SENTRY_DSN: "d" } as unknown as NodeJS.ProcessEnv);
    forwardStructuredLogToSentry(
      JSON.stringify({
        level: "error",
        event: "check_run_post_denied",
        repository: "owner/repo",
        pullNumber: 3,
        message: "permission denied",
      }),
    );
    expect(mocks.scope.setTag).toHaveBeenCalledWith("repo", "owner/repo");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("repository", "owner/repo");
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
    expect(lastCapturedError().message).toBe("(no message — see the log context)");
    expect(mocks.scope.setTag).toHaveBeenCalledWith("installation_id_hash", "21ab41515eeee762");
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

describe("Sentry operational taxonomy exports (#1824)", () => {
  it("exports monitor names aligned with wrapped cron loops", () => {
    expect(SENTRY_MONITOR_NAMES).toEqual([
      "scheduled-loop",
      "orb-export",
      "orb-relay-drain",
      "orb-relay-register",
      "queue-dead-letter-revive",
    ]);
  });

  it("exports subsystem taxonomy keys for operator docs", () => {
    expect(Object.keys(SENTRY_OPERATIONAL_SUBSYSTEMS).sort()).toEqual([
      "ai",
      "backup",
      "gate",
      "github",
      "publish",
      "queue",
      "relay",
      "scheduled",
      "webhook",
    ]);
  });

  it("keeps operational tag keys low-cardinality and review-aware", () => {
    expect(SENTRY_OPERATIONAL_TAG_KEYS).toEqual(
      expect.arrayContaining([
        "kind",
        "subsystem",
        "jobType",
        "repo",
        "pr",
        "head_sha",
        "operation",
        "event",
        "monitor",
      ]),
    );
    expect(SENTRY_OPERATIONAL_TAG_KEYS).not.toContain("installationId");
  });
});
