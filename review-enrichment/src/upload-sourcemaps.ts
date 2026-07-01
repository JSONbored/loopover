import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  captureSourcemapUploadFailure,
  flushSentry,
  initSentry,
  resolveReesSentryRelease,
  resolveSentryEnvironment,
} from "./sentry.js";

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

function sentryCliPath(): string {
  return nonBlank(process.env.SENTRY_CLI_PATH) ?? resolve(appDir, "node_modules/.bin/sentry-cli");
}

function runSentry(args: string[], options: RunOptions = {}): void {
  const result = spawnSync(sentryCliPath(), args, {
    cwd: appDir,
    env: process.env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    if (output) log("rees_sentry_cli", { command: args.slice(0, 2).join(" "), output: output.slice(0, 300) });
    return;
  }
  if (options.allowExistingRelease && /already exists|version already exists/i.test(output)) return;
  if (options.allowFailure) {
    warn("rees_sentry_cli_failed", {
      command: args.slice(0, 3).join(" "),
      status: result.status,
      message: output.slice(0, 300),
    });
    return;
  }
  throw new Error(`sentry-cli ${args.join(" ")} failed (${result.status}): ${output.slice(0, 500)}`);
}

function shouldValidateRelease(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.REES_SENTRY_VALIDATE_RELEASE ?? "");
}

function numericEnv(name: string, fallback: number, max: number): number {
  const raw = Number(nonBlank(process.env[name]));
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), max) : fallback;
}

async function runReleaseValidation(
  release: string,
  fields: { sha?: string; deployName: string; environment: string },
): Promise<void> {
  if (!shouldValidateRelease()) return;
  const attempts = Math.max(1, numericEnv("REES_SENTRY_VALIDATE_ATTEMPTS", 5, 20));
  const retryDelayMs = numericEnv("REES_SENTRY_VALIDATE_RETRY_DELAY_MS", 1_000, 30_000);
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
        SENTRY_REQUIRE_COMMITS: "true",
        SENTRY_REQUIRE_DEPLOY: "true",
        SENTRY_REQUIRE_FINALIZED: "true",
      },
      encoding: "utf8",
    });
    status = result.status;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      if (output) log("rees_sentry_release_validation", { output: output.slice(0, 500), attempt });
      return;
    }
    if (attempt < attempts) {
      warn("rees_sentry_release_validation_retry", {
        attempt,
        attempts,
        retryDelayMs,
        message: output.slice(0, 500),
      });
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw new Error(`Sentry release validation failed (${status}): ${output.slice(0, 500)}`);
}

async function main(): Promise<number> {
  await initSentry(process.env).catch(() => false);
  const release = resolveReesSentryRelease(process.env);
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
    log("rees_sentry_sourcemap_upload_skipped", { reason: "missing_config", missing });
    return 0;
  }

  const strict = /^(1|true|yes|on)$/i.test(process.env.REES_SENTRY_UPLOAD_STRICT ?? "");
  try {
    validateSourceMaps();
    const projectArgs = ["--org", required.SENTRY_ORG!, "--project", required.SENTRY_PROJECT!];
    runSentry(["releases", ...projectArgs, "new", release!], { allowExistingRelease: true });

    const sha = nonBlank(process.env.SENTRY_COMMIT_SHA) ?? nonBlank(process.env.RAILWAY_GIT_COMMIT_SHA);
    if (sha) {
      const repo = nonBlank(process.env.SENTRY_REPOSITORY) ?? "JSONbored/gittensory";
      const previous = nonBlank(process.env.SENTRY_PREVIOUS_COMMIT_SHA);
      const spec = previous ? `${repo}@${previous}..${sha}` : `${repo}@${sha}`;
      runSentry(["releases", ...projectArgs, "set-commits", release!, "--commit", spec, "--ignore-missing"], {
        allowFailure: !strict,
      });
    }

    runSentry(["sourcemaps", ...projectArgs, "inject", "dist"]);
    validateSourceMaps();
    runSentry([
      "sourcemaps",
      ...projectArgs,
      "upload",
      "--release",
      release!,
      "--validate",
      "--wait",
      ...(strict ? ["--strict"] : []),
      "dist",
    ]);
    runSentry([
      "releases",
      ...projectArgs,
      "deploys",
      "new",
      "--release",
      release!,
      "--env",
      resolveSentryEnvironment(process.env),
      "--name",
      nonBlank(process.env.RAILWAY_DEPLOYMENT_ID) ?? "railway",
    ]);
    runSentry(["releases", ...projectArgs, "finalize", release!]);
    await runReleaseValidation(release!, {
      sha,
      deployName: nonBlank(process.env.RAILWAY_DEPLOYMENT_ID) ?? "railway",
      environment: resolveSentryEnvironment(process.env),
    });
    log("rees_sentry_sourcemap_upload_complete", { release });
    return 0;
  } catch (error) {
    captureSourcemapUploadFailure(error, {
      release,
      railwayDeploymentId: nonBlank(process.env.RAILWAY_DEPLOYMENT_ID),
      strict,
      sha: nonBlank(process.env.SENTRY_COMMIT_SHA) ?? nonBlank(process.env.RAILWAY_GIT_COMMIT_SHA),
    });
    await flushSentry();
    warn("rees_sentry_sourcemap_upload_failed", {
      release,
      message: error instanceof Error ? error.message : String(error),
      strict,
    });
    return strict ? 1 : 0;
  }
}

process.exitCode = await main();
