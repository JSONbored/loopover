import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRouteError,
  captureSourcemapUploadFailure,
  captureUnhandledError,
  flushSentry,
  initSentry,
  resetSentryForTest,
  resolveDiscoveryIndexSentryRelease,
  resolveSentryEnvironment,
  resolveTracesSampleRate,
  setSentryForTest,
} from "../../../packages/discovery-index/src/sentry";

function sentryHarness() {
  const tags: Record<string, string> = {};
  const contexts: Record<string, unknown> = {};
  const fingerprints: unknown[][] = [];
  const levels: string[] = [];
  const captured: Error[] = [];
  const flushed: number[] = [];
  const scope = {
    setLevel: (level: string) => levels.push(level),
    setContext: (name: string, context: unknown) => {
      contexts[name] = context;
    },
    setFingerprint: (fingerprint: unknown[]) => fingerprints.push(fingerprint),
    setTag: (name: string, value: string) => {
      tags[name] = value;
    },
  };
  setSentryForTest(
    // The real @sentry/node types for withScope/flush are far broader than what captureScopedError
    // actually calls (it only ever touches setLevel/setContext/setFingerprint/setTag on the scope, and
    // awaits flush with no args) -- cast through unknown, the same way this repo's other Sentry test
    // harnesses (test/unit/selfhost-sentry.test.ts) work around fakes narrower than the real SDK surface.
    {
      withScope: (run: (value: typeof scope) => void) => run(scope),
      captureException: (error: unknown) => {
        captured.push(error instanceof Error ? error : new Error(String(error)));
        return "event-id";
      },
      flush: async (timeoutMs: number) => {
        flushed.push(timeoutMs);
        return true;
      },
    } as unknown as Parameters<typeof setSentryForTest>[0],
    { release: "loopover-discovery-index@test", environment: "test" },
  );
  return { tags, contexts, fingerprints, levels, captured, flushed };
}

afterEach(() => {
  resetSentryForTest();
});

