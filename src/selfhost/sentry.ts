// Self-host-only error tracking (#1468). Opt-in: a complete NO-OP when SENTRY_DSN is unset, mirroring the
// env-gated, dynamically-imported selfhost-integration pattern (Redis/Qdrant/embed-provider in server.ts).
// @sentry/node is NEVER imported at module top level — it loads lazily inside initSentry(), so it never enters
// the Worker bundle (src/index.ts) and cloudflare:* stubbing stays clean. All helpers are safe to call when off.
import {
  PUBLIC_LOCAL_PATH_SCRUB_PATTERN,
  PUBLIC_UNSAFE_TERMS,
} from "../signals/redaction";
import { hostname } from "node:os";
import { currentOtelTraceIds } from "./otel";

type SentryNs = typeof import("@sentry/node");
type SentryMonitorConfig = NonNullable<Parameters<SentryNs["captureCheckIn"]>[1]>;
export type SentryMonitorName = "scheduled-loop" | "orb-export" | "orb-relay-drain";
type SentryScope = {
  setContext(name: string, context: Record<string, unknown>): void;
  setTag(key: string, value: string): void;
};
let Sentry: SentryNs | undefined;
let active = false;
let sentryEnvironment = "production";
// The resolved tracing sample rate. Tracing stays a complete no-op (no spans started, no trace traffic) until this
// is configured above 0 — distinct from error capture, which is on whenever the DSN is set. (#1734)
let tracesSampleRate = 0;

const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)/i;
const PAYLOAD_KEY =
  /(^|[_-])(body|payload|patch|diff|prompt|rubric|guardrail|headers?|cookies?|title|config|review[-_]?text|review[-_]?content)([_-]|$)|^(body|payload|patch|diff|prompt|rubric|guardrail|headers?|cookies?|title|config|review[-_]?text|review[-_]?content)$/i;
