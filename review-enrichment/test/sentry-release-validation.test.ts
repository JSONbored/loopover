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

test("REGRESSION: validateSentryRelease does NOT enforce the expected-commit match when SENTRY_REQUIRE_COMMITS=false", async () => {
  // Same mismatched-commit fixture as the strict-mode test above ("def456" vs the expected "abc123"), but with
  // requireCommits off (upload-sourcemaps.ts's non-strict deploy path: SENTRY_REQUIRE_COMMITS: fields.strict ?
  // "true" : "false"). SENTRY_COMMIT_SHA is still passed unconditionally (it's the deploy's actual git SHA, not
  // itself a strictness signal), so expectedCommitSha stays set -- the bug this guards was that the match check
  // read only `config.expectedCommitSha`, never `config.requireCommits`, so it fired regardless of strict mode.
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
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

  const result = await validateSentryRelease(validationEnv({ SENTRY_REQUIRE_COMMITS: "false" }), fetchImpl);
  assert.equal(result.release, "gittensory-rees@abc123");
  // Non-strict mode must not even CALL the commits endpoint -- confirmed below with a second regression pinning
  // this exact call-skip, since a real Sentry API hiccup on /commits/ would otherwise still fail a non-strict
  // deploy (sentryJson throws on any non-OK response) even though no commit check would run on the result.
  assert.equal(calls.includes("/api/0/organizations/jsonbored/releases/gittensory-rees%40abc123/commits/"), false);
});

test("REGRESSION: validateSentryRelease never calls the commits endpoint at all when SENTRY_REQUIRE_COMMITS=false, even if that endpoint is unhealthy", async () => {
  // The specific gap the AI reviewer caught on the first pass of this fix: gating only the FAILURE pushes on
  // requireCommits, while leaving the fetch itself conditioned on `requireCommits || expectedCommitSha`, meant a
  // non-strict deploy still depended on /commits/ succeeding even though nothing would ever fail from its result.
  // Prove it directly: the endpoint returns a hard 500, and non-strict validation must still succeed.
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/commits/")) return response({ detail: "internal error" }, 500);
    if (path.endsWith("/deploys/")) return response([{ name: "deploy-1", environment: "production" }]);
    return response({
      version: "gittensory-rees@abc123",
      dateReleased: "2026-06-29T00:00:00Z",
      commitCount: 1,
      deployCount: 1,
      projects: [{ slug: "gittensory" }],
    });
  };

  const result = await validateSentryRelease(validationEnv({ SENTRY_REQUIRE_COMMITS: "false" }), fetchImpl);
  assert.equal(result.release, "gittensory-rees@abc123");
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
