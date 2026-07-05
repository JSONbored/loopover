import { pathToFileURL } from "node:url";

const DEFAULT_SENTRY_URL = "https://sentry.io";

const TRUE_VALUE = /^(1|true|yes|on)$/i;
const FALSE_VALUE = /^(0|false|no|off)$/i;

export class SentryReleaseValidationError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "SentryReleaseValidationError";
    this.failures = failures;
  }
}

function nonBlank(value) {
  const text = typeof value === "string" ? value.trim() : undefined;
  return text ? text : undefined;
}

function boolEnv(value, fallback) {
  const text = nonBlank(value);
  if (!text) return fallback;
  if (TRUE_VALUE.test(text)) return true;
  if (FALSE_VALUE.test(text)) return false;
  return fallback;
}

function apiBaseUrl(value) {
  return (nonBlank(value) ?? DEFAULT_SENTRY_URL).replace(/\/+$/, "");
}

export function loadSentryReleaseValidationConfig(env = process.env) {
  return {
    authToken: nonBlank(env.SENTRY_AUTH_TOKEN),
    org: nonBlank(env.SENTRY_ORG),
    project: nonBlank(env.SENTRY_PROJECT),
    release: nonBlank(env.SENTRY_RELEASE),
    baseUrl: apiBaseUrl(env.SENTRY_URL),
    expectedCommitSha:
      nonBlank(env.SENTRY_EXPECT_COMMIT_SHA) ??
      nonBlank(env.SENTRY_COMMIT_SHA) ??
      nonBlank(env.RAILWAY_GIT_COMMIT_SHA),
    expectedDeployName: nonBlank(env.SENTRY_DEPLOY_NAME) ?? nonBlank(env.RAILWAY_DEPLOYMENT_ID),
    expectedEnvironment:
      nonBlank(env.SENTRY_ENVIRONMENT) ??
      nonBlank(env.RAILWAY_ENVIRONMENT_NAME) ??
      "production",
    requireCommits: boolEnv(env.SENTRY_REQUIRE_COMMITS, true),
    requireDeploy: boolEnv(env.SENTRY_REQUIRE_DEPLOY, false),
    requireFinalized: boolEnv(env.SENTRY_REQUIRE_FINALIZED, true),
    requireReleaseFiles: boolEnv(env.SENTRY_REQUIRE_RELEASE_FILES, false),
  };
}

function requireConfig(config) {
  const missing = [
    ["SENTRY_AUTH_TOKEN", config.authToken],
    ["SENTRY_ORG", config.org],
    ["SENTRY_PROJECT", config.project],
    ["SENTRY_RELEASE", config.release],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new SentryReleaseValidationError("missing Sentry release validation config", [
      `missing ${missing.join(", ")}`,
    ]);
  }
}

function apiUrl(config, segments) {
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${config.baseUrl}/api/0/${encoded}/`;
}

async function sentryJson(config, segments, fetchImpl) {
  const response = await fetchImpl(apiUrl(config, segments), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.authToken}`,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body?.detail ?? body?.error ?? body?.message ?? message;
    } catch {
      /* Keep the status text when the body is not JSON. */
    }
    throw new SentryReleaseValidationError("Sentry API request failed", [
      `${segments.join("/")} returned HTTP ${response.status}${message ? ` (${message})` : ""}`,
    ]);
  }
  return response.json();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

function stringField(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return undefined;
}

function releaseProjects(release) {
  return asArray(release?.projects)
    .map((project) => stringField(project, ["slug", "name"]))
    .filter(Boolean);
}

function isFinalized(release) {
  return Boolean(stringField(release, ["dateReleased", "released", "releaseDate"]));
}

function commitIdsFrom(value, results = []) {
  if (!value || typeof value !== "object") return results;
  for (const key of ["id", "sha", "commitId", "shortId"]) {
    const id = value[key];
    if (typeof id === "string" && id.trim()) results.push(id.trim());
  }
  for (const key of ["commit", "lastCommit", "previousCommit"]) commitIdsFrom(value[key], results);
  return results;
}

function commitMatches(expected, candidates) {
  const wanted = expected.toLowerCase();
  return candidates.some((candidate) => {
    const got = candidate.toLowerCase();
    return got === wanted || got.startsWith(wanted) || wanted.startsWith(got);
  });
}

