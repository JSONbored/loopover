import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubResponseCacheForTest,
  githubRateLimitAdmissionKeyForInstallation,
  latestGitHubRestRateLimitObservation,
} from "../../src/github/client";
import { buildCapture } from "../../src/review/visual/capture";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("visual capture preview discovery", () => {
  it("threads admission telemetry through deployment, checks, comments, and build-state fallbacks", async () => {
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    const seenUrls: string[] = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      const init = {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "33",
          "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
        },
      };
      if (url.includes("/deployments?")) return Response.json([], init);
      if (url.includes("/status")) return Response.json({ statuses: [] }, init);
      if (url.includes("/issues/7/comments")) return Response.json([], init);
      if (url.includes("/check-runs")) {
        return Response.json(
          { check_runs: [{ name: "Cloudflare Workers Builds", status: "completed", conclusion: "failure" }] },
          init,
        );
      }
      return Response.json({}, init);
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      {
        repoFullName: "owner/repo",
        prNumber: 7,
        headSha: "abc123",
        previewFromChecks: true,
      },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      key,
    );

    expect(seenUrls.some((url) => url.includes("/deployments?sha=abc123"))).toBe(true);
    expect(seenUrls.some((url) => url.includes("/commits/abc123/status"))).toBe(true);
    expect(seenUrls.some((url) => url.includes("/commits/abc123/check-runs"))).toBe(true);
    expect(seenUrls.some((url) => url.includes("/issues/7/comments"))).toBe(true);
    expect(result.previewPending).toBe(false);
    expect(result.routes).toEqual([
      {
        path: "/app",
        beforeUrl: undefined,
        beforeUrlMobile: undefined,
        afterUrl: "https://worker.example/gittensory/shot?placeholder=failed",
        afterUrlMobile: "https://worker.example/gittensory/shot?placeholder=failed",
      },
    ]);
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 33,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
    });
  });
});
