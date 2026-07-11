import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubResponseCacheForTest,
  githubRateLimitAdmissionKeyForInstallation,
  latestGitHubRestRateLimitObservation,
} from "../../src/github/client";
import { fallbackShotR2Key, markFallbackDispatched } from "../../src/review/visual/actions-fallback";
import { buildCapture, fetchExternalScreenshotContentBlock, fetchShotContentBlock, hasSuccessfulBotCapture, mapFilesToRoutes, resolvePreviewUrlTemplate, resolveVisualRoutes } from "../../src/review/visual/capture";
import type { CaptureRoute } from "../../src/review/visual/capture";
import * as pixelDiffModule from "../../src/review/visual/pixel-diff";
import * as previewUrlModule from "../../src/review/visual/preview-url";
import * as scrollGifModule from "../../src/review/visual/scroll-gif";
import * as shotModule from "../../src/review/visual/shot";
import { sha256Hex } from "../../src/utils/crypto";
import { createTestEnv } from "../helpers/d1";

/** Minimal in-memory R2Bucket-compatible store (mirrors the self-host filesystem blob-store's get/put
 *  surface) — lets a test pre-seed a "cached" screenshot at the exact fingerprinted key capturePage derives,
 *  without needing a real browser binding to produce fresh bytes. `failPut: true` makes every put() reject,
 *  for testing the caller's own `.catch(() => undefined)` degrade-gracefully path. */
function memoryReviewAudit(options: { failPut?: boolean; failGet?: boolean } = {}): R2Bucket {
  const store = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      if (options.failGet) throw new Error("simulated storage read failure");
      const bytes = store.get(key);
      return bytes ? ({ body: new Response(bytes).body } as unknown as R2ObjectBody) : null;
    },
    async put(key: string, value: unknown) {
      if (options.failPut) throw new Error("simulated storage failure");
      const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      store.set(key, bytes);
      return { key } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
}

/** An R2Bucket whose get() resolves to a cached object whose body stream ERRORS when read — for testing
 *  capturePage's "cache hit but reading the bytes back fails" degrade-gracefully path. */
function reviewAuditWithBrokenCachedBody(key: string): R2Bucket {
  return {
    async get(requestedKey: string) {
      if (requestedKey !== key) return null;
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error("simulated read failure"));
        },
      });
      return { body } as unknown as R2ObjectBody;
    },
    async put() {
      return { key } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
}

async function shotKey(prNumber: number, slot: "before" | "after", viewportName: "desktop" | "mobile", page: string): Promise<string> {
  const fingerprint = await sha256Hex(`${prNumber}:${slot}:${viewportName}:${page}`);
  return `gittensory/shots/${fingerprint.slice(0, 40)}.png`;
}

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

  it("an explicit preview.url_template wins over the target's own previewUrl and skips discovery entirely", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      throw new Error("discovery must never be called when review.visual.preview.url_template is configured");
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      {
        repoFullName: "owner/repo",
        prNumber: 42,
        headSha: "abc1234def5678900000000000000000000000a",
        previewUrl: "https://should-be-ignored.example.com",
        previewFromChecks: true,
      },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { preview: { urlTemplate: "https://pr-{number}-{head_sha_short}.preview.example.com" } },
    );

    expect(seenUrls).toEqual([]);
    expect(result.previewPending).toBe(false);
    expect(result.routes).toEqual([
      {
        path: "/app",
        beforeUrl: undefined,
        beforeUrlMobile: undefined,
        afterUrl: `https://worker.example/gittensory/shot?url=${encodeURIComponent("https://pr-42-abc1234.preview.example.com/app")}&w=1440&h=900`,
        afterUrlMobile: `https://worker.example/gittensory/shot?url=${encodeURIComponent("https://pr-42-abc1234.preview.example.com/app")}&w=390&h=844`,
      },
    ]);
  });

  it("uses target.previewUrl directly (no url_template configured) and skips discovery entirely", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      throw new Error("discovery must not run when target.previewUrl is already set");
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 9, previewUrl: "https://existing-preview.example.com", previewFromChecks: true },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(seenUrls).toEqual([]);
    expect(result.routes[0]?.afterUrl).toContain(encodeURIComponent("https://existing-preview.example.com/app"));
  });

  it("degrades to no preview (never throws) when getLatestDeploymentStatus itself throws — defense-in-depth for a callee that never actually rejects in practice", async () => {
    const statusSpy = vi.spyOn(previewUrlModule, "getLatestDeploymentStatus").mockRejectedValueOnce(new Error("transient failure"));
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));

    try {
      const result = await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 10, headSha: "deadbeef" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(result.routes[0]?.afterUrl).toContain("placeholder=loading");
      expect(result.previewPending).toBe(false);
    } finally {
      statusSpy.mockRestore();
    }
  });

  it("marks the capture pending when a matching check run is still running (buildState 'building')", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        return Response.json({ check_runs: [{ name: "Cloudflare Workers Builds", status: "in_progress" }] });
      }
      if (url.includes("/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 11, headSha: "cafebabe", previewFromChecks: true },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(result.previewPending).toBe(true);
    expect(result.routes[0]?.afterUrl).toContain("placeholder=loading");
  });

  it("finds the preview URL from a commit check run, skipping the PR-comment fallback entirely", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      seenUrls.push(url);
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        return Response.json({ check_runs: [{ status: "completed", conclusion: "success", details_url: "https://pr-9.myapp.pages.dev/preview" }] });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 9, headSha: "cafebabe", previewFromChecks: true },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(seenUrls.some((url) => url.includes("/issues/9/comments"))).toBe(false);
    expect(result.routes[0]?.afterUrl).toContain(encodeURIComponent("https://pr-9.myapp.pages.dev/app"));
  });

  it("marks the capture pending when a matching check run already succeeded (buildState 'succeeded')", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        return Response.json({ check_runs: [{ name: "Cloudflare Workers Builds", status: "completed", conclusion: "success" }] });
      }
      if (url.includes("/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 12, headSha: "cafebabe", previewFromChecks: true },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(result.previewPending).toBe(true);
  });

  it("leaves the capture non-pending when no matching preview check run exists at all (buildState 'absent')", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ check_runs: [{ name: "lint", status: "completed", conclusion: "success" }] });
      if (url.includes("/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 13, headSha: "cafebabe", previewFromChecks: true },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(result.previewPending).toBe(false);
  });

  it("an explicit routes.paths list replaces file-based route inference end to end", async () => {
    vi.stubGlobal("fetch", async () => Response.json([], { status: 200 }));

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 1, previewFromChecks: false },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { routes: { paths: ["/pricing"] } },
    );

    expect(result.routes.map((route) => route.path)).toEqual(["/pricing"]);
  });
});