const SECRET_VALUE = new RegExp(
  [
    `${"github" + "_pat_"}[A-Za-z0-9_]+`,
    String.raw`gh[opsru]_[A-Za-z0-9_]{20,}`,
    String.raw`sk-[A-Za-z0-9_-]{20,}`,
    String.raw`xox[baprs]-[A-Za-z0-9-]+`,
    String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{12,}`,
    String.raw`-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----`,
  ].join("|"),
  "gi",
);
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET_VALUE =
  /([?&;][^=\s&#;]*(?:token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)[^=\s&#;]*=)[^&#\s;]+/gi;
const PRIVATE_TEXT =
  /\b(raw[-_\s]?score|scoring context|private rubric|gate prompt|review prompt|guardrail paths?|pull request body|pr body|pr title|raw diff)\b/gi;
const PUBLIC_UNSAFE_SCRUB = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b`, "gi");
const ALLOWED_CONTEXTS = new Set([
  "gittensory",
  "review",
  "log",
  "sentry_monitor",
  "otel",
  "trace",
  "runtime",
  "os",
]);
const REDACTED = "[redacted]";

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const SENTRY_MONITORS: Record<SentryMonitorName, { slug: string; config: SentryMonitorConfig }> = {
  "scheduled-loop": {
    slug: "scheduled-loop",
    config: {
      schedule: { type: "interval", value: 2, unit: "minute" },
      checkinMargin: 3,
      maxRuntime: 2,
      failureIssueThreshold: 2,
      recoveryThreshold: 1,
    },
  },
  "orb-export": {
    slug: "orb-export",
    config: {
      schedule: { type: "interval", value: 1, unit: "hour" },
      checkinMargin: 10,
      maxRuntime: 10,
      failureIssueThreshold: 2,
      recoveryThreshold: 1,
    },
  },
  "orb-relay-drain": {
    slug: "orb-relay-drain",
    config: {
      schedule: { type: "interval", value: 1, unit: "minute" },
      checkinMargin: 2,
      maxRuntime: 1,
      failureIssueThreshold: 3,
      recoveryThreshold: 1,
    },
  },
};

function slugPart(value: string | undefined): string {
  const slug = nonBlank(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "production";
}

export function resolveSentryMonitorSlug(
  name: SentryMonitorName,
  environment = sentryEnvironment,
): string {
  return `gittensory-selfhost-${slugPart(environment)}-${SENTRY_MONITORS[name].slug}`;
}

function safeMonitorContext(
  name: SentryMonitorName,
  monitorSlug: string,
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { monitor: name, monitorSlug };
  if (!context) return safe;
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY.test(key) || value === null || value === undefined) continue;
    if (typeof value === "string")
      safe[key] = value.length > 160 ? `${value.slice(0, 157)}...` : value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

function setOtelTraceScope(scope: SentryScope): void {
  const trace = currentOtelTraceIds();
  if (!trace) return;
  scope.setTag("trace_id", trace.trace_id);
  scope.setTag("span_id", trace.span_id);
  scope.setContext("otel", { ...trace });
}

/** Resolve the Sentry release id from explicit override first, then the image-baked self-host version. */
export function resolveSentryRelease(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return nonBlank(env.SENTRY_RELEASE) ?? nonBlank(env.GITTENSORY_VERSION);
}

/** Resolve the trace sample rate, clamped to [0, 1]. Defaults to 0 (tracing off) — a malformed value is treated as
 *  off rather than full sampling, so a typo can never accidentally flood the tracer. (#1734) */
export function resolveTracesSampleRate(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0");
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/** beforeSend scrubber — redact anything token/secret-like before an event leaves the box (privacy boundary). */
export function scrubEvent<T>(event: T): T | null {
  try {
    const e = event as {
      request?: Record<string, unknown>;
      contexts?: Record<string, unknown>;
      extra?: Record<string, unknown>;
      tags?: Record<string, unknown>;
      breadcrumbs?: Array<Record<string, unknown>>;
      exception?: unknown;
      logentry?: unknown;
      message?: unknown;
      spans?: unknown;
      transaction?: unknown;
      user?: unknown;
    };
    scrubRequest(e.request);
    scrubAllowedContexts(e.contexts);
    scrubRecord(e.extra, 0);
    scrubRecord(e.tags, 0);
    scrubRecord(e.exception, 0);
    scrubRecord(e.logentry, 0);
    scrubRecord(e.spans, 0);
    delete e.user;
    if (typeof e.message === "string") e.message = scrubString(e.message);
    if (typeof e.transaction === "string") e.transaction = scrubString(e.transaction);
    if (Array.isArray(e.breadcrumbs)) {
      for (const breadcrumb of e.breadcrumbs) scrubRecord(breadcrumb, 0);
    }
  } catch {
    return null;
  }
  return event;
}

function shouldRedactKey(key: string): boolean {
  const compact = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    SECRET_KEY.test(key) ||
    PAYLOAD_KEY.test(key) ||
    /(body|payload|patch|diff|prompt|rubric|guardrail|header|cookie|title|config|reviewtext|reviewcontent|prcontent|pullrequest)/.test(compact)
  );
}

function scrubString(value: string): string {
  return value
    .replace(QUERY_SECRET_VALUE, `$1${REDACTED}`)
    .replace(SECRET_VALUE, REDACTED)
    .replace(JWT_VALUE, REDACTED)
    .replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>")
    .replace(PUBLIC_UNSAFE_SCRUB, "private context")
    .replace(PRIVATE_TEXT, "private context");
}

function scrubRecord(obj: unknown, depth: number): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const value = obj[i];
      if (typeof value === "string") obj[i] = scrubString(value);
      else if (value && typeof value === "object") {
        if (depth >= 6) obj[i] = REDACTED;
        else scrubRecord(value, depth + 1);
      }
    }
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (shouldRedactKey(key)) {
      rec[key] = REDACTED;
      continue;
    }
    const value = rec[key];
    if (typeof value === "string") rec[key] = scrubStringField(key, value);
    else if (value && typeof value === "object") {
      if (depth >= 6) rec[key] = REDACTED;
      else scrubRecord(value, depth + 1);
    }
  }
}

function scrubStringField(key: string, value: string): string {
  if (isUrlKey(key)) return scrubUrl(value);
  if (isQueryKey(key)) return scrubQueryString(value);
  return scrubString(value);
}

function isUrlKey(key: string): boolean {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase().endsWith("url");
}

function isQueryKey(key: string): boolean {
  const compact = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return compact === "query" || compact === "querystring";
}

function scrubUrl(value: string): string {
  const scrubbed = scrubString(value);
  const queryStart = scrubbed.indexOf("?");
  if (queryStart === -1) return scrubbed;
  try {
    const parsed = new URL(scrubbed);
    parsed.search = scrubQueryString(parsed.search);
    return parsed.toString();
  } catch {
    return `${scrubbed.slice(0, queryStart + 1)}${scrubQueryString(
      scrubbed.slice(queryStart + 1),
    )}`;
  }
}

function scrubQueryString(value: string): string {
  const hasQuestionMark = value.startsWith("?");
  const source = hasQuestionMark ? value.slice(1) : value;
  const params = new URLSearchParams(source);
  for (const key of Array.from(new Set(params.keys()))) {
    const values = params.getAll(key);
    params.delete(key);
    for (const entry of values) {
      params.append(key, shouldRedactKey(key) ? REDACTED : scrubString(entry));
    }
  }
  const scrubbed = params.toString();
  return hasQuestionMark ? `?${scrubbed}` : scrubbed;
}

