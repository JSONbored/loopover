// Self-host-only error tracking (#1468). Opt-in: a complete NO-OP when SENTRY_DSN is unset, mirroring the
// env-gated, dynamically-imported selfhost-integration pattern (Redis/Qdrant/embed-provider in server.ts).
// @sentry/node is NEVER imported at module top level — it loads lazily inside initSentry(), so it never enters
// the Worker bundle (src/index.ts) and cloudflare:* stubbing stays clean. All helpers are safe to call when off.
import {
  PUBLIC_LOCAL_PATH_SCRUB_PATTERN,
  PUBLIC_UNSAFE_TERMS,
} from "../signals/redaction";
import { hostname } from "node:os";
import {
  currentOtelTraceIds,
  openTelemetryTraceExportEnabled,
  type OpenTelemetryBridge,
} from "./otel";
import { hashedInstallationIdWith } from "./review-tracing";
import { queueDeadLetterReviveIntervalMs } from "./queue-common";

type SentryNs = typeof import("@sentry/node");
type SentryClient = NonNullable<ReturnType<SentryNs["init"]>>;
type SentryMonitorConfig = NonNullable<Parameters<SentryNs["captureCheckIn"]>[1]>;
export type SentryMonitorName = "scheduled-loop" | "orb-export" | "orb-relay-drain" | "orb-relay-register" | "queue-dead-letter-revive";
export const SENTRY_MONITOR_NAMES: readonly SentryMonitorName[] = ["scheduled-loop", "orb-export", "orb-relay-drain", "orb-relay-register", "queue-dead-letter-revive"];
export const SENTRY_OPERATIONAL_SUBSYSTEMS = { webhook: "GitHub webhook ingest and enqueue", queue: "Job claim, process, dead-letter revival, and pump loops", github: "GitHub App token minting and broker calls", ai: "AI provider attempts, rate limits, and close-breaker engagement", gate: "Gate verdict and check-run publish", publish: "PR comment and public-surface publish", scheduled: "Maintenance tick, regate sweeps, and cron fan-out", backup: "Backup profile runs and freshness advisories", relay: "Orb relay register/drain and broker export loops" } as const;
export const SENTRY_OPERATIONAL_TAG_KEYS = ["repo", "repository", "owner", "installation_id_hash", "pull", "pullNumber", "pr", "head_sha", "project", "kind", "subsystem", "job_type", "jobType", "reason", "result", "deliveryId", "provider", "model", "effort", "timeoutMs", "trace_id", "span_id", "operation", "agent", "decision_outcome", "event", "monitor"] as const;
type SentryScope = {
  setContext(name: string, context: Record<string, unknown>): void;
  setTag(key: string, value: string): void;
};
type DigestHex = (input: string) => string;
let Sentry: SentryNs | undefined;
let sentryClient: SentryClient | undefined;
let sentryTraceSampleRate: number | undefined;
let active = false;
let sentryEnvironment = "production";
let digestHexSync: DigestHex | undefined;

const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)/i;
const PAYLOAD_KEY =
  /(^|[_-])(body|payload|patch|diff|prompt|rubric|guardrail|headers?|cookies?|title|config|review[-_]?text|review[-_]?content|comment[-_]?text|comment[-_]?body)([_-]|$)|^(body|payload|patch|diff|prompt|rubric|guardrail|headers?|cookies?|title|config|review[-_]?text|review[-_]?content|comment[-_]?text|comment[-_]?body)$/i;
