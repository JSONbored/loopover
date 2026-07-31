// Hosted ORB Worker PostHog error tracking (#8288, epic #8286). REPLACES the old @sentry/hono/cloudflare
// middleware entirely (2026-07-25 epic correction: full replacement, not a parallel-run) -- same treatment
// as #8287's self-host swap.
//
// Uses posthog-node's own documented captureException(), NOT a hand-built $exception payload. #8288 originally
// scoped this as a raw-HTTP capture (mirroring JSONbored/metagraphed#7777's usage-telemetry.ts, which really
// does avoid posthog-node entirely for bundle-size reasons) -- corrected after checking PostHog's own docs:
// they explicitly warn a hand-constructed $exception event "fails in the vast majority of cases because the
// exception event schema is strict", and PostHog's own Cloudflare Workers guide recommends installing
// posthog-node itself with flushAt:1/flushInterval:0 for exactly this edge lifecycle. This Worker already
// bundles posthog-node for src/mcp/telemetry.ts's MCP usage events (#6235), so reusing it here costs nothing
// new in the bundle either -- unlike metagraphed's situation, which the original scoping was based on.
//
// Ephemeral-client-per-call, mirroring src/mcp/telemetry.ts's identical choice for the identical reason: a
// Workers isolate can be torn down between requests, so there's no safe place to hold a long-lived batching
// client the way self-host's posthog.ts does. flushAt:1/flushInterval:0 sends immediately; the caller still
// awaits client.flush() before the returned promise resolves, so scheduling it via ctx.waitUntil (not an
// inline await) keeps a slow flush from delaying the actual HTTP response.
import type { Context } from "hono";
import { loadNodeHasher, scrubRecord, scrubString } from "../selfhost/redaction-scrub";

type PostHogNs = typeof import("posthog-node");
type PostHogClient = InstanceType<PostHogNs["PostHog"]>;
type PostHogEventMessage = import("posthog-node").EventMessage;

/** PostHog US-cloud ingestion host, matching src/mcp/telemetry.ts's and src/selfhost/posthog.ts's default. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** No per-user identity is tracked (operational error events, not user analytics) -- every event shares one
 *  anonymous, constant distinct id, mirroring src/selfhost/posthog.ts's POSTHOG_DISTINCT_ID choice. */
const WORKER_ERROR_DISTINCT_ID = "loopover-worker";

let hasherLoaded = false;

/** The env slice this module reads. Deliberately NAMED DIFFERENTLY from the dual-purpose POSTHOG_API_KEY/
 *  POSTHOG_HOST (MCP telemetry #6228/#6235 + self-host error tracking #8287): this Worker's fetch handler is
 *  the SAME one self-host's server.ts calls by synthesizing a Worker-shaped env from process.env, so reusing
 *  POSTHOG_API_KEY here would silently activate Worker-path exception capture inside a self-hoster's own Node
 *  process the moment they set POSTHOG_API_KEY for #8287's self-host sink -- an unrelated, unintended
 *  cross-wire. A second, independent reason: keeping this separate from POSTHOG_API_KEY also lets an operator
 *  toggle Worker-level exception capture without touching MCP tool-call telemetry, or vice versa. Opt-in: a
 *  complete no-op until BOTH isCloudflareWorkerRuntime() AND this is set. Inject as a wrangler secret. */
export type WorkerPostHogEnv = Pick<Env, "WORKER_POSTHOG_API_KEY" | "WORKER_POSTHOG_HOST" | "WORKER_POSTHOG_ENVIRONMENT">;

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** True when this deployment has a non-empty WORKER_POSTHOG_API_KEY configured. Callers still also gate on
 *  isCloudflareWorkerRuntime() -- this function alone doesn't imply the Worker-isolate check. */
export function isWorkerPostHogConfigured(env: WorkerPostHogEnv): boolean {
  return trimmedOrUndefined(env.WORKER_POSTHOG_API_KEY) !== undefined;
}

/** before_send scrubber -- redact anything token/secret-like before an event leaves the box, applied to every
 *  outgoing event including the ones captureException() builds internally (exception message/stacktrace can
 *  legitimately contain an interpolated secret from an upstream error string). Reuses the exact same pure
 *  primitives src/selfhost/posthog.ts's scrubPostHogEvent does -- one security-critical scrub implementation. */
export function scrubWorkerPostHogEvent(event: PostHogEventMessage | null): PostHogEventMessage | null {
  if (!event) return event;
  try {
    if (event.properties) scrubRecord(event.properties, 0);
    if (typeof event.event === "string") event.event = scrubString(event.event);
  } catch {
    return null;
  }
  return event;
}

