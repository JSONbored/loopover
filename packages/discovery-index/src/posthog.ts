// PostHog error tracking for discovery-index (#8289, epic #8286). REPLACES Sentry entirely -- per the epic's
// revised strategy (2026-07-25 correction on #8286), PostHog is a straight swap-in, not a parallel sink; there
// is no more sentry.ts in this package. This service runs as a long-lived Node process in a Cloudflare
// Container (not a Workers isolate), so posthog-node's default batching client is fine here -- unlike
// src/api/worker-posthog.ts's per-request ephemeral-client design for the actual Workers isolate path, this
// mirrors src/selfhost/posthog.ts's long-running-server posture.
//
// Deliberately kept the shape the now-deleted sentry.ts had (redaction, tag allowlist, capture entry points)
// rather than PostHog's own withScope-free API design, so the swap stayed a straightforward like-for-like
// replacement. PostHog has no Sentry-style context/tags split -- captureException's flat properties bag carries
// the SAME allowlisted fields the old sentry.ts's setAllowedTags exposed as tags (DISCOVERY_INDEX_POSTHOG_TAG_KEYS),
// not the raw context object, so the redaction surface matches the sink it replaced.
import type { PostHog } from "posthog-node";

type PostHogClient = Pick<PostHog, "captureException" | "flush" | "shutdown">;

let client: PostHogClient | undefined;
let active = false;
let activeRelease: string | undefined;
let activeEnvironment = "production";

/** No per-user identity is tracked (operational error events, not user analytics) -- every event shares one
 *  anonymous, constant distinct id, matching src/selfhost/posthog.ts's identical POSTHOG_DISTINCT_ID choice. */
const DISTINCT_ID = "loopover-discovery-index";

/** PostHog US-cloud ingestion host, matching every other PostHog sink in this repo's default. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// The redaction rules match the SECRET_FIELD/SECRET_VALUE the now-deleted sentry.ts used (#8289 deliverable:
// capture/redaction parity with the Sentry sink PostHog replaced) -- defined literally here rather than shared
// via an import, so this module stays self-contained, exactly as review-enrichment/src/posthog.ts keeps its own
// copy; the two packages' PostHog modules deliberately stay structurally in lockstep without a compile-time
// dependency between them.
const SECRET_FIELD = /(?:authorization|cookie|token|secret|password|private[_-]?key|shared[_-]?secret)/i;
const SECRET_VALUE = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const DISCOVERY_INDEX_POSTHOG_TAG_KEYS = ["event", "route", "method", "release", "environment"] as const;

type DiscoveryIndexPostHogTagKey = (typeof DISCOVERY_INDEX_POSTHOG_TAG_KEYS)[number];
type DiscoveryIndexPostHogTags = Partial<Record<DiscoveryIndexPostHogTagKey, string | number | undefined>>;
type CaptureOptions = {
  fingerprint: string[];
  tags: DiscoveryIndexPostHogTags;
  /** Additional diagnostic properties outside the fixed tag allowlist (e.g. captureSourcemapUploadPostHogFailure's
   *  deploymentId/strict/sha) -- still scrubbed like everything else, just not one of the five stable tag keys. */
  extra?: Record<string, unknown>;
};

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function resolveDiscoveryIndexPostHogRelease(env: NodeJS.ProcessEnv): string | undefined {
  return nonBlank(env.POSTHOG_RELEASE) ?? (nonBlank(env.POSTHOG_COMMIT_SHA) ? `loopover-discovery-index@${nonBlank(env.POSTHOG_COMMIT_SHA)}` : undefined);
}

export function resolvePostHogEnvironment(env: NodeJS.ProcessEnv): string {
  return nonBlank(env.POSTHOG_ENVIRONMENT) ?? "production";
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

function tagValue(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scrubbed = scrubValue(String(value));
  /* v8 ignore next -- @preserve unreachable: scrubValue(string) always returns a string, mirrored the now-deleted sentry.ts's identical sentryTagValue guard */
  if (typeof scrubbed !== "string") return undefined;
  const text = nonBlank(scrubbed);
  return text ? text.slice(0, 200) : undefined;
}

function compactContext(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function allowedTagProperties(tags: DiscoveryIndexPostHogTags): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const key of DISCOVERY_INDEX_POSTHOG_TAG_KEYS) {
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
  const properties = {
    ...allowedTagProperties(tags),
    ...compactContext(options.extra ?? {}),
  };
  const safeProperties = scrubValue(properties) as Record<string, unknown>;
  safeProperties.$exception_fingerprint = fingerprint(options.fingerprint);
  client.captureException(error instanceof Error ? error : new Error(String(error)), DISTINCT_ID, safeProperties);
}

export async function initDiscoveryIndexPostHog(env: NodeJS.ProcessEnv): Promise<boolean> {
  const apiKey = nonBlank(env.POSTHOG_API_KEY);
  if (!apiKey) return false;
  try {
    const { PostHog } = await import("posthog-node");
    activeRelease = resolveDiscoveryIndexPostHogRelease(env);
    activeEnvironment = resolvePostHogEnvironment(env);
    client = new PostHog(apiKey, {
      host: nonBlank(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
      before_send: (event) => (event ? (scrubValue(event) as typeof event) : event),
    });
    active = true;
    return true;
  } catch (error) {
    active = false;
    client = undefined;
    activeRelease = undefined;
    activeEnvironment = "production";
    warn("discovery_index_posthog_init_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function captureRoutePostHogError(error: unknown, context: { route: string; method: string }): void {
  captureScopedError(error, {
    fingerprint: ["discovery-index-route-error", context.route, context.method],
    tags: { event: "discovery_index_route_error", route: context.route, method: context.method },
  });
}

export function captureUnhandledPostHogError(error: unknown, context: { event: "discovery_index_unhandled_rejection" | "discovery_index_uncaught_exception" }): void {
  captureScopedError(error, {
    fingerprint: ["discovery-index-process-error", context.event],
    tags: { event: context.event },
  });
}

export function captureSourcemapUploadPostHogFailure(
  error: unknown,
  context: { release?: string | undefined; deploymentId?: string | undefined; strict?: boolean; sha?: string | undefined },
): void {
  captureScopedError(error, {
    fingerprint: ["discovery-index-sourcemap-upload-failed"],
    tags: { event: "discovery_index_sourcemap_upload_failed", release: context.release ?? activeRelease },
    extra: { deploymentId: context.deploymentId, strict: context.strict, sha: context.sha },
  });
}

export async function flushDiscoveryIndexPostHog(): Promise<void> {
  if (!active || !client) return;
  await client.flush().catch(() => undefined);
}

export async function shutdownDiscoveryIndexPostHog(): Promise<void> {
  if (!active || !client) return;
  await client.shutdown().catch(() => undefined);
}

export function resetDiscoveryIndexPostHogForTest(): void {
  client = undefined;
  active = false;
  activeRelease = undefined;
  activeEnvironment = "production";
}

export function setDiscoveryIndexPostHogForTest(posthog: PostHogClient, options: { release?: string; environment?: string } = {}): void {
  client = posthog;
  active = true;
  activeRelease = options.release;
  activeEnvironment = options.environment ?? "production";
}
