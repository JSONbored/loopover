// Uploads this build's source maps to PostHog at container startup, then deletes them before the real server
// starts (see the Dockerfile/entrypoint's runtime CMD) -- mirrors packages/discovery-index/src/upload-sourcemaps.ts's
// PostHog leg. REPLACES the old Sentry-based pipeline entirely (#8290, epic #8286's revised strategy,
// 2026-07-25 correction on #8286): no more @sentry/cli, no more Railway-specific env vars (this repo no
// longer deploys anything on Railway).
//
// Running this at process startup rather than at build time is deliberate: POSTHOG_CLI_API_KEY is a real
// secret, injected however this service's operator provisions runtime env vars -- it is never a build-time
// value, so it never risks being baked into a cached image layer.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  captureSourcemapUploadPostHogFailure,
  flushReesPostHog,
  initReesPostHog,
  resolveReesPostHogRelease,
} from "./posthog.js";

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
  // Unreachable on a real filesystem: the existsSync(serverMap) check above already guarantees
  // dist/server.js.map exists, and listFiles(distDir) always picks it up, so `maps` can never be empty
  // here. Only forceable by mocking readdirSync independently of existsSync (as discovery-index's twin
  // does) -- this package's tests spawn the real built subprocess against the real filesystem instead.
  /* v8 ignore next -- @preserve unreachable without mocking fs: see comment above */
  if (maps.length === 0) throw new Error("dist has no JavaScript source maps");

  let sawServerSource = false;
  for (const path of maps) {
    const map = JSON.parse(readFileSync(path, "utf8")) as {
      sources?: unknown;
      sourcesContent?: unknown;
    };
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
  return !/^(0|false|no|off)$/i.test(process.env.REES_POSTHOG_VALIDATE_RELEASE ?? "");
}

function numericEnv(name: string, fallback: number, max: number): number {
  const raw = Number(nonBlank(process.env[name]));
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), max) : fallback;
}

async function runReleaseValidation(release: string): Promise<void> {
  if (!shouldValidateRelease()) return;
  const attempts = Math.max(1, numericEnv("REES_POSTHOG_VALIDATE_ATTEMPTS", 5, 20));
  const retryDelayMs = numericEnv("REES_POSTHOG_VALIDATE_RETRY_DELAY_MS", 1_000, 30_000);
  let output = "";
  let status: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(process.execPath, ["scripts/validate-posthog-release.mjs"], {
      cwd: appDir,
      env: { ...process.env, POSTHOG_RELEASE: release },
      encoding: "utf8",
    });
    status = result.status;
    // process.execPath is the real running Node binary, so spawnSync here always spawns successfully --
    // the null-stdout/stderr case only exists when spawnSync itself fails to launch (e.g. ENOENT on the
    // command). Unlike discovery-index's twin (test/unit/discovery-index/upload-sourcemaps.test.ts), this
    // package's node:test suite spawns the real built subprocess with no child_process mocking, so this
    // fallback can't be exercised without breaking that testing strategy.
    /* v8 ignore next -- @preserve unreachable without mocking child_process: see comment above */
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      if (output) log("rees_posthog_release_validation", { output: output.slice(0, 500), attempt });
      return;
    }
    if (attempt < attempts) {
      warn("rees_posthog_release_validation_retry", { attempt, attempts, retryDelayMs, message: output.slice(0, 500) });
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw new Error(`PostHog release validation failed (${status}): ${output.slice(0, 500)}`);
}

// review-enrichment is a standalone, non-workspace package, so node_modules/.bin/posthog-cli is genuinely
// the right (non-hoisted) location -- unlike discovery-index's require.resolve-based approach, which exists
// specifically because THAT package IS an npm workspace member with hoisting to worry about.
function postHogCliPath(): string {
  return nonBlank(process.env.POSTHOG_CLI_PATH) ?? resolve(appDir, "node_modules/.bin/posthog-cli");
}

function runPostHog(args: string[]): void {
  const result = spawnSync(postHogCliPath(), args, { cwd: appDir, env: process.env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    if (output) log("rees_posthog_cli", { command: args.slice(0, 2).join(" "), output: output.slice(0, 300) });
    return;
  }
  throw new Error(`posthog-cli ${args.join(" ")} failed (${result.status}): ${output.slice(0, 500)}`);
}

async function main(): Promise<number> {
  await initReesPostHog(process.env).catch(() => false);
  const release = resolveReesPostHogRelease(process.env);
  const required = {
    POSTHOG_CLI_API_KEY: nonBlank(process.env.POSTHOG_CLI_API_KEY),
    POSTHOG_CLI_PROJECT_ID: nonBlank(process.env.POSTHOG_CLI_PROJECT_ID),
    POSTHOG_RELEASE: release,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    log("rees_posthog_sourcemap_upload_skipped", { reason: "missing_config", missing });
    return 0;
  }

  const strict = /^(1|true|yes|on)$/i.test(process.env.REES_POSTHOG_UPLOAD_STRICT ?? "");
  try {
    validateSourceMaps();
    // No separate "create release" step (PostHog release metadata is a byproduct of inject/upload) and an
    // explicit --release-version rather than posthog-cli's own git-metadata auto-detection -- the deploy
    // environment isn't guaranteed to have a usable .git checkout at this step.
    runPostHog(["sourcemap", "inject", "--directory", "dist", "--release-version", release!]);
    validateSourceMaps();
    runPostHog(["sourcemap", "upload", "--directory", "dist", "--release-version", release!]);
    await runReleaseValidation(release!);
    log("rees_posthog_sourcemap_upload_complete", { release });
    return 0;
  } catch (error) {
    captureSourcemapUploadPostHogFailure(error, {
      release,
      strict,
      sha: nonBlank(process.env.POSTHOG_COMMIT_SHA),
    });
    await flushReesPostHog();
    // Every throw site in this file's try block above (validateSourceMaps, runPostHog, runReleaseValidation)
    // throws a real Error, so the String(error) arm below only exists for the general catch-clause-is-typed-
    // unknown case. Discovery-index's twin covers the equivalent line by mocking child_process.spawnSync to
    // throw a bare string; this package's real-subprocess test strategy has no equivalent hook.
    /* v8 ignore next -- @preserve unreachable without mocking a non-Error throw: see comment above */
    warn("rees_posthog_sourcemap_upload_failed", { release, message: error instanceof Error ? error.message : String(error), strict });
    return strict ? 1 : 0;
  }
}

process.exitCode = await main();