/** Build a fresh, ephemeral PostHog client for one capture call. Returns undefined when unconfigured. */
async function buildClient(env: WorkerPostHogEnv): Promise<PostHogClient | undefined> {
  const apiKey = trimmedOrUndefined(env.WORKER_POSTHOG_API_KEY);
  if (!apiKey) return undefined;
  if (!hasherLoaded) {
    hasherLoaded = true;
    await loadNodeHasher();
  }
  const { PostHog } = await import("posthog-node");
  const host = trimmedOrUndefined(env.WORKER_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST;
  return new PostHog(apiKey, {
    host,
    // Required for an edge/per-request lifecycle (PostHog's own Cloudflare Workers guidance): batched data is
    // sent asynchronously and the isolate can be torn down before it lands, causing silent event loss.
    flushAt: 1,
    flushInterval: 0,
    before_send: scrubWorkerPostHogEvent,
  });
}

/** The allowlisted request context attached to a captured error -- deliberately NOT the raw Hono Context or
 *  request object (which could carry headers/cookies/bodies), matching #8288's "typed-allowlist" redaction
 *  option: only these two scalars are ever read off the request. */
export interface WorkerErrorRequestContext {
  path: string;
  method: string;
}

/** Capture one exception from the hosted Worker path. Never throws -- a PostHog init/capture/flush failure
 *  degrades to recording nothing, matching every other capture* function in this codebase's identical
 *  best-effort guarantee. Resolves once the event has actually been flushed (or given up on), so the caller
 *  should schedule this via ctx.waitUntil rather than await it inline on the request's hot path.
 *
 *  `extraProperties` lets a non-HTTP caller (the MCP dispatch sink, #10037) attach its own grouping
 *  properties (e.g. `mcp_tool`/`error_code`) alongside the fixed `environment`/`request_path`/
 *  `request_method` shape -- scrubbed the same way those are, then merged in. Omitting it leaves
 *  `createWorkerPostHogErrorMiddleware`'s HTTP callers unaffected. */
export async function capturePostHogWorkerError(
  env: WorkerPostHogEnv,
  error: unknown,
  context: WorkerErrorRequestContext,
  extraProperties?: Record<string, unknown>,
): Promise<void> {
  try {
    const client = await buildClient(env);
    if (!client) return;
    const err = error instanceof Error ? error : new Error(String(error));
    const scrubbedExtra = extraProperties ? { ...extraProperties } : undefined;
    if (scrubbedExtra) scrubRecord(scrubbedExtra, 0);
    client.captureException(err, WORKER_ERROR_DISTINCT_ID, {
      environment: trimmedOrUndefined(env.WORKER_POSTHOG_ENVIRONMENT) ?? "production",
      request_path: scrubString(context.path),
      request_method: context.method,
      ...scrubbedExtra,
    });
    await client.flush();
  } catch {
    // Best-effort: telemetry must never surface into the actual request path.
  }
}

/** Resolve the real Workers ExecutionContext off a Hono Context, falling back to a no-op when it isn't
 *  available (self-host's server.ts calls this same Worker's fetch handler outside a real Workers isolate --
 *  see isCloudflareWorkerRuntime's doc comment -- so c.executionCtx can throw there). Mirrors
 *  src/mcp/server.ts's getExecutionContext exactly; kept local since it's an 8-line guard, not shared state. */
function resolveExecutionCtx(c: Context): ExecutionContext<unknown> {
  try {
    return c.executionCtx as unknown as ExecutionContext<unknown>;
  } catch {
    return { waitUntil: () => {}, passThroughOnException: () => {}, exports: {}, props: {} } as unknown as ExecutionContext<unknown>;
  }
}

/** Hono middleware: after any downstream middleware/handler runs, checks `c.error` and schedules a PostHog
 *  capture via waitUntil when it's set -- mirrors Hono's own documented pattern
 *  (https://hono.dev/docs/api/context#error), NOT a try/catch around next(). This app has no app.onError(), but
 *  Hono's Hono class always installs its OWN default errorHandler internally (hono-base.js) regardless -- every
 *  compose() dispatch level catches a thrown error at the exact index it occurred, hands it to that default
 *  handler (which logs it and finalizes a 500 Response), sets context.error, and returns normally. A plain
 *  try/catch around next() here would NEVER see the exception, because it's already been caught and converted
 *  to a response several dispatch levels below by the time next() resolves. A no-op wrapper (zero overhead
 *  beyond the check) when WORKER_POSTHOG_API_KEY is unset.
 *
 *  Scope note: this captures errors that propagate through the Hono middleware/handler chain specifically, not
 *  every possible Workers-runtime failure mode (e.g. a crash reachable only via the raw fetch() export outside
 *  Hono's dispatch). Sentry's old middleware additionally patched the Worker's fetch export via
 *  @sentry/cloudflare's withSentry for that broader case -- this codebase has no PostHog equivalent, since every
 *  real route in this app is dispatched through Hono anyway. */
export function createWorkerPostHogErrorMiddleware() {
  return async (c: Context<{ Bindings: WorkerPostHogEnv }>, next: () => Promise<void>): Promise<void> => {
    if (!isWorkerPostHogConfigured(c.env)) {
      await next();
      return;
    }
    await next();
    if (c.error) {
      resolveExecutionCtx(c).waitUntil(capturePostHogWorkerError(c.env, c.error, { path: c.req.path, method: c.req.method }));
    }
  };
}
