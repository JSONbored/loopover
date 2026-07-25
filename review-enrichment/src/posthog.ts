// PostHog error tracking for review-enrichment (#8290, epic #8286). REPLACES Sentry entirely -- per the
// epic's revised strategy (2026-07-25 correction on #8286), PostHog is a straight swap-in, not a parallel
// sink; there is no more sentry.ts in this package. Kept structurally in lockstep with
// packages/discovery-index/src/posthog.ts's shape (redaction primitives, captureException(error, distinctId,
// properties)-based capture, fingerprint/tag structure) since the two services' Sentry modules used to mirror
// each other and there's no reason for their replacements not to. The one REES-specific addition,
// captureAnalyzerDegradationPostHog, mirrors the old captureAnalyzerDegradation's #5010 grouping choice
// (fingerprint by WHY -- partialReason -- not WHICH analyzer).
//
// No Railway-specific config: this repo no longer deploys anything on Railway. Release/environment are plain
// operator-set POSTHOG_RELEASE/POSTHOG_ENVIRONMENT with no platform-specific fallback derivation, matching
// how src/selfhost/posthog.ts's own release/environment resolution makes no deploy-platform assumptions.
import type { PostHog } from "posthog-node";

type PostHogClient = Pick<PostHog, "captureException" | "flush" | "shutdown">;

let client: PostHogClient | undefined;
let active = false;
let activeRelease: string | undefined;
let activeEnvironment = "production";

/** No per-user identity is tracked (operational error events, not user analytics) -- every event shares one
 *  anonymous, constant distinct id, matching every other PostHog sink in this repo's identical choice. */
const DISTINCT_ID = "loopover-rees";

/** PostHog US-cloud ingestion host, matching every other PostHog sink in this repo's default. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// Redaction rules preserved verbatim from the old sentry.ts (capture/redaction parity is an #8290
// deliverable) -- kept as a literal copy rather than an import so this module has no unnecessary
// compile-time coupling to discovery-index's sibling module, matching that module's own independence choice.
const SECRET_FIELD = /(?:authorization|cookie|token|secret|password|private[_-]?key|shared[_-]?secret)/i;
const SECRET_VALUE = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[a-f0-9]{64}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const REES_POSTHOG_TAG_KEYS = ["event", "route", "method", "repo", "pullNumber", "analyzer", "release", "environment", "deploymentId"] as const;

type ReesPostHogTagKey = (typeof REES_POSTHOG_TAG_KEYS)[number];
type ReesPostHogTags = Partial<Record<ReesPostHogTagKey, string | number | undefined>>;
type CaptureOptions = {
  fingerprint: string[];
  tags: ReesPostHogTags;
  /** Additional diagnostic properties outside the fixed tag allowlist (analyzer-degradation's rich
   *  diagnostics, sourcemap-upload's stage/sha) -- still scrubbed like everything else. */
  extra?: Record<string, unknown>;
};

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function resolveReesPostHogRelease(env: NodeJS.ProcessEnv): string | undefined {
  return nonBlank(env.POSTHOG_RELEASE) ?? (nonBlank(env.POSTHOG_COMMIT_SHA) ? `loopover-rees@${nonBlank(env.POSTHOG_COMMIT_SHA)}` : undefined);
}

export function resolvePostHogEnvironment(env: NodeJS.ProcessEnv): string {
  return nonBlank(env.POSTHOG_ENVIRONMENT) ?? "production";
}

/* v8 ignore start -- @preserve untestable without module mocking: warn()'s only call site is
 * initReesPostHog's catch branch below, itself ignored for the same reason (see that block's comment). */
function warn(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "warn", event, ...fields }));
}
/* v8 ignore stop */

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

function tagValue(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scrubbed = scrubValue(String(value));
  /* v8 ignore next -- @preserve unreachable: scrubValue(string) always returns a string, mirrors sentry.ts's identical sentryTagValue guard */
  if (typeof scrubbed !== "string") return undefined;
  const text = nonBlank(scrubbed);
  return text ? text.slice(0, 200) : undefined;
}

function compactContext(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function allowedTagProperties(tags: ReesPostHogTags): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const key of REES_POSTHOG_TAG_KEYS) {
    const value = tagValue(tags[key]);
    if (value) properties[key] = value;
  }
  return properties;
}

function fingerprint(parts: string[]): string {
  return parts.map((part) => tagValue(part) ?? "unknown").join("|");
}

