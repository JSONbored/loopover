import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROOT_CONTEXT } from "@opentelemetry/api";

const otelMocks = vi.hoisted(() => {
  const exportedSpans: any[] = [];
  const exporterInstances: any[] = [];
  const OTLPTraceExporter = vi.fn(function (this: any, options: unknown) {
    this.options = options;
    this.export = (spans: any[], done: (result: { code: number }) => void) => {
      exportedSpans.push(...spans);
      done({ code: 0 });
    };
    this.forceFlush = vi.fn(async () => undefined);
    this.shutdown = vi.fn(async () => undefined);
    exporterInstances.push(this);
  });
  return { exportedSpans, exporterInstances, OTLPTraceExporter };
});

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: otelMocks.OTLPTraceExporter,
}));

import {
  currentOtelTraceIds,
  currentOtelTraceParent,
  flushOpenTelemetry,
  initOpenTelemetry,
  openTelemetryTraceExportEnabled,
  otelSafeAttributes,
  otelTraceLogFields,
  resetOpenTelemetryForTest,
  resolveOtelTraceEndpoint,
  selfHostHttpRequestAttributes,
  selfHostHttpResponseAttributes,
  setCurrentOtelSpanAttributes,
  withOtelSpan,
} from "../../src/selfhost/otel";
import {
  hashedInstallationId,
  hashedInstallationIdWith,
  reviewTraceAttributes,
  setReviewPipelineSpanOutcome,
  withReviewPipelineSpan,
} from "../../src/selfhost/review-tracing";
import {
  clearSelfHostRequestTraceParent,
  getSelfHostRequestTraceParent,
  setSelfHostRequestTraceParent,
} from "../../src/selfhost/trace-context";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as unknown as NodeJS.ProcessEnv;

beforeEach(async () => {
  await resetOpenTelemetryForTest();
  otelMocks.exportedSpans.length = 0;
  otelMocks.exporterInstances.length = 0;
  vi.clearAllMocks();
});

