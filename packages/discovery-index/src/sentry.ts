// Error tracking for the discovery-index service (#4934), reporting into the shared "metagraphed" Sentry
// project other infra/operational pieces already flow into (jsonbored org) -- not a new, separate project.
// Deliberately mirrors review-enrichment/src/sentry.ts's shape (a comparably-sized standalone service),
// not the main app's much larger src/selfhost/sentry.ts (self-host-operator opt-in, dozens of redaction
// rules, cron monitors, OpenTelemetry bridging) -- this service has a much smaller secret surface
// (DISCOVERY_INDEX_SHARED_SECRET, DISCOVERY_INDEX_GITHUB_TOKEN) and no per-operator opt-in model to begin
// with (it's the one hosted plane, not self-hosted).
import type { ErrorEvent, EventHint } from "@sentry/node";

type SentryNs = typeof import("@sentry/node");
type SentryClient = Pick<SentryNs, "init" | "withScope" | "captureException" | "flush">;
type SentryScope = {
  setContext(name: string, context: Record<string, unknown>): unknown;
  setFingerprint(fingerprint: string[]): unknown;
  setLevel(level: "error" | "warning"): unknown;
  setTag(key: string, value: string): unknown;
};

let Sentry: SentryClient | undefined;
let active = false;
let activeRelease: string | undefined;
let activeEnvironment = "production";

// Field-name-based redaction is the primary defense (DISCOVERY_INDEX_SHARED_SECRET is an arbitrary
// operator-set value with no fixed shape to pattern-match) -- these value patterns are a secondary net for
// the one secret that DOES have a recognizable shape, DISCOVERY_INDEX_GITHUB_TOKEN (GitHub's own token
// prefixes, same patterns review-enrichment's own SECRET_VALUE already covers).
const SECRET_FIELD = /(?:authorization|cookie|token|secret|password|private[_-]?key|shared[_-]?secret)/i;
const SECRET_VALUE = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const DISCOVERY_INDEX_SENTRY_TAG_KEYS = ["event", "route", "method", "release", "environment"] as const;

type DiscoveryIndexSentryTagKey = (typeof DISCOVERY_INDEX_SENTRY_TAG_KEYS)[number];
type DiscoveryIndexSentryTags = Partial<Record<DiscoveryIndexSentryTagKey, string | number | undefined>>;
type CaptureOptions = {
  contextName: string;
  context: Record<string, unknown>;
  fingerprint: string[];
  level?: "error" | "warning";
  tags: DiscoveryIndexSentryTags;
};

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function resolveDiscoveryIndexSentryRelease(env: NodeJS.ProcessEnv): string | undefined {
  return nonBlank(env.SENTRY_RELEASE) ?? (nonBlank(env.SENTRY_COMMIT_SHA) ? `loopover-discovery-index@${nonBlank(env.SENTRY_COMMIT_SHA)}` : undefined);
}

export function resolveSentryEnvironment(env: NodeJS.ProcessEnv): string {
  return nonBlank(env.SENTRY_ENVIRONMENT) ?? "production";
}

export function resolveTracesSampleRate(env: NodeJS.ProcessEnv): number {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0");
  if (!Number.isFinite(rate)) return 0;
  return Math.max(0, Math.min(1, rate));
}

function warn(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "warn", event, ...fields }));
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, SECRET_FIELD.test(key) ? "[Filtered]" : scrubValue(entry)]),
    );
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[Filtered]");
  return value;
}

function sentryTagValue(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scrubbed = scrubValue(String(value));
  // scrubValue's string branch (the only one reachable here, since String(value) is always a string) always
  // returns a string -- this check has no live "true" side through this call path. Retained defensively in
  // case scrubValue's own shape ever changes; see safe-url.ts's identical "unreachable through the real
  // entry point" pattern for the same reasoning.
  /* v8 ignore next -- @preserve unreachable: scrubValue(string) always returns a string */
  if (typeof scrubbed !== "string") return undefined;
  const text = nonBlank(scrubbed);
  return text ? text.slice(0, 200) : undefined;
}