function scrubRequest(request: Record<string, unknown> | undefined): void {
  if (!request) return;
  scrubRecord(request.headers, 0);
  for (const key of ["url", "query_string", "queryString", "query"] as const) {
    const value = request[key];
    if (typeof value === "string") request[key] = scrubStringField(key, value);
    else if (value && typeof value === "object") scrubRecord(value, 0);
  }
  for (const key of ["body", "data", "payload", "cookies"] as const) {
    if (key in request) delete request[key];
  }
}

function scrubAllowedContexts(contexts: Record<string, unknown> | undefined): void {
  if (!contexts) return;
  for (const key of Object.keys(contexts)) {
    if (!ALLOWED_CONTEXTS.has(key)) {
      delete contexts[key];
      continue;
    }
    scrubRecord(contexts[key], 0);
  }
}

/** Initialize Sentry from the environment. Returns false (and stays a no-op) when SENTRY_DSN is unset. */
export async function initSentry(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!env.SENTRY_DSN) return false;
  Sentry = await import("@sentry/node");
  const release = resolveSentryRelease(env);
  sentryEnvironment = nonBlank(env.SENTRY_ENVIRONMENT) ?? "production";
  tracesSampleRate = resolveTracesSampleRate(env);
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: sentryEnvironment,
    ...(release ? { release } : {}),
    tracesSampleRate,
    // Identify this instance by a CLEAN, configurable name — not the public-origin URL. An operator sets
    // SENTRY_SERVER_NAME (e.g. "gittensory-us-east"); unset falls back to the OS hostname, which is dynamic
    // per instance with no hardcoded value and reads as a name rather than a URL.
    serverName: nonBlank(env.SENTRY_SERVER_NAME) ?? hostname(),
    beforeSend: (e) => scrubEvent(e),
    beforeSendTransaction: (e) => scrubEvent(e),
  });
  active = true;
  return true;
}

/** Capture an error with optional structured context. No-op when Sentry is off. */
export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    setOtelTraceScope(scope);
    if (context) scope.setContext("gittensory", context);
    Sentry!.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

/** Capture a failed review at ERROR level, tagged by repo/PR/SHA for triage. A review that cannot be produced is a
 *  real failure the maintainer must SEE — not a warning that hides in the noise. No-op when off. */
export function captureReviewFailure(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    scope.setLevel("error");
    setOtelTraceScope(scope);
    if (context) {
      scope.setContext("review", context);
      for (const tag of ["owner", "repo", "pr", "head_sha"]) {
        const value = context[tag];
        if (value !== undefined && value !== null)
          scope.setTag(tag, String(value));
      }
    }
    Sentry!.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

/** True only when error capture is active AND trace sampling is configured above 0. When false, every span helper
 *  is a complete no-op — no span is started and no trace traffic is emitted (the #1734 "sampling off" guarantee). */
export function sentryTracingEnabled(): boolean {
  return active && Sentry !== undefined && tracesSampleRate > 0;
}

/** Project an attribute bag onto the safe, low-cardinality subset allowed on a span: drop secret-keyed keys and
 *  null/undefined, keep finite numbers + booleans, and truncate strings — never a prompt/diff/token/body. */
export function sentrySpanAttributes(
  input: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key) || value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value.length > 160 ? `${value.slice(0, 157)}...` : value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** Run `fn` inside a Sentry span named `name`, tagged with the safe attributes. The span auto-closes and is marked
 *  errored if `fn` throws (so slow/failed stages are filterable). A pure pass-through to `fn` when tracing is off. */
export async function withSentrySpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!sentryTracingEnabled()) return fn();
  return Sentry!.startSpan(
    { name, op: name, attributes: sentrySpanAttributes(attributes) },
    () => fn(),
  );
}

// The structured-log fields worth indexing as Sentry tags — the dimensions operators filter + group by. Only
// string|number values are tagged; everything else stays in the full "log" context.
const SENTRY_LOG_TAG_KEYS = ["repo", "repository", "installationId", "installation_id", "pull", "pullNumber", "pr", "project", "kind", "deliveryId", "provider", "model", "effort", "timeoutMs", "trace_id", "span_id"] as const;

/** A SHORT location suffix — " (repo#pr)" — for a no-message error title, so the issue list shows WHERE without
 *  dumping every scalar field (which made titles unreadably long, e.g. trailing a full deliveryId). The complete
 *  field set is still indexed as Sentry tags + kept in the "log" context. Empty when the log carries no repo. */
