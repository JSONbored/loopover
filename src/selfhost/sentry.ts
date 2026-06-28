// Self-host-only error tracking (#1468). Opt-in: a complete NO-OP when SENTRY_DSN is unset, mirroring the
// env-gated, dynamically-imported selfhost-integration pattern (Redis/Qdrant/embed-provider in server.ts).
// @sentry/node is NEVER imported at module top level — it loads lazily inside initSentry(), so it never enters
// the Worker bundle (src/index.ts) and cloudflare:* stubbing stays clean. All helpers are safe to call when off.
type SentryNs = typeof import("@sentry/node");
let Sentry: SentryNs | undefined;
let active = false;

const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)/i;

/** beforeSend scrubber — redact anything token/secret-like before an event leaves the box (privacy boundary). */
export function scrubEvent<T>(event: T): T {
  const redact = (obj: unknown, depth: number): void => {
    if (!obj || typeof obj !== "object" || depth > 6) return;
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const rec = obj as Record<string, unknown>;
      if (SECRET_KEY.test(key)) rec[key] = "[redacted]";
      else if (typeof rec[key] === "object") redact(rec[key], depth + 1);
    }
  };
  try {
    const e = event as {
      request?: { headers?: unknown };
      contexts?: unknown;
      extra?: unknown;
    };
    redact(e.request?.headers, 0);
    redact(e.contexts, 0);
    redact(e.extra, 0);
  } catch {
    /* scrubbing must never break the send */
  }
  return event;
}

/** Initialize Sentry from the environment. Returns false (and stays a no-op) when SENTRY_DSN is unset. */
export async function initSentry(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!env.SENTRY_DSN) return false;
  Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    release: env.SENTRY_RELEASE ?? env.GITTENSORY_VERSION,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    serverName: env.PUBLIC_API_ORIGIN,
    beforeSend: (e) => scrubEvent(e),
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

// The structured-log fields worth indexing as Sentry tags — the dimensions operators filter + group by. Only
// string|number values are tagged; everything else stays in the full "log" context.
const SENTRY_LOG_TAG_KEYS = ["repo", "repository", "installationId", "installation_id", "pull", "pullNumber", "pr", "project", "kind", "deliveryId"] as const;

/** Forward a structured console line to Sentry when it is an ERROR-level log. The engine logs operational
 *  failures (orb_broker_unavailable, gate-check errors, relay drops, …) as JSON strings, often via console.error.
 *  No-op when Sentry is off, the line isn't a JSON object string, or its level isn't error/fatal — routine logs
 *  (audit/info/no-level: job_complete, regate_sweep_throttled, …) are intentionally skipped. */
export function forwardStructuredLogToSentry(line: unknown): void {
  if (!active || !Sentry) return;
  if (typeof line !== "string" || line.charCodeAt(0) !== 123 /* "{" */) return;
  let obj: Record<string, unknown>;
  try {
    // A "{"-prefixed string that parses is always an object (else JSON.parse throws → caught below).
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // not JSON — an ordinary log line
  }
  const level = obj.level;
  if (level !== "error" && level !== "fatal") return;
  const severity = level === "fatal" ? "fatal" : "error";
  const event = typeof obj.event === "string" ? obj.event : undefined;
  // Lead the Sentry title with the real failure detail (message → error), not just the event slug, so an operator
  // sees WHAT broke straight from the issue list instead of having to open the context blob.
  const detail = typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : undefined;
  const title = event ? (detail ? `${event}: ${detail}` : event) : (detail ?? "error");
  Sentry.withScope((scope) => {
    scope.setLevel(severity);
    scope.setContext("log", obj);
    if (event) scope.setTag("event", event);
    // Index the dimensions operators filter + group by, so issues are findable without digging into the context.
    for (const key of SENTRY_LOG_TAG_KEYS) {
      const value = obj[key];
      if (typeof value === "string" || typeof value === "number") scope.setTag(key, String(value));
    }
    // Group recurrences of ONE failure into a single issue (by event, not the variable detail that's in the title).
    if (event) scope.setFingerprint(["gittensory-log", event]);
    Sentry!.captureMessage(title, severity);
  });
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
  const forward = (line: unknown): void => {
    if (forwardingToSentry) return;
    forwardingToSentry = true;
    try {
      forwardStructuredLogToSentry(line);
    } finally {
      forwardingToSentry = false;
    }
  };
  target.log = (...args: unknown[]): void => {
    baseConsoleLog(...args);
    forward(args[0]);
  };
  target.error = (...args: unknown[]): void => {
    baseConsoleError(...args);
    forward(args[0]);
  };
}
