import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPostHogReleaseValidationConfig,
  PostHogReleaseValidationError,
  validatePostHogRelease,
} from "../scripts/validate-posthog-release.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validationEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    POSTHOG_CLI_API_KEY: "phx_test",
    POSTHOG_CLI_PROJECT_ID: "42",
    POSTHOG_RELEASE: "loopover-rees@abc123",
    ...overrides,
  };
}

test("loadPostHogReleaseValidationConfig resolves exact release validation defaults", () => {
  assert.deepEqual(
    loadPostHogReleaseValidationConfig({
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-rees@abc123",
    }),
    {
      apiKey: "phx_test",
      projectId: "42",
      release: "loopover-rees@abc123",
      baseUrl: "https://us.posthog.com",
    },
  );
});

test("loadPostHogReleaseValidationConfig uses POSTHOG_CLI_HOST when set and strips a trailing slash", () => {
  const config = loadPostHogReleaseValidationConfig({ POSTHOG_CLI_HOST: "https://eu.posthog.com/" });
  assert.equal(config.baseUrl, "https://eu.posthog.com");
});

test("validatePostHogRelease throws when fetch is unavailable", async () => {
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), null as never),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["Node 20+ fetch support is required"]);
      return true;
    },
  );
});

test("validatePostHogRelease throws with all missing fields listed when config is incomplete", async () => {
  await assert.rejects(
    () => validatePostHogRelease({}, async () => response({})),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["missing POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID, POSTHOG_RELEASE"]);
      return true;
    },
  );
});

test("validatePostHogRelease queries the correct URL with the bearer auth header", async () => {
  let capturedUrl: string | undefined;
  let capturedAuth: string | undefined;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>).authorization;
    return response({ results: [] });
  };

  await assert.rejects(() => validatePostHogRelease(validationEnv(), fetchImpl));
  assert.equal(capturedUrl, "https://us.posthog.com/api/projects/42/error_tracking/symbol_sets?limit=100");
  assert.equal(capturedAuth, "Bearer phx_test");
});

test("validatePostHogRelease throws with the response status/message when the API request fails", async () => {
  const fetchImpl = async (): Promise<Response> => response({ detail: "invalid token" }, 401);
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.equal(error.failures[0].includes("returned HTTP 401 (invalid token)"), true);
      return true;
    },
  );
});

test("validatePostHogRelease falls back to statusText when a failed response body isn't valid JSON", async () => {
  const fetchImpl = async (): Promise<Response> => new Response("not json", { status: 500, statusText: "Internal Server Error" });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.equal(error.failures[0].includes("returned HTTP 500 (Internal Server Error)"), true);
      return true;
    },
  );
});

test("validatePostHogRelease accepts a bare array response body (not wrapped in {results})", async () => {
  // The real error_tracking/symbol_sets API returns `release` as a NESTED OBJECT
  // ({id, hash_id, created_at, metadata, version, project}), never a flat string -- these fixtures use that
  // real shape throughout this file (see releaseIdentifier's own comment in the source for why).
  const fetchImpl = async (): Promise<Response> =>
    response([{ release: { project: "loopover-rees", version: "abc123" }, failure_reason: null }]);
  const result = await validatePostHogRelease(validationEnv(), fetchImpl);
  assert.deepEqual(result, { release: "loopover-rees@abc123", symbolSetCount: 1 });
});

test("validatePostHogRelease treats a response body that's neither an array nor {results} as an empty list", async () => {
  const fetchImpl = async (): Promise<Response> => response({ unexpected: "shape" });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["no symbol sets found for release loopover-rees@abc123"]);
      return true;
    },
  );
});

test("validatePostHogRelease fails when no symbol sets match the target release", async () => {
  const fetchImpl = async (): Promise<Response> =>
    response({ results: [{ release: { project: "some-other", version: "release" } }] });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["no symbol sets found for release loopover-rees@abc123"]);
      return true;
    },
  );
});

test("validatePostHogRelease fails when a symbol set's release is null (skip_release_on_fail path)", async () => {
  const fetchImpl = async (): Promise<Response> => response({ results: [{ release: null }] });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["no symbol sets found for release loopover-rees@abc123"]);
      return true;
    },
  );
});

test("validatePostHogRelease treats a release object missing version or project as non-matching", async () => {
  const fetchImpl = async (): Promise<Response> =>
    response({ results: [{ release: { project: "loopover-rees" } }, { release: { version: "abc123" } }] });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["no symbol sets found for release loopover-rees@abc123"]);
      return true;
    },
  );
});

test("validatePostHogRelease fails when a matching symbol set recorded a failure_reason", async () => {
  const fetchImpl = async (): Promise<Response> =>
    response({
      results: [{ release: { project: "loopover-rees", version: "abc123" }, failure_reason: "could not parse sourcemap" }],
    });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["1 symbol set(s) for release loopover-rees@abc123 recorded a failure_reason"]);
      return true;
    },
  );
});

test("validatePostHogRelease succeeds when at least one matching symbol set has no failure_reason", async () => {
  const fetchImpl = async (): Promise<Response> =>
    response({
      results: [
        { release: { project: "some-other", version: "release" }, failure_reason: "unrelated" },
        { release: { project: "loopover-rees", version: "abc123" }, failure_reason: null },
        { release: { project: "loopover-rees", version: "abc123" } },
      ],
    });
  const result = await validatePostHogRelease(validationEnv(), fetchImpl);
  assert.deepEqual(result, { release: "loopover-rees@abc123", symbolSetCount: 2 });
});

test("validatePostHogRelease counts every failed symbol set, not just the first one found", async () => {
  const fetchImpl = async (): Promise<Response> =>
    response({
      results: [
        { release: { project: "loopover-rees", version: "abc123" }, failure_reason: "a" },
        { release: { project: "loopover-rees", version: "abc123" }, failure_reason: "b" },
      ],
    });
  await assert.rejects(
    () => validatePostHogRelease(validationEnv(), fetchImpl),
    (error) => {
      assert(error instanceof PostHogReleaseValidationError);
      assert.deepEqual(error.failures, ["2 symbol set(s) for release loopover-rees@abc123 recorded a failure_reason"]);
      return true;
    },
  );
});
