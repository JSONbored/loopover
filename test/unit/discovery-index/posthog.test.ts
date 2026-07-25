import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRoutePostHogError,
  captureSourcemapUploadPostHogFailure,
  captureUnhandledPostHogError,
  flushDiscoveryIndexPostHog,
  initDiscoveryIndexPostHog,
  resetDiscoveryIndexPostHogForTest,
  resolveDiscoveryIndexPostHogRelease,
  resolvePostHogEnvironment,
  setDiscoveryIndexPostHogForTest,
  shutdownDiscoveryIndexPostHog,
} from "../../../packages/discovery-index/src/posthog";

function postHogHarness() {
  const captured: Array<{ error: Error; distinctId: string; properties: Record<string, unknown> }> = [];
  const flushed: number[] = [];
  const shutdowns: number[] = [];
  setDiscoveryIndexPostHogForTest(
    {
      captureException: (error: unknown, distinctId: string, properties: Record<string, unknown>) => {
        captured.push({ error: error instanceof Error ? error : new Error(String(error)), distinctId, properties });
      },
      flush: async () => {
        flushed.push(Date.now());
      },
      shutdown: async () => {
        shutdowns.push(Date.now());
      },
    } as unknown as Parameters<typeof setDiscoveryIndexPostHogForTest>[0],
    { release: "loopover-discovery-index@test", environment: "test" },
  );
  return { captured, flushed, shutdowns };
}

afterEach(() => {
  resetDiscoveryIndexPostHogForTest();
});

describe("resolveDiscoveryIndexPostHogRelease", () => {
  it("prefers an explicit POSTHOG_RELEASE", () => {
    expect(resolveDiscoveryIndexPostHogRelease({ POSTHOG_RELEASE: "v1", POSTHOG_COMMIT_SHA: "abc" } as unknown as NodeJS.ProcessEnv)).toBe("v1");
  });
  it("derives a release from POSTHOG_COMMIT_SHA when POSTHOG_RELEASE is unset", () => {
    expect(resolveDiscoveryIndexPostHogRelease({ POSTHOG_COMMIT_SHA: "abc123" } as unknown as NodeJS.ProcessEnv)).toBe("loopover-discovery-index@abc123");
  });
  it("returns undefined when neither is set", () => {
    expect(resolveDiscoveryIndexPostHogRelease({} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolvePostHogEnvironment", () => {
  it("uses POSTHOG_ENVIRONMENT when set", () => {
    expect(resolvePostHogEnvironment({ POSTHOG_ENVIRONMENT: "staging" } as unknown as NodeJS.ProcessEnv)).toBe("staging");
  });
  it("defaults to production", () => {
    expect(resolvePostHogEnvironment({} as unknown as NodeJS.ProcessEnv)).toBe("production");
  });
  it("treats a blank/whitespace-only value as unset", () => {
    expect(resolvePostHogEnvironment({ POSTHOG_ENVIRONMENT: "   " } as unknown as NodeJS.ProcessEnv)).toBe("production");
  });
});

describe("initDiscoveryIndexPostHog", () => {
  it("stays inert (returns false) when POSTHOG_API_KEY is unset", async () => {
    await expect(initDiscoveryIndexPostHog({} as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
  });

  it("stays inert when POSTHOG_API_KEY is blank/whitespace-only", async () => {
    await expect(initDiscoveryIndexPostHog({ POSTHOG_API_KEY: "   " } as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
  });

  it("resets state and returns false when the dynamic posthog-node import throws", async () => {
    vi.doMock("posthog-node", () => {
      throw new Error("module load failed");
    });
    vi.resetModules();
    const { initDiscoveryIndexPostHog: initFresh } = await import("../../../packages/discovery-index/src/posthog");
    await expect(initFresh({ POSTHOG_API_KEY: "phc_test" } as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
    vi.doUnmock("posthog-node");
    vi.resetModules();
  });

  it("resets state and returns false when the PostHog constructor throws a non-Error value", async () => {
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch deliberately
          throw "init failed (string throw)";
        }
      },
    }));
    vi.resetModules();
    const { initDiscoveryIndexPostHog: initFresh } = await import("../../../packages/discovery-index/src/posthog");
    await expect(initFresh({ POSTHOG_API_KEY: "phc_test" } as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
    vi.doUnmock("posthog-node");
    vi.resetModules();
  });

  it("succeeds, wires before_send to scrub a real event, and leaves PostHog active", async () => {
    let capturedOptions: { before_send?: (event: unknown) => unknown; host?: string } | undefined;
    const captured: unknown[] = [];
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(_apiKey: string, options: typeof capturedOptions) {
          capturedOptions = options;
        }
        captureException(error: unknown) {
          captured.push(error);
        }
      },
    }));
    vi.resetModules();
    const { initDiscoveryIndexPostHog: initFresh, captureRoutePostHogError: captureFresh, resetDiscoveryIndexPostHogForTest: resetFresh } = await import(
      "../../../packages/discovery-index/src/posthog"
    );
    await expect(initFresh({ POSTHOG_API_KEY: "phc_test", POSTHOG_COMMIT_SHA: "abc" } as unknown as NodeJS.ProcessEnv)).resolves.toBe(true);
    expect(capturedOptions?.host).toBe("https://us.i.posthog.com");
    const scrubbed = capturedOptions?.before_send?.({ properties: { authorization: "should-be-filtered" } }) as { properties: Record<string, unknown> };
    expect(scrubbed.properties.authorization).toBe("[Filtered]");
    // Proves init actually left `active` true end-to-end: a real capture reaches the mocked client.
    captureFresh(new Error("real capture"), { route: "/x", method: "GET" });
    expect(captured[0]).toBeInstanceOf(Error);
    resetFresh();
    vi.doUnmock("posthog-node");
    vi.resetModules();
  });

  it("uses POSTHOG_HOST when set", async () => {
    let capturedHost: string | undefined;
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(_apiKey: string, options: { host?: string }) {
          capturedHost = options.host;
        }
        captureException() {}
      },
    }));
    vi.resetModules();
    const { initDiscoveryIndexPostHog: initFresh } = await import("../../../packages/discovery-index/src/posthog");
    await initFresh({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" } as unknown as NodeJS.ProcessEnv);
    expect(capturedHost).toBe("https://eu.i.posthog.com");
    vi.doUnmock("posthog-node");
    vi.resetModules();
  });

  it("before_send passes through a null event unchanged", async () => {
    let capturedOptions: { before_send?: (event: unknown) => unknown } | undefined;
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(_apiKey: string, options: typeof capturedOptions) {
          capturedOptions = options;
        }
        captureException() {}
      },
    }));
    vi.resetModules();
    const { initDiscoveryIndexPostHog: initFresh } = await import("../../../packages/discovery-index/src/posthog");
    await initFresh({ POSTHOG_API_KEY: "phc_test" } as unknown as NodeJS.ProcessEnv);
    expect(capturedOptions?.before_send?.(null)).toBeNull();
    vi.doUnmock("posthog-node");
    vi.resetModules();
  });
});

