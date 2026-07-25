// Self-host PostHog error tracking (#1468, epic #8286). Opt-in: a complete NO-OP unless POSTHOG_API_KEY is
// set. posthog-node is dynamically imported inside initPostHog() so it never enters the Worker bundle when
// unconfigured.
//
// REPLACES Sentry entirely (2026-07-25 epic correction on #8286: full replacement, not a parallel-run --
// src/selfhost/sentry.ts, @sentry/node, and @sentry/opentelemetry are gone from this surface). This file was
// originally built as a parallel sink alongside sentry.ts (#8287); its shape reflects that heritage (mirrors
// what sentry.ts used to do, field for field) even though sentry.ts itself no longer exists.
//
// Reuses the pure redaction primitives originally extracted out of sentry.ts into ./redaction-scrub (#8287) --
// PostHog's event shape (event name + a flat `properties` bag) is materially simpler than Sentry's own
// request/contexts/extra/tags/breadcrumbs/exception shape was, so this file's own orchestrator
// (scrubPostHogEvent) stays a straightforward single-bag walk.
//
// Env-var decision (#8287's own deliverable): POSTHOG_API_KEY/POSTHOG_HOST are the SAME vars #6235's MCP
// telemetry (src/mcp/telemetry.ts) already reads off the typed Cloudflare Env -- one project key activates
// both surfaces, the MCP tool-call allowlist (#6228) is untouched. Everything else here (POSTHOG_MIN_SEVERITY,
// POSTHOG_REPO_MIN_SEVERITY, POSTHOG_ENVIRONMENT, POSTHOG_SERVER_NAME, POSTHOG_RELEASE) is self-host-only,
// read off real process.env, never added to src/env.d.ts's typed Env, matching that file's precedent for
// self-host-exclusive config.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  currentOtelTraceIds,
} from "./otel";
import { meetsSeverityThreshold, resolveSeverityThreshold, type LoopoverSeverity } from "../services/severity-threshold";
import {
  hashedInstallationContext,
  loadNodeHasher,
  nonBlank,
  OPERATIONAL_TAG_KEYS,
  REDACTED,
  resetRedactionScrubForTest,
  scrubRecord,
  scrubString,
  SECRET_KEY,
} from "./redaction-scrub";

type PostHogNs = typeof import("posthog-node");
type PostHogClient = InstanceType<PostHogNs["PostHog"]>;
type PostHogEventMessage = import("posthog-node").EventMessage;

let client: PostHogClient | undefined;
let active = false;
let posthogEnvironment = "production";

/** No per-user identity is tracked by this sink (operational error events, not user analytics) -- every event
 *  shares one anonymous, constant distinct id, mirroring src/mcp/telemetry.ts's identical MCP_TELEMETRY_DISTINCT_ID
 *  choice for the same reason (#6228). */
const POSTHOG_DISTINCT_ID = "loopover-selfhost";

/** PostHog US-cloud ingestion host, matching src/mcp/telemetry.ts's default. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Resolve a self-host-only config var: process.env only (unlike POSTHOG_API_KEY/POSTHOG_HOST, these have no
 *  Worker/Env-typed counterpart -- mirrors sentry.ts's own SENTRY_* self-host var reads verbatim). */
function processEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return nonBlank(env[name]);
}

/** Resolve the PostHog release id: explicit override first, then the image-baked self-host version, matching
 *  {@link resolveSentryRelease}'s identical precedence in sentry.ts. */
export function resolvePostHogRelease(env: NodeJS.ProcessEnv): string | undefined {
  return nonBlank(env.POSTHOG_RELEASE) ?? nonBlank(env.LOOPOVER_VERSION);
}

/** The repo a capture's properties belong to, for per-repo severity-threshold lookup -- mirrors sentry.ts's
 *  contextRepoFullName's identical repo-over-repository normalization. */
function contextRepoFullName(properties: Record<string, unknown> | undefined): string {
  if (!properties) return "";
  const repo = typeof properties.repo === "string" ? properties.repo : typeof properties.repository === "string" ? properties.repository : undefined;
  return repo ?? "";
}

/** Resolve the minimum severity for `repoFullName`: POSTHOG_REPO_MIN_SEVERITY (a JSON `{repoFullName: severity}`
 *  map) wins, else the global POSTHOG_MIN_SEVERITY, else `"error"` -- the quietest safe default, matching the
 *  behavior every capture path below already had (error/fatal-only) before this resolver existed. */
