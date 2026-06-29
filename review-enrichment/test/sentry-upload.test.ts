import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resolveReesSentryRelease, resolveTracesSampleRate } from "../src/sentry.ts";

test("resolveReesSentryRelease prefers explicit releases and falls back to Railway commit shas", () => {
  assert.equal(
    resolveReesSentryRelease({
      SENTRY_RELEASE: "custom-release",
      RAILWAY_GIT_COMMIT_SHA: "abc123",
    }),
    "custom-release",
  );
  assert.equal(resolveReesSentryRelease({ RAILWAY_GIT_COMMIT_SHA: "abc123" }), "gittensory-rees@abc123");
  assert.equal(resolveReesSentryRelease({}), undefined);
});

test("resolveTracesSampleRate clamps malformed or out-of-range config", () => {
  assert.equal(resolveTracesSampleRate({}), 0);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0.25" }), 0.25);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "nope" }), 0);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "-1" }), 0);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "2" }), 1);
});

async function sentryApiServer() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/") {
      res.end(
        JSON.stringify({
          version: "gittensory-rees@abc123",
          dateReleased: "2026-06-29T00:00:00Z",
          commitCount: 1,
          deployCount: 1,
          projects: [{ slug: "rees" }],
          lastDeploy: { name: "deploy-1", environment: "production" },
        }),
      );
      return;
    }
    if (req.url === "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/commits/") {
      res.end(JSON.stringify([{ id: "abc123" }]));
      return;
    }
    if (req.url === "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/deploys/") {
      res.end(JSON.stringify([{ name: "deploy-1", environment: "production" }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    }),
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

test("upload-sourcemaps calls Sentry CLI with release association on upload", async () => {
  const api = await sentryApiServer();
  const dir = mkdtempSync(resolve(tmpdir(), "rees-sentry-cli-"));
  const logPath = resolve(dir, "calls.jsonl");
  const cliPath = resolve(dir, "sentry-cli");
  writeFileSync(
    cliPath,
    `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' '${logPath}' "$@"\n`,
  );
  chmodSync(cliPath, 0o755);

  try {
    const result = await runUploadSourcemaps({
      ...process.env,
      SENTRY_AUTH_TOKEN: "test-token",
      SENTRY_ORG: "jsonbored",
      SENTRY_PROJECT: "rees",
      SENTRY_CLI_PATH: cliPath,
      SENTRY_URL: api.url,
      RAILWAY_GIT_COMMIT_SHA: "abc123",
      RAILWAY_DEPLOYMENT_ID: "deploy-1",
      RAILWAY_ENVIRONMENT_NAME: "production",
      REES_SENTRY_UPLOAD_STRICT: "true",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    assert.deepEqual(calls[0], [
      "releases",
      "--org",
      "jsonbored",
      "--project",
      "rees",
      "new",
      "gittensory-rees@abc123",
    ]);
    assert.deepEqual(calls[2], ["sourcemaps", "--org", "jsonbored", "--project", "rees", "inject", "dist"]);
    assert.deepEqual(calls[3], [
      "sourcemaps",
      "--org",
      "jsonbored",
      "--project",
      "rees",
      "upload",
      "--release",
      "gittensory-rees@abc123",
      "--validate",
      "--wait",
      "--strict",
      "dist",
    ]);
    assert.equal(api.seen.includes("/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/"), true);
    assert.equal(api.seen.includes("/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/commits/"), true);
    assert.equal(api.seen.includes("/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/deploys/"), true);
  } finally {
    await api.close();
  }
});