describe("captureRoutePostHogError", () => {
  it("is inert when PostHog is disabled", () => {
    expect(() => captureRoutePostHogError(new Error("boom"), { route: "/v1/discovery-index/query", method: "POST" })).not.toThrow();
  });

  it("tags, fingerprints, and captures a route-level error", () => {
    const posthog = postHogHarness();
    captureRoutePostHogError(new Error("boom"), { route: "/v1/discovery-index/query", method: "POST" });

    expect(posthog.captured).toHaveLength(1);
    const [capture] = posthog.captured;
    expect(capture!.distinctId).toBe("loopover-discovery-index");
    expect(capture!.error.message).toBe("boom");
    expect(capture!.properties.$exception_fingerprint).toBe("discovery-index-route-error|/v1/discovery-index/query|POST");
    expect(capture!.properties.event).toBe("discovery_index_route_error");
    expect(capture!.properties.route).toBe("/v1/discovery-index/query");
    expect(capture!.properties.method).toBe("POST");
    expect(capture!.properties.release).toBe("loopover-discovery-index@test");
    expect(capture!.properties.environment).toBe("test");
  });

  it("wraps a non-Error throw into a real Error before capture", () => {
    const posthog = postHogHarness();
    captureRoutePostHogError("a plain string throw", { route: "/health", method: "GET" });
    expect(posthog.captured[0]?.error.message).toBe("a plain string throw");
  });

  it("drops an empty tag value instead of setting a blank property, and falls fingerprint parts back to 'unknown'", () => {
    const posthog = postHogHarness();
    captureRoutePostHogError(new Error("boom"), { route: "", method: "GET" });
    expect(posthog.captured[0]?.properties.route).toBeUndefined();
    expect(posthog.captured[0]?.properties.$exception_fingerprint).toBe("discovery-index-route-error|unknown|GET");
  });
});

describe("captureUnhandledPostHogError", () => {
  it("fingerprints process-level failures by event class", () => {
    const posthog = postHogHarness();
    captureUnhandledPostHogError(new Error("kaboom"), { event: "discovery_index_uncaught_exception" });

    expect(posthog.captured[0]?.properties.$exception_fingerprint).toBe("discovery-index-process-error|discovery_index_uncaught_exception");
    expect(posthog.captured[0]?.properties.event).toBe("discovery_index_uncaught_exception");
  });

  it("covers the unhandled_rejection event branch too", () => {
    const posthog = postHogHarness();
    captureUnhandledPostHogError(new Error("rejected"), { event: "discovery_index_unhandled_rejection" });
    expect(posthog.captured[0]?.properties.event).toBe("discovery_index_unhandled_rejection");
  });
});

