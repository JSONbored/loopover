import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes, Context, Tracer } from "@opentelemetry/api";

type OtelApi = typeof import("@opentelemetry/api");
type OtelSdk = typeof import("@opentelemetry/sdk-trace-node");
type OtelProvider = {
  getTracer(name: string): Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};
type SpanOptions = { parentTraceParent?: string | undefined };
export type OtelTraceIds = { trace_id: string; span_id: string };
export type OtelTraceLogFields = { trace_id: string; span_id?: string };

let Otel: OtelApi | undefined;
let provider: OtelProvider | undefined;
let tracer: Tracer | undefined;
let active = false;

const contextStore = new AsyncLocalStorage<Context>();
const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)/i;
const MAX_ATTRIBUTE_LENGTH = 160;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function traceExporterEnabled(env: NodeJS.ProcessEnv): boolean {
  const exporters = nonBlank(env.OTEL_TRACES_EXPORTER);
  return exporters?.split(",").map((part) => part.trim().toLowerCase()).includes("otlp") === true;
}

export function resolveOtelTraceEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = nonBlank(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  if (explicit) return explicit;
  const base = nonBlank(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!base) return undefined;
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

function serviceAttributes(env: NodeJS.ProcessEnv): Attributes {
  const attrs: Attributes = {
    "service.name": nonBlank(env.OTEL_SERVICE_NAME) ?? "gittensory-selfhost",
    "deployment.environment.name": nonBlank(env.OTEL_SERVICE_ENVIRONMENT) ?? nonBlank(env.SENTRY_ENVIRONMENT) ?? "selfhost",
  };
  const version = nonBlank(env.GITTENSORY_VERSION) ?? nonBlank(env.SENTRY_RELEASE);
  if (version) attrs["service.version"] = version;
  return attrs;
}

function ratioFromEnv(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(1, parsed));
}

function samplerFromEnv(env: NodeJS.ProcessEnv, sdk: OtelSdk) {
  const sampler = (env.OTEL_TRACES_SAMPLER ?? "parentbased_always_on").trim().toLowerCase();
  if (sampler === "always_off") return new sdk.AlwaysOffSampler();
  if (sampler === "traceidratio") return new sdk.TraceIdRatioBasedSampler(ratioFromEnv(env.OTEL_TRACES_SAMPLER_ARG));
  if (sampler === "parentbased_always_off") return new sdk.ParentBasedSampler({ root: new sdk.AlwaysOffSampler() });
  if (sampler === "parentbased_traceidratio")
    return new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(ratioFromEnv(env.OTEL_TRACES_SAMPLER_ARG)) });
  return new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() });
}

export function otelSafeAttributes(input: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key) || value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value.length > MAX_ATTRIBUTE_LENGTH ? `${value.slice(0, MAX_ATTRIBUTE_LENGTH - 3)}...` : value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

const SELFHOST_STATIC_ROUTES = new Set([
  "/mcp",
  "/v1/github/webhook",
  "/v1/orb/relay",
  "/v1/orb/relay/pull",
  "/v1/orb/webhook",
]);

function selfHostHttpRoute(path: string): string {
  if (SELFHOST_STATIC_ROUTES.has(path)) return path;
  if (path.startsWith("/v1/internal/")) return "/v1/internal/*";
  return path.startsWith("/v1/") ? "/v1/*" : "other";
}

export function selfHostHttpRequestAttributes(request: Request, path = new URL(request.url).pathname): Record<string, unknown> {
  const route = selfHostHttpRoute(path);
  const attrs: Record<string, unknown> = {
    "http.request.method": request.method,
    "http.route": route,
  };
  const eventName = request.headers.get("x-github-event")?.trim();
  if (eventName && (route === "/v1/github/webhook" || route === "/v1/orb/relay" || route === "/v1/orb/webhook"))
    attrs["github.webhook.event"] = eventName;
  if (route === "/v1/github/webhook") attrs["selfhost.webhook.transport"] = "github";
  else if (route === "/v1/orb/relay") attrs["selfhost.webhook.transport"] = "orb-relay";
  else if (route === "/v1/orb/webhook") attrs["selfhost.webhook.transport"] = "orb";
  return attrs;
}

