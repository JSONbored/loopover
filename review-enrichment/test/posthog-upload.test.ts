import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

function postHogCliStub(options: { echoOutput?: string } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "rees-posthog-cli-"));
  const logPath = resolve(dir, "calls.jsonl");
  const cliPath = resolve(dir, "posthog-cli");
  const echo = options.echoOutput ? `echo '${options.echoOutput}'\n` : "";
  writeFileSync(
    cliPath,
    `#!/bin/sh\n${echo}node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' '${logPath}' "$@"\n`,
  );
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

/** A real local HTTP server standing in for PostHog's error_tracking/symbol_sets API, so
 *  runReleaseValidation's actual retry/attempts/success logic (validate-posthog-release.mjs, spawned as a
 *  real subprocess-of-a-subprocess by upload-sourcemaps.js) gets exercised for real rather than always being
 *  skipped via REES_POSTHOG_VALIDATE_RELEASE=0. Mirrors the pre-Sentry-removal sentryApiServer() test helper
 *  this file's deleted predecessor (sentry-upload.test.ts) used for the identical purpose. */
async function postHogApiServer(options: { failFirstAttempt?: boolean } = {}) {
  const seen: string[] = [];
  let reads = 0;
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    reads += 1;
    if (options.failFirstAttempt && reads === 1) {
      res.statusCode = 500;
      res.end(JSON.stringify({ detail: "internal error" }));
      return;
    }
    res.end(JSON.stringify({ results: [{ release: "loopover-rees@abc123", failure_reason: null }] }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
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

test("upload-sourcemaps logs posthog-cli's own stdout/stderr when it writes any", async () => {
  const { cliPath, logPath } = postHogCliStub({ echoOutput: "posthog-cli: uploaded 3 sourcemaps" });

  const result = await runUploadSourcemaps({
    ...process.env,
    POSTHOG_CLI_PATH: cliPath,
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    REES_POSTHOG_VALIDATE_RELEASE: "0",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /rees_posthog_cli.*uploaded 3 sourcemaps/);
  assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 2);
});

test("upload-sourcemaps falls back to the default node_modules/.bin/posthog-cli path when POSTHOG_CLI_PATH is blank", async () => {
  const result = await runUploadSourcemaps({
    ...process.env,
    // Blank, not unset: nonBlank() treats "" the same as absent, forcing postHogCliPath()'s
    // resolve(appDir, "node_modules/.bin/posthog-cli") fallback -- which genuinely doesn't exist in this
    // standalone package's node_modules (no real @posthog/cli binary installed here), so spawnSync fails
    // to launch at all (ENOENT), giving undefined stdout/stderr for free on the same call.
    POSTHOG_CLI_PATH: "",
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    REES_POSTHOG_VALIDATE_RELEASE: "0",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /rees_posthog_sourcemap_upload_failed/);
  assert.match(result.stderr, /posthog-cli.*failed/);
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

test("upload-sourcemaps runs real release validation once and succeeds on the first attempt", async () => {
  const { cliPath, logPath } = postHogCliStub();
  const api = await postHogApiServer();
  try {
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_CLI_HOST: api.url,
      POSTHOG_RELEASE: "loopover-rees@abc123",
      // Deliberately unset (not "1"): shouldValidateRelease() defaults to enabled when the env var is
      // absent, so leaving it out exercises that `?? ""` fallback while still running real validation.
      REES_POSTHOG_VALIDATE_RELEASE: undefined,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /rees_posthog_release_validation_complete|rees_posthog_sourcemap_upload_complete/);
    assert.equal(api.seen.length, 1);
    // The CLI itself still ran (inject/upload), independent of the validation step's own separate real HTTP call.
    assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 2);
  } finally {
    await api.close();
  }
});

test("upload-sourcemaps retries real release validation until it succeeds, logging a retry warning", async () => {
  const { cliPath } = postHogCliStub();
  const api = await postHogApiServer({ failFirstAttempt: true });
  try {
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_CLI_HOST: api.url,
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "1",
      REES_POSTHOG_VALIDATE_ATTEMPTS: "3",
      // Nonzero (not "0") so the real `await sleep(retryDelayMs)` call between attempts is actually
      // exercised -- 1ms keeps the test fast while still hitting that branch instead of skipping it.
      REES_POSTHOG_VALIDATE_RETRY_DELAY_MS: "1",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /rees_posthog_release_validation_retry/);
    assert.equal(api.seen.length, 2);
  } finally {
    await api.close();
  }
});

// validateSourceMaps() runs against the REAL dist/server.js.map this file's own build just produced --
// unlike discovery-index's vitest-based fs-mocking, subprocess-spawn tests can't inject a fake bad fixture
// without touching the real file, so these tests do exactly that: back up the real map, corrupt it, spawn,
// restore in a finally. Real code, real subprocess, no coverage gap on validateSourceMaps()'s failure paths.
const REAL_SERVER_MAP = resolve(import.meta.dirname, "..", "dist", "server.js.map");

async function withCorruptedServerMap(badMap: unknown, run: () => Promise<void>): Promise<void> {
  const original = readFileSync(REAL_SERVER_MAP, "utf8");
  writeFileSync(REAL_SERVER_MAP, JSON.stringify(badMap));
  try {
    await run();
  } finally {
    writeFileSync(REAL_SERVER_MAP, original);
  }
}

test("upload-sourcemaps fails when the source map has no original sources", async () => {
  await withCorruptedServerMap({ sources: [], sourcesContent: [] }, async () => {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /has no original sources/);
  });
});

test("upload-sourcemaps fails when sourcesContent doesn't match the sources length", async () => {
  await withCorruptedServerMap({ sources: ["../src/server.ts"], sourcesContent: [] }, async () => {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /does not embed sourcesContent for every source/);
  });
});

test("upload-sourcemaps fails when sourcesContent is present but entirely blank", async () => {
  await withCorruptedServerMap({ sources: ["../src/server.ts"], sourcesContent: ["   "] }, async () => {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /has empty sourcesContent/);
  });
});

