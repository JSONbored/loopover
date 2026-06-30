import { beforeEach, describe, expect, it, vi } from "vitest";

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
  currentOtelTraceParent,
  flushOpenTelemetry,
  initOpenTelemetry,
  otelSafeAttributes,
  resetOpenTelemetryForTest,
  resolveOtelTraceEndpoint,
  selfHostHttpRequestAttributes,
  selfHostHttpResponseAttributes,
  setCurrentOtelSpanAttributes,
  withOtelSpan,
} from "../../src/selfhost/otel";
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
    expect(await initOpenTelemetry(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" }))).toBe(false);
    await flushOpenTelemetry();
    await expect(withOtelSpan("off", { "job.type": "x" }, () => 42)).resolves.toBe(42);
    expect(currentOtelTraceParent()).toBeUndefined();
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
          GITTENSORY_VERSION: "gittensory-selfhost@test",
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
    setCurrentOtelSpanAttributes({ ignored: true });
    let traceParent: string | undefined;
    await withOtelSpan("selfhost.http.request", undefined, () => {
      traceParent = currentOtelTraceParent();
      setCurrentOtelSpanAttributes({
        "http.response.status_code": 202,
        secretHeader: "drop",
      });
    });
    expect(traceParent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

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
      "selfhost.webhook.transport": "orb",
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