export function selfHostHttpResponseAttributes(status: number): Record<string, unknown> {
  return {
    "http.response.status_code": status,
    "http.response.status_class": `${Math.floor(status / 100)}xx`,
  };
}

/** Initialize self-host OTEL traces. No global provider registration: Sentry can coexist when both are enabled. */
export async function initOpenTelemetry(env: NodeJS.ProcessEnv): Promise<boolean> {
  const endpoint = resolveOtelTraceEndpoint(env);
  if (!endpoint || !traceExporterEnabled(env)) return false;
  if (active) return true;
  const [api, sdk, exporterNs, resources] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const exporter = new exporterNs.OTLPTraceExporter({ url: endpoint });
  provider = new sdk.NodeTracerProvider({
    resource: resources.resourceFromAttributes(serviceAttributes(env)),
    sampler: samplerFromEnv(env, sdk),
    spanProcessors: [new sdk.BatchSpanProcessor(exporter)],
  });
  Otel = api;
  tracer = provider.getTracer("gittensory-selfhost");
  active = true;
  return true;
}

function exceptionFor(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function statusMessage(error: unknown): string {
  return exceptionFor(error).message.slice(0, MAX_ATTRIBUTE_LENGTH);
}

function parseTraceParent(traceParent: string | undefined): { traceId: string; spanId: string; traceFlags: number } | undefined {
  if (!traceParent) return undefined;
  const match = TRACEPARENT_RE.exec(traceParent.trim());
  if (!match) return undefined;
  return {
    traceId: match[1]!.toLowerCase(),
    spanId: match[2]!.toLowerCase(),
    traceFlags: Number.parseInt(match[3]!, 16) & 1,
  };
}

function activeContextFromTraceParent(api: OtelApi, traceParent: string | undefined): Context | undefined {
  const parsed = parseTraceParent(traceParent);
  if (!parsed) return undefined;
  return api.trace.setSpanContext(api.context.active(), {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.traceFlags,
    isRemote: true,
  });
}

function currentOtelSpanContext() {
  if (!active || !Otel) return undefined;
  return Otel.trace.getSpanContext(contextStore.getStore() ?? Otel.context.active());
}

export function currentOtelTraceParent(): string | undefined {
  const spanContext = currentOtelSpanContext();
  if (!spanContext) return undefined;
  const flags = (spanContext.traceFlags & 1).toString(16).padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

export function currentOtelTraceIds(): OtelTraceIds | undefined {
  const spanContext = currentOtelSpanContext();
  if (!spanContext) return undefined;
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

export function otelTraceLogFields(fallbackTraceParent?: string): OtelTraceLogFields | undefined {
  const activeTrace = currentOtelTraceIds();
  if (activeTrace) return activeTrace;
  const fallback = parseTraceParent(fallbackTraceParent);
  return fallback ? { trace_id: fallback.traceId } : undefined;
}

export function setCurrentOtelSpanAttributes(attributes: Record<string, unknown>): void {
  if (!active || !Otel) return;
  const span = Otel.trace.getSpan(contextStore.getStore() ?? Otel.context.active());
  span?.setAttributes(otelSafeAttributes(attributes));
}

export async function withOtelSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  if (!active || !Otel || !tracer) return await fn();
  const parentContext = activeContextFromTraceParent(Otel, options?.parentTraceParent) ?? contextStore.getStore() ?? Otel.context.active();
  const span = tracer.startSpan(name, { attributes: otelSafeAttributes(attributes) }, parentContext);
  const childContext = Otel.trace.setSpan(parentContext, span);
  return await contextStore.run(childContext, async () => {
    try {
      const result = await fn();
      span.setStatus({ code: Otel!.SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(exceptionFor(error));
      span.setStatus({ code: Otel!.SpanStatusCode.ERROR, message: statusMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function flushOpenTelemetry(): Promise<void> {
  if (!active || !provider) return;
  /* v8 ignore next -- NodeTracerProvider may absorb exporter forceFlush failures before this best-effort guard. */
  await provider.forceFlush().catch(() => undefined);
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const current = provider;
  provider = undefined;
  tracer = undefined;
  Otel = undefined;
  active = false;
  await current?.shutdown().catch(() => undefined);
}

/** Test-only: reset module state between cases. */
export async function resetOpenTelemetryForTest(): Promise<void> {
  await shutdownOpenTelemetry();
}