function captureScopedError(error: unknown, options: CaptureOptions): void {
  if (!active || !client) return;
  const tags = { ...options.tags, release: options.tags.release ?? activeRelease, environment: options.tags.environment ?? activeEnvironment };
  const properties = { ...allowedTagProperties(tags), ...compactContext(options.extra ?? {}) };
  const safeProperties = scrubValue(properties) as Record<string, unknown>;
  safeProperties.$exception_fingerprint = fingerprint(options.fingerprint);
  client.captureException(error instanceof Error ? error : new Error(String(error)), DISTINCT_ID, safeProperties);
}

export async function initReesPostHog(env: NodeJS.ProcessEnv): Promise<boolean> {
  const apiKey = nonBlank(env.POSTHOG_API_KEY);
  if (!apiKey) return false;
  try {
    const { PostHog } = await import("posthog-node");
    activeRelease = resolveReesPostHogRelease(env);
    activeEnvironment = resolvePostHogEnvironment(env);
    client = new PostHog(apiKey, {
      host: nonBlank(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
      before_send: (event) => (event ? (scrubValue(event) as typeof event) : event),
    });
    active = true;
    return true;
    /* v8 ignore start -- @preserve untestable without module mocking: the sibling PostHog sinks in this repo
     * (src/selfhost/posthog.ts, src/api/worker-posthog.ts, packages/discovery-index/src/posthog.ts) exercise
     * this identical catch branch via vitest's vi.doMock, forcing posthog-node's dynamic import to throw.
     * review-enrichment uses node:test, whose equivalent (mock.module) requires
     * --experimental-test-module-mocks -- a flag this package's own "node": ">=20" engines range can't assume
     * (the feature needs Node 22.3+), and unconditionally calling mock.module() in a test file would crash
     * npm test outright for anyone running the flagless, Node-20-compatible path. No way found to make the
     * REAL posthog-node's PostHog constructor throw synchronously (a malformed host string doesn't) without
     * network access, which a unit test must not depend on. */
  } catch (error) {
    active = false;
    client = undefined;
    activeRelease = undefined;
    activeEnvironment = "production";
    warn("rees_posthog_init_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
  /* v8 ignore stop */
}

export function captureRoutePostHogError(error: unknown, context: { route: string; method: string }): void {
  captureScopedError(error, {
    fingerprint: ["rees-route-error", context.route, context.method],
    tags: { event: "rees_route_error", route: context.route, method: context.method },
  });
}

export function captureUnhandledPostHogError(error: unknown, context: { event: "rees_unhandled_rejection" | "rees_uncaught_exception" }): void {
  captureScopedError(error, {
    fingerprint: ["rees-process-error", context.event],
    tags: { event: context.event },
  });
}

export function captureSourcemapUploadPostHogFailure(
  error: unknown,
  context: { release?: string; deploymentId?: string; strict?: boolean; sha?: string; stage?: string },
): void {
  captureScopedError(error, {
    fingerprint: ["rees-sourcemap-upload-failed"],
    tags: { event: "rees_sourcemap_upload_failed", release: context.release ?? activeRelease, deploymentId: context.deploymentId },
    extra: { strict: context.strict, sha: context.sha, stage: context.stage },
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

/** Mirrors sentry.ts's captureAnalyzerDegradation exactly, including its #5010 grouping choice: fingerprint by
 *  WHY (partialReason) rather than WHICH analyzer, since the generic reasons share one root cause (the shared,
 *  dynamically-shrinking per-analyzer time budget) regardless of which analyzer's turn it was. */
export function captureAnalyzerDegradationPostHog(error: unknown, context: AnalyzerDegradationContext): void {
  const headShaPrefix = nonBlank(context.headSha)?.slice(0, 12);
  captureScopedError(error, {
    fingerprint: ["rees-analyzer-degraded", context.partialReason ?? context.analyzer],
    tags: { event: "rees_analyzer_degraded", analyzer: context.analyzer, repo: context.repoFullName, pullNumber: context.prNumber },
    extra: {
      requestedAnalyzers: context.requestedAnalyzers,
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
    },
  });
}

export async function flushReesPostHog(): Promise<void> {
  if (!active || !client) return;
  await client.flush().catch(() => undefined);
}

export async function shutdownReesPostHog(): Promise<void> {
  if (!active || !client) return;
  await client.shutdown().catch(() => undefined);
}

export function resetReesPostHogForTest(): void {
  client = undefined;
  active = false;
  activeRelease = undefined;
  activeEnvironment = "production";
}

export function setReesPostHogForTest(posthog: PostHogClient, options: { release?: string; environment?: string } = {}): void {
  client = posthog;
  active = true;
  activeRelease = options.release;
  activeEnvironment = options.environment ?? "production";
}