describe("self-host OpenTelemetry", () => {
  it("stays inert unless OTLP trace export is explicitly enabled", async () => {
    expect(resolveOtelTraceEndpoint(env({}))).toBeUndefined();
    expect(resolveOtelTraceEndpoint(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" }))).toBe(
      "http://otel-collector:4318/v1/traces",
    );
    expect(resolveOtelTraceEndpoint(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318/v1/traces" }))).toBe(
      "http://otel-collector:4318/v1/traces",
    );
    expect(resolveOtelTraceEndpoint(env({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector/custom" }))).toBe(
      "http://collector/custom",
    );
    expect(openTelemetryTraceExportEnabled(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" }))).toBe(false);
    expect(openTelemetryTraceExportEnabled(env({ OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" }))).toBe(true);
    expect(await initOpenTelemetry(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" }))).toBe(false);
    await flushOpenTelemetry();
    await expect(withOtelSpan("off", { "job.type": "x" }, () => 42)).resolves.toBe(42);
    expect(currentOtelTraceParent()).toBeUndefined();
    expect(currentOtelTraceIds()).toBeUndefined();
    expect(otelTraceLogFields()).toBeUndefined();
    expect(otelTraceLogFields("bad-traceparent")).toBeUndefined();
    expect(otelTraceLogFields("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")).toEqual({
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    setCurrentOtelSpanAttributes({ ignored: true });
    expect(otelMocks.OTLPTraceExporter).not.toHaveBeenCalled();
  });

  it("exports successful spans with safe resource and span attributes", async () => {
    expect(
      await initOpenTelemetry(
        env({
          OTEL_TRACES_EXPORTER: "console,otlp",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318/",
          OTEL_SERVICE_NAME: "gittensory-test",
          SENTRY_ENVIRONMENT: "selfhost-test",
          LOOPOVER_VERSION: "gittensory-selfhost@test",
        }),
      ),
    ).toBe(true);
    expect(
      await initOpenTelemetry(
        env({ OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored:4318" }),
      ),
    ).toBe(true);
    await expect(
      withOtelSpan(
        "selfhost.queue.job",
        {
          "job.type": "github-webhook",
          "queue.backend": "sqlite",
          "job.attempt": 2,
          "safe.flag": true,
          apiKey: "do-not-export",
          nested: { value: "skip objects" },
          badNumber: Number.NaN,
          longText: "x".repeat(200),
        },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
    await flushOpenTelemetry();
    expect(otelMocks.exporterInstances[0]?.options).toEqual({ url: "http://otel-collector:4318/v1/traces" });
    const span = otelMocks.exportedSpans[0];
    expect(span.name).toBe("selfhost.queue.job");
    expect(span.attributes).toMatchObject({
      "job.type": "github-webhook",
      "queue.backend": "sqlite",
      "job.attempt": 2,
      "safe.flag": true,
    });
    expect(span.attributes.apiKey).toBeUndefined();
    expect(span.attributes.nested).toBeUndefined();
    expect(span.attributes.badNumber).toBeUndefined();
    expect(span.attributes.longText).toHaveLength(160);
    expect(span.resource.attributes).toMatchObject({
      "service.name": "gittensory-test",
      "service.version": "gittensory-selfhost@test",
      "deployment.environment.name": "selfhost-test",
    });
    expect(otelMocks.OTLPTraceExporter).toHaveBeenCalledTimes(1);
  });

  it("resolves service.version from LOOPOVER_VERSION", async () => {
    await initOpenTelemetry(
      env({ OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318", LOOPOVER_VERSION: "loopover-selfhost@test" }),
    );
    await withOtelSpan("selfhost.queue.job", {}, async () => "ok");
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans[0].resource.attributes).toMatchObject({ "service.version": "loopover-selfhost@test" });
  });

  it("records failed spans and preserves nested parent context", async () => {
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector/v1/traces",
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "1",
    }));
    await expect(
      withOtelSpan("parent", undefined, async () => {
        await expect(withOtelSpan("child", { secretToken: "drop" }, async () => {
          throw new Error("child failed");
        })).rejects.toThrow("child failed");
      }),
    ).resolves.toBeUndefined();
    await flushOpenTelemetry();
    const parent = otelMocks.exportedSpans.find((span) => span.name === "parent");
    const child = otelMocks.exportedSpans.find((span) => span.name === "child");
    expect(parent.status.code).toBe(1);
    expect(child.status.code).toBe(2);
    expect(child.events.map((event: { name: string }) => event.name)).toContain("exception");
    expect(child.attributes.secretToken).toBeUndefined();
    expect(child.parentSpanContext.spanId).toBe(parent.spanContext().spanId);
  });

  it("injects traceparent context and resumes later spans from it", async () => {
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector/v1/traces",
    }));
    expect(currentOtelTraceParent()).toBeUndefined();
    expect(currentOtelTraceIds()).toBeUndefined();
    setCurrentOtelSpanAttributes({ ignored: true });
    let traceParent: string | undefined;
    let traceIds: ReturnType<typeof currentOtelTraceIds>;
    let logFields: ReturnType<typeof otelTraceLogFields>;
    await withOtelSpan("selfhost.http.request", undefined, () => {
      traceParent = currentOtelTraceParent();
      traceIds = currentOtelTraceIds();
      logFields = otelTraceLogFields("00-ffffffffffffffffffffffffffffffff-eeeeeeeeeeeeeeee-01");
      setCurrentOtelSpanAttributes({
        "http.response.status_code": 202,
        secretHeader: "drop",
      });
    });
    expect(traceParent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(traceIds).toEqual({
      trace_id: traceParent!.split("-")[1],
      span_id: traceParent!.split("-")[2],
    });
    expect(logFields).toEqual(traceIds);

    await withOtelSpan("selfhost.queue.job", { "job.type": "github-webhook" }, () => undefined, { parentTraceParent: traceParent });
    await withOtelSpan("invalid-parent", undefined, () => undefined, { parentTraceParent: "not-a-traceparent" });
    await flushOpenTelemetry();

    const root = otelMocks.exportedSpans.find((span) => span.name === "selfhost.http.request");
    const child = otelMocks.exportedSpans.find((span) => span.name === "selfhost.queue.job");
    const invalid = otelMocks.exportedSpans.find((span) => span.name === "invalid-parent");
    expect(root.attributes).toMatchObject({ "http.response.status_code": 202 });
    expect(root.attributes.secretHeader).toBeUndefined();
    expect(child.parentSpanContext.spanId).toBe(root.spanContext().spanId);
    expect(invalid.parentSpanContext).toBeUndefined();
  });

  it("builds low-cardinality self-host HTTP span attributes", () => {
    expect(
      selfHostHttpRequestAttributes(
        new Request("https://self.example/v1/github/webhook", {
          method: "POST",
          headers: { "x-github-event": "pull_request" },
        }),
      ),
    ).toEqual({
      "http.request.method": "POST",
      "http.route": "/v1/github/webhook",
      "github.webhook.event": "pull_request",
      "selfhost.webhook.transport": "github",
    });
    expect(
      selfHostHttpRequestAttributes(
        new Request("https://self.example/v1/orb/relay", {
          method: "POST",
          headers: { "x-github-event": "check_run" },
        }),
      ),
    ).toMatchObject({
      "http.route": "/v1/orb/relay",
      "github.webhook.event": "check_run",
      "selfhost.webhook.transport": "orb-relay",
    });
    expect(
      selfHostHttpRequestAttributes(
        new Request("https://self.example/v1/orb/webhook", {
          method: "POST",
          headers: { "x-github-event": "installation" },
        }),
      ),
    ).toMatchObject({
      "http.route": "/v1/orb/webhook",
      "github.webhook.event": "installation",
      "selfhost.webhook.transport": "orb",
    });
    expect(
      selfHostHttpRequestAttributes(
        new Request("https://self.example/v1/github/webhook", {
          method: "POST",
          headers: { "x-github-event": "attacker_unique_event_1" },
        }),
      ),
    ).toEqual({
      "http.request.method": "POST",
      "http.route": "/v1/github/webhook",
      "selfhost.webhook.transport": "github",
    });
    expect(
      selfHostHttpRequestAttributes(
        new Request("https://self.example/v1/repos/acme/widgets", {
          headers: { "x-github-event": "pull_request" },
        }),
      ),
    ).toEqual({
      "http.request.method": "GET",
      "http.route": "/v1/*",
    });
    expect(selfHostHttpRequestAttributes(new Request("https://self.example/v1/internal/jobs/refresh-registry"))).toMatchObject({
      "http.route": "/v1/internal/*",
    });
    expect(selfHostHttpRequestAttributes(new Request("https://self.example/v1/repos/acme/widgets"))).toMatchObject({
      "http.route": "/v1/*",
    });
    expect(selfHostHttpRequestAttributes(new Request("https://self.example/favicon.ico"))).toMatchObject({
      "http.route": "other",
    });
    expect(selfHostHttpResponseAttributes(204)).toEqual({
      "http.response.status_code": 204,
      "http.response.status_class": "2xx",
    });
  });

  it("stores request trace context only for the exact Request object", () => {
    const request = new Request("https://self.example/v1/github/webhook");
    const other = new Request("https://self.example/v1/github/webhook");
    setSelfHostRequestTraceParent(request, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    expect(getSelfHostRequestTraceParent(request)).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    expect(getSelfHostRequestTraceParent(other)).toBeUndefined();
    setSelfHostRequestTraceParent(request, undefined);
    expect(getSelfHostRequestTraceParent(request)).toBeUndefined();
    setSelfHostRequestTraceParent(request, "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01");
    clearSelfHostRequestTraceParent(request);
    expect(getSelfHostRequestTraceParent(request)).toBeUndefined();
  });

  it("uses safe defaults and captures non-Error failures", async () => {
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      SENTRY_RELEASE: "custom-release",
    }));
    await expect(withOtelSpan("plain-failure", undefined, async () => {
      throw "plain boom";
    })).rejects.toBe("plain boom");
    await flushOpenTelemetry();
    const span = otelMocks.exportedSpans.find((entry) => entry.name === "plain-failure");
    expect(span.status.message).toBe("plain boom");
    expect(span.resource.attributes).toMatchObject({
      "service.name": "gittensory-selfhost",
      "service.version": "custom-release",
      "deployment.environment.name": "selfhost",
    });
  });

  it("honors sampler choices without exporting when roots are sampled off", async () => {
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "always_off",
    }));
    await withOtelSpan("always-off", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans).toEqual([]);

    await resetOpenTelemetryForTest();
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "parentbased_always_off",
    }));
    await withOtelSpan("parentbased-off", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans).toEqual([]);

    await resetOpenTelemetryForTest();
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "not-a-number",
    }));
    await withOtelSpan("ratio-defaults-on", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans.map((span) => span.name)).toContain("ratio-defaults-on");
  });

  it("can export custom spans through a Sentry bridge without requiring OTLP export", async () => {
    const sentryEndedSpans: any[] = [];
    const sentryProcessor = {
      onStart: vi.fn(),
      onEnd: vi.fn((span: unknown) => sentryEndedSpans.push(span)),
      forceFlush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const validate = vi.fn();
    const propagator = {
      inject: vi.fn(),
      extract: vi.fn((context) => context),
      fields: vi.fn(() => []),
    };
    let contextManager: any;
    contextManager = {
      active: vi.fn(() => ROOT_CONTEXT),
      with: vi.fn((context, fn, thisArg, ...args) => fn.apply(thisArg, args)),
      bind: vi.fn((_context, target) => target),
      enable: vi.fn(() => contextManager),
      disable: vi.fn(() => contextManager),
    };

    expect(await initOpenTelemetry(env({}), {
      spanProcessor: sentryProcessor,
      propagator,
      contextManager,
      validate,
    })).toBe(true);
    await withOtelSpan("selfhost.review.gate", { "gittensory.operation": "gate_decision" }, () => undefined);
    await flushOpenTelemetry();

    expect(otelMocks.OTLPTraceExporter).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(contextManager.enable).toHaveBeenCalledTimes(1);
    expect(sentryProcessor.onEnd).toHaveBeenCalledTimes(1);
    expect(sentryEndedSpans[0].name).toBe("selfhost.review.gate");
    expect(sentryEndedSpans[0].attributes).toMatchObject({
      "gittensory.operation": "gate_decision",
    });

    await resetOpenTelemetryForTest();

    expect(await initOpenTelemetry(env({}), { spanProcessor: sentryProcessor, propagator })).toBe(true);
    await resetOpenTelemetryForTest();

    expect(await initOpenTelemetry(env({}), { spanProcessor: sentryProcessor, contextManager })).toBe(true);
    expect(contextManager.enable).toHaveBeenCalledTimes(2);

    await resetOpenTelemetryForTest();
    otelMocks.exportedSpans.length = 0;

    expect(await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "always_on",
    }), { propagator, contextManager })).toBe(true);
    await withOtelSpan("otlp-only-with-sentry-context", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans.map((span) => span.name)).toContain("otlp-only-with-sentry-context");
    expect(contextManager.enable).toHaveBeenCalledTimes(3);

    await resetOpenTelemetryForTest();
    otelMocks.exportedSpans.length = 0;
    sentryEndedSpans.length = 0;
    sentryProcessor.onStart.mockClear();
    sentryProcessor.onEnd.mockClear();
    sentryProcessor.forceFlush.mockClear();
    sentryProcessor.shutdown.mockClear();

    expect(await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "always_on",
    }), {
      spanProcessor: sentryProcessor,
      propagator,
      contextManager,
    })).toBe(true);
    await withOtelSpan("otlp-and-sentry-no-sampler", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans.map((span) => span.name)).toContain("otlp-and-sentry-no-sampler");
    expect(sentryEndedSpans.map((span) => span.name)).toContain("otlp-and-sentry-no-sampler");
    expect(sentryProcessor.forceFlush).toHaveBeenCalledTimes(1);
    expect(contextManager.enable).toHaveBeenCalledTimes(4);

    await resetOpenTelemetryForTest();
    otelMocks.exportedSpans.length = 0;
    sentryEndedSpans.length = 0;
    sentryProcessor.onStart.mockClear();
    sentryProcessor.onEnd.mockClear();
    sentryProcessor.forceFlush.mockClear();
    sentryProcessor.shutdown.mockClear();
    const dropAllBridgeSampler = {
      shouldSample: vi.fn((..._args: any[]) => ({ decision: 0 })),
      toString: () => "drop-all-bridge-sampler",
    };

    expect(await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "always_on",
    }), {
      sampler: dropAllBridgeSampler as any,
      spanProcessor: sentryProcessor,
      propagator,
      contextManager,
    })).toBe(true);
    await withOtelSpan("otlp-keeps-env-sampler", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans.map((span) => span.name)).toContain("otlp-keeps-env-sampler");
    expect(dropAllBridgeSampler.shouldSample).toHaveBeenCalledTimes(1);
    expect(dropAllBridgeSampler.shouldSample.mock.calls[0]?.[2]).toBe("otlp-keeps-env-sampler");
    expect(sentryProcessor.onStart).not.toHaveBeenCalled();
    expect(sentryProcessor.onEnd).not.toHaveBeenCalled();
    expect(sentryProcessor.forceFlush).toHaveBeenCalledTimes(1);
    expect(contextManager.enable).toHaveBeenCalledTimes(5);

    await resetOpenTelemetryForTest();
    otelMocks.exportedSpans.length = 0;
    sentryEndedSpans.length = 0;
    sentryProcessor.onStart.mockClear();
    sentryProcessor.onEnd.mockClear();
    sentryProcessor.forceFlush.mockClear();
    sentryProcessor.shutdown.mockClear();
    const sampleBridgeSampler = {
      shouldSample: vi.fn((..._args: any[]) => ({ decision: 2 })),
      toString: () => "sample-bridge-sampler",
    };

    expect(await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "always_on",
    }), {
      sampler: sampleBridgeSampler as any,
      spanProcessor: sentryProcessor,
      propagator,
      contextManager,
    })).toBe(true);
    await withOtelSpan("otlp-and-sentry-sampled", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans.map((span) => span.name)).toContain("otlp-and-sentry-sampled");
    expect(sampleBridgeSampler.shouldSample).toHaveBeenCalledTimes(1);
    expect(sentryProcessor.onStart).toHaveBeenCalledTimes(1);
    expect(sentryEndedSpans.map((span) => span.name)).toContain("otlp-and-sentry-sampled");
    expect(sentryProcessor.forceFlush).toHaveBeenCalledTimes(1);
    expect(contextManager.enable).toHaveBeenCalledTimes(6);

    await resetOpenTelemetryForTest();
    otelMocks.exportedSpans.length = 0;
    sentryEndedSpans.length = 0;
    sentryProcessor.onStart.mockClear();
    sentryProcessor.onEnd.mockClear();
    sentryProcessor.forceFlush.mockClear();
    sentryProcessor.shutdown.mockClear();
    const sampleSentryWhenOtelDropsSampler = {
      shouldSample: vi.fn((..._args: any[]) => ({ decision: 2 })),
      toString: () => "sample-sentry-when-otel-drops",
    };

    expect(await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "always_off",
    }), {
      sampler: sampleSentryWhenOtelDropsSampler as any,
      spanProcessor: sentryProcessor,
      propagator,
      contextManager,
    })).toBe(true);
    await withOtelSpan("sentry-keeps-span-when-otel-drops", undefined, () => undefined);
    await flushOpenTelemetry();
    expect(otelMocks.exportedSpans.map((span) => span.name)).not.toContain("sentry-keeps-span-when-otel-drops");
    expect(sampleSentryWhenOtelDropsSampler.shouldSample).toHaveBeenCalledTimes(1);
    expect(sentryProcessor.onStart).toHaveBeenCalledTimes(1);
    expect(sentryEndedSpans.map((span) => span.name)).toContain("sentry-keeps-span-when-otel-drops");
    expect(sentryProcessor.forceFlush).toHaveBeenCalledTimes(1);
    expect(contextManager.enable).toHaveBeenCalledTimes(7);
  });

  it("keeps parent-based OTLP sampling isolated when Sentry samples nested spans", async () => {
    const sentryEndedSpans: any[] = [];
    const sentryProcessor = {
      onStart: vi.fn(),
      onEnd: vi.fn((span: unknown) => sentryEndedSpans.push(span)),
      forceFlush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const sampleSentrySampler = {
      shouldSample: vi.fn((..._args: any[]) => ({ decision: 2 })),
      toString: () => "sample-sentry",
    };

    expect(await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_TRACES_SAMPLER: "parentbased_always_off",
    }), {
      sampler: sampleSentrySampler as any,
      spanProcessor: sentryProcessor,
    })).toBe(true);
    await withOtelSpan("sentry-only-parent", undefined, async () => {
      await withOtelSpan("sentry-only-child", undefined, () => undefined);
    });
    await withOtelSpan(
      "remote-parent-not-sampled",
      undefined,
      () => undefined,
      { parentTraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00" },
    );
    await flushOpenTelemetry();

    expect(otelMocks.exportedSpans.map((span) => span.name)).toEqual([]);
    expect(sentryEndedSpans.map((span) => span.name)).toEqual([
      "sentry-only-child",
      "sentry-only-parent",
      "remote-parent-not-sampled",
    ]);
    expect(sampleSentrySampler.shouldSample).toHaveBeenCalledTimes(3);
    expect(sentryProcessor.onStart).toHaveBeenCalledTimes(3);
    expect(sentryProcessor.forceFlush).toHaveBeenCalledTimes(1);
  });

  it("adds hashed tenant and decision attributes to review pipeline spans", async () => {
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
    }));

    expect(await hashedInstallationId(143010787)).toBe("68b9c2136087c5ca");
    expect(await hashedInstallationId(" 143010787 ")).toBe("68b9c2136087c5ca");
    expect(await hashedInstallationId("not-an-id")).toBeUndefined();
    expect(await hashedInstallationId(Number.NaN)).toBeUndefined();
    expect(hashedInstallationIdWith(143010787, () => "a".repeat(64))).toBe("aaaaaaaaaaaaaaaa");
    expect(hashedInstallationIdWith(" ", () => "a".repeat(64))).toBeUndefined();
    expect(hashedInstallationIdWith(null, () => "a".repeat(64))).toBeUndefined();
    await withReviewPipelineSpan(
      "selfhost.review.gate",
      {
        installationId: 143010787,
        repoFullName: "JSONbored/gittensory",
        pullNumber: 1001,
        operation: "gate_decision",
        agent: "dual-ai",
      },
      async () => {
        await setReviewPipelineSpanOutcome({ decisionOutcome: "success" });
      },
    );
    await flushOpenTelemetry();

    const span = otelMocks.exportedSpans.find((entry) => entry.name === "selfhost.review.gate");
    expect(span.attributes).toMatchObject({
      "github.repository": "JSONbored/gittensory",
      "github.pull_request.number": 1001,
      "github.installation_id_hash": "68b9c2136087c5ca",
      "gittensory.operation": "gate_decision",
      "gittensory.agent": "dual-ai",
      "gittensory.decision_outcome": "success",
    });
    await expect(reviewTraceAttributes({})).resolves.toEqual({});
  });

  it("swallows exporter flush and shutdown failures", async () => {
    await initOpenTelemetry(env({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
    }));
    otelMocks.exporterInstances[0].forceFlush.mockRejectedValueOnce(new Error("flush down"));
    await expect(flushOpenTelemetry()).resolves.toBeUndefined();
    otelMocks.exporterInstances[0].shutdown.mockRejectedValueOnce(new Error("shutdown down"));
    await expect(resetOpenTelemetryForTest()).resolves.toBeUndefined();
  });

  it("keeps only primitive, finite, non-secret attributes", () => {
    expect(
      otelSafeAttributes({
        repo: "JSONbored/gittensory",
        count: 1,
        ok: false,
        authHeader: "Bearer nope",
        missing: undefined,
        nil: null,
        nan: Number.NaN,
        obj: { x: 1 },
      }),
    ).toEqual({ repo: "JSONbored/gittensory", count: 1, ok: false });
  });
});
