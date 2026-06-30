import type { ErrorEvent, EventHint } from "@sentry/node";

type SentryNs = typeof import("@sentry/node");
type SentryClient = Pick<SentryNs, "init" | "withScope" | "captureException" | "flush">;

let Sentry: SentryClient | undefined;
let active = false;
let activeRelease: string | undefined;
let activeEnvironment = "production";

const SECRET_FIELD = /(?:authorization|cookie|token|secret|password|private[_-]?key|shared[_-]?secret)/i;
const SECRET_VALUE = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[a-f0-9]{64}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

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
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext("rees", scrubValue(context) as Record<string, unknown>);
    Sentry!.captureException(error instanceof Error ? error : new Error(String(error)));
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
  if (!active || !Sentry) return;
  const headShaPrefix = nonBlank(context.headSha)?.slice(0, 12);
  const safeContext = {
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
  };
  Sentry.withScope((scope) => {
    const analyzerTag = sentryTagValue(context.analyzer) ?? "unknown";
    const headShaTag = sentryTagValue(headShaPrefix);
    const timeoutTag = sentryTagValue(context.timeoutMs);
    const releaseTag = sentryTagValue(activeRelease);
    scope.setLevel("error");
    scope.setContext("rees_analyzer", scrubValue(compactContext(safeContext)) as Record<string, unknown>);
    scope.setFingerprint(["rees-analyzer-degraded", analyzerTag]);
    scope.setTag("event", "rees_analyzer_degraded");
    scope.setTag("analyzer", analyzerTag);
    scope.setTag("repo", sentryTagValue(context.repoFullName) ?? "unknown");
    scope.setTag("pullNumber", sentryTagValue(context.prNumber) ?? "unknown");
    if (headShaTag) scope.setTag("headShaPrefix", headShaTag);
    if (timeoutTag) scope.setTag("timeoutMs", timeoutTag);
    if (releaseTag) scope.setTag("release", releaseTag);
    const analyzerStatusTag = sentryTagValue(context.analyzerStatus);
    const profileTag = sentryTagValue(context.profile);
    const costClassTag = sentryTagValue(context.costClass);
    const responseReserveTag = sentryTagValue(context.responseReserveMs);
    const partialStatusTag = sentryTagValue(context.partialStatus);
    const phaseTag = sentryTagValue(context.phase);
    const endpointCategoryTag = sentryTagValue(context.endpointCategory);
    const externalFailureReasonTag = sentryTagValue(context.externalFailureReason);
    const endpointTag = sentryTagValue(context.githubEndpointCategory);
    const requestIdTag = sentryTagValue(context.requestId);
    const traceIdTag = sentryTagValue(context.traceId);
    const cacheHitsTag = sentryTagValue(context.cacheHits);
    const cacheMissesTag = sentryTagValue(context.cacheMisses);
    if (analyzerStatusTag) scope.setTag("analyzerStatus", analyzerStatusTag);
    if (profileTag) scope.setTag("profile", profileTag);
    if (costClassTag) scope.setTag("costClass", costClassTag);
    if (responseReserveTag) scope.setTag("responseReserveMs", responseReserveTag);
    if (partialStatusTag) scope.setTag("partialStatus", partialStatusTag);
    if (phaseTag) scope.setTag("phase", phaseTag);
    if (endpointCategoryTag) scope.setTag("endpointCategory", endpointCategoryTag);
    if (externalFailureReasonTag) scope.setTag("externalFailureReason", externalFailureReasonTag);
    if (endpointTag) scope.setTag("githubEndpointCategory", endpointTag);
    if (requestIdTag) scope.setTag("requestId", requestIdTag);
    if (traceIdTag) scope.setTag("traceId", traceIdTag);
    if (cacheHitsTag) scope.setTag("cacheHits", cacheHitsTag);
    if (cacheMissesTag) scope.setTag("cacheMisses", cacheMissesTag);
    scope.setTag("environment", sentryTagValue(activeEnvironment) ?? "production");
    Sentry!.captureException(error instanceof Error ? error : new Error(String(error)));
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