function logLocation(obj: Record<string, unknown>): string {
  const repo =
    typeof obj.repository === "string"
      ? obj.repository
      : typeof obj.repo === "string"
        ? obj.repo
        : undefined;
  if (!repo) return "";
  // The standard pullNumber locates the PR in the title; other pr aliases stay in the tags/context (not the title).
  const pr = obj.pullNumber;
  return typeof pr === "number" ? ` (${repo}#${pr})` : ` (${repo})`;
}

/** When a log carries no message/error, summarize its SALIENT scalar fields (project, counts, precisions, …) into the
 *  Sentry value so a field-only log — e.g. close_breaker_engaged{project,closePrecision,floor} or closehold_backlog
 *  {count,projects} — shows real data instead of "(no message)". Skips meta + the location keys logLocation already
 *  used + long blobs (IDs/bodies stay in the indexed tags + the "log" context); caps to a few fields so the title
 *  stays readable. This is the STRUCTURAL fix for field-only error logs (current + future), not per-log message-adding. */
const SUMMARY_SKIP_KEYS = new Set([
  "level",
  "event",
  "ts",
  "time",
  "timestamp",
  "msg",
  "ev",
  "message",
  "error",
  "repo",
  "repository",
  "pullNumber",
  "deliveryId",
]);
function redactSummaryValue(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return "[redacted]";
  if (Array.isArray(value))
    return value.map((item) => redactSummaryValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SECRET_KEY.test(key)
        ? "[redacted]"
        : redactSummaryValue(nested, depth + 1),
    ]),
  );
}

function summarizeLogFields(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(
      ([k, v]) => !SUMMARY_SKIP_KEYS.has(k) && !SECRET_KEY.test(k) && v !== null,
    )
    .map(
      ([k, v]) =>
        `${k}=${typeof v === "object" ? JSON.stringify(redactSummaryValue(v)) : String(v)}`,
    )
    .filter((part) => part.length <= 90) // a long blob (id/body) belongs in the context, not the title
    .slice(0, 5) // a few salient fields, not a dump
    .join(", ");
}

/** Forward a structured console line to Sentry when it is an ERROR-level log. The engine logs operational
 *  failures (orb_broker_unavailable, gate-check errors, relay drops, …) as JSON strings, often via console.error.
 *  No-op when Sentry is off, the line isn't a JSON object string, or its level isn't error/fatal — routine logs
 *  (audit/info/no-level: job_complete, regate_sweep_throttled, …) are intentionally skipped. */
export function forwardStructuredLogToSentry(line: unknown, fromErrorSink = false): void {
  if (!active || !Sentry) return;
  if (typeof line !== "string" || line.charCodeAt(0) !== 123 /* "{" */) return;
  let obj: Record<string, unknown>;
  try {
    // A "{"-prefixed string that parses is always an object (else JSON.parse throws → caught below).
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // not JSON — an ordinary log line
  }
  // A console.error sink is error-level by DEFAULT even when the JSON omits an explicit level (many engine error
  // logs do) — that's how those errors reach Sentry instead of printing to stderr and vanishing. An EXPLICIT level
  // always wins, so a deliberate level:"warn" emitted via console.error is still skipped.
  const explicitLevel = typeof obj.level === "string" ? obj.level : undefined;
  const level = explicitLevel ?? (fromErrorSink ? "error" : undefined);
  if (level !== "error" && level !== "fatal") return;
  const severity = level === "fatal" ? "fatal" : "error";
  const event = typeof obj.event === "string" ? obj.event : undefined;
  // Lead the Sentry title with the real failure detail (message → error), not just the event slug, so an operator
  // sees WHAT broke straight from the issue list instead of having to open the context blob.
  const detail = typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : undefined;
  // Forward as a synthetic EXCEPTION, NOT captureMessage. captureMessage leaves the exception value empty, which
  // Sentry's issue UI renders as "(No error message)". An exception gives the issue a real `type: value`:
  //   name (type)     = the event slug (e.g. check_run_post_denied)
  //   message (value) = the failure detail (message/error) → else the PR location → else a pointer to the context
  // So the issue list always shows a legible "event: detail", never a bare slug or "(No error message)". The
  // fingerprint (by event) still groups recurrences, so the synthetic stack doesn't fragment grouping. (#1468)
  // value = the real detail (message/error) → else the PR location + a summary of salient fields (so a field-only log
  // like close_breaker_engaged shows "project=x, closePrecision=0.6, floor=0.8") → else a context pointer.
  const value =
    detail ??
    ([logLocation(obj).trim(), summarizeLogFields(obj)]
      .filter(Boolean)
      .join(" ") || "(no message — see the log context)");
  const errorEvent = new Error(value);
  errorEvent.name = event ?? "GittensoryLog";
  // This exception is SYNTHETIC — minted here from a console line, never thrown at the code that failed. Its captured
  // JS stack therefore points at this forwarder and the console sink that called it (installStructuredLogForwarding),
  // not at the origin. Left attached, Sentry computes EVERY forwarded issue's culprit as forwardStructuredLogToSentry,
  // burying the real signal. Reduce the stack to its header line (the parser yields zero frames from it) so no frame
  // is misattributed; the event slug supplies the culprit below and the `log` context keeps the full payload.
  errorEvent.stack = `${errorEvent.name}: ${value}`;
  Sentry.withScope((scope) => {
    scope.setLevel(severity);
    setOtelTraceScope(scope);
    scope.setContext("log", obj);
    if (event) scope.setTag("event", event);
    // Index the dimensions operators filter + group by, so issues are findable without digging into the context.
    for (const key of SENTRY_LOG_TAG_KEYS) {
      const tagValue = obj[key];
      if (typeof tagValue === "string" || typeof tagValue === "number")
        scope.setTag(key, String(tagValue));
    }
    // Group recurrences of ONE failure into a single issue (by event, not the variable detail in the value).
    if (event) scope.setFingerprint(["gittensory-log", event]);
    // Give the issue a legible culprit (the location Sentry shows under the title). It derives from event.transaction
    // when set, else from the now-stripped stack — so point it at the operational event slug (e.g.
    // "orb_broker_unavailable") rather than the forwarder. setTransactionName on the scope does NOT populate
    // event.transaction in this SDK version, so set it on the event via a scoped processor.
    if (event)
      scope.addEventProcessor((sentryEvent) => {
        sentryEvent.transaction = event;
        return sentryEvent;
      });
    Sentry!.captureException(errorEvent);
  });
}

