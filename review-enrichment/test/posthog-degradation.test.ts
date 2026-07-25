import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { buildBrief } from "../dist/brief.js";
import {
  captureAnalyzerDegradationPostHog,
  captureRoutePostHogError,
  captureSourcemapUploadPostHogFailure,
  captureUnhandledPostHogError,
  flushReesPostHog,
  initReesPostHog,
  resetReesPostHogForTest,
  setReesPostHogForTest,
  shutdownReesPostHog,
} from "../dist/posthog.js";

function postHogHarness() {
  const captured: Array<{ error: Error; distinctId: string; properties: Record<string, unknown> }> = [];
  setReesPostHogForTest(
    {
      captureException: (error: unknown, distinctId: string, properties: Record<string, unknown>) => {
        captured.push({ error: error instanceof Error ? error : new Error(String(error)), distinctId, properties });
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    },
    { release: "loopover-rees@test", environment: "test" },
  );
  return { captured };
}

afterEach(() => {
  resetReesPostHogForTest();
});

test("captureAnalyzerDegradationPostHog is inert when PostHog is disabled", () => {
  assert.doesNotThrow(() =>
    captureAnalyzerDegradationPostHog(new Error("boom"), {
      analyzer: "dependency",
      repoFullName: "JSONbored/loopover",
      prNumber: 7,
      headSha: "abc123",
      timeoutMs: 8000,
    }),
  );
});

test("captureAnalyzerDegradationPostHog tags and fingerprints sanitized analyzer failures", () => {
  const posthog = postHogHarness();
  const fakeGithubPat = ["github", "pat", "should_never_be_attached"].join("_");
  const fakeGhp = ["ghp", "should_never_be_attached"].join("_");

  captureAnalyzerDegradationPostHog(new Error("registry timeout"), {
    analyzer: "dependency",
    repoFullName: "JSONbored/loopover",
    prNumber: 7,
    headSha: "abc123",
    timeoutMs: 8000,
    diff: fakeGithubPat,
    githubToken: fakeGhp,
    authorization: "Bearer should_never_be_attached",
  } as never);

  const [capture] = posthog.captured;
  assert.equal(capture.error.message, "registry timeout");
  assert.equal(capture.distinctId, "loopover-rees");
  assert.equal(capture.properties.event, "rees_analyzer_degraded");
  assert.equal(capture.properties.analyzer, "dependency");
  assert.equal(capture.properties.repo, "JSONbored/loopover");
  assert.equal(capture.properties.pullNumber, "7");
  assert.equal(capture.properties.release, "loopover-rees@test");
  assert.equal(capture.properties.environment, "test");
  assert.equal(capture.properties.$exception_fingerprint, "rees-analyzer-degraded|dependency");

  const serialized = JSON.stringify(capture.properties);
  assert.equal(serialized.includes(fakeGithubPat), false);
  assert.equal(serialized.includes(fakeGhp), false);
  assert.equal(serialized.includes("Bearer should_never_be_attached"), false);
  assert.equal(serialized.includes("diff"), false);
  assert.equal(serialized.includes("githubToken"), false);
});

test("captureAnalyzerDegradationPostHog groups by partialReason (WHY), not analyzer name (WHICH), matching sentry's old #5010 fix", () => {
  const posthog = postHogHarness();

  captureAnalyzerDegradationPostHog(new Error("analyzer_timeout"), {
    analyzer: "installScript",
    repoFullName: "JSONbored/loopover",
    prNumber: 7,
    headSha: "abc123",
    timeoutMs: 1400,
    partialReason: "analyzer_timeout",
  } as never);
  captureAnalyzerDegradationPostHog(new Error("analyzer_timeout"), {
    analyzer: "nativeBuild",
    repoFullName: "JSONbored/loopover",
    prNumber: 8,
    headSha: "def456",
    timeoutMs: 1400,
    partialReason: "analyzer_timeout",
  } as never);

  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-analyzer-degraded|analyzer_timeout");
  assert.equal(posthog.captured[1].properties.$exception_fingerprint, "rees-analyzer-degraded|analyzer_timeout");
  // The specific analyzer is still fully visible via the tag -- only the GROUPING changed.
  assert.equal(posthog.captured[1].properties.analyzer, "nativeBuild");
});

test("captureAnalyzerDegradationPostHog falls back to analyzer name when partialReason is absent", () => {
  const posthog = postHogHarness();

  captureAnalyzerDegradationPostHog(new Error("boom"), {
    analyzer: "dependency",
    repoFullName: "JSONbored/loopover",
    prNumber: 7,
    headSha: "abc123",
    timeoutMs: 8000,
  });

  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-analyzer-degraded|dependency");
});

test("captureAnalyzerDegradationPostHog filters tag values before sending them", () => {
  const posthog = postHogHarness();
  const secretLikeValue = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");

  captureAnalyzerDegradationPostHog(new Error("registry timeout"), {
    analyzer: secretLikeValue,
    repoFullName: `JSONbored/${secretLikeValue}`,
    prNumber: 7,
    headSha: secretLikeValue,
    timeoutMs: 8000,
  });

  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-analyzer-degraded|[Filtered]");
  assert.equal(posthog.captured[0].properties.analyzer, "[Filtered]");
  assert.equal(posthog.captured[0].properties.repo, "JSONbored/[Filtered]");
});

test("buildBrief stays fail-open and captures a degraded analyzer", async () => {
  const posthog = postHogHarness();
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");

  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/loopover",
      prNumber: 42,
      headSha: "head-sha",
      analyzers: ["dependency"],
      files: [{ path: "package.json", patch: '+    "lodash": "4.17.20",' }],
      budget: { timeoutMs: 2000 },
    },
    {
      dependency: async () => {
        throw new Error(`osv unavailable for ${fakeToken}`);
      },
    },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.dependency, "degraded");
  assert.deepEqual(brief.findings, {});
  assert.equal(JSON.stringify(brief.telemetry).includes(fakeToken), false);
  assert.equal(posthog.captured.length, 1);
  assert.equal(posthog.captured[0].error.message, "analyzer_error");
  assert.equal(posthog.captured[0].properties.analyzer, "dependency");
  assert.equal(posthog.captured[0].properties.repo, "JSONbored/loopover");
  assert.equal(posthog.captured[0].properties.pullNumber, "42");
  assert.equal(posthog.captured[0].properties.event, "rees_analyzer_degraded");
});

