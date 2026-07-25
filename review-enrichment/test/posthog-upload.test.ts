import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resolveReesPostHogRelease, resolvePostHogEnvironment } from "../src/posthog.ts";

test("resolveReesPostHogRelease prefers explicit releases and falls back to a commit sha, with no platform-specific derivation", () => {
  assert.equal(
    resolveReesPostHogRelease({
      POSTHOG_RELEASE: "custom-release",
      POSTHOG_COMMIT_SHA: "abc123",
    }),
    "custom-release",
  );
  assert.equal(resolveReesPostHogRelease({ POSTHOG_COMMIT_SHA: "abc123" }), "loopover-rees@abc123");
  assert.equal(resolveReesPostHogRelease({}), undefined);
});

test("resolvePostHogEnvironment defaults to production with no platform-specific fallback", () => {
  assert.equal(resolvePostHogEnvironment({}), "production");
  assert.equal(resolvePostHogEnvironment({ POSTHOG_ENVIRONMENT: "staging" }), "staging");
});

function postHogCliStub() {
  const dir = mkdtempSync(resolve(tmpdir(), "rees-posthog-cli-"));
  const logPath = resolve(dir, "calls.jsonl");
  const cliPath = resolve(dir, "posthog-cli");
  writeFileSync(
    cliPath,
    `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' '${logPath}' "$@"\n`,
  );
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

async function runUploadSourcemaps(env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ["dist/upload-sourcemaps.js"], {
      cwd: resolve(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("upload-sourcemaps skips the PostHog upload and exits 0 when required config is missing", async () => {
  const { cliPath, logPath } = postHogCliStub();
  const result = await runUploadSourcemaps({
    ...process.env,
    POSTHOG_CLI_PATH: cliPath,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /rees_posthog_sourcemap_upload_skipped/);
  assert.throws(() => readFileSync(logPath, "utf8"));
});

test("upload-sourcemaps calls posthog-cli inject then upload with an explicit --release-version", async () => {
  const { cliPath, logPath } = postHogCliStub();

  const result = await runUploadSourcemaps({
    ...process.env,
    POSTHOG_CLI_PATH: cliPath,
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    REES_POSTHOG_VALIDATE_RELEASE: "0",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

  assert.deepEqual(calls[0], ["sourcemap", "inject", "--directory", "dist", "--release-version", "loopover-rees@abc123"]);
  assert.deepEqual(calls[1], ["sourcemap", "upload", "--directory", "dist", "--release-version", "loopover-rees@abc123"]);
  assert.match(result.stdout, /rees_posthog_sourcemap_upload_complete/);
});

test("upload-sourcemaps propagates a strict posthog-cli failure as a hard failure and exits 1", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rees-posthog-cli-fail-"));
  const cliPath = resolve(dir, "posthog-cli");
  writeFileSync(cliPath, `#!/bin/sh\necho "upload rejected" 1>&2\nexit 1\n`);
  chmodSync(cliPath, 0o755);

  const result = await runUploadSourcemaps({
    ...process.env,
    POSTHOG_CLI_PATH: cliPath,
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    REES_POSTHOG_VALIDATE_RELEASE: "0",
    REES_POSTHOG_UPLOAD_STRICT: "true",
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /rees_posthog_sourcemap_upload_failed/);
});

test("upload-sourcemaps treats a non-strict posthog-cli failure as a soft failure and exits 0", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rees-posthog-cli-fail-"));
  const cliPath = resolve(dir, "posthog-cli");
  writeFileSync(cliPath, `#!/bin/sh\necho "upload rejected" 1>&2\nexit 1\n`);
  chmodSync(cliPath, 0o755);

  const result = await runUploadSourcemaps({
    ...process.env,
    POSTHOG_CLI_PATH: cliPath,
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    REES_POSTHOG_VALIDATE_RELEASE: "0",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /rees_posthog_sourcemap_upload_failed/);
});