function resolvePostHogMinSeverity(repoFullName: string): LoopoverSeverity {
  const processEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return resolveSeverityThreshold(processEnv as unknown as Env, repoFullName, "POSTHOG_MIN_SEVERITY", "POSTHOG_REPO_MIN_SEVERITY");
}

/** Map a structured log's own level onto the shared severity taxonomy, matching sentry.ts's
 *  normalizeLoopoverSeverity exactly (debug folds into info; an unrecognized word is treated as info, never
 *  promoted). */
function normalizePostHogSeverity(level: string): LoopoverSeverity {
  const lower = level.toLowerCase();
  if (lower === "critical" || lower === "fatal") return "critical";
  if (lower === "error") return "error";
  if (lower === "warning" || lower === "warn") return "warning";
  return "info";
}

/** before_send scrubber -- redact anything token/secret-like before an event leaves the box (privacy
 *  boundary), applied to every outgoing event including the ones captureException() builds internally.
 *  PostHog's event shape is just {event, properties, ...}, so unlike sentry.ts's scrubEvent this only needs to
 *  walk one bag, not five separately-shaped sub-objects. */
export function scrubPostHogEvent(event: PostHogEventMessage | null): PostHogEventMessage | null {
  if (!event) return event;
  try {
    if (event.properties) scrubRecord(event.properties, 0);
    if (typeof event.event === "string") event.event = scrubString(event.event);
  } catch {
    return null;
  }
  return event;
}

/** Build the properties bag for a captured error/log: hashes any installation id, then tags the shared
 *  operational key allowlist (./redaction-scrub's OPERATIONAL_TAG_KEYS) alongside whatever else the caller
 *  passed. */
function operationalProperties(context: Record<string, unknown> | undefined): Record<string, unknown> {
  const safeContext = context ? hashedInstallationContext(context) : {};
  const normalized: Record<string, unknown> =
    typeof safeContext.repository === "string" && safeContext.repo === undefined
      ? { ...safeContext, repo: safeContext.repository }
      : { ...safeContext };
  const properties: Record<string, unknown> = {};
  for (const key of OPERATIONAL_TAG_KEYS) {
    const value = normalized[key];
    if (typeof value === "string" || typeof value === "number") properties[key] = value;
  }
  const trace = currentOtelTraceIds();
  if (trace) {
    properties.trace_id = trace.trace_id;
    properties.span_id = trace.span_id;
  }
  return properties;
}

/** Initialize PostHog from the environment. Returns false (and stays a no-op) when POSTHOG_API_KEY is unset --
 *  the SAME var #6235's MCP telemetry reads (env-var decision, #8287). `env` is real process.env, matching
 *  initSentry's identical NodeJS.ProcessEnv shape. */
export async function initPostHog(env: NodeJS.ProcessEnv): Promise<boolean> {
  const apiKey = processEnvString(env, "POSTHOG_API_KEY");
  if (!apiKey) return false;
  await loadNodeHasher();
  const { PostHog } = await import("posthog-node");
  posthogEnvironment = processEnvString(env, "POSTHOG_ENVIRONMENT") ?? "production";
  const host = processEnvString(env, "POSTHOG_HOST") ?? DEFAULT_POSTHOG_HOST;
  client = new PostHog(apiKey, {
    host,
    // Long-running server, not a per-request/edge context (unlike src/mcp/telemetry.ts's ephemeral
    // per-call client) -- default batching/flush interval is the right posture here; flushPostHog() below
    // still exists for explicit drain-before-exit, and PostHog's own recommended client.shutdown() covers
    // graceful process shutdown.
    before_send: scrubPostHogEvent,
    // Matches Sentry's own Node SDK default posture (Sentry.init() installs global uncaughtException/
    // unhandledRejection handlers unless explicitly disabled) -- a safety net for genuinely-unhandled cases
    // beyond the explicit capturePostHogError/capturePostHogReviewFailure call sites below, per PostHog's
    // own documented recommendation for Node.js error tracking.
    enableExceptionAutocapture: true,
  });
  active = true;
  return true;
}

