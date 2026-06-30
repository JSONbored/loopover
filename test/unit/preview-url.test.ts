import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitHubResponseCacheForTest, githubRateLimitAdmissionKeyForInstallation, latestGitHubRestRateLimitObservation } from "../../src/github/client";
import { getPreviewBuildState } from "../../src/review/visual/preview-url";

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("preview-url GitHub reads", () => {
  it("records REST admission telemetry only for installation-token preview lookups", async () => {
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { check_runs: [] },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
          },
        },
      ),
    );

    await expect(
      getPreviewBuildState({ token: "dummy-user-token", repo: { owner: "o", repo: "r" }, sha: "abc123" }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toBeNull();

    await expect(
      getPreviewBuildState({
        token: "dummy-installation-token",
        repo: { owner: "o", repo: "r" },
        sha: "abc123",
        rateLimitAdmissionKey: key,
      }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 42,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
    });
  });
});