describe("resolvePreviewUrlTemplate (#3609)", () => {
  it("substitutes {number}, {head_sha}, and {head_sha_short}", () => {
    const url = resolvePreviewUrlTemplate("https://pr-{number}-{head_sha_short}.preview.example.com/{head_sha}", {
      number: 42,
      headSha: "abc1234def5678900000000000000000000000a",
    });
    expect(url).toBe("https://pr-42-abc1234.preview.example.com/abc1234def5678900000000000000000000000a");
  });

  it("leaves the sha placeholders empty when headSha is missing", () => {
    expect(resolvePreviewUrlTemplate("https://pr-{number}-{head_sha_short}.example.com/{head_sha}", { number: 7 })).toBe(
      "https://pr-7-.example.com/",
    );
  });

  it("is a no-op on a template with no placeholders", () => {
    expect(resolvePreviewUrlTemplate("https://staging.example.com", { number: 1, headSha: "abc" })).toBe("https://staging.example.com");
  });
});

describe("resolveVisualRoutes (#3610)", () => {
  const files = ["apps/gittensory-ui/src/routes/app.index.tsx"];
  const manyFiles = [
    "apps/gittensory-ui/src/routes/app.index.tsx",
    "apps/gittensory-ui/src/routes/app.analytics.tsx",
    "apps/gittensory-ui/src/routes/app.billing.tsx",
  ];

  it("falls through to file-based inference when config is absent, null, or empty", () => {
    expect(resolveVisualRoutes(files)).toEqual(["/app"]);
    expect(resolveVisualRoutes(files, null)).toEqual(["/app"]);
    expect(resolveVisualRoutes(files, {})).toEqual(["/app"]);
  });

  it("an explicit non-empty paths list replaces file-based inference entirely", () => {
    expect(resolveVisualRoutes(files, { paths: ["/pricing", "/docs"] })).toEqual(["/pricing", "/docs"]);
  });

  it("an explicit but empty paths list still falls through to inference", () => {
    expect(resolveVisualRoutes(files, { paths: [] })).toEqual(["/app"]);
  });

  it("maxRoutes caps an explicit paths list, not just inferred routes", () => {
    expect(resolveVisualRoutes(manyFiles, { paths: ["/a", "/b", "/c"], maxRoutes: 2 })).toEqual(["/a", "/b"]);
  });

  it("clamps oversized configured maxRoutes to the safe visual route limit", () => {
    const sixFiles = [
      ...manyFiles,
      "apps/gittensory-ui/src/routes/app.settings.tsx",
      "apps/gittensory-ui/src/routes/app.usage.tsx",
      "apps/gittensory-ui/src/routes/app.users.tsx",
    ];
    expect(resolveVisualRoutes(sixFiles, { maxRoutes: 1000 })).toEqual([
      "/app",
      "/app/analytics",
      "/app/billing",
      "/app/settings",
      "/app/usage",
    ]);
    expect(resolveVisualRoutes(sixFiles, { paths: ["/a", "/b", "/c", "/d", "/e", "/f"], maxRoutes: 1000 })).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });

  it("a maxRoutes of zero or negative falls back to the built-in default cap", () => {
    expect(resolveVisualRoutes(manyFiles, { maxRoutes: 0 })).toEqual(["/app", "/app/analytics"]);
    expect(resolveVisualRoutes(manyFiles, { maxRoutes: -1 })).toEqual(["/app", "/app/analytics"]);
  });
});

describe("mapFilesToRoutes maxRoutes parameter", () => {
  const manyFiles = [
    "apps/gittensory-ui/src/routes/app.index.tsx",
    "apps/gittensory-ui/src/routes/app.analytics.tsx",
    "apps/gittensory-ui/src/routes/app.billing.tsx",
  ];

  it("defaults to the built-in cap of 2", () => {
    expect(mapFilesToRoutes(manyFiles)).toEqual(["/app", "/app/analytics"]);
  });

  it("honors an explicit maxRoutes override", () => {
    expect(mapFilesToRoutes(manyFiles, undefined, 1)).toEqual(["/app"]);
    expect(mapFilesToRoutes(manyFiles, undefined, 3)).toEqual(["/app", "/app/analytics", "/app/billing"]);
  });
});

describe("mapFilesToRoutes app-folder generalization (#3611 follow-up)", () => {
  it("maps metagraphed-style apps/ui/src/routes/** files the same way as apps/gittensory-ui/** (identical TanStack flat-file convention, different app folder name)", () => {
    expect(mapFilesToRoutes(["apps/ui/src/routes/settings.tsx"])).toEqual(["/settings"]);
    expect(mapFilesToRoutes(["apps/ui/src/routes/accounts.index.tsx"])).toEqual(["/accounts"]);
  });

  it("still falls back to '/' for a file that matches no app-folder-routes pattern at all", () => {
    expect(mapFilesToRoutes(["src/components/Widget.tsx"])).toEqual(["/"]);
  });
});