test("captureRoutePostHogError applies the route-level fingerprint and allowlisted tags", () => {
  const posthog = postHogHarness();

  captureRoutePostHogError(new Error("boom"), { route: "/v1/enrich", method: "POST" });

  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-route-error|/v1/enrich|POST");
  assert.equal(posthog.captured[0].properties.event, "rees_route_error");
  assert.equal(posthog.captured[0].properties.route, "/v1/enrich");
  assert.equal(posthog.captured[0].properties.method, "POST");
  assert.equal(posthog.captured[0].properties.release, "loopover-rees@test");
  assert.equal(posthog.captured[0].properties.environment, "test");
});

test("captureUnhandledPostHogError fingerprints process-level failures by event class", () => {
  const posthog = postHogHarness();

  captureUnhandledPostHogError(new Error("kaboom"), { event: "rees_uncaught_exception" });

  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-process-error|rees_uncaught_exception");
  assert.equal(posthog.captured[0].properties.event, "rees_uncaught_exception");
  assert.equal(posthog.captured[0].properties.release, "loopover-rees@test");
  assert.equal(posthog.captured[0].properties.environment, "test");
});

test("captureUnhandledPostHogError covers the unhandled_rejection event branch too", () => {
  const posthog = postHogHarness();
  captureUnhandledPostHogError(new Error("rejected"), { event: "rees_unhandled_rejection" });
  assert.equal(posthog.captured[0].properties.event, "rees_unhandled_rejection");
});

test("captureSourcemapUploadPostHogFailure applies stable upload grouping and safe extra fields", () => {
  const posthog = postHogHarness();

  captureSourcemapUploadPostHogFailure(new Error("upload failed"), {
    release: "loopover-rees@test",
    deploymentId: "deploy-123",
    strict: true,
    sha: "abcdef1234567890",
    stage: "upload",
  });

  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-sourcemap-upload-failed");
  assert.equal(posthog.captured[0].properties.event, "rees_sourcemap_upload_failed");
  assert.equal(posthog.captured[0].properties.release, "loopover-rees@test");
  assert.equal(posthog.captured[0].properties.environment, "test");
  assert.equal(posthog.captured[0].properties.deploymentId, "deploy-123");
  assert.equal(posthog.captured[0].properties.strict, true);
  assert.equal(posthog.captured[0].properties.sha, "abcdef1234567890");
  assert.equal(posthog.captured[0].properties.stage, "upload");
});

test("captureSourcemapUploadPostHogFailure falls back to the active release when no explicit release is given", () => {
  const posthog = postHogHarness();
  captureSourcemapUploadPostHogFailure(new Error("upload failed"), {});
  assert.equal(posthog.captured[0].properties.release, "loopover-rees@test");
  assert.equal(posthog.captured[0].properties.deploymentId, undefined);
});

test("secret scrubbing: redacts a nested-object extra field by KEY name regardless of its value", () => {
  const posthog = postHogHarness();
  captureSourcemapUploadPostHogFailure(new Error("boom"), { sha: { authorization: "innocuous-looking-value" } } as never);
  assert.deepEqual(posthog.captured[0].properties.sha, { authorization: "[Filtered]" });
});