function compactContext(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function setAllowedTags(scope: Pick<SentryScope, "setTag">, tags: DiscoveryIndexSentryTags): void {
  for (const key of DISCOVERY_INDEX_SENTRY_TAG_KEYS) {
    const value = sentryTagValue(tags[key]);
    if (value) scope.setTag(key, value);
  }
}

function setFingerprint(scope: Pick<SentryScope, "setFingerprint">, parts: string[]): void {
  const safeParts = parts.map((part) => sentryTagValue(part) ?? "unknown");
  scope.setFingerprint(safeParts);
}

function captureScopedError(error: unknown, options: CaptureOptions): void {
  if (!active || !Sentry) return;
  const safeContext = scrubValue(compactContext(options.context)) as Record<string, unknown>;
  Sentry.withScope((scope) => {
    scope.setLevel(options.level ?? "error");
    scope.setContext(options.contextName, safeContext);
    setFingerprint(scope, options.fingerprint);
    setAllowedTags(scope, { ...options.tags, release: options.tags.release ?? activeRelease, environment: options.tags.environment ?? activeEnvironment });
    Sentry!.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}

function scrubEvent(event: ErrorEvent): ErrorEvent {
  return scrubValue(event) as ErrorEvent;
}

export async function initSentry(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!nonBlank(env.SENTRY_DSN)) return false;
  try {
    Sentry = await import("@sentry/node");
    activeRelease = resolveDiscoveryIndexSentryRelease(env);
    activeEnvironment = resolveSentryEnvironment(env);
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: activeEnvironment,
      release: activeRelease,
      tracesSampleRate: resolveTracesSampleRate(env),
      beforeSend: (event: ErrorEvent, _hint: EventHint) => scrubEvent(event),
    });
    active = true;
    return true;
  } catch (error) {
    active = false;
    Sentry = undefined;
    activeRelease = undefined;
    activeEnvironment = "production";
    warn("discovery_index_sentry_init_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function captureRouteError(error: unknown, context: { route: string; method: string }): void {
  captureScopedError(error, {
    contextName: "discovery_index_route",
    context: { event: "discovery_index_route_error", route: context.route, method: context.method, release: activeRelease, environment: activeEnvironment },
    fingerprint: ["discovery-index-route-error", context.route, context.method],
    tags: { event: "discovery_index_route_error", route: context.route, method: context.method },
  });
}

export function captureUnhandledError(error: unknown, context: { event: "discovery_index_unhandled_rejection" | "discovery_index_uncaught_exception" }): void {
  captureScopedError(error, {
    contextName: "discovery_index_process",
    context: { event: context.event, release: activeRelease, environment: activeEnvironment },
    fingerprint: ["discovery-index-process-error", context.event],
    tags: { event: context.event },
  });
}

export function captureSourcemapUploadFailure(error: unknown, context: { release?: string | undefined; deploymentId?: string | undefined; strict?: boolean; sha?: string | undefined }): void {
  captureScopedError(error, {
    contextName: "discovery_index_sourcemap_upload",
    context: {
      event: "discovery_index_sourcemap_upload_failed",
      release: context.release ?? activeRelease,
      deploymentId: context.deploymentId,
      strict: context.strict,
      sha: context.sha,
      environment: activeEnvironment,
    },
    fingerprint: ["discovery-index-sourcemap-upload-failed"],
    tags: { event: "discovery_index_sourcemap_upload_failed", release: context.release ?? activeRelease },
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!active || !Sentry) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

export function resetSentryForTest(): void {
  Sentry = undefined;
  active = false;
  activeRelease = undefined;
  activeEnvironment = "production";
}

export function setSentryForTest(sentry: Pick<SentryClient, "withScope" | "captureException" | "flush">, options: { release?: string; environment?: string } = {}): void {
  Sentry = sentry as SentryClient;
  active = true;
  activeRelease = options.release;
  activeEnvironment = options.environment ?? "production";
}