/** Name a captured Error before capture so its PostHog issue title reads "eventName: message" instead of the
 *  generic "Error: message", mirroring sentry.ts's namedCaptureError exactly (including its never-mutate-the-
 *  caught-value care for read-only `name` on some runtime errors like DOMException). */
function namedCaptureError(error: unknown, eventName?: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!eventName) return err;
  const namedError = new Error(err.message, { cause: err });
  namedError.name = eventName;
  Object.defineProperty(namedError, "stack", { value: err.stack, configurable: true, writable: true });
  return namedError;
}

/** Capture an error with optional structured context. No-op when PostHog is off OR the repo's resolved
 *  severity threshold is above `error`. Mirrors sentry.ts's captureError exactly, using PostHog's own
 *  documented captureException(error, distinctId, properties) instead of Sentry.withScope/captureException. */
export function capturePostHogError(error: unknown, context?: Record<string, unknown>, eventName?: string): void {
  if (!active || !client) return;
  if (!meetsSeverityThreshold("error", resolvePostHogMinSeverity(contextRepoFullName(context)))) return;
  const properties = operationalProperties(context);
  properties.server_name = nonBlank((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.POSTHOG_SERVER_NAME) ?? hostname();
  properties.environment = posthogEnvironment;
  client.captureException(namedCaptureError(error, eventName), POSTHOG_DISTINCT_ID, properties);
}

/** Capture a failed review at ERROR level, tagged by repo/PR/SHA for triage. Mirrors sentry.ts's
 *  captureReviewFailure exactly -- a review that cannot be produced is a real failure, always captured at
 *  error grade when the threshold allows it through at all. */
export function capturePostHogReviewFailure(error: unknown, context?: Record<string, unknown>, eventName?: string): void {
  if (!active || !client) return;
  if (!meetsSeverityThreshold("error", resolvePostHogMinSeverity(contextRepoFullName(context)))) return;
  const properties = operationalProperties(context);
  properties.kind = "review_failure";
  client.captureException(namedCaptureError(error, eventName), POSTHOG_DISTINCT_ID, properties);
}

/** A SHORT location suffix for a no-message log's summary, matching sentry.ts's logLocation exactly. */
function logLocation(obj: Record<string, unknown>): string {
  const repo = typeof obj.repository === "string" ? obj.repository : typeof obj.repo === "string" ? obj.repo : undefined;
  if (!repo) return "";
  const pr = obj.pullNumber;
  return typeof pr === "number" ? ` (${repo}#${pr})` : ` (${repo})`;
}

const SUMMARY_SKIP_KEYS = new Set([
  "level", "event", "ts", "time", "timestamp", "msg", "ev", "message", "error", "repo", "repository",
  "installationId", "installation_id", "installation_id_hash", "pullNumber", "deliveryId", "trace_id", "span_id",
]);

function redactSummaryValue(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactSummaryValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, SECRET_KEY.test(key) ? REDACTED : redactSummaryValue(nested, depth + 1)]),
  );
}

/** Summarize a field-only log's salient scalars into the captured value, matching sentry.ts's
 *  summarizeLogFields exactly. */
