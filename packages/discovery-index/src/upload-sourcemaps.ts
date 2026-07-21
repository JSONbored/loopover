// Uploads this build's source maps to Sentry at container startup, then deletes them before the real
// server starts (see the Dockerfile's runtime CMD) -- mirrors review-enrichment/src/upload-sourcemaps.ts
// (a comparably-sized standalone service with the identical Sentry setup), adapted only by dropping that
// copy's Railway-specific env vars (RAILWAY_GIT_COMMIT_SHA, RAILWAY_DEPLOYMENT_ID, RAILWAY_ENVIRONMENT_NAME)
// since discovery-index deploys via a Cloudflare Container (#7167), not Railway.
//
// Running this at CONTAINER STARTUP rather than at Docker BUILD time is deliberate: SENTRY_AUTH_TOKEN is a
// real secret, injected the same way DISCOVERY_INDEX_SHARED_SECRET/DISCOVERY_INDEX_GITHUB_TOKEN already are
// (worker.ts's Container envVars) -- it is never a Docker build-time value, so it never risks being baked
// into a cached image layer.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { captureSourcemapUploadFailure, flushSentry, initSentry, resolveDiscoveryIndexSentryRelease, resolveSentryEnvironment } from "./sentry.js";

const require = createRequire(import.meta.url);

type RunOptions = {
  allowExistingRelease?: boolean;
  allowFailure?: boolean;
};

const distDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(distDir, "..");

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function warn(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "warn", event, ...fields }));
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .filter((path) => statSync(path).isFile())
    .sort();
}

function validateSourceMaps(): void {
  const serverBundle = resolve(distDir, "server.js");
  const serverMap = resolve(distDir, "server.js.map");
  if (!existsSync(serverBundle)) throw new Error("dist/server.js is missing");
  if (!existsSync(serverMap)) throw new Error("dist/server.js.map is missing");
  if (!readFileSync(serverBundle, "utf8").includes("//# sourceMappingURL=server.js.map")) {
    throw new Error("dist/server.js is missing the server.js.map sourceMappingURL");
  }

  const maps = listFiles(distDir).filter((path) => path.endsWith(".js.map"));
  if (maps.length === 0) throw new Error("dist has no JavaScript source maps");

  let sawServerSource = false;
  for (const path of maps) {
    const map = JSON.parse(readFileSync(path, "utf8")) as { sources?: unknown; sourcesContent?: unknown };
    const label = relative(appDir, path);
    if (!Array.isArray(map.sources) || map.sources.length === 0) {
      throw new Error(`${label} has no original sources`);
    }
    if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
      throw new Error(`${label} does not embed sourcesContent for every source`);
    }
    if (!map.sourcesContent.some((source) => typeof source === "string" && source.trim().length > 0)) {
      throw new Error(`${label} has empty sourcesContent`);
    }
    if (map.sources.some((source) => String(source).replaceAll("\\", "/").endsWith("src/server.ts"))) {
      sawServerSource = true;
    }
  }
  if (!sawServerSource) throw new Error("source maps do not include src/server.ts");
}

// Resolved via require.resolve, not a hardcoded packages/discovery-index/node_modules/.bin/ path: unlike
// review-enrichment (a standalone, non-workspace package this file otherwise mirrors), discovery-index is
// a real npm workspace member, so npm hoists @sentry/cli's binary to the ROOT node_modules/.bin/ by default
// -- a package-relative path assumption would silently look in the wrong place. Same resolution pattern as
// the root repo's own scripts/gen-cf-typegen.mjs resolveLocalWranglerBin().
function sentryCliPath(): string {
  const override = nonBlank(process.env.SENTRY_CLI_PATH);
  if (override) return override;
  const pkgJsonPath = require.resolve("@sentry/cli/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
  const binRelativePath = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.["sentry-cli"] ?? pkg.bin?.["@sentry/cli"]);
  if (!binRelativePath) throw new Error("@sentry/cli package.json has no resolvable bin entry");
  return join(dirname(pkgJsonPath), binRelativePath);
}

function runSentry(args: string[], options: RunOptions = {}): void {
  const result = spawnSync(sentryCliPath(), args, { cwd: appDir, env: process.env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    if (output) log("discovery_index_sentry_cli", { command: args.slice(0, 2).join(" "), output: output.slice(0, 300) });
    return;
  }
  if (options.allowExistingRelease && /already exists|version already exists/i.test(output)) return;
  if (options.allowFailure) {
    warn("discovery_index_sentry_cli_failed", { command: args.slice(0, 3).join(" "), status: result.status, message: output.slice(0, 300) });
    return;
  }
  throw new Error(`sentry-cli ${args.join(" ")} failed (${result.status}): ${output.slice(0, 500)}`);
}

function shouldValidateRelease(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE ?? "");
}

