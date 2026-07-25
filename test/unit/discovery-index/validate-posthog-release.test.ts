// Coverage for validate-posthog-release.mjs (#8289). Outside codecov.yml's measured discovery-index/src/**
// scope (scripts/** isn't gated), same as its untested validate-sentry-release.mjs sibling -- written anyway
// since it carries real logic (config loading, API querying, failure aggregation) worth verifying directly.
import { describe, expect, it, vi } from "vitest";
import {
  loadPostHogReleaseValidationConfig,
  PostHogReleaseValidationError,
  validatePostHogRelease,
} from "../../../packages/discovery-index/scripts/validate-posthog-release.mjs";

function jsonResponse(body: unknown, ok = true, status = 200, statusText = "OK") {
  return { ok, status, statusText, json: async () => body };
}

describe("loadPostHogReleaseValidationConfig", () => {
  it("reads all fields and defaults the host to PostHog's app host", () => {
    const config = loadPostHogReleaseValidationConfig({
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "42",
      POSTHOG_RELEASE: "loopover-discovery-index@abc",
    });
    expect(config).toEqual({ apiKey: "phx_test", projectId: "42", release: "loopover-discovery-index@abc", baseUrl: "https://us.posthog.com" });
  });

  it("uses POSTHOG_CLI_HOST when set and strips a trailing slash", () => {
    const config = loadPostHogReleaseValidationConfig({ POSTHOG_CLI_HOST: "https://eu.posthog.com/" });
    expect(config.baseUrl).toBe("https://eu.posthog.com");
  });

  it("treats blank/whitespace values as unset", () => {
    const config = loadPostHogReleaseValidationConfig({ POSTHOG_CLI_API_KEY: "   ", POSTHOG_CLI_PROJECT_ID: "", POSTHOG_RELEASE: undefined });
    expect(config.apiKey).toBeUndefined();
    expect(config.projectId).toBeUndefined();
    expect(config.release).toBeUndefined();
  });
});

describe("validatePostHogRelease", () => {
  const validEnv = { POSTHOG_CLI_API_KEY: "phx_test", POSTHOG_CLI_PROJECT_ID: "42", POSTHOG_RELEASE: "loopover-discovery-index@abc" };

  it("throws when fetch is unavailable", async () => {
    // null, not undefined -- a default parameter only activates on an omitted/undefined argument, and
    // undefined here would silently fall through to the real globalThis.fetch (a live network call).
    await expect(validatePostHogRelease(validEnv, null as never)).rejects.toThrow("fetch is unavailable");
  });

  it("throws with all missing fields listed when config is incomplete", async () => {
    const fetchImpl = vi.fn();
    await expect(validatePostHogRelease({}, fetchImpl)).rejects.toMatchObject({
      failures: ["missing POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID, POSTHOG_RELEASE"],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("queries the correct URL with the bearer auth header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toBeInstanceOf(PostHogReleaseValidationError);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://us.posthog.com/api/projects/42/error_tracking/symbol_sets?limit=100",
      expect.objectContaining({ headers: { accept: "application/json", authorization: "Bearer phx_test" } }),
    );
  });

  it("throws with the response status/message when the API request fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ detail: "invalid token" }, false, 401, "Unauthorized"));
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toMatchObject({
      failures: [expect.stringContaining("returned HTTP 401 (invalid token)")],
    });
  });

  it("falls back to statusText when a failed response body isn't valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toMatchObject({
      failures: [expect.stringContaining("returned HTTP 500 (Internal Server Error)")],
    });
  });

  it("accepts a bare array response body (not wrapped in {results})", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ release: "loopover-discovery-index@abc", failure_reason: null }]));
    await expect(validatePostHogRelease(validEnv, fetchImpl)).resolves.toEqual({ release: "loopover-discovery-index@abc", symbolSetCount: 1 });
  });

  it("treats a response body that's neither an array nor {results} as an empty list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: "shape" }));
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toMatchObject({
      failures: [`no symbol sets found for release loopover-discovery-index@abc`],
    });
  });

  it("fails when no symbol sets match the target release", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{ release: "some-other-release" }] }));
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toMatchObject({
      failures: [`no symbol sets found for release loopover-discovery-index@abc`],
    });
  });

  it("fails when a matching symbol set recorded a failure_reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ release: "loopover-discovery-index@abc", failure_reason: "could not parse sourcemap" }] }),
    );
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toMatchObject({
      failures: ["1 symbol set(s) for release loopover-discovery-index@abc recorded a failure_reason"],
    });
  });

  it("succeeds when at least one matching symbol set has no failure_reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { release: "some-other-release", failure_reason: "unrelated" },
          { release: "loopover-discovery-index@abc", failure_reason: null },
          { release: "loopover-discovery-index@abc" },
        ],
      }),
    );
    await expect(validatePostHogRelease(validEnv, fetchImpl)).resolves.toEqual({ release: "loopover-discovery-index@abc", symbolSetCount: 2 });
  });

  it("counts every failed symbol set, not just the first one found", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ release: "loopover-discovery-index@abc", failure_reason: "a" }, { release: "loopover-discovery-index@abc", failure_reason: "b" }] }),
    );
    await expect(validatePostHogRelease(validEnv, fetchImpl)).rejects.toMatchObject({
      failures: ["2 symbol set(s) for release loopover-discovery-index@abc recorded a failure_reason"],
    });
  });
});