const SECRET_VALUE = new RegExp(
  [
    `${"github" + "_pat_"}[A-Za-z0-9_]+`,
    String.raw`gh[opsru]_[A-Za-z0-9_]{20,}`,
    String.raw`sk-[A-Za-z0-9_-]{20,}`,
    String.raw`xox[baprs]-[A-Za-z0-9-]+`,
    // Gittensory's own opaque tokens (createOpaqueToken, src/auth/security.ts): gts_ is the default session-token
    // prefix, orbenr_/orbsec_ are the Orb broker's enrollment id/secret (#1825) — a broker error message can quote
    // these bare (no "secret"/"token"-named field for the key-based redaction above to catch), so the VALUE itself
    // must be recognized here too.
    String.raw`(?:gts|orbenr|orbsec)_[A-Za-z0-9_]{20,}`,
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

async function loadNodeHasher(): Promise<void> {
  const { createHash } = await import("node:crypto");
  digestHexSync = (input: string): string =>
    createHash("sha256").update(input).digest("hex");
}

const SENTRY_MONITORS: Record<SentryMonitorName, { slug: string; config: SentryMonitorConfig | (() => SentryMonitorConfig) }> = {
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
  "orb-relay-register": {
    slug: "orb-relay-register",
    config: {
      schedule: { type: "interval", value: 1, unit: "minute" },
      checkinMargin: 2,
      maxRuntime: 1,
      failureIssueThreshold: 3,
      recoveryThreshold: 1,
    },
  },
  // Derived from the LIVE QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS override (default 30min, see queue-common.ts)
  // rather than hard-coded: a static 30min schedule would report false missed check-ins for any operator who
  // configures an interval longer than the schedule + margin window, even though the job is running exactly on
  // its own configured cadence. Silent stoppage here means dead jobs never retry again without manual
  // intervention (#1824), so the monitor must track whatever interval is actually in effect.
  "queue-dead-letter-revive": {
    slug: "queue-dead-letter-revive",
    config: () => {
      const intervalMinutes = Math.max(1, Math.round(queueDeadLetterReviveIntervalMs() / 60_000));
      return {
        schedule: { type: "interval", value: intervalMinutes, unit: "minute" },
        checkinMargin: Math.max(5, Math.ceil(intervalMinutes / 3)),
        maxRuntime: 5,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      };
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

export function resolveSentryTracesSampleRate(
  env: NodeJS.ProcessEnv,
): number | undefined {
  const raw = nonBlank(env.SENTRY_TRACES_SAMPLE_RATE);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 1);
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

function isInstallationIdKey(key: string): boolean {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase() === "installationid";
}

function installationIdHash(value: unknown): string | undefined {
  if (!digestHexSync) return undefined;
  return hashedInstallationIdWith(value, digestHexSync);
}

function hashedInstallationContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const hasInstallationId =
    "installation_id" in context || "installationId" in context;
  const hash = installationIdHash(context.installation_id ?? context.installationId);
  if (!hash && !hasInstallationId) return context;
  const safe: Record<string, unknown> = { ...context };
  if (hash) safe.installation_id_hash = hash;
  delete safe.installation_id;
  delete safe.installationId;
  return safe;
}

function tagHashedInstallation(scope: SentryScope, context: Record<string, unknown>): void {
  const hash = installationIdHash(context.installation_id ?? context.installationId);
  if (hash) scope.setTag("installation_id_hash", hash);
}

function applyOperationalTags(scope: SentryScope, context: Record<string, unknown>): void { const normalized: Record<string, unknown> = typeof context.repository === "string" && context.repo === undefined ? { ...context, repo: context.repository } : { ...context }; tagHashedInstallation(scope, normalized); for (const key of SENTRY_OPERATIONAL_TAG_KEYS) { const tagValue = normalized[key]; if (typeof tagValue === "string" || typeof tagValue === "number") scope.setTag(key, String(tagValue)); } }
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
    if (isInstallationIdKey(key)) {
      const hash = installationIdHash(rec[key]);
      if (hash) rec.installation_id_hash = hash;
      delete rec[key];
      continue;
    }
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
  await loadNodeHasher();
  Sentry = await import("@sentry/node");
  const release = resolveSentryRelease(env);
  sentryTraceSampleRate = resolveSentryTracesSampleRate(env);
  const useCustomOpenTelemetry =
    sentryTraceSampleRate !== undefined || openTelemetryTraceExportEnabled(env);
  sentryEnvironment = nonBlank(env.SENTRY_ENVIRONMENT) ?? "production";
  sentryClient = Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: sentryEnvironment,
    ...(release ? { release } : {}),
    ...(sentryTraceSampleRate !== undefined
      ? { tracesSampleRate: sentryTraceSampleRate }
      : {}),
    ...(useCustomOpenTelemetry ? { skipOpenTelemetrySetup: true } : {}),
    // Identify this instance by a CLEAN, configurable name, not the public-origin URL. An operator sets
    // SENTRY_SERVER_NAME (e.g. "gittensory-us-east"); unset falls back to the OS hostname.
    serverName: nonBlank(env.SENTRY_SERVER_NAME) ?? hostname(),
    beforeSend: (e) => scrubEvent(e),
    beforeSendTransaction: (e) => scrubEvent(e),
  });
  active = true;
  return true;
}

export async function buildSentryOpenTelemetryBridge(): Promise<OpenTelemetryBridge | undefined> {
  if (!active || !Sentry || !sentryClient) return undefined;
  const SentryOtel = await import("@sentry/opentelemetry");
  const exportSentrySpans = sentryTraceSampleRate !== undefined;
  return {
    ...(exportSentrySpans ? { sampler: new SentryOtel.SentrySampler(sentryClient) } : {}),
    propagator: new SentryOtel.SentryPropagator(),
    contextManager: new Sentry.SentryContextManager(),
    ...(exportSentrySpans ? { spanProcessor: new SentryOtel.SentrySpanProcessor() } : {}),
    validate: () => {
      Sentry?.validateOpenTelemetrySetup?.();
    },
  };
}

/** Name a synthetic Error before capture so its Sentry issue title reads "eventName: message" instead of the
 *  generic "Error: message" (or a caught exception's own class name, e.g. "HttpError: ..."). Mirrors
 *  forwardStructuredLogToSentry's `errorEvent.name = event` below — same discipline, applied to the handful of
 *  call sites that construct their OWN `new Error(...)` purely to report a known condition, not to a genuinely
 *  caught exception (which keeps its real name/type — mislabeling those would hide what actually threw). Only
 *  renames when the caller opts in; every other captureError/captureReviewFailure call is unaffected. */
function namedCaptureError(error: unknown, eventName?: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  if (eventName) err.name = eventName;
  return err;
}

/** Capture an error with optional structured context. No-op when Sentry is off. `eventName`, when given, becomes
 *  the Sentry issue title's prefix (see {@link namedCaptureError}) instead of the generic "Error". */
export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
  eventName?: string,
): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    setOtelTraceScope(scope);
    if (context) { const safeContext = hashedInstallationContext(context); scope.setContext("gittensory", safeContext); applyOperationalTags(scope, safeContext); }
    Sentry!.captureException(namedCaptureError(error, eventName));
  });
}

