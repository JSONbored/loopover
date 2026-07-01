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

const SECRET_FIELD = /(?:authorization|cookie|token|secret|password|private[_-]?key|shared[_-]?secret)/i;
const SECRET_VALUE = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[a-f0-9]{64}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const REES_SENTRY_TAG_KEYS = [
  "event",
  "route",
  "method",
  "repo",
  "pullNumber",
  "analyzer",
  "release",
  "environment",
  "railwayDeploymentId",
] as const;

type ReesSentryTagKey = (typeof REES_SENTRY_TAG_KEYS)[number];
type ReesSentryTags = Partial<Record<ReesSentryTagKey, string | number | undefined>>;
type ReesCaptureOptions = {
  contextName: string;
  context: Record<string, unknown>;
  fingerprint: string[];
  level?: "error" | "warning";
  tags: ReesSentryTags;
};

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function resolveReesSentryRelease(env: NodeJS.ProcessEnv): string | undefined {
  return (
    nonBlank(env.SENTRY_RELEASE) ??
    (nonBlank(env.RAILWAY_GIT_COMMIT_SHA)
      ? `gittensory-rees@${nonBlank(env.RAILWAY_GIT_COMMIT_SHA)}`
      : undefined)
  );
}

export function resolveSentryEnvironment(env: NodeJS.ProcessEnv): string {
  return nonBlank(env.SENTRY_ENVIRONMENT) ?? nonBlank(env.RAILWAY_ENVIRONMENT_NAME) ?? "production";
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
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_FIELD.test(key) ? "[Filtered]" : scrubValue(entry),
      ]),
    );
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[Filtered]");
  return value;
}

function sentryTagValue(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scrubbed = scrubValue(String(value));
  if (typeof scrubbed !== "string") return undefined;
  const text = nonBlank(scrubbed);
  return text ? text.slice(0, 200) : undefined;
}