describe("review.visual.production_url (#3611 follow-up)", () => {
  it("prefers visualConfig.productionUrl over the global PUBLIC_SITE_ORIGIN env var for the 'before' shot", async () => {
    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://gittensory.example.com" }),
      "installation-token",
      { repoFullName: "owner/metagraphed", prNumber: 50, previewUrl: "https://preview.example.com" },
      ["apps/ui/src/routes/index.tsx"],
      undefined,
      { productionUrl: "https://metagraph.example.com" },
    );
    expect(result.routes[0]?.beforeUrl).toContain(encodeURIComponent("https://metagraph.example.com/"));
    expect(result.routes[0]?.beforeUrl).not.toContain(encodeURIComponent("https://gittensory.example.com"));
  });

  it("falls back to the global PUBLIC_SITE_ORIGIN when visualConfig.productionUrl is null/unset", async () => {
    const withNull = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://gittensory.example.com" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 51, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { productionUrl: null },
    );
    expect(withNull.routes[0]?.beforeUrl).toContain(encodeURIComponent("https://gittensory.example.com/app"));

    const withoutConfig = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://gittensory.example.com" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 52, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );
    expect(withoutConfig.routes[0]?.beforeUrl).toContain(encodeURIComponent("https://gittensory.example.com/app"));
  });

  it("degrades to an empty 'before' base (no page, no shot) when NEITHER productionUrl nor PUBLIC_SITE_ORIGIN is set at all", async () => {
    const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example" });
    delete (env as Partial<Env>).PUBLIC_SITE_ORIGIN;
    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 53, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { productionUrl: null },
    );
    expect(result.routes[0]?.beforeUrl).toBeUndefined();
    expect(result.routes[0]?.beforeUrlMobile).toBeUndefined();
  });
});

describe("buildCapture pixel-diff wiring (#3674)", () => {
  it("never calls the diff provider when diffing is unavailable (the real, unmocked default) — byte-identical to pre-#3674", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable");
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots");
    try {
      const result = await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 1, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(availableSpy).toHaveBeenCalled();
      expect(compareSpy).not.toHaveBeenCalled();
      expect(result.routes[0]?.diffUrl).toBeUndefined();
      expect(result.routes[0]?.diffUrlMobile).toBeUndefined();
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("uploads a diff image and threads diffUrl when the provider reports a real change", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "changed",
      changedPixelPercent: 12.5,
      diffImagePng: new Uint8Array([1, 2, 3, 4]),
    });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 2, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(result.routes[0]?.diffUrl).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.diffUrlMobile).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.diffUrl).not.toBe(result.routes[0]?.diffUrlMobile);
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("does not attach a diffUrl when the provider reports no visible change (no diff image)", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "unchanged",
      changedPixelPercent: 0,
      diffImagePng: null,
    });
    try {
      const result = await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 3, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(result.routes[0]?.diffUrl).toBeUndefined();
      expect(result.routes[0]?.diffUrlMobile).toBeUndefined();
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("skips the diff upload gracefully when REVIEW_AUDIT/PUBLIC_API_ORIGIN aren't configured, even with a real diff image", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "changed",
      changedPixelPercent: 40,
      diffImagePng: new Uint8Array([9, 9, 9]),
    });
    try {
      const result = await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 4, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(result.routes[0]?.diffUrl).toBeUndefined();
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("passes cached screenshot bytes (not just the URL) to the diff provider on a cache hit — the common case for a reused 'before' shot", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue(null);
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
      });
      const beforeBytes = new Uint8Array([10, 20, 30]);
      const afterBytes = new Uint8Array([40, 50, 60]);
      const beforeKey = await shotKey(5, "before", "desktop", "https://prod.example.com/app");
      const afterKey = await shotKey(5, "after", "desktop", "https://preview.example.com/app");
      await env.REVIEW_AUDIT!.put(beforeKey, beforeBytes, {} as R2PutOptions);
      await env.REVIEW_AUDIT!.put(afterKey, afterBytes, {} as R2PutOptions);

      await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 5, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );

      const desktopCall = compareSpy.mock.calls.find(([before, after]) => before !== undefined || after !== undefined);
      expect(desktopCall?.[0]).toEqual(beforeBytes);
      expect(desktopCall?.[1]).toEqual(afterBytes);
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("returns just the URL (no bytes) on a cache hit when diffing is unavailable — the real default, includeBytes stays false", async () => {
    const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
    const beforeKey = await shotKey(6, "before", "desktop", "https://prod.example.com/app");
    await env.REVIEW_AUDIT!.put(beforeKey, new Uint8Array([1, 2, 3]), {} as R2PutOptions);

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 6, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(result.routes[0]?.beforeUrl).toContain("/gittensory/shot?key=");
    expect(result.routes[0]?.diffUrl).toBeUndefined();
  });

  it("degrades to no bytes (never throws) when reading a cached screenshot's body fails", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue(null);
    try {
      const beforeKey = await shotKey(7, "before", "desktop", "https://prod.example.com/app");
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: reviewAuditWithBrokenCachedBody(beforeKey),
      });

      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 7, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );

      expect(result.routes[0]?.beforeUrl).toContain("/gittensory/shot?key=");
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("returns just the URL (no bytes) for a fresh successful render when diffing is unavailable — the real default", async () => {
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: new Uint8Array([5, 5, 5]), authWalled: false });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
      });

      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 11, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );

      expect(captureShotSpy).toHaveBeenCalled();
      expect(result.routes[0]?.beforeUrl).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.diffUrl).toBeUndefined();
    } finally {
      captureShotSpy.mockRestore();
    }
  });

  it("threads fresh screenshot bytes to the diff provider right after a successful render, not just on a cache hit", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue(null);
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: new Uint8Array([9, 9, 9]), authWalled: false });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
      });

      await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 8, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );

      expect(captureShotSpy).toHaveBeenCalled();
      const bothSidesFresh = compareSpy.mock.calls.find(([before, after]) => before !== undefined && after !== undefined);
      expect(bothSidesFresh?.[0]).toEqual(new Uint8Array([9, 9, 9]));
      expect(bothSidesFresh?.[1]).toEqual(new Uint8Array([9, 9, 9]));
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
      captureShotSpy.mockRestore();
    }
  });

  it("still returns a diff URL even when persisting the diff image fails (fire-and-forget put, mirrors capturePage's own pattern)", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "changed",
      changedPixelPercent: 30,
      diffImagePng: new Uint8Array([7, 7, 7]),
    });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit({ failPut: true }),
      });

      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 10, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );

      expect(result.routes[0]?.diffUrl).toContain("/gittensory/shot?key=");
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });
});

