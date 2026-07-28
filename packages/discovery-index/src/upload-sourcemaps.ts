// Uploads this build's source maps to PostHog at container startup, then deletes them before the real server
// starts (see the Dockerfile's runtime CMD). REPLACES the old Sentry-based pipeline entirely (#8289, epic
// #8286's revised strategy, 2026-07-25 correction on #8286): no more @sentry/cli.
//
// Running this at CONTAINER STARTUP rather than at Docker BUILD time is deliberate: POSTHOG_CLI_API_KEY is a
// real secret, injected the same way DISCOVERY_INDEX_SHARED_SECRET/DISCOVERY_INDEX_GITHUB_TOKEN already are
// (worker.ts's Container envVars) -- it is never a Docker build-time value, so it never risks being baked
// into a cached image layer.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { captureSourcemapUploadPostHogFailure, flushDiscoveryIndexPostHog, initDiscoveryIndexPostHog, resolveDiscoveryIndexPostHogRelease } from "./posthog.js";

const require = createRequire(import.meta.url);

const distDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(distDir, "..");

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

// posthog-cli's sourcemap inject/upload take --release-name and --release-version as SEPARATE flags, which
// it combines server-side into the release id "{name}@{version}". Passing our own already-combined
// POSTHOG_RELEASE (e.g. "loopover-discovery-index@<sha>") as --release-version alone leaves --release-name
// unset, and the CLI then auto-derives one from git/package.json instead -- silently doubling up into
// "<auto-derived>@loopover-discovery-index@<sha>", which never matches what runReleaseValidation looks up.
// Splitting our own convention at its first "@" reproduces exactly the release id we already expect.
function splitRelease(release: string, defaultName: string): { name: string; version: string } {
  const at = release.indexOf("@");
  if (at === -1) return { name: defaultName, version: release };
  return { name: release.slice(0, at), version: release.slice(at + 1) };
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

function shouldValidateRelease(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE ?? "");
}

function numericEnv(name: string, fallback: number, max: number): number {
  const raw = Number(nonBlank(process.env[name]));
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), max) : fallback;
}

async function runReleaseValidation(release: string): Promise<void> {
  if (!shouldValidateRelease()) return;
  const attempts = Math.max(1, numericEnv("DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS", 5, 20));
  const retryDelayMs = numericEnv("DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS", 1_000, 30_000);
  let output = "";
  let status: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/validate-posthog-release.ts"], {
      cwd: appDir,
      env: { ...process.env, POSTHOG_RELEASE: release },
      encoding: "utf8",
    });
    status = result.status;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      if (output) log("discovery_index_posthog_release_validation", { output: output.slice(0, 500), attempt });
      return;
    }
    if (attempt < attempts) {
      warn("discovery_index_posthog_release_validation_retry", { attempt, attempts, retryDelayMs, message: output.slice(0, 500) });
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw new Error(`PostHog release validation failed (${status}): ${output.slice(0, 500)}`);
}

// Resolved via require.resolve, not a hardcoded packages/discovery-index/node_modules/.bin/ path: unlike
// review-enrichment (a standalone, non-workspace package), discovery-index is a real npm workspace member,
// so npm hoists @posthog/cli's binary to the ROOT node_modules/.bin/ by default -- a package-relative path
// assumption would silently look in the wrong place. Same resolution pattern as the root repo's own
// scripts/gen-cf-typegen.ts resolveLocalWranglerBin().
function postHogCliPath(): string {
  const override = nonBlank(process.env.POSTHOG_CLI_PATH);
  if (override) return override;
  const pkgJsonPath = require.resolve("@posthog/cli/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
  const binRelativePath = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.["posthog-cli"] ?? pkg.bin?.["@posthog/cli"]);
  if (!binRelativePath) throw new Error("@posthog/cli package.json has no resolvable bin entry");
  return join(dirname(pkgJsonPath), binRelativePath);
}

function runPostHog(args: string[]): void {
  // POSTHOG_CLI_API_KEY/POSTHOG_CLI_PROJECT_ID/POSTHOG_CLI_HOST are read directly from the environment by
  // posthog-cli itself (its own documented auth convention).
  const result = spawnSync(postHogCliPath(), args, { cwd: appDir, env: process.env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    if (output) log("discovery_index_posthog_cli", { command: args.slice(0, 2).join(" "), output: output.slice(0, 300) });
    return;
  }
  throw new Error(`posthog-cli ${args.join(" ")} failed (${result.status}): ${output.slice(0, 500)}`);
}

async function main(): Promise<number> {
  /* v8 ignore next -- @preserve unreachable: initDiscoveryIndexPostHog(process.env) never rejects */
  await initDiscoveryIndexPostHog(process.env).catch(() => false);
  const release = resolveDiscoveryIndexPostHogRelease(process.env);
  const required = {
    POSTHOG_CLI_API_KEY: nonBlank(process.env.POSTHOG_CLI_API_KEY),
    POSTHOG_CLI_PROJECT_ID: nonBlank(process.env.POSTHOG_CLI_PROJECT_ID),
    POSTHOG_RELEASE: release,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    log("discovery_index_posthog_sourcemap_upload_skipped", { reason: "missing_config", missing });
    return 0;
  }

  const strict = /^(1|true|yes|on)$/i.test(process.env.DISCOVERY_INDEX_POSTHOG_UPLOAD_STRICT ?? "");
  try {
    validateSourceMaps();
    // No separate "create release" step -- PostHog release metadata is a byproduct of the inject/upload
    // calls below. Explicit --release-version rather than posthog-cli's own git-metadata auto-detection: the
    // Dockerfile's build stage only copies packages/loopover-engine and packages/discovery-index source,
    // never `.git`, so auto-detection has nothing to inspect at container-startup time.
    const { name: releaseName, version: releaseVersion } = splitRelease(release!, "loopover-discovery-index");
    runPostHog(["sourcemap", "inject", "--directory", "dist", "--release-name", releaseName, "--release-version", releaseVersion]);
    validateSourceMaps();
    runPostHog(["sourcemap", "upload", "--directory", "dist", "--release-name", releaseName, "--release-version", releaseVersion]);
    await runReleaseValidation(release!);
    log("discovery_index_posthog_sourcemap_upload_complete", { release });
    return 0;
  } catch (error) {
    captureSourcemapUploadPostHogFailure(error, { release, strict, sha: nonBlank(process.env.POSTHOG_COMMIT_SHA) });
    await flushDiscoveryIndexPostHog();
    warn("discovery_index_posthog_sourcemap_upload_failed", { release, message: error instanceof Error ? error.message : String(error), strict });
    return strict ? 1 : 0;
  }
}

process.exitCode = await main();