describe("resolveDiscoveryIndexSentryRelease", () => {
  it("prefers an explicit SENTRY_RELEASE", () => {
    expect(resolveDiscoveryIndexSentryRelease({ SENTRY_RELEASE: "v1", SENTRY_COMMIT_SHA: "abc" } as unknown as NodeJS.ProcessEnv)).toBe("v1");
  });
  it("derives a release from SENTRY_COMMIT_SHA when SENTRY_RELEASE is unset", () => {
    expect(resolveDiscoveryIndexSentryRelease({ SENTRY_COMMIT_SHA: "abc123" } as unknown as NodeJS.ProcessEnv)).toBe("loopover-discovery-index@abc123");
  });
  it("returns undefined when neither is set", () => {
    expect(resolveDiscoveryIndexSentryRelease({} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveSentryEnvironment", () => {
  it("uses SENTRY_ENVIRONMENT when set", () => {
    expect(resolveSentryEnvironment({ SENTRY_ENVIRONMENT: "staging" } as unknown as NodeJS.ProcessEnv)).toBe("staging");
  });
  it("defaults to production", () => {
    expect(resolveSentryEnvironment({} as unknown as NodeJS.ProcessEnv)).toBe("production");
  });
  it("treats a blank/whitespace-only value as unset", () => {
    expect(resolveSentryEnvironment({ SENTRY_ENVIRONMENT: "   " } as unknown as NodeJS.ProcessEnv)).toBe("production");
  });
});

describe("resolveTracesSampleRate", () => {
  it("parses a valid in-range rate", () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0.5" } as unknown as NodeJS.ProcessEnv)).toBe(0.5);
  });
  it("clamps a rate above 1 down to 1", () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "5" } as unknown as NodeJS.ProcessEnv)).toBe(1);
  });
  it("clamps a negative rate up to 0", () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "-2" } as unknown as NodeJS.ProcessEnv)).toBe(0);
  });
  it("falls back to 0 for a non-numeric value", () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "not-a-number" } as unknown as NodeJS.ProcessEnv)).toBe(0);
  });
  it("falls back to 0 when unset", () => {
    expect(resolveTracesSampleRate({} as unknown as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("initSentry", () => {
  it("stays inert (returns false) when SENTRY_DSN is unset", async () => {
    await expect(initSentry({} as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
  });

  it("stays inert when SENTRY_DSN is blank/whitespace-only", async () => {
    await expect(initSentry({ SENTRY_DSN: "   " } as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
  });

  it("resets state and returns false when the dynamic @sentry/node import throws an Error", async () => {
    vi.doMock("@sentry/node", () => {
      throw new Error("module load failed");
    });
    vi.resetModules();
    const { initSentry: initSentryFresh } = await import("../../../packages/discovery-index/src/sentry");
    await expect(initSentryFresh({ SENTRY_DSN: "https://example.test/1" } as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
    vi.doUnmock("@sentry/node");
    vi.resetModules();
  });

  it("resets state and returns false when Sentry.init throws a non-Error value", async () => {
    // A synchronous throw from inside vi.doMock's own factory gets re-wrapped by vitest itself into a real
    // Error ("There was an error when mocking a module...") before initSentry's catch ever sees it -- that
    // path can't actually exercise the non-Error side of `error instanceof Error ? ... : String(error)`.
    // Throwing from the mocked Sentry.init() call instead reaches initSentry's catch block directly, with
    // the raw value intact.
    vi.doMock("@sentry/node", () => ({
      init: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch deliberately
        throw "init failed (string throw)";
      },
      withScope: () => undefined,
      captureException: () => undefined,
    }));
    vi.resetModules();
    const { initSentry: initSentryFresh } = await import("../../../packages/discovery-index/src/sentry");
    await expect(initSentryFresh({ SENTRY_DSN: "https://example.test/1" } as unknown as NodeJS.ProcessEnv)).resolves.toBe(false);
    vi.doUnmock("@sentry/node");
    vi.resetModules();
  });

  it("succeeds, wires beforeSend to scrubEvent, and leaves Sentry active", async () => {
    let capturedInitOptions: { beforeSend?: (event: unknown) => unknown } | undefined;
    const captured: Error[] = [];
    vi.doMock("@sentry/node", () => ({
      init: (options: { beforeSend?: (event: unknown) => unknown }) => {
        capturedInitOptions = options;
        return {};
      },
      withScope: (run: (scope: unknown) => void) => run({ setLevel() {}, setContext() {}, setFingerprint() {}, setTag() {} }),
      captureException: (error: unknown) => {
        captured.push(error instanceof Error ? error : new Error(String(error)));
      },
    }));
    vi.resetModules();
    const { initSentry: initSentryFresh, captureRouteError: captureRouteErrorFresh, resetSentryForTest: resetFresh } = await import(
      "../../../packages/discovery-index/src/sentry"
    );
    await expect(initSentryFresh({ SENTRY_DSN: "https://example.test/1", SENTRY_COMMIT_SHA: "abc" } as unknown as NodeJS.ProcessEnv)).resolves.toBe(true);
    // beforeSend is wired to scrubEvent -- a secret-shaped field on a real event gets redacted.
    const scrubbed = capturedInitOptions?.beforeSend?.({ tags: { authorization: "should-be-filtered" } }) as { tags: Record<string, unknown> };
    expect(scrubbed.tags.authorization).toBe("[Filtered]");
    // Proves init actually left `active` true end-to-end: a real capture reaches the mocked client.
    captureRouteErrorFresh(new Error("real capture"), { route: "/x", method: "GET" });
    expect(captured[0]?.message).toBe("real capture");
    resetFresh();
    vi.doUnmock("@sentry/node");
    vi.resetModules();
  });
});

describe("captureRouteError", () => {
  it("is inert when Sentry is disabled", () => {
    expect(() => captureRouteError(new Error("boom"), { route: "/v1/discovery-index/query", method: "POST" })).not.toThrow();
  });

  it("tags, fingerprints, and scopes a route-level error", () => {
    const sentry = sentryHarness();
    captureRouteError(new Error("boom"), { route: "/v1/discovery-index/query", method: "POST" });

    expect(sentry.levels).toEqual(["error"]);
    expect(sentry.fingerprints).toEqual([["discovery-index-route-error", "/v1/discovery-index/query", "POST"]]);
    expect(sentry.tags.event).toBe("discovery_index_route_error");
    expect(sentry.tags.route).toBe("/v1/discovery-index/query");
    expect(sentry.tags.method).toBe("POST");
    expect(sentry.tags.release).toBe("loopover-discovery-index@test");
    expect(sentry.tags.environment).toBe("test");
    expect(sentry.captured[0]?.message).toBe("boom");
  });

  it("wraps a non-Error throw into a real Error before capture", () => {
    const sentry = sentryHarness();
    captureRouteError("a plain string throw", { route: "/health", method: "GET" });
    expect(sentry.captured[0]?.message).toBe("a plain string throw");
  });
});

describe("captureUnhandledError", () => {
  it("fingerprints process-level failures by event class", () => {
    const sentry = sentryHarness();
    captureUnhandledError(new Error("kaboom"), { event: "discovery_index_uncaught_exception" });

    expect(sentry.fingerprints).toEqual([["discovery-index-process-error", "discovery_index_uncaught_exception"]]);
    expect(sentry.tags.event).toBe("discovery_index_uncaught_exception");
    expect(sentry.contexts.discovery_index_process).toEqual({
      event: "discovery_index_uncaught_exception",
      release: "loopover-discovery-index@test",
      environment: "test",
    });
  });

  it("covers the unhandled_rejection event branch too", () => {
    const sentry = sentryHarness();
    captureUnhandledError(new Error("rejected"), { event: "discovery_index_unhandled_rejection" });
    expect(sentry.tags.event).toBe("discovery_index_unhandled_rejection");
  });
});

describe("captureSourcemapUploadFailure", () => {
  it("applies stable upload grouping and forwards optional context fields", () => {
    const sentry = sentryHarness();
    captureSourcemapUploadFailure(new Error("upload failed"), {
      release: "loopover-discovery-index@abc",
      deploymentId: "cloudflare-container",
      strict: true,
      sha: "abcdef1234567890",
    });

    expect(sentry.fingerprints).toEqual([["discovery-index-sourcemap-upload-failed"]]);
    expect(sentry.tags.event).toBe("discovery_index_sourcemap_upload_failed");
    expect(sentry.tags.release).toBe("loopover-discovery-index@abc");
    expect(sentry.contexts.discovery_index_sourcemap_upload).toEqual({
      event: "discovery_index_sourcemap_upload_failed",
      release: "loopover-discovery-index@abc",
      deploymentId: "cloudflare-container",
      strict: true,
      sha: "abcdef1234567890",
      environment: "test",
    });
  });

  it("falls back to the active release when no explicit release is given", () => {
    const sentry = sentryHarness();
    captureSourcemapUploadFailure(new Error("upload failed"), {});
    expect(sentry.tags.release).toBe("loopover-discovery-index@test");
    // deploymentId/sha/strict all undefined -> compactContext drops them from the stored context.
    expect(sentry.contexts.discovery_index_sourcemap_upload).toEqual({
      event: "discovery_index_sourcemap_upload_failed",
      release: "loopover-discovery-index@test",
      environment: "test",
    });
  });
});

describe("secret scrubbing", () => {
  it("redacts a context field by KEY name regardless of its value (object branch)", () => {
    const sentry = sentryHarness();
    // captureSourcemapUploadFailure builds its own context object from named fields (event/release/
    // deploymentId/strict/sha/environment) -- none of those names are secret-shaped, so an *extra* field
    // would just be dropped before scrubValue ever sees it. To reach scrubValue's object/key-name branch,
    // inject a nested object through `sha` itself (typed string, but scrubValue recurses on whatever it
    // actually receives at runtime) -- the same `as never` bypass review-enrichment's own tests use to feed
    // shapes the public type wouldn't otherwise allow.
    captureSourcemapUploadFailure(new Error("boom"), { sha: { authorization: "innocuous-looking-value" } } as never);
    const context = sentry.contexts.discovery_index_sourcemap_upload as Record<string, unknown>;
    expect(context.sha).toEqual({ authorization: "[Filtered]" });
  });

  it("redacts secret-named keys inside a nested array value (array branch)", () => {
    const sentry = sentryHarness();
    captureSourcemapUploadFailure(new Error("boom"), { sha: [{ token: "should-be-filtered" }, "plain-string"] } as never);
    const context = sentry.contexts.discovery_index_sourcemap_upload as Record<string, unknown>;
    expect(context.sha).toEqual([{ token: "[Filtered]" }, "plain-string"]);
  });

  it("redacts a GitHub-token-shaped VALUE (not just key name) inside upload-failure context", () => {
    const sentry = sentryHarness();
    const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    captureSourcemapUploadFailure(new Error(`upload failed for ${fakeToken}`), { sha: fakeToken });
    const context = sentry.contexts.discovery_index_sourcemap_upload as Record<string, unknown>;
    expect(JSON.stringify(context)).not.toContain(fakeToken);
    expect(context.sha).toBe("[Filtered]");
  });

  it("filters a secret-shaped TAG value down to [Filtered]", () => {
    const sentry = sentryHarness();
    const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    captureSourcemapUploadFailure(new Error("boom"), { release: fakeToken });
    expect(sentry.tags.release).toBe("[Filtered]");
  });

  it("drops an empty tag value instead of setting a blank tag, and falls fingerprint parts back to 'unknown'", () => {
    const sentry = sentryHarness();
    captureRouteError(new Error("boom"), { route: "", method: "GET" });
    expect(sentry.tags.route).toBeUndefined();
    expect(sentry.fingerprints).toEqual([["discovery-index-route-error", "unknown", "GET"]]);
  });
});

describe("flushSentry", () => {
  it("is inert when Sentry is disabled", async () => {
    await expect(flushSentry()).resolves.toBeUndefined();
  });

  it("flushes with the given timeout when enabled", async () => {
    const sentry = sentryHarness();
    await flushSentry(1234);
    expect(sentry.flushed).toEqual([1234]);
  });

  it("swallows a flush rejection rather than throwing", async () => {
    setSentryForTest(
      {
        withScope: () => undefined,
        captureException: () => "id",
        flush: async () => {
          throw new Error("flush failed");
        },
      },
      {},
    );
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});