describe("buildCapture with REVIEW_AUDIT_S3_PUBLIC_URL configured (direct bucket links)", () => {
  it("links an already-cached shot directly at the bucket instead of this instance's /gittensory/shot proxy", async () => {
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
      REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev",
    });
    const afterKey = await shotKey(30, "after", "desktop", "https://preview.example.com/app");
    await env.REVIEW_AUDIT!.put(afterKey, new Uint8Array([1, 2, 3]));
    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 30, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );
    expect(result.routes[0]?.afterUrl).toBe(`https://pub-abc123.r2.dev/${afterKey}`);
    expect(result.routes[0]?.afterUrl).not.toContain("/gittensory/shot?key=");
  });

  it("strips a trailing slash from REVIEW_AUDIT_S3_PUBLIC_URL before joining the key", async () => {
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
      REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev/",
    });
    const afterKey = await shotKey(31, "after", "desktop", "https://preview.example.com/app");
    await env.REVIEW_AUDIT!.put(afterKey, new Uint8Array([1, 2, 3]));
    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 31, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );
    expect(result.routes[0]?.afterUrl).toBe(`https://pub-abc123.r2.dev/${afterKey}`); // no double slash
  });

  it("wins over PUBLIC_API_ORIGIN when both are configured", async () => {
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
      REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev",
    });
    const beforeKey = await shotKey(32, "before", "desktop", "https://prod.example.com/app");
    await env.REVIEW_AUDIT!.put(beforeKey, new Uint8Array([1, 2, 3]));
    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 32, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );
    expect(result.routes[0]?.beforeUrl).toContain("pub-abc123.r2.dev");
    expect(result.routes[0]?.beforeUrl).not.toContain("worker.example");
  });

  it("the on-demand (?url=) fallback still goes through this instance's own PUBLIC_API_ORIGIN even with a public bucket configured — rendering only ever happens here", async () => {
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      // REVIEW_AUDIT deliberately absent: forces the onDemand fallback path in capturePage.
      REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev",
    });
    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 23, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );
    expect(result.routes[0]?.afterUrl).toContain("worker.example/gittensory/shot?url=");
  });

  it("uploadDiffImage links directly at the bucket even when PUBLIC_API_ORIGIN is unset (S3 public URL alone is enough)", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "changed",
      changedPixelPercent: 15,
      diffImagePng: new Uint8Array([3, 3, 3]),
    });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
        REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev",
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 24, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(result.routes[0]?.diffUrl).toMatch(/^https:\/\/pub-abc123\.r2\.dev\//);
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });

  it("uploadDiffImage still skips gracefully when NEITHER PUBLIC_API_ORIGIN nor the S3 public URL is configured", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "changed",
      changedPixelPercent: 15,
      diffImagePng: new Uint8Array([3, 3, 3]),
    });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 25, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(result.routes[0]?.diffUrl).toBeUndefined();
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });
});

describe("buildCapture theme matrix (#3678)", () => {
  it("produces exactly one untagged route per path when no themes are configured — byte-identical to pre-#3678", async () => {
    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 20, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.theme).toBeUndefined();
  });

  it("produces one tagged route per (path, theme) pair when themes are configured, with distinct shot URLs per theme", async () => {
    const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 21, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { themes: ["light", "dark"] },
    );
    expect(result.routes).toHaveLength(2);
    expect(result.routes.map((r) => r.theme)).toEqual(["light", "dark"]);
    expect(result.routes[0]?.path).toBe(result.routes[1]?.path);
    // Different themes must never collide on the same cache key/URL.
    expect(result.routes[0]?.beforeUrl).not.toBe(result.routes[1]?.beforeUrl);
  });

  it("tags the single route with its theme even when only one theme is explicitly configured", async () => {
    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 22, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { themes: ["dark"] },
    );
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.theme).toBe("dark");
  });

  it("passes the configured theme through to captureShot's render options", async () => {
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: null, authWalled: false });
    try {
      await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 23, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { themes: ["dark"] },
      );
      expect(captureShotSpy).toHaveBeenCalled();
      const themedCall = captureShotSpy.mock.calls.find(([, , , opts]) => opts?.theme === "dark");
      expect(themedCall).toBeDefined();
    } finally {
      captureShotSpy.mockRestore();
    }
  });

  it("never passes a theme option to captureShot when no themes are configured", async () => {
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: null, authWalled: false });
    try {
      await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 24, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(captureShotSpy).toHaveBeenCalled();
      expect(captureShotSpy.mock.calls.every(([, , , opts]) => !opts?.theme)).toBe(true);
    } finally {
      captureShotSpy.mockRestore();
    }
  });

  it("threads the theme into the diff-image fingerprint too, so a themed and untagged diff never collide", async () => {
    const availableSpy = vi.spyOn(pixelDiffModule, "isVisualDiffAvailable").mockReturnValue(true);
    const compareSpy = vi.spyOn(pixelDiffModule, "compareCapturedScreenshots").mockResolvedValue({
      status: "changed",
      changedPixelPercent: 12.5,
      diffImagePng: new Uint8Array([1, 2, 3, 4]),
    });
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 25, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { themes: ["dark"] },
      );
      expect(result.routes[0]?.theme).toBe("dark");
      expect(result.routes[0]?.diffUrl).toContain("/gittensory/shot?key=");
      // Same path/PR, but tagged "dark" — must not reuse the untagged diff's fingerprint (theme is part of the key).
      const untaggedFingerprint = await sha256Hex(`25:diff:desktop:/app`);
      expect(result.routes[0]?.diffUrl).not.toContain(untaggedFingerprint.slice(0, 40));
    } finally {
      availableSpy.mockRestore();
      compareSpy.mockRestore();
    }
  });
});