/** Wrap recurring self-host work with Sentry cron check-ins. No-op when Sentry is disabled. */
export async function withSentryMonitor<T>(
  name: SentryMonitorName,
  context: Record<string, unknown> | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  if (!active || !Sentry) return callback();
  const monitorSlug = resolveSentryMonitorSlug(name);
  const checkInId = Sentry.captureCheckIn(
    { monitorSlug, status: "in_progress" },
    SENTRY_MONITORS[name].config,
  );
  const startedAt = Date.now();
  try {
    const result = await callback();
    Sentry.captureCheckIn({
      monitorSlug,
      status: "ok",
      checkInId,
      duration: (Date.now() - startedAt) / 1000,
    });
    return result;
  } catch (error) {
    Sentry.captureCheckIn({
      monitorSlug,
      status: "error",
      checkInId,
      duration: (Date.now() - startedAt) / 1000,
    });
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      setOtelTraceScope(scope);
      scope.setContext("sentry_monitor", safeMonitorContext(name, monitorSlug, context));
      scope.setTag("monitor", monitorSlug);
      scope.setFingerprint(["gittensory-sentry-monitor", name]);
      Sentry!.captureException(error instanceof Error ? error : new Error(String(error)));
    });
    throw error;
  }
}

/** Flush buffered events before exit. No-op when off. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!active || !Sentry) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

/** Test-only: reset module state between cases. */
export function resetSentryForTest(): void {
  Sentry = undefined;
  active = false;
  sentryEnvironment = "production";
  tracesSampleRate = 0;
}

interface StructuredLogConsole {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Install central structured-log forwarding for both stdout and stderr sinks used by self-host. */
export function installStructuredLogForwarding(
  target: StructuredLogConsole = console,
): void {
  const baseConsoleLog = target.log.bind(target);
  const baseConsoleError = target.error.bind(target);
  let forwardingToSentry = false;
  const forward = (line: unknown, fromErrorSink: boolean): void => {
    if (forwardingToSentry) return;
    forwardingToSentry = true;
    try {
      forwardStructuredLogToSentry(line, fromErrorSink);
    } finally {
      forwardingToSentry = false;
    }
  };
  // stdout (console.log): forward only an EXPLICIT level:error/fatal. stderr (console.error): forward as error by
  // default (an explicit level still wins) — so EVERY console.error structured log reaches Sentry, not just the
  // ones that happened to include a level field.
  target.log = (...args: unknown[]): void => {
    baseConsoleLog(...args);
    forward(args[0], false);
  };
  target.error = (...args: unknown[]): void => {
    baseConsoleError(...args);
    forward(args[0], true);
  };
}