function deployField(deploy, keys) {
  if (!deploy || typeof deploy !== "object") return undefined;
  for (const key of keys) {
    const value = deploy[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = stringField(value, ["name", "slug", "id"]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function deployMatches(deploy, config) {
  const name = deployField(deploy, ["name", "id"]);
  const environment = deployField(deploy, ["environment", "env"]);
  if (config.expectedDeployName && name !== config.expectedDeployName) return false;
  if (config.expectedEnvironment && environment !== config.expectedEnvironment) return false;
  return true;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function logError(event, fields = {}) {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

export async function validateSentryRelease(env = process.env, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new SentryReleaseValidationError("fetch is unavailable", ["Node 20+ fetch support is required"]);
  }

  const config = loadSentryReleaseValidationConfig(env);
  requireConfig(config);

  const release = await sentryJson(
    config,
    ["organizations", config.org, "releases", config.release],
    fetchImpl,
  );

  const failures = [];
  if (release?.version && release.version !== config.release) {
    failures.push(`release version mismatch: expected ${config.release}, got ${release.version}`);
  }

  const projects = releaseProjects(release);
  if (projects.length > 0 && !projects.includes(config.project)) {
    failures.push(`release is not associated with Sentry project ${config.project}`);
  }

  if (config.requireFinalized && !isFinalized(release)) {
    failures.push("release is not finalized");
  }

  let commits = [];
  if (config.requireCommits || config.expectedCommitSha) {
    commits = asArray(
      await sentryJson(
        config,
        ["organizations", config.org, "releases", config.release, "commits"],
        fetchImpl,
      ),
    );
    const commitCount =
      typeof release?.commitCount === "number" ? release.commitCount : commits.length;
    const commitIds = [
      ...commitIdsFrom(release),
      ...commits.flatMap((commit) => commitIdsFrom(commit)),
    ];
    if (config.requireCommits && commitCount <= 0 && commitIds.length === 0) {
      failures.push("release has no associated commits");
    }
    if (config.requireCommits && config.expectedCommitSha && !commitMatches(config.expectedCommitSha, commitIds)) {
      failures.push(`release commits do not include expected commit ${config.expectedCommitSha}`);
    }
  }

  let deploys = [];
  if (config.requireDeploy) {
    deploys = asArray(
      await sentryJson(
        config,
        ["organizations", config.org, "releases", config.release, "deploys"],
        fetchImpl,
      ),
    );
    const deployCount =
      typeof release?.deployCount === "number" ? release.deployCount : deploys.length;
    const releaseDeploy = release?.lastDeploy ? [release.lastDeploy] : [];
    const allDeploys = [...deploys, ...releaseDeploy];
    if (deployCount <= 0 && allDeploys.length === 0) {
      failures.push("release has no associated deploys");
    } else if (!allDeploys.some((deploy) => deployMatches(deploy, config))) {
      failures.push(
        `release deploys do not include ${config.expectedEnvironment}/${config.expectedDeployName ?? "any"}`,
      );
    }
  }

  let releaseFiles = [];
  if (config.requireReleaseFiles) {
    releaseFiles = asArray(
      await sentryJson(
        config,
        ["projects", config.org, config.project, "releases", config.release, "files"],
        fetchImpl,
      ),
    );
    if (releaseFiles.length === 0) {
      failures.push("release has no release files");
    }
  }

  if (failures.length > 0) {
    throw new SentryReleaseValidationError("Sentry release validation failed", failures);
  }

  return {
    release: config.release,
    project: config.project,
    finalized: isFinalized(release),
    commitCount: typeof release?.commitCount === "number" ? release.commitCount : commits.length,
    deployCount: typeof release?.deployCount === "number" ? release.deployCount : deploys.length,
    releaseFileCount: releaseFiles.length,
  };
}

async function main() {
  try {
    const result = await validateSentryRelease();
    log("sentry_release_validation_complete", result);
  } catch (error) {
    const failures = Array.isArray(error?.failures) ? error.failures : [String(error)];
    logError("sentry_release_validation_failed", {
      release: nonBlank(process.env.SENTRY_RELEASE),
      failures,
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