describe("buildCapture theme-storage-key wiring (#4109)", () => {
  it("passes themeStorageKey through to captureShot's render options when both themes and theme_storage_key are configured", async () => {
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: null, authWalled: false });
    try {
      await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 40, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { themes: ["dark"], themeStorageKey: "theme" },
      );
      expect(captureShotSpy).toHaveBeenCalled();
      const themedCall = captureShotSpy.mock.calls.find(([, , , opts]) => opts?.theme === "dark" && opts?.themeStorageKey === "theme");
      expect(themedCall).toBeDefined();
    } finally {
      captureShotSpy.mockRestore();
    }
  });

  it("never passes themeStorageKey to captureShot when no themes are configured, even if theme_storage_key is set", async () => {
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: null, authWalled: false });
    try {
      await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 41, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { themeStorageKey: "theme" },
      );
      expect(captureShotSpy).toHaveBeenCalled();
      expect(captureShotSpy.mock.calls.every(([, , , opts]) => !opts?.theme && !opts?.themeStorageKey)).toBe(true);
    } finally {
      captureShotSpy.mockRestore();
    }
  });

  it("carries the theme storage key in the on-demand URL fallback so a later GitHub-image-proxy retry still forces it", async () => {
    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }), // no REVIEW_AUDIT -> always the on-demand fallback
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 44, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { themes: ["dark"], themeStorageKey: "theme" },
    );
    expect(result.routes[0]?.beforeUrl).toBe(
      `https://worker.example/gittensory/shot?url=${encodeURIComponent("https://prod.example.com/app")}&w=1440&h=900&theme=dark&themeStorageKey=${encodeURIComponent("theme")}`,
    );
  });

  it("omits themeStorageKey from the on-demand URL fallback when no theme is configured", async () => {
    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 45, previewUrl: "https://preview.example.com" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { themeStorageKey: "theme" },
    );
    expect(result.routes[0]?.beforeUrl).toBe(`https://worker.example/gittensory/shot?url=${encodeURIComponent("https://prod.example.com/app")}&w=1440&h=900`);
  });

  it("threads the theme storage key into the shot fingerprint too, so it never collides with an untagged-key capture of the same theme", async () => {
    const captureShotSpy = vi.spyOn(shotModule, "captureShot").mockResolvedValue({ png: new Uint8Array([9, 9, 9]), authWalled: false });
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 42, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { themes: ["dark"], themeStorageKey: "theme" },
      );
      expect(result.routes[0]?.theme).toBe("dark");
      expect(result.routes[0]?.beforeUrl).toContain("/gittensory/shot?key=");
      // Same PR/path/theme, but tagged with a storage key — must not reuse the untagged-key fingerprint.
      const untaggedFingerprint = await sha256Hex(`42:before:desktop:https://prod.example.com/app:dark`);
      expect(result.routes[0]?.beforeUrl).not.toContain(untaggedFingerprint.slice(0, 40));
    } finally {
      captureShotSpy.mockRestore();
    }
  });

  it("threads the theme storage key into the scroll-GIF fingerprint too, so it never collides with an untagged-key GIF", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 43, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true, themes: ["dark"], themeStorageKey: "theme" },
      );
      expect(result.routes[0]?.theme).toBe("dark");
      expect(result.routes[0]?.afterGifUrl).toContain("/gittensory/shot?key=");
      const untaggedFingerprint = await sha256Hex(`43:scrollgif:after:desktop:https://preview.example.com/app:dark`);
      expect(result.routes[0]?.afterGifUrl).not.toContain(untaggedFingerprint.slice(0, 40));
      expect(captureScrollSpy.mock.calls.some(([, , , opts]) => opts?.themeStorageKey === "theme")).toBe(true);
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });
});

