// PostHog release/sourcemap-upload verification (#8289), the PostHog counterpart to validate-sentry-release.mjs.
// PostHog's release model is intentionally much simpler than Sentry's -- there is no separate release
// resource with its own commits/deploys/finalize lifecycle; a release is purely a version string baked into
// each uploaded symbol set's metadata as a byproduct of `posthog-cli sourcemap upload`. This script therefore
// verifies a narrower, honestly-scoped claim than its Sentry sibling: that at least one symbol set exists for
// our release, and none of them recorded a failure_reason. There is no PostHog equivalent to check for
// "commits associated" or "deploy recorded" or "finalized" -- those concepts don't exist in this API.
import { pathToFileURL } from "node:url";

const DEFAULT_POSTHOG_APP_HOST = "https://us.posthog.com";

export class PostHogReleaseValidationError extends Error {
  readonly failures: string[];
  constructor(message: string, failures: string[] = []) {
    super(message);
    this.name = "PostHogReleaseValidationError";
    this.failures = failures;
  }
}

/** The nested release object PostHog returns on a symbol set (never a flat string -- see
 *  releaseIdentifier below). */
type PostHogRelease = { project?: string | undefined; version?: string | undefined };

/** One symbol set as the error_tracking API returns it. */
type PostHogSymbolSet = { release?: PostHogRelease | undefined; failure_reason?: string | undefined };

export type PostHogReleaseValidationConfig = {
  apiKey: string | undefined;
  projectId: string | undefined;
  release: string | undefined;
  baseUrl: string;
};

/** Only the vars this script actually reads. Deliberately NOT NodeJS.ProcessEnv: typing it as the
 *  full environment would force every caller (and every test) to supply the ~50 unrelated vars the
 *  app's own ProcessEnv declares, for a script that reads three. */
type PostHogReleaseEnv = Record<string, string | undefined>;

function nonBlank(value: string | undefined): string | undefined {
  const text = typeof value === "string" ? value.trim() : undefined;
  return text ? text : undefined;
}

function apiBaseUrl(value: string | undefined): string {
  return (nonBlank(value) ?? DEFAULT_POSTHOG_APP_HOST).replace(/\/+$/, "");
}

// GET .../error_tracking/symbol_sets returns each symbol set's `release` as a NESTED OBJECT
// ({id, hash_id, created_at, metadata, version, project}, per PostHog's own
// ErrorTrackingRelease/ErrorTrackingSymbolSet dataclasses) -- never a flat string. Reconstructing
// "{project}@{version}" here is what actually makes this comparable to our own POSTHOG_RELEASE
// convention (the same "{release-name}@{release-version}" split posthog-cli's --release-name/
// --release-version flags combine server-side into the release posthog-cli itself resolves).
function releaseIdentifier(release: PostHogRelease | undefined): string | undefined {
  if (!release || typeof release !== "object") return undefined;
  const project = nonBlank(release.project);
  const version = nonBlank(release.version);
  return project && version ? `${project}@${version}` : undefined;
}

export function loadPostHogReleaseValidationConfig(env: PostHogReleaseEnv = process.env): PostHogReleaseValidationConfig {
  return {
    // The same personal API key posthog-cli's upload step uses (error-tracking write + organization read
    // scopes) -- listing symbol sets needs error_tracking:read, which that scope grant already covers.
    apiKey: nonBlank(env.POSTHOG_CLI_API_KEY),
    projectId: nonBlank(env.POSTHOG_CLI_PROJECT_ID),
    release: nonBlank(env.POSTHOG_RELEASE),
    baseUrl: apiBaseUrl(env.POSTHOG_CLI_HOST),
  };
}

function requireConfig(config: PostHogReleaseValidationConfig): void {
  const missing: string[] = ([
    ["POSTHOG_CLI_API_KEY", config.apiKey],
    ["POSTHOG_CLI_PROJECT_ID", config.projectId],
    ["POSTHOG_RELEASE", config.release],
  ] as Array<[string, string | undefined]>)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new PostHogReleaseValidationError("missing PostHog release validation config", [`missing ${missing.join(", ")}`]);
  }
}

function symbolSetsUrl(config: PostHogReleaseValidationConfig): string {
  // requireConfig has already thrown if these are missing; TS cannot narrow across that call.
  return `${config.baseUrl}/api/projects/${encodeURIComponent(config.projectId ?? "")}/error_tracking/symbol_sets?limit=100`;
}

async function fetchSymbolSets(config: PostHogReleaseValidationConfig, fetchImpl: typeof globalThis.fetch): Promise<PostHogSymbolSet[]> {
  const response = await fetchImpl(symbolSetsUrl(config), {
    headers: { accept: "application/json", authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { detail?: string; error?: string; message?: string };
      message = body?.detail ?? body?.error ?? body?.message ?? message;
    } catch {
      /* Keep the status text when the body is not JSON. */
    }
    throw new PostHogReleaseValidationError("PostHog API request failed", [`error_tracking/symbol_sets returned HTTP ${response.status}${message ? ` (${message})` : ""}`]);
  }
  const body = (await response.json()) as PostHogSymbolSet[] | { results?: PostHogSymbolSet[] };
  return Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

export async function validatePostHogRelease(env: PostHogReleaseEnv = process.env, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new PostHogReleaseValidationError("fetch is unavailable", ["Node 20+ fetch support is required"]);
  }

  const config = loadPostHogReleaseValidationConfig(env);
  requireConfig(config);

  const symbolSets = await fetchSymbolSets(config, fetchImpl);
  const forRelease = symbolSets.filter((set: PostHogSymbolSet) => releaseIdentifier(set?.release) === config.release);

  const failures = [];
  if (forRelease.length === 0) {
    failures.push(`no symbol sets found for release ${config.release}`);
  }
  const failed = forRelease.filter((set: PostHogSymbolSet) => nonBlank(set?.failure_reason));
  if (failed.length > 0) {
    failures.push(`${failed.length} symbol set(s) for release ${config.release} recorded a failure_reason`);
  }

  if (failures.length > 0) {
    throw new PostHogReleaseValidationError("PostHog release validation failed", failures);
  }

  return { release: config.release, symbolSetCount: forRelease.length };
}

async function main() {
  try {
    const result = await validatePostHogRelease();
    log("discovery_index_posthog_release_validation_complete", result);
  } catch (error) {
    const failures = error instanceof PostHogReleaseValidationError ? error.failures : [String(error)];
    logError("discovery_index_posthog_release_validation_failed", { release: nonBlank(process.env.POSTHOG_RELEASE), failures });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
