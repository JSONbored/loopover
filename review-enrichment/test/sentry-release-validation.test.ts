import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSentryReleaseValidationConfig,
  SentryReleaseValidationError,
  validateSentryRelease,
} from "../scripts/validate-sentry-release.mjs";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validationEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SENTRY_AUTH_TOKEN: "test-token",
    SENTRY_ORG: "jsonbored",
    SENTRY_PROJECT: "gittensory",
    SENTRY_RELEASE: "gittensory-rees@abc123",
    SENTRY_COMMIT_SHA: "abc123",
    SENTRY_DEPLOY_NAME: "deploy-1",
    SENTRY_ENVIRONMENT: "production",
    SENTRY_REQUIRE_DEPLOY: "true",
    ...overrides,
  };
}

test("loadSentryReleaseValidationConfig resolves exact release validation defaults", () => {
  assert.deepEqual(
    loadSentryReleaseValidationConfig({
      SENTRY_AUTH_TOKEN: "token",
      SENTRY_ORG: "jsonbored",
      SENTRY_PROJECT: "gittensory",
      SENTRY_RELEASE: "gittensory-rees@abc123",
      RAILWAY_GIT_COMMIT_SHA: "abc123",
      RAILWAY_DEPLOYMENT_ID: "deploy-1",
      RAILWAY_ENVIRONMENT_NAME: "production",
    }),
    {
      authToken: "token",
      org: "jsonbored",
      project: "gittensory",
      release: "gittensory-rees@abc123",
      baseUrl: "https://sentry.io",
      expectedCommitSha: "abc123",
      expectedDeployName: "deploy-1",
      expectedEnvironment: "production",
      requireCommits: true,
      requireDeploy: false,
      requireFinalized: true,
      requireReleaseFiles: false,
    },
  );
});

test("validateSentryRelease verifies finalized release, commits, and deploy", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-token");
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/") {
      return response({
        version: "gittensory-rees@abc123",
        dateReleased: "2026-06-29T00:00:00Z",
        commitCount: 1,
        deployCount: 1,
        projects: [{ slug: "gittensory" }],
        lastDeploy: { name: "deploy-1", environment: "production" },
      });
    }
    if (path === "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/commits/") {
      return response([{ id: "abc123" }]);
    }
    if (path === "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/deploys/") {
      return response([{ name: "deploy-1", environment: "production" }]);
    }
    return response({ detail: "not found" }, 404);
  };

  const result = await validateSentryRelease(validationEnv(), fetchImpl);

  assert.equal(result.release, "gittensory-rees@abc123");
  assert.equal(result.finalized, true);
  assert.equal(result.commitCount, 1);
  assert.equal(result.deployCount, 1);
  assert.deepEqual(calls, [
    "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/",
    "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/commits/",
    "/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/deploys/",
  ]);
});

test("validateSentryRelease rejects a release missing the expected commit", async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/commits/")) return response([{ id: "def456" }]);
    if (path.endsWith("/deploys/")) return response([{ name: "deploy-1", environment: "production" }]);
    return response({
      version: "gittensory-rees@abc123",
      dateReleased: "2026-06-29T00:00:00Z",
      commitCount: 1,
      deployCount: 1,
      projects: [{ slug: "gittensory" }],
    });
  };

  await assert.rejects(
    () => validateSentryRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof SentryReleaseValidationError);
      assert.deepEqual(error.failures, ["release commits do not include expected commit abc123"]);
      assert.equal(JSON.stringify(error.failures).includes("test-token"), false);
      return true;
    },
  );
});

test("validateSentryRelease rejects a release missing the required deploy", async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/commits/")) return response([{ id: "abc123" }]);
    if (path.endsWith("/deploys/")) return response([]);
    return response({
      version: "gittensory-rees@abc123",
      dateReleased: "2026-06-29T00:00:00Z",
      commitCount: 1,
      deployCount: 0,
      projects: [{ slug: "gittensory" }],
    });
  };

  await assert.rejects(
    () => validateSentryRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof SentryReleaseValidationError);
      assert.deepEqual(error.failures, ["release has no associated deploys"]);
      return true;
    },
  );
});