describe("buildCapture scroll-GIF wiring (#3612)", () => {
  it("never captures scroll frames when review.visual.gif is unset, even when isScrollGifAvailable is true", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames");
    try {
      const result = await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 30, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
      );
      expect(captureScrollSpy).not.toHaveBeenCalled();
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
    }
  });

  it("never captures scroll frames when gif:true is configured but this build can't assemble GIFs (hosted mode)", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(false);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames");
    try {
      const result = await buildCapture(
        createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 31, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(captureScrollSpy).not.toHaveBeenCalled();
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
    }
  });

  it("captures + uploads both a before and after scroll GIF when gif:true and isScrollGifAvailable are both true", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 32, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(captureScrollSpy).toHaveBeenCalledTimes(2); // before + after
      expect(encodeSpy).toHaveBeenCalledTimes(2);
      expect(result.routes[0]?.beforeGifUrl).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.afterGifUrl).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.beforeGifUrl).not.toBe(result.routes[0]?.afterGifUrl);
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("links scroll GIFs directly at the bucket when REVIEW_AUDIT_S3_PUBLIC_URL is configured, even with PUBLIC_API_ORIGIN unset", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit(),
        REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev",
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 33, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(result.routes[0]?.beforeGifUrl).toMatch(/^https:\/\/pub-abc123\.r2\.dev\//);
      expect(result.routes[0]?.afterGifUrl).toMatch(/^https:\/\/pub-abc123\.r2\.dev\//);
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("does not attempt an after-GIF when there is no preview URL yet (afterPage is empty)", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 33 }, // no previewUrl -> afterPage is ""
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(captureScrollSpy).toHaveBeenCalledTimes(1); // before only
      expect(result.routes[0]?.beforeGifUrl).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("reuses a cached scroll GIF without re-capturing frames on the next review of the same head", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const target = { repoFullName: "owner/repo", prNumber: 34, previewUrl: "https://preview.example.com" };
      const files = ["apps/gittensory-ui/src/routes/app.index.tsx"];
      const first = await buildCapture(env, "installation-token", target, files, undefined, { gif: true });
      expect(captureScrollSpy).toHaveBeenCalledTimes(2);
      const second = await buildCapture(env, "installation-token", target, files, undefined, { gif: true });
      expect(captureScrollSpy).toHaveBeenCalledTimes(2); // no NEW calls — both slots served from cache
      expect(second.routes[0]?.beforeGifUrl).toBe(first.routes[0]?.beforeGifUrl);
      expect(second.routes[0]?.afterGifUrl).toBe(first.routes[0]?.afterGifUrl);
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("does not upload a GIF when the frames come back empty (auth-walled or render failure)", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({ frames: [], authWalled: false });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif");
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 35, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(encodeSpy).not.toHaveBeenCalled();
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("does not upload a GIF when the encoder degrades to null", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(null);
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 36, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("does not attempt a before-GIF when there is no production URL configured (beforePage is empty)", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 37, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(captureScrollSpy).toHaveBeenCalledTimes(1); // after only — before has no page to capture
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toContain("/gittensory/shot?key=");
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("does not capture scroll frames when there is no REVIEW_AUDIT storage, even with gif:true configured", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames");
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }); // no REVIEW_AUDIT
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 38, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(captureScrollSpy).not.toHaveBeenCalled();
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
    }
  });

  it("threads the theme into the scroll-GIF fingerprint too, so a themed and untagged GIF never collide", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 39, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true, themes: ["dark"] },
      );
      expect(result.routes[0]?.theme).toBe("dark");
      expect(result.routes[0]?.afterGifUrl).toContain("/gittensory/shot?key=");
      const untaggedFingerprint = await sha256Hex(`39:scrollgif:after:desktop:https://preview.example.com/app`);
      expect(result.routes[0]?.afterGifUrl).not.toContain(untaggedFingerprint.slice(0, 40));
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("degrades to a fresh capture (never throws) when the GIF cache lookup itself fails", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit({ failGet: true }),
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 40, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(captureScrollSpy).toHaveBeenCalled(); // cache lookup failed -> falls through to a fresh capture
      expect(result.routes[0]?.beforeGifUrl).toContain("/gittensory/shot?key=");
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });

  it("degrades to no GIF (never throws) when captureScrollFrames itself rejects", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockRejectedValue(new Error("browser binding exhausted"));
    try {
      const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com", REVIEW_AUDIT: memoryReviewAudit() });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 41, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(result.routes[0]?.beforeGifUrl).toBeUndefined();
      expect(result.routes[0]?.afterGifUrl).toBeUndefined();
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
    }
  });

  it("still returns the GIF URL even when persisting it fails (fire-and-forget put, mirrors uploadDiffImage's own pattern)", async () => {
    const gifAvailableSpy = vi.spyOn(scrollGifModule, "isScrollGifAvailable").mockReturnValue(true);
    const captureScrollSpy = vi.spyOn(shotModule, "captureScrollFrames").mockResolvedValue({
      frames: [new Uint8Array([1, 2, 3])],
      authWalled: false,
    });
    const encodeSpy = vi.spyOn(scrollGifModule, "encodeScrollGif").mockResolvedValue(new Uint8Array([7, 8, 9]));
    try {
      const env = createTestEnv({
        PUBLIC_API_ORIGIN: "https://worker.example",
        PUBLIC_SITE_ORIGIN: "https://prod.example.com",
        REVIEW_AUDIT: memoryReviewAudit({ failPut: true }),
      });
      const result = await buildCapture(
        env,
        "installation-token",
        { repoFullName: "owner/repo", prNumber: 42, previewUrl: "https://preview.example.com" },
        ["apps/gittensory-ui/src/routes/app.index.tsx"],
        undefined,
        { gif: true },
      );
      expect(result.routes[0]?.beforeGifUrl).toContain("/gittensory/shot?key=");
      expect(result.routes[0]?.afterGifUrl).toContain("/gittensory/shot?key=");
    } finally {
      gifAvailableSpy.mockRestore();
      captureScrollSpy.mockRestore();
      encodeSpy.mockRestore();
    }
  });
});