function numericEnv(name: string, fallback: number, max: number): number {
  const raw = Number(nonBlank(process.env[name]));
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), max) : fallback;
}

async function runReleaseValidation(release: string, fields: { sha?: string | undefined; deployName: string; environment: string; strict: boolean }): Promise<void> {
  if (!shouldValidateRelease()) return;
  const attempts = Math.max(1, numericEnv("DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS", 5, 20));
  const retryDelayMs = numericEnv("DISCOVERY_INDEX_SENTRY_VALIDATE_RETRY_DELAY_MS", 1_000, 30_000);
  let output = "";
  let status: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(process.execPath, ["scripts/validate-sentry-release.mjs"], {
      cwd: appDir,
      env: {
        ...process.env,
        SENTRY_RELEASE: release,
        SENTRY_COMMIT_SHA: fields.sha ?? "",
        SENTRY_DEPLOY_NAME: fields.deployName,
        SENTRY_ENVIRONMENT: fields.environment,
        SENTRY_REQUIRE_COMMITS: fields.strict ? "true" : "false",
        SENTRY_REQUIRE_DEPLOY: "true",
        SENTRY_REQUIRE_FINALIZED: "true",
      },
      encoding: "utf8",
    });
    status = result.status;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      if (output) log("discovery_index_sentry_release_validation", { output: output.slice(0, 500), attempt });
      return;
    }
    if (attempt < attempts) {
      warn("discovery_index_sentry_release_validation_retry", { attempt, attempts, retryDelayMs, message: output.slice(0, 500) });
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw new Error(`Sentry release validation failed (${status}): ${output.slice(0, 500)}`);
}

async function main(): Promise<number> {
  // initSentry's own body already wraps everything error-prone in its own try/catch and always resolves
  // (never rejects) when called with a real process.env -- this .catch is unreachable through the real
  // call site above, same "defensive net, no live branch" reasoning as sentry.ts's own sentryTagValue guard.
  /* v8 ignore next -- @preserve unreachable: initSentry(process.env) never rejects */
  await initSentry(process.env).catch(() => false);
  const release = resolveDiscoveryIndexSentryRelease(process.env);
  const required = {
    SENTRY_AUTH_TOKEN: nonBlank(process.env.SENTRY_AUTH_TOKEN),
    SENTRY_ORG: nonBlank(process.env.SENTRY_ORG),
    SENTRY_PROJECT: nonBlank(process.env.SENTRY_PROJECT),
    SENTRY_RELEASE: release,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    log("discovery_index_sentry_sourcemap_upload_skipped", { reason: "missing_config", missing });
    return 0;
  }

  const strict = /^(1|true|yes|on)$/i.test(process.env.DISCOVERY_INDEX_SENTRY_UPLOAD_STRICT ?? "");
  try {
    validateSourceMaps();
    const projectArgs = ["--org", required.SENTRY_ORG!, "--project", required.SENTRY_PROJECT!];
    runSentry(["releases", ...projectArgs, "new", release!], { allowExistingRelease: true });

    const sha = nonBlank(process.env.SENTRY_COMMIT_SHA);
    if (sha) {
      const repo = nonBlank(process.env.SENTRY_REPOSITORY) ?? "JSONbored/loopover";
      const previous = nonBlank(process.env.SENTRY_PREVIOUS_COMMIT_SHA);
      const spec = previous ? `${repo}@${previous}..${sha}` : `${repo}@${sha}`;
      runSentry(["releases", ...projectArgs, "set-commits", release!, "--commit", spec, "--ignore-missing"], { allowFailure: !strict });
    }

    runSentry(["sourcemaps", ...projectArgs, "inject", "dist"]);
    validateSourceMaps();
    runSentry(["sourcemaps", ...projectArgs, "upload", "--release", release!, "--validate", "--wait", ...(strict ? ["--strict"] : []), "dist"]);
    const deployName = nonBlank(process.env.SENTRY_DEPLOY_NAME) ?? "cloudflare-container";
    runSentry(["releases", ...projectArgs, "deploys", "new", "--release", release!, "--env", resolveSentryEnvironment(process.env), "--name", deployName]);
    runSentry(["releases", ...projectArgs, "finalize", release!]);
    await runReleaseValidation(release!, { sha, deployName, environment: resolveSentryEnvironment(process.env), strict });
    log("discovery_index_sentry_sourcemap_upload_complete", { release });
    return 0;
  } catch (error) {
    captureSourcemapUploadFailure(error, {
      release,
      deploymentId: nonBlank(process.env.SENTRY_DEPLOY_NAME),
      strict,
      sha: nonBlank(process.env.SENTRY_COMMIT_SHA),
    });
    await flushSentry();
    warn("discovery_index_sentry_sourcemap_upload_failed", { release, message: error instanceof Error ? error.message : String(error), strict });
    return strict ? 1 : 0;
  }
}

process.exitCode = await main();