/** Capture a failed review at ERROR level, tagged by repo/PR/SHA for triage. A review that cannot be produced is a
 *  real failure the maintainer must SEE — not a warning that hides in the noise. No-op when off. `eventName`, when
 *  given, becomes the Sentry issue title's prefix (see {@link namedCaptureError}) instead of the generic "Error". */
export function captureReviewFailure(
  error: unknown,
  context?: Record<string, unknown>,
  eventName?: string,
): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    scope.setLevel("error");
    setOtelTraceScope(scope);
    if (context) {
      const safeContext = hashedInstallationContext(context);
      scope.setContext("review", safeContext);
      applyOperationalTags(scope, safeContext);
    }
    Sentry!.captureException(namedCaptureError(error, eventName));
  });
}

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
  "installationId",
  "installation_id",
  "installation_id_hash",
  "pullNumber",
  "deliveryId",
  "trace_id",
  "span_id",
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
  const safeObj = hashedInstallationContext(obj);
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
    ([logLocation(safeObj).trim(), summarizeLogFields(safeObj)]
      .filter(Boolean)
      .join(" ") || "(no message — see the log context)");
  const errorEvent = new Error(value);
  errorEvent.name = event ?? "GittensoryLog";
  // This exception is synthetic: it was minted from a console line, never thrown at the failing code. Strip the
  // wrapper stack so Sentry does not attribute forwarded operational issues to this forwarding helper.
  errorEvent.stack = `${errorEvent.name}: ${value}`;
  Sentry.withScope((scope) => {
    scope.setLevel(severity);
    setOtelTraceScope(scope);
    scope.setContext("log", safeObj);
    if (event) safeObj.event = event;
    applyOperationalTags(scope, safeObj);
    // Group recurrences of ONE failure into a single issue (by event, not the variable detail in the value).
    if (event) scope.setFingerprint(["gittensory-log", event]);
    // Sentry uses event.transaction as the issue culprit fallback when the stack has no frames; point it at the
    // operational event slug rather than the forwarding helper.
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
  const configOrResolver = SENTRY_MONITORS[name].config;
  const resolvedConfig = typeof configOrResolver === "function" ? configOrResolver() : configOrResolver;
  const checkInId = Sentry.captureCheckIn({ monitorSlug, status: "in_progress" }, resolvedConfig);
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
      const monitorContext = safeMonitorContext(name, monitorSlug, context);
      scope.setContext("sentry_monitor", monitorContext);
      applyOperationalTags(scope, { ...monitorContext, monitor: monitorSlug, kind: `sentry_monitor_${name}`, subsystem: "scheduled" });
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
  sentryClient = undefined;
  sentryTraceSampleRate = undefined;
  active = false;
  sentryEnvironment = "production";
  digestHexSync = undefined;
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