describe("hasSuccessfulBotCapture (#4110)", () => {
  const REAL_BEFORE = "https://api.example/gittensory/shot?key=gittensory%2Fshots%2Fbefore.png";
  const REAL_AFTER = "https://api.example/gittensory/shot?key=gittensory%2Fshots%2Fafter.png";
  const ON_DEMAND_BEFORE = "https://api.example/gittensory/shot?url=https%3A%2F%2Fprod.example%2Fapp&w=1440&h=900";
  const ON_DEMAND_AFTER = "https://api.example/gittensory/shot?url=https%3A%2F%2Fpreview.example%2Fapp&w=1440&h=900";
  const LOADING_PLACEHOLDER = "https://api.example/gittensory/shot?placeholder=loading";
  const FAILED_PLACEHOLDER = "https://api.example/gittensory/shot?placeholder=failed";

  function route(overrides: Partial<CaptureRoute> = {}): CaptureRoute {
    return { path: "/app", ...overrides };
  }

  it("true when a route has a real before+after pair on desktop", () => {
    expect(hasSuccessfulBotCapture([route({ beforeUrl: REAL_BEFORE, afterUrl: REAL_AFTER })])).toBe(true);
  });

  it("true when only the MOBILE pair is real (desktop absent)", () => {
    expect(hasSuccessfulBotCapture([route({ beforeUrlMobile: REAL_BEFORE, afterUrlMobile: REAL_AFTER })])).toBe(true);
  });

  it("false when afterUrl is a placeholder (preview still building)", () => {
    expect(hasSuccessfulBotCapture([route({ beforeUrl: REAL_BEFORE, afterUrl: LOADING_PLACEHOLDER })])).toBe(false);
  });

  it("false when afterUrl is the failed-deploy placeholder", () => {
    expect(hasSuccessfulBotCapture([route({ beforeUrl: REAL_BEFORE, afterUrl: FAILED_PLACEHOLDER })])).toBe(false);
  });

  it("false for on-demand fallback URLs because they do not prove rendered PNGs (regression for failed visual renders satisfying the gate)", () => {
    expect(hasSuccessfulBotCapture([route({ beforeUrl: ON_DEMAND_BEFORE, afterUrl: ON_DEMAND_AFTER })])).toBe(false);
  });

  it("false when beforeUrl is missing (no production render)", () => {
    expect(hasSuccessfulBotCapture([route({ afterUrl: REAL_AFTER })])).toBe(false);
  });

  it("false when afterUrl is an empty string", () => {
    expect(hasSuccessfulBotCapture([route({ beforeUrl: REAL_BEFORE, afterUrl: "" })])).toBe(false);
  });

  it("false for a route with no shots at all", () => {
    expect(hasSuccessfulBotCapture([route()])).toBe(false);
  });

  it("false for an empty routes array (capture never ran / found nothing)", () => {
    expect(hasSuccessfulBotCapture([])).toBe(false);
  });

  it("true when only ONE of several routes has a real pair (some() semantics, not every())", () => {
    const routes = [route({ path: "/a", afterUrl: LOADING_PLACEHOLDER, beforeUrl: REAL_BEFORE }), route({ path: "/b", beforeUrl: REAL_BEFORE, afterUrl: REAL_AFTER })];
    expect(hasSuccessfulBotCapture(routes)).toBe(true);
  });

  it("false when every route is all-placeholder", () => {
    const routes = [route({ path: "/a", beforeUrl: REAL_BEFORE, afterUrl: LOADING_PLACEHOLDER }), route({ path: "/b", beforeUrl: REAL_BEFORE, afterUrl: FAILED_PLACEHOLDER })];
    expect(hasSuccessfulBotCapture(routes)).toBe(false);
  });
});

describe("review.visual.actions_fallback (#4112 GitHub-Actions build-and-serve fallback)", () => {
  function stubNoPreviewFound(extra?: (url: string, init?: RequestInit) => Response | null): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
      const url = input.toString();
      const custom = extra?.(url, init);
      if (custom) return custom;
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
      if (url.includes("/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    };
  }

  it("dispatches the fallback workflow when no preview is found anywhere, pinned to the default branch, and marks the capture pending", async () => {
    const dispatchBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url, init) => {
        if (!url.includes("/actions/workflows/visual-capture-fallback.yml/dispatches")) return null;
        dispatchBodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      }),
    );

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 20, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchBodies).toHaveLength(1);
    expect(JSON.parse(dispatchBodies[0] as string)).toEqual({
      ref: "main",
      inputs: { pr_number: "20", head_sha: "cafebabe", routes: JSON.stringify(["/app"]) },
    });
    expect(result.previewPending).toBe(true);
  });

  it("skips dispatching a NEW run when one was already dispatched for this exact headSha (persisted marker), but still marks the capture pending (#4112 review fix)", async () => {
    let dispatchCalled = false;
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => {
        if (url.includes("/dispatches")) {
          dispatchCalled = true;
          return new Response(null, { status: 204 });
        }
        return null;
      }),
    );
    const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "", REVIEW_AUDIT: memoryReviewAudit() });
    await markFallbackDispatched(env, "cafebabecafebabecafebabecafebabecafebabe");

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 20, headSha: "cafebabecafebabecafebabecafebabecafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchCalled).toBe(false);
    expect(result.previewPending).toBe(true);
  });

  it("dispatches a NEW run when the persisted marker is for a DIFFERENT headSha (a later push)", async () => {
    let dispatchCalled = false;
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => {
        if (url.includes("/dispatches")) {
          dispatchCalled = true;
          return new Response(null, { status: 204 });
        }
        return null;
      }),
    );
    const env = createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "", REVIEW_AUDIT: memoryReviewAudit() });
    await markFallbackDispatched(env, "ffffffffffffffffffffffffffffffffffffffff");

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 20, headSha: "cafebabecafebabecafebabecafebabecafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchCalled).toBe(true);
    expect(result.previewPending).toBe(true);
  });

  it("leaves the capture non-pending when the dispatch call itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => (url.includes("/dispatches") ? new Response("nope", { status: 422 }) : null)),
    );

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 21, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.previewPending).toBe(false);
  });

  it("never dispatches when actions_fallback is not configured (byte-identical to pre-#4112)", async () => {
    let dispatchCalled = false;
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => {
        if (url.includes("/dispatches")) dispatchCalled = true;
        return null;
      }),
    );

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 22, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
    );

    expect(dispatchCalled).toBe(false);
    expect(result.previewPending).toBe(false);
  });

  it("never dispatches without a headSha to pin the build to", async () => {
    let dispatchCalled = false;
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => {
        if (url.includes("/dispatches")) dispatchCalled = true;
        return null;
      }),
    );

    await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 23, previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchCalled).toBe(false);
  });

  it("never dispatches without a resolved default branch to pin the dispatch to", async () => {
    let dispatchCalled = false;
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => {
        if (url.includes("/dispatches")) dispatchCalled = true;
        return null;
      }),
    );

    await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 24, headSha: "cafebabe", previewFromChecks: true },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchCalled).toBe(false);
  });

  it("never dispatches when the preview deploy already FAILED (a real terminal state, not a gap to fill)", async () => {
    let dispatchCalled = false;
    vi.stubGlobal(
      "fetch",
      stubNoPreviewFound((url) => {
        if (url.includes("/dispatches")) dispatchCalled = true;
        return null;
      }),
    );

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 25, headSha: "cafebabe", previewFailed: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchCalled).toBe(false);
    expect(result.routes[0]?.afterUrl).toContain("placeholder=failed");
  });

  it("never dispatches when a real preview build is already pending (buildState 'building')", async () => {
    let dispatchCalled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/dispatches")) dispatchCalled = true;
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        return Response.json({ check_runs: [{ name: "Cloudflare Workers Builds", status: "in_progress" }] });
      }
      if (url.includes("/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 26, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(dispatchCalled).toBe(false);
    expect(result.previewPending).toBe(true);
  });

  it("uses an already-stored fallback shot from R2 as the after URL, without any preview discovery URL", async () => {
    vi.stubGlobal("fetch", stubNoPreviewFound());
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
    });
    const key = await fallbackShotR2Key("cafebabe", "/app", "desktop");
    await env.REVIEW_AUDIT!.put(key, new Uint8Array([1, 2, 3]));

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 27, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.routes[0]?.afterUrl).toBe(`https://worker.example/gittensory/shot?key=${encodeURIComponent(key)}`);
  });

  it("links an already-stored fallback shot directly at the bucket when REVIEW_AUDIT_S3_PUBLIC_URL is configured", async () => {
    vi.stubGlobal("fetch", stubNoPreviewFound());
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
      REVIEW_AUDIT_S3_PUBLIC_URL: "https://pub-abc123.r2.dev",
    });
    const key = await fallbackShotR2Key("cafebabe", "/app", "desktop");
    await env.REVIEW_AUDIT!.put(key, new Uint8Array([1, 2, 3]));

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 29, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.routes[0]?.afterUrl).toBe(`https://pub-abc123.r2.dev/${key}`);
  });

  it("degrades to no after URL at all when a fallback shot is cached but neither PUBLIC_API_ORIGIN nor REVIEW_AUDIT_S3_PUBLIC_URL is configured (nothing servable can be constructed, not even a placeholder)", async () => {
    vi.stubGlobal("fetch", stubNoPreviewFound());
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
    });
    const key = await fallbackShotR2Key("cafebabe", "/app", "desktop");
    await env.REVIEW_AUDIT!.put(key, new Uint8Array([1, 2, 3]));

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 31, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.routes[0]?.afterUrl).toBeUndefined();
  });

  it("falls back to the loading placeholder when actions_fallback is enabled but no shot has landed in R2 yet", async () => {
    vi.stubGlobal("fetch", stubNoPreviewFound());
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit(),
    });

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 28, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.routes[0]?.afterUrl).toContain("placeholder=loading");
  });

  it("falls back to the loading placeholder (never throws) when the R2 read for a fallback shot itself throws", async () => {
    vi.stubGlobal("fetch", stubNoPreviewFound());
    const env = createTestEnv({
      PUBLIC_API_ORIGIN: "https://worker.example",
      PUBLIC_SITE_ORIGIN: "https://prod.example.com",
      REVIEW_AUDIT: memoryReviewAudit({ failGet: true }),
    });

    const result = await buildCapture(
      env,
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 30, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.routes[0]?.afterUrl).toContain("placeholder=loading");
  });

  it("falls back to the loading placeholder (never throws) when actions_fallback is enabled but REVIEW_AUDIT isn't configured", async () => {
    vi.stubGlobal("fetch", stubNoPreviewFound());

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "https://prod.example.com" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 29, headSha: "cafebabe", previewFromChecks: true, defaultBranchRef: "main" },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { actionsFallback: true },
    );

    expect(result.routes[0]?.afterUrl).toContain("placeholder=loading");
  });
});