describe("captureSourcemapUploadPostHogFailure", () => {
  it("applies stable upload grouping and forwards optional extra fields", () => {
    const posthog = postHogHarness();
    captureSourcemapUploadPostHogFailure(new Error("upload failed"), {
      release: "loopover-discovery-index@abc",
      deploymentId: "cloudflare-container",
      strict: true,
      sha: "abcdef1234567890",
    });

    expect(posthog.captured[0]?.properties.$exception_fingerprint).toBe("discovery-index-sourcemap-upload-failed");
    expect(posthog.captured[0]?.properties.event).toBe("discovery_index_sourcemap_upload_failed");
    expect(posthog.captured[0]?.properties.release).toBe("loopover-discovery-index@abc");
    expect(posthog.captured[0]?.properties.deploymentId).toBe("cloudflare-container");
    expect(posthog.captured[0]?.properties.strict).toBe(true);
    expect(posthog.captured[0]?.properties.sha).toBe("abcdef1234567890");
  });

  it("falls back to the active release when no explicit release is given", () => {
    const posthog = postHogHarness();
    captureSourcemapUploadPostHogFailure(new Error("upload failed"), {});
    expect(posthog.captured[0]?.properties.release).toBe("loopover-discovery-index@test");
    expect(posthog.captured[0]?.properties.deploymentId).toBeUndefined();
    expect(posthog.captured[0]?.properties.strict).toBeUndefined();
    expect(posthog.captured[0]?.properties.sha).toBeUndefined();
  });
});

describe("secret scrubbing", () => {
  it("redacts an extra field by KEY name regardless of its value (object branch)", () => {
    const posthog = postHogHarness();
    captureSourcemapUploadPostHogFailure(new Error("boom"), { sha: { authorization: "innocuous-looking-value" } } as never);
    expect(posthog.captured[0]?.properties.sha).toEqual({ authorization: "[Filtered]" });
  });

  it("redacts secret-named keys inside a nested array value (array branch)", () => {
    const posthog = postHogHarness();
    captureSourcemapUploadPostHogFailure(new Error("boom"), { sha: [{ token: "should-be-filtered" }, "plain-string"] } as never);
    expect(posthog.captured[0]?.properties.sha).toEqual([{ token: "[Filtered]" }, "plain-string"]);
  });

  it("redacts a GitHub-token-shaped VALUE (not just key name) inside upload-failure properties", () => {
    const posthog = postHogHarness();
    const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    captureSourcemapUploadPostHogFailure(new Error(`upload failed for ${fakeToken}`), { sha: fakeToken });
    expect(JSON.stringify(posthog.captured[0]?.properties)).not.toContain(fakeToken);
    expect(posthog.captured[0]?.properties.sha).toBe("[Filtered]");
  });

  it("filters a secret-shaped tag value down to [Filtered]", () => {
    const posthog = postHogHarness();
    const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    captureSourcemapUploadPostHogFailure(new Error("boom"), { release: fakeToken });
    expect(posthog.captured[0]?.properties.release).toBe("[Filtered]");
  });
});

describe("flushDiscoveryIndexPostHog", () => {
  it("is inert when PostHog is disabled", async () => {
    await expect(flushDiscoveryIndexPostHog()).resolves.toBeUndefined();
  });

  it("flushes when enabled", async () => {
    const posthog = postHogHarness();
    await flushDiscoveryIndexPostHog();
    expect(posthog.flushed).toHaveLength(1);
  });

  it("swallows a flush rejection rather than throwing", async () => {
    setDiscoveryIndexPostHogForTest({
      captureException: () => undefined,
      flush: async () => {
        throw new Error("flush failed");
      },
      shutdown: async () => undefined,
    } as never);
    await expect(flushDiscoveryIndexPostHog()).resolves.toBeUndefined();
  });
});

describe("shutdownDiscoveryIndexPostHog", () => {
  it("is inert when PostHog is disabled", async () => {
    await expect(shutdownDiscoveryIndexPostHog()).resolves.toBeUndefined();
  });

  it("shuts down when enabled", async () => {
    const posthog = postHogHarness();
    await shutdownDiscoveryIndexPostHog();
    expect(posthog.shutdowns).toHaveLength(1);
  });

  it("swallows a shutdown rejection rather than throwing", async () => {
    setDiscoveryIndexPostHogForTest({
      captureException: () => undefined,
      flush: async () => undefined,
      shutdown: async () => {
        throw new Error("shutdown failed");
      },
    } as never);
    await expect(shutdownDiscoveryIndexPostHog()).resolves.toBeUndefined();
  });
});