test("upload-sourcemaps fails when no source map includes src/server.ts", async () => {
  await withCorruptedServerMap({ sources: ["../src/other.ts"], sourcesContent: ["export const y = 1;"] }, async () => {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /source maps do not include src\/server\.ts/);
  });
});

test("upload-sourcemaps fails when dist/server.js is missing", async () => {
  const REAL_SERVER_JS = resolve(import.meta.dirname, "..", "dist", "server.js");
  const backupPath = `${REAL_SERVER_JS}.bak`;
  renameSync(REAL_SERVER_JS, backupPath);
  try {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /dist\/server\.js is missing/);
  } finally {
    renameSync(backupPath, REAL_SERVER_JS);
  }
});

test("upload-sourcemaps fails when dist/server.js.map is missing", async () => {
  const backupPath = `${REAL_SERVER_MAP}.bak`;
  renameSync(REAL_SERVER_MAP, backupPath);
  try {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /dist\/server\.js\.map is missing/);
  } finally {
    renameSync(backupPath, REAL_SERVER_MAP);
  }
});

test("upload-sourcemaps fails when the server bundle is missing its sourceMappingURL comment", async () => {
  const REAL_SERVER_JS = resolve(import.meta.dirname, "..", "dist", "server.js");
  const originalBundle = readFileSync(REAL_SERVER_JS, "utf8");
  writeFileSync(REAL_SERVER_JS, originalBundle.replace(/\/\/# sourceMappingURL=server\.js\.map\s*$/, ""));
  try {
    const { cliPath } = postHogCliStub();
    const result = await runUploadSourcemaps({
      ...process.env,
      POSTHOG_CLI_PATH: cliPath,
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
      REES_POSTHOG_VALIDATE_RELEASE: "0",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /missing the server\.js\.map sourceMappingURL/);
  } finally {
    writeFileSync(REAL_SERVER_JS, originalBundle);
  }
});

test("upload-sourcemaps exhausts real release-validation attempts and fails strictly (exit 1)", async () => {
  const { cliPath } = postHogCliStub();
  // No real server at all: every validation attempt hits connection-refused, matching the exhaustion path.
  const result = await runUploadSourcemaps({
    ...process.env,
    POSTHOG_CLI_PATH: cliPath,
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_CLI_HOST: "http://127.0.0.1:1",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    REES_POSTHOG_VALIDATE_RELEASE: "1",
    REES_POSTHOG_VALIDATE_ATTEMPTS: "2",
    REES_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0",
    REES_POSTHOG_UPLOAD_STRICT: "true",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /rees_posthog_sourcemap_upload_failed/);
});