describe("fetchShotContentBlock (#4111)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a base64-encoded image content block on a successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })));
    const block = await fetchShotContentBlock("https://x/gittensory/shot?key=before");
    expect(block).toEqual({ type: "image", data: Buffer.from([137, 80, 78, 71]).toString("base64"), mimeType: "image/png" });
  });

  it("returns undefined on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(fetchShotContentBlock("https://x/gittensory/shot?key=missing")).resolves.toBeUndefined();
  });

  it("returns undefined (never throws) when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchShotContentBlock("https://x/gittensory/shot?key=broken")).resolves.toBeUndefined();
  });
});


describe("fetchExternalScreenshotContentBlock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an image block for safe public image responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } })),
    );

    await expect(fetchExternalScreenshotContentBlock("https://example.com/before.png")).resolves.toEqual({
      type: "image",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("revalidates redirect targets before fetching contributor screenshots", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/metadata" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExternalScreenshotContentBlock("https://example.com/before.png")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/before.png",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects oversized contributor screenshots before buffering the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(4 * 1024 * 1024 + 1) },
        }),
      ),
    );

    await expect(fetchExternalScreenshotContentBlock("https://example.com/huge.png")).resolves.toBeUndefined();
  });

  it("rejects non-image contributor screenshot responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret", { status: 200, headers: { "content-type": "text/plain" } })));

    await expect(fetchExternalScreenshotContentBlock("https://example.com/not-image.txt")).resolves.toBeUndefined();
  });

  it("follows safe redirects and preserves non-png image MIME types", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/after.jpg" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), { status: 200, headers: { "content-type": "image/jpeg; charset=binary" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExternalScreenshotContentBlock("https://example.com/before.png")).resolves.toEqual({
      type: "image",
      data: Buffer.from([4, 5]).toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com/after.jpg", expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects invalid inputs, broken redirects, non-ok responses, overlong streams, and thrown fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExternalScreenshotContentBlock("http://example.com/before.png")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(fetchExternalScreenshotContentBlock("https://example.com/no-location.png")).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(fetchExternalScreenshotContentBlock("https://example.com/missing.png")).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(4 * 1024 * 1024 + 1), { status: 200, headers: { "content-type": "image/png" } }),
    );
    await expect(fetchExternalScreenshotContentBlock("https://example.com/stream-too-large.png")).resolves.toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchExternalScreenshotContentBlock("https://example.com/broken.png")).resolves.toBeUndefined();
  });

  it("stops after the bounded redirect budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 302, headers: { location: "https://example.com/next.png" } })),
    );

    await expect(fetchExternalScreenshotContentBlock("https://example.com/first.png")).resolves.toBeUndefined();
  });
});
