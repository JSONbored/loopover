// PostHog release/sourcemap-upload verification (#8290), replacing the old validate-sentry-release.mjs.
// PostHog's release model is intentionally much simpler than Sentry's -- there is no separate release
// resource with its own commits/deploys/finalize lifecycle; a release is purely a version string baked into
// each uploaded symbol set's metadata as a byproduct of `posthog-cli sourcemap upload`. This script therefore
// verifies a narrower, honestly-scoped claim: that at least one symbol set exists for our release, and none
// of them recorded a failure_reason. Mirrors packages/discovery-index/scripts/validate-posthog-release.ts.
import { pathToFileURL } from "node:url";

const DEFAULT_POSTHOG_APP_HOST = "https://us.posthog.com";

export class PostHogReleaseValidationError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "PostHogReleaseValidationError";
    this.failures = failures;
  }
}

function nonBlank(value) {
  const text = typeof value === "string" ? value.trim() : undefined;
  return text ? text : undefined;
}

function apiBaseUrl(value) {
  return (nonBlank(value) ?? DEFAULT_POSTHOG_APP_HOST).replace(/\/+$/, "");
}

// GET .../error_tracking/symbol_sets returns each symbol set's `release` as a NESTED OBJECT
// ({id, hash_id, created_at, metadata, version, project}, per PostHog's own
// ErrorTrackingRelease/ErrorTrackingSymbolSet dataclasses) -- never a flat string. Reconstructing
// "{project}@{version}" here is what actually makes this comparable to our own POSTHOG_RELEASE
// convention (the same "{release-name}@{release-version}" split posthog-cli's --release-name/
// --release-version flags combine server-side into the release posthog-cli itself resolves).
function releaseIdentifier(release) {
  if (!release || typeof release !== "object") return undefined;
  const project = nonBlank(release.project);
  const version = nonBlank(release.version);
  return project && version ? `${project}@${version}` : undefined;
}

export function loadPostHogReleaseValidationConfig(env = process.env) {
  return {
    // The same personal API key posthog-cli's upload step uses (error-tracking write + organization read
    // scopes) -- listing symbol sets needs error_tracking:read, which that scope grant already covers.
    apiKey: nonBlank(env.POSTHOG_CLI_API_KEY),
    projectId: nonBlank(env.POSTHOG_CLI_PROJECT_ID),
    release: nonBlank(env.POSTHOG_RELEASE),
    baseUrl: apiBaseUrl(env.POSTHOG_CLI_HOST),
  };
}

function requireConfig(config) {
  const missing = [
    ["POSTHOG_CLI_API_KEY", config.apiKey],
    ["POSTHOG_CLI_PROJECT_ID", config.projectId],
    ["POSTHOG_RELEASE", config.release],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new PostHogReleaseValidationError("missing PostHog release validation config", [`missing ${missing.join(", ")}`]);
  }
}

function symbolSetsUrl(config) {
  return `${config.baseUrl}/api/projects/${encodeURIComponent(config.projectId)}/error_tracking/symbol_sets?limit=100`;
}

async function fetchSymbolSets(config, fetchImpl) {
  const response = await fetchImpl(symbolSetsUrl(config), {
    headers: { accept: "application/json", authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body?.detail ?? body?.error ?? body?.message ?? message;
    } catch {
      /* Keep the status text when the body is not JSON. */
    }
    throw new PostHogReleaseValidationError("PostHog API request failed", [`error_tracking/symbol_sets returned HTTP ${response.status}${message ? ` (${message})` : ""}`]);
  }
  const body = await response.json();
  return Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function logError(event, fields = {}) {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

export async function validatePostHogRelease(env = process.env, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new PostHogReleaseValidationError("fetch is unavailable", ["Node 20+ fetch support is required"]);
  }

  const config = loadPostHogReleaseValidationConfig(env);
  requireConfig(config);

  const symbolSets = await fetchSymbolSets(config, fetchImpl);
  const forRelease = symbolSets.filter((set) => releaseIdentifier(set?.release) === config.release);

  const failures = [];
  if (forRelease.length === 0) {
    failures.push(`no symbol sets found for release ${config.release}`);
  }
  const failed = forRelease.filter((set) => nonBlank(set?.failure_reason));
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
    log("rees_posthog_release_validation_complete", result);
  } catch (error) {
    const failures = Array.isArray(error?.failures) ? error.failures : [String(error)];
    logError("rees_posthog_release_validation_failed", { release: nonBlank(process.env.POSTHOG_RELEASE), failures });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