function compactContext(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function setAllowedTags(scope: Pick<SentryScope, "setTag">, tags: ReesSentryTags): void {
  for (const key of REES_SENTRY_TAG_KEYS) {
    const value = sentryTagValue(tags[key]);
    if (value) scope.setTag(key, value);
  }
}

function setFingerprint(scope: Pick<SentryScope, "setFingerprint">, parts: string[]): void {
  const safeParts = parts.map((part) => sentryTagValue(part) ?? "unknown");
  scope.setFingerprint(safeParts);
}

function captureScopedError(error: unknown, options: ReesCaptureOptions): void {
  if (!active || !Sentry) return;
  const safeContext = scrubValue(compactContext(options.context)) as Record<string, unknown>;
  Sentry.withScope((scope) => {
    scope.setLevel(options.level ?? "error");
    scope.setContext(options.contextName, safeContext);
    setFingerprint(scope, options.fingerprint);
    setAllowedTags(scope, {
      ...options.tags,
      event: options.tags.event,
      release: options.tags.release ?? activeRelease,
      environment: options.tags.environment ?? activeEnvironment,
    });
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
    activeRelease = resolveReesSentryRelease(env);
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
    warn("rees_sentry_init_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  captureScopedError(error, {
    contextName: "rees",
    context: {
      ...context,
      release: activeRelease,
      environment: activeEnvironment,
    },
    fingerprint: ["rees-error"],
    tags: {},
  });
}

export function captureRouteError(
  error: unknown,
  context: { route: string; method: string },
): void {
  captureScopedError(error, {
    contextName: "rees_route",
    context: {
      event: "rees_route_error",
      route: context.route,
      method: context.method,
      release: activeRelease,
      environment: activeEnvironment,
    },
    fingerprint: ["rees-route-error", context.route, context.method],
    tags: {
      event: "rees_route_error",
      route: context.route,
      method: context.method,
    },
  });
}

export function captureUnhandledError(
  error: unknown,
  context: { event: "rees_unhandled_rejection" | "rees_uncaught_exception" },
): void {
  captureScopedError(error, {
    contextName: "rees_process",
    context: {
      event: context.event,
      release: activeRelease,
      environment: activeEnvironment,
    },
    fingerprint: ["rees-process-error", context.event],
    tags: {
      event: context.event,
    },
  });
}

export function captureSourcemapUploadFailure(
  error: unknown,
  context: {
    release?: string;
    railwayDeploymentId?: string;
    strict?: boolean;
    sha?: string;
    stage?: string;
  },
): void {
  captureScopedError(error, {
    contextName: "rees_sourcemap_upload",
    context: {
      event: "rees_sourcemap_upload_failed",
      release: context.release ?? activeRelease,
      railwayDeploymentId: context.railwayDeploymentId,
      strict: context.strict,
      sha: context.sha,
      stage: context.stage,
      environment: activeEnvironment,
    },
    fingerprint: ["rees-sourcemap-upload-failed"],
    tags: {
      event: "rees_sourcemap_upload_failed",
      release: context.release ?? activeRelease,
      railwayDeploymentId: context.railwayDeploymentId,
    },
  });
}

export interface AnalyzerDegradationContext {
  analyzer: string;
  requestedAnalyzers?: string[];
  repoFullName: string;
  prNumber: number;
  headSha?: string;
  timeoutMs?: number;
  elapsedMs?: number;
  analyzerStatus?: string;
  profile?: string;
  costClass?: string;
  responseReserveMs?: number;
  partialStatus?: string;
  partialReason?: string;
  phase?: string;
  subcall?: string;
  endpointCategory?: string;
  externalFailureReason?: string;
  externalElapsedMs?: number;
  fileLookupCount?: number;
  commitLookupCount?: number;
  prLookupCount?: number;
  skippedFileCount?: number;
  githubEndpointCategory?: string;
  capped?: boolean;
  cacheHits?: number;
  cacheMisses?: number;
  externalCallsByCategory?: Record<string, number>;
  skippedWorkByCategory?: Record<string, number>;
  cappedWorkByCategory?: Record<string, number>;
  analysisElapsedMs?: number;
  requestId?: string;
  traceId?: string;
}

export function captureAnalyzerDegradation(error: unknown, context: AnalyzerDegradationContext): void {
  const headShaPrefix = nonBlank(context.headSha)?.slice(0, 12);
  captureScopedError(error, {
    contextName: "rees_analyzer",
    context: {
    event: "rees_analyzer_degraded",
    analyzer: context.analyzer,
    requestedAnalyzers: context.requestedAnalyzers,
    repoFullName: context.repoFullName,
    prNumber: context.prNumber,
    headShaPrefix,
    timeoutMs: context.timeoutMs,
    elapsedMs: context.elapsedMs,
    analyzerStatus: context.analyzerStatus,
    profile: context.profile,
    costClass: context.costClass,
    responseReserveMs: context.responseReserveMs,
    partialStatus: context.partialStatus,
    partialReason: context.partialReason,
    phase: context.phase,
    subcall: context.subcall,
    endpointCategory: context.endpointCategory,
    externalFailureReason: context.externalFailureReason,
    externalElapsedMs: context.externalElapsedMs,
    fileLookupCount: context.fileLookupCount,
    commitLookupCount: context.commitLookupCount,
    prLookupCount: context.prLookupCount,
    skippedFileCount: context.skippedFileCount,
    githubEndpointCategory: context.githubEndpointCategory,
    capped: context.capped,
    cacheHits: context.cacheHits,
    cacheMisses: context.cacheMisses,
    externalCallsByCategory: context.externalCallsByCategory,
    skippedWorkByCategory: context.skippedWorkByCategory,
    cappedWorkByCategory: context.cappedWorkByCategory,
    analysisElapsedMs: context.analysisElapsedMs,
    requestId: context.requestId,
    traceId: context.traceId,
    release: activeRelease,
    environment: activeEnvironment,
    },
    fingerprint: ["rees-analyzer-degraded", context.analyzer],
    tags: {
      event: "rees_analyzer_degraded",
      analyzer: context.analyzer,
      repo: context.repoFullName,
      pullNumber: context.prNumber,
    },
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

export function setSentryForTest(
  sentry: Pick<SentryClient, "withScope" | "captureException" | "flush">,
  options: { release?: string; environment?: string } = {},
): void {
  Sentry = sentry as SentryClient;
  active = true;
  activeRelease = options.release;
  activeEnvironment = options.environment ?? "production";
}