test("secret scrubbing: redacts secret-named keys inside a nested array value", () => {
  const posthog = postHogHarness();
  captureSourcemapUploadPostHogFailure(new Error("boom"), { sha: [{ token: "should-be-filtered" }, "plain-string"] } as never);
  assert.deepEqual(posthog.captured[0].properties.sha, [{ token: "[Filtered]" }, "plain-string"]);
});

test("secret scrubbing: redacts a GitHub-token-shaped VALUE (not just key name)", () => {
  const posthog = postHogHarness();
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  captureSourcemapUploadPostHogFailure(new Error(`upload failed for ${fakeToken}`), { sha: fakeToken });
  assert.equal(JSON.stringify(posthog.captured[0].properties).includes(fakeToken), false);
  assert.equal(posthog.captured[0].properties.sha, "[Filtered]");
});

test("secret scrubbing: filters a secret-shaped tag value down to [Filtered]", () => {
  const posthog = postHogHarness();
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  captureSourcemapUploadPostHogFailure(new Error("boom"), { release: fakeToken });
  assert.equal(posthog.captured[0].properties.release, "[Filtered]");
});

test("secret scrubbing: drops an empty tag value instead of setting a blank property, and falls fingerprint parts back to 'unknown'", () => {
  const posthog = postHogHarness();
  captureRoutePostHogError(new Error("boom"), { route: "", method: "GET" });
  assert.equal(posthog.captured[0].properties.route, undefined);
  assert.equal(posthog.captured[0].properties.$exception_fingerprint, "rees-route-error|unknown|GET");
});

// initReesPostHog's real dynamic-import success path, exercised with the REAL posthog-node package rather
// than a mock: node:test's mock.module needs --experimental-test-module-mocks, which review-enrichment's own
// "node": ">=20" engines range can't assume (the flag needs Node 22.3+). The real PostHog client with an
// empty event queue makes zero network I/O on shutdown -- verified empirically (constructed + shut down
// against an unreachable host in ~2ms, no hang, no error) -- so this is safe: never call a capture* function
// in these tests (that would actually queue a real event), and always shutdownReesPostHog() before
// resetReesPostHogForTest() so the real client's internal flush timer doesn't dangle into later tests.
test("initReesPostHog stays inert (returns false) when POSTHOG_API_KEY is unset", async () => {
  assert.equal(await initReesPostHog({} as NodeJS.ProcessEnv), false);
});

test("initReesPostHog stays inert when POSTHOG_API_KEY is blank/whitespace", async () => {
  assert.equal(await initReesPostHog({ POSTHOG_API_KEY: "   " } as NodeJS.ProcessEnv), false);
});

test("initReesPostHog activates a real client with the default host for a configured key", async () => {
  const activated = await initReesPostHog({ POSTHOG_API_KEY: "phc_test_fake_key_coverage_only" } as NodeJS.ProcessEnv);
  assert.equal(activated, true);
  await shutdownReesPostHog();
  resetReesPostHogForTest();
});

test("initReesPostHog uses POSTHOG_HOST when set", async () => {
  const activated = await initReesPostHog({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" } as NodeJS.ProcessEnv);
  assert.equal(activated, true);
  await shutdownReesPostHog();
  resetReesPostHogForTest();
});

test("initReesPostHog activates with POSTHOG_COMMIT_SHA/POSTHOG_ENVIRONMENT set (release/environment resolution itself is covered separately by resolveReesPostHogRelease/resolvePostHogEnvironment's own unit tests)", async () => {
  const activated = await initReesPostHog({ POSTHOG_API_KEY: "phc_test", POSTHOG_COMMIT_SHA: "abc123", POSTHOG_ENVIRONMENT: "staging" } as NodeJS.ProcessEnv);
  assert.equal(activated, true);
  // Deliberately does NOT call a capture* function here -- that would queue a real event on the real
  // client, and shutdownReesPostHog() below would then attempt to flush it over the real network
  // (unlike the empty-queue case, which is verified network-free). Keeping the queue empty for every
  // init test in this file, not just this one, is what keeps them all safe to run without a live
  // PostHog endpoint or network access.
  await shutdownReesPostHog();
  resetReesPostHogForTest();
});

test("flushReesPostHog and shutdownReesPostHog are inert when PostHog is disabled", async () => {
  await assert.doesNotReject(() => flushReesPostHog());
  await assert.doesNotReject(() => shutdownReesPostHog());
});

test("flushReesPostHog drains a real, empty-queue client without throwing", async () => {
  const activated = await initReesPostHog({ POSTHOG_API_KEY: "phc_test_fake_key_coverage_only" } as NodeJS.ProcessEnv);
  assert.equal(activated, true);
  await assert.doesNotReject(() => flushReesPostHog());
  await shutdownReesPostHog();
  resetReesPostHogForTest();
});