function summarizeLogFields(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([k, v]) => !SUMMARY_SKIP_KEYS.has(k) && !SECRET_KEY.test(k) && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(redactSummaryValue(v)) : String(v)}`)
    .filter((part) => part.length <= 90)
    .slice(0, 5)
    .join(", ");
}

/** Forward a structured console line to PostHog when its level meets the repo's resolved severity threshold,
 *  matching sentry.ts's forwardStructuredLogToSentry exactly (same error-sink-defaults-to-error-level
 *  behavior, same synthetic-exception construction so the captured event always has a real type+value). */
export function forwardStructuredLogToPostHog(line: unknown, fromErrorSink = false): void {
  if (!active || !client) return;
  if (typeof line !== "string" || line.charCodeAt(0) !== 123 /* "{" */) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const safeObj = hashedInstallationContext(obj);
  const explicitLevel = typeof obj.level === "string" ? obj.level : undefined;
  const level = explicitLevel ?? (fromErrorSink ? "error" : undefined);
  if (!level) return;
  const loopoverSeverity = normalizePostHogSeverity(level);
  if (!meetsSeverityThreshold(loopoverSeverity, resolvePostHogMinSeverity(contextRepoFullName(safeObj)))) return;
  const event = typeof obj.event === "string" ? obj.event : undefined;
  const subEvent = typeof obj.ev === "string" ? obj.ev : undefined;
  const detail = typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : undefined;
  const value = detail ?? ([logLocation(safeObj).trim(), summarizeLogFields(safeObj)].filter(Boolean).join(" ") || "(no message — see the log context)");
  const errorEvent = new Error(value);
  errorEvent.name = event ? (subEvent ? `${event}/${subEvent}` : event) : "LoopOverLog";
  errorEvent.stack = `${errorEvent.name}: ${value}`;
  const properties = operationalProperties(safeObj);
  properties.severity = loopoverSeverity;
  if (event) properties.event_slug = event;
  if (subEvent) properties.event_sub_slug = subEvent;
  client.captureException(errorEvent, POSTHOG_DISTINCT_ID, properties);
}

interface StructuredLogConsole {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Install PostHog structured-log forwarding for both stdout and stderr sinks. Safe to call alongside
 *  sentry.ts's installStructuredLogForwarding (parallel run) -- each wraps whatever target.log/target.error
 *  currently is, so calling both chains correctly regardless of call order. */
export function installPostHogStructuredLogForwarding(target: StructuredLogConsole = console): void {
  const baseConsoleLog = target.log.bind(target);
  const baseConsoleError = target.error.bind(target);
  let forwarding = false;
  const forward = (line: unknown, fromErrorSink: boolean): void => {
    if (forwarding) return;
    forwarding = true;
    try {
      forwardStructuredLogToPostHog(line, fromErrorSink);
    } finally {
      forwarding = false;
    }
  };
  target.log = (...args: unknown[]): void => {
    baseConsoleLog(...args);
    forward(args[0], false);
  };
  target.error = (...args: unknown[]): void => {
    baseConsoleError(...args);
    forward(args[0], true);
  };
}

/** Cron-monitor replacement (#8287 deliverable 4): PostHog has no native cron-monitor/check-in product, so
 *  this emits a plain heartbeat event per run instead -- start, then ok/error with duration -- rather than
 *  Sentry's structured monitor-slug + check-in-id + schedule-config concept, which has no PostHog equivalent
 *  to map onto. The "silent death is an alert" property is preserved at the ALERTING layer, not here: a
 *  PostHog insight alert on a no-data condition over `orb_monitor_heartbeat` (filtered to status:"ok" and a
 *  given monitor name) fires exactly when check-ins stop arriving, the same failure mode Sentry Crons'
 *  missed-check-in alerting catches. Configuring that alert is explicitly out of scope here -- it belongs to
 *  #8294 (the epic's insights/dashboards/alert-routing issue), which this event stream is built to feed. */
export type PostHogMonitorName = "scheduled-loop" | "orb-export" | "orb-relay-drain" | "orb-relay-register" | "queue-dead-letter-revive";
export const POSTHOG_MONITOR_HEARTBEAT_EVENT = "orb_monitor_heartbeat";

export async function withPostHogMonitor<T>(name: PostHogMonitorName, context: Record<string, unknown> | undefined, callback: () => Promise<T>): Promise<T> {
  if (!active || !client) return callback();
  const startedAt = Date.now();
  try {
    const result = await callback();
    client.capture({
      distinctId: POSTHOG_DISTINCT_ID,
      event: POSTHOG_MONITOR_HEARTBEAT_EVENT,
      properties: { monitor: name, status: "ok", duration_ms: Date.now() - startedAt, environment: posthogEnvironment },
    });
    return result;
  } catch (error) {
    client.capture({
      distinctId: POSTHOG_DISTINCT_ID,
      event: POSTHOG_MONITOR_HEARTBEAT_EVENT,
      properties: { monitor: name, status: "error", duration_ms: Date.now() - startedAt, environment: posthogEnvironment },
    });
    const properties = operationalProperties({ ...context, monitor: name, kind: `posthog_monitor_${name}`, subsystem: "scheduled" });
    client.captureException(error instanceof Error ? error : new Error(String(error)), POSTHOG_DISTINCT_ID, properties);
    throw error;
  }
}

/** `"review"` (chat/completion) vs `"embedding"` -- matches ai.ts's own `requestKind()` classification
 *  (`options.text` set ⇒ embedding), which picks the PostHog event name below. */
export type PostHogAiGenerationRequestKind = "review" | "embedding";

/** One AI provider attempt (#8296, epic #8286 track 3): every field here is metadata -- model id, provider
 *  name, timing, token/cost accounting, and (on failure) an already-redacted error string ai.ts's own
 *  `redactSecrets`/`errorMessage` produced before ever throwing. There is deliberately no field for the
 *  prompt or the response text; `$ai_generation`'s own optional content properties are never populated. */
export type PostHogAiGenerationEvent = {
  provider: string;
  model: string;
  requestKind: PostHogAiGenerationRequestKind;
  latencyMs: number;
  isError: boolean;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** A single blended figure -- ai.ts's own `AiUsage.costUsd` never splits input/output cost, so this
   *  never fabricates a split its source data doesn't have. Absent for the claude-code/codex subscription
   *  CLIs whenever their own stdout reports none (a flat subscription has no real per-call dollar cost). */
  totalCostUsd?: number | undefined;
  /** Reasoning-effort dial ("low"/"medium"/"high"/"max") -- generation CONFIG, never prompt content. */
  effort?: string | undefined;
  /** Correlation context (repo/PR), the same optional fields AiRunOptions already threads through for
   *  `logSelfHostAiProviderFailed` -- routed through {@link operationalProperties} so only the shared
   *  operational-tag allowlist survives, exactly like every other capture path in this file. */
  context?: Record<string, unknown> | undefined;
  /** Raw caught value on the error path (mirrors capturePostHogError's own `error` param) -- never a
   *  caller-preformatted string. Ignored when `isError` is false. */
  error?: unknown;
};

/** Capture one AI provider attempt as PostHog's `$ai_generation` (`$ai_embedding` for an embedding
 *  request) event (#8296). No-op when PostHog is off -- same contract as every other capture function in
 *  this file. Unlike {@link capturePostHogError}, this never gates on POSTHOG_MIN_SEVERITY: a successful
 *  generation is not an error-severity event at all, and a failed one is ALREADY captured as a real
 *  exception by the caller's own existing `selfhost_ai_provider_failed` log line (forwarded via
 *  {@link forwardStructuredLogToPostHog}) -- this event exists for spend/latency/failure ANALYTICS, a
 *  parallel concern to error tracking, not a substitute gate for it. */
export function capturePostHogAiGeneration(event: PostHogAiGenerationEvent): void {
  if (!active || !client) return;
  const properties: Record<string, unknown> = {
    ...operationalProperties(event.context),
    $ai_trace_id: randomUUID(),
    $ai_model: nonBlank(event.model) ?? "unknown",
    $ai_provider: nonBlank(event.provider) ?? "unknown",
    // PostHog's own $ai_generation schema reports latency in SECONDS, not ms.
    $ai_latency: event.latencyMs / 1000,
    $ai_http_status: event.isError ? 500 : 200,
    $ai_input_tokens: Number.isFinite(event.inputTokens) ? event.inputTokens : 0,
    $ai_output_tokens: Number.isFinite(event.outputTokens) ? event.outputTokens : 0,
    $ai_is_error: event.isError,
    environment: posthogEnvironment,
  };
  if (Number.isFinite(event.totalCostUsd)) properties.$ai_total_cost_usd = event.totalCostUsd;
  if (event.effort) properties.$ai_model_parameters = { effort: event.effort };
  if (event.isError) {
    const error = event.error instanceof Error ? event.error : new Error(String(event.error));
    properties.$ai_error = error.message.slice(0, 500);
  }
  client.capture({
    distinctId: POSTHOG_DISTINCT_ID,
    event: event.requestKind === "embedding" ? "$ai_embedding" : "$ai_generation",
    properties,
  });
}

/** Flush buffered events before exit. No-op when off. */
export async function flushPostHog(): Promise<void> {
  if (!active || !client) return;
  await client.flush().catch(() => undefined);
}

/** Gracefully shut the PostHog client down (flushes, then stops its internal timers) -- PostHog's own
 *  documented cleanup call for a long-running Node process, distinct from flushPostHog's mid-life drain. */
export async function shutdownPostHog(): Promise<void> {
  if (!active || !client) return;
  await client.shutdown().catch(() => undefined);
}

/** Test-only: reset module state between cases. */
export function resetPostHogForTest(): void {
  client = undefined;
  active = false;
  posthogEnvironment = "production";
  resetRedactionScrubForTest();
}
