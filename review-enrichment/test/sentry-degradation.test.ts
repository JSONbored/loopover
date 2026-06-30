import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { buildBrief } from "../dist/brief.js";
import {
  captureAnalyzerDegradation,
  captureRouteError,
  captureSourcemapUploadFailure,
  captureUnhandledError,
  resetSentryForTest,
  setSentryForTest,
} from "../dist/sentry.js";

function sentryHarness() {
  const tags: Record<string, string> = {};
  const contexts: Record<string, unknown> = {};
  const fingerprints: unknown[][] = [];
  const levels: string[] = [];
  const captured: Error[] = [];
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
    {
      withScope: (run: (value: typeof scope) => void) => run(scope),
      captureException: (error: unknown) => {
        captured.push(error instanceof Error ? error : new Error(String(error)));
        return "event-id";
      },
      flush: async () => true,
    },
    { release: "gittensory-rees@test", environment: "test" },
  );
  return { tags, contexts, fingerprints, levels, captured };
}

afterEach(() => {
  resetSentryForTest();
});

test("captureAnalyzerDegradation is inert when Sentry is disabled", () => {
  assert.doesNotThrow(() =>
    captureAnalyzerDegradation(new Error("boom"), {
      analyzer: "dependency",
      repoFullName: "JSONbored/gittensory",
      prNumber: 7,
      headSha: "abc123",
      timeoutMs: 8000,
    }),
  );
});

test("captureAnalyzerDegradation tags and fingerprints sanitized analyzer failures", () => {
  const sentry = sentryHarness();
  const fakeGithubPat = ["github", "pat", "should_never_be_attached"].join("_");
  const fakeGhp = ["ghp", "should_never_be_attached"].join("_");

  captureAnalyzerDegradation(new Error("registry timeout"), {
    analyzer: "dependency",
    repoFullName: "JSONbored/gittensory",
    prNumber: 7,
    headSha: "abc123",
    timeoutMs: 8000,
    diff: fakeGithubPat,
    githubToken: fakeGhp,
    authorization: "Bearer should_never_be_attached",
  } as never);

  assert.deepEqual(sentry.levels, ["error"]);
  assert.deepEqual(sentry.fingerprints, [["rees-analyzer-degraded", "dependency"]]);
  assert.equal(sentry.tags.event, "rees_analyzer_degraded");
  assert.equal(sentry.tags.analyzer, "dependency");
  assert.equal(sentry.tags.repo, "JSONbored/gittensory");
  assert.equal(sentry.tags.pullNumber, "7");
  assert.equal(sentry.tags.release, "gittensory-rees@test");
  assert.equal(sentry.tags.environment, "test");
  assert.equal(sentry.captured[0].message, "registry timeout");

  const analyzerContext = sentry.contexts.rees_analyzer as Record<string, unknown>;
  assert.deepEqual(analyzerContext, {
    event: "rees_analyzer_degraded",
    analyzer: "dependency",
    repoFullName: "JSONbored/gittensory",
    prNumber: 7,
    headShaPrefix: "abc123",
    timeoutMs: 8000,
    release: "gittensory-rees@test",
    environment: "test",
  });
  const serializedContext = JSON.stringify(analyzerContext);
  assert.equal(serializedContext.includes(fakeGithubPat), false);
  assert.equal(serializedContext.includes(fakeGhp), false);
  assert.equal(serializedContext.includes("Bearer should_never_be_attached"), false);
});

test("captureAnalyzerDegradation filters tag values before sending them", () => {
  const sentry = sentryHarness();
  const secretLikeValue = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");

  captureAnalyzerDegradation(new Error("registry timeout"), {
    analyzer: secretLikeValue,
    repoFullName: `JSONbored/${secretLikeValue}`,
    prNumber: 7,
    headSha: secretLikeValue,
    timeoutMs: 8000,
  });

  assert.deepEqual(sentry.fingerprints, [["rees-analyzer-degraded", "[Filtered]"]]);
  assert.equal(sentry.tags.analyzer, "[Filtered]");
  assert.equal(sentry.tags.repo, "JSONbored/[Filtered]");
});

test("captureAnalyzerDegradation attaches safe attribution context for history failures", () => {
  const sentry = sentryHarness();
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");

  captureAnalyzerDegradation(new Error("history budget exhausted"), {
    analyzer: "history",
    requestedAnalyzers: ["secret", "history"],
    repoFullName: "JSONbored/metagraphed",
    prNumber: 2359,
    headSha: "abcdef1234567890",
    timeoutMs: 7000,
    elapsedMs: 6812,
    analyzerStatus: "degraded",
    profile: "balanced",
    costClass: "github-heavy",
    responseReserveMs: 750,
    partialStatus: "partial",
    partialReason: "history_budget_exhausted",
    phase: "similar_past_prs",
    subcall: "commit_pulls",
    endpointCategory: "github-commit-pulls",
    externalFailureReason: "timeout",
    externalElapsedMs: 1200,
    fileLookupCount: 5,
    commitLookupCount: 13,
    prLookupCount: 12,
    skippedFileCount: 2,
    githubEndpointCategory: "commit_pulls",
    capped: true,
    cacheHits: 4,
    cacheMisses: 9,
    externalCallsByCategory: { osv: 3, commit_pulls: 12 },
    skippedWorkByCategory: { history_budget: 2 },
    cappedWorkByCategory: { history_files: 2 },
    analysisElapsedMs: 6812,
    requestId: "req-123",
    traceId: "0123456789abcdef0123456789abcdef",
    diff: `+${fakeToken}`,
    githubToken: fakeToken,
  } as never);

  assert.equal(sentry.tags.analyzer, "history");
  assert.equal(sentry.tags.repo, "JSONbored/metagraphed");
  assert.equal(sentry.tags.pullNumber, "2359");
  const analyzerContext = sentry.contexts.rees_analyzer as Record<string, unknown>;
  assert.deepEqual(analyzerContext, {
    event: "rees_analyzer_degraded",
    analyzer: "history",
    requestedAnalyzers: ["secret", "history"],
    repoFullName: "JSONbored/metagraphed",
    prNumber: 2359,
    headShaPrefix: "abcdef123456",
    timeoutMs: 7000,
    elapsedMs: 6812,
    analyzerStatus: "degraded",
    profile: "balanced",
    costClass: "github-heavy",
    responseReserveMs: 750,
    partialStatus: "partial",
    partialReason: "history_budget_exhausted",
    phase: "similar_past_prs",
    subcall: "commit_pulls",
    endpointCategory: "github-commit-pulls",
    externalFailureReason: "timeout",
    externalElapsedMs: 1200,
    fileLookupCount: 5,
    commitLookupCount: 13,
    prLookupCount: 12,
    skippedFileCount: 2,
    githubEndpointCategory: "commit_pulls",
    capped: true,
    cacheHits: 4,
    cacheMisses: 9,
    externalCallsByCategory: { osv: 3, commit_pulls: 12 },
    skippedWorkByCategory: { history_budget: 2 },
    cappedWorkByCategory: { history_files: 2 },
    analysisElapsedMs: 6812,
    requestId: "req-123",
    traceId: "0123456789abcdef0123456789abcdef",
    release: "gittensory-rees@test",
    environment: "test",
  });
  const serializedContext = JSON.stringify(analyzerContext);
  assert.equal(serializedContext.includes(fakeToken), false);
  assert.equal(serializedContext.includes("diff"), false);
  assert.equal(serializedContext.includes("githubToken"), false);
});

test("buildBrief stays fail-open and captures a degraded analyzer", async () => {
  const sentry = sentryHarness();
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");

  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 42,
      headSha: "head-sha",
      analyzers: ["dependency"],
      files: [{ path: "package.json", patch: '+    "lodash": "4.17.20",' }],
      budget: { timeoutMs: 200 },
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
  assert.equal(brief.repoFullName, "JSONbored/gittensory");
  assert.equal(brief.prNumber, 42);
  assert.equal(brief.telemetry.analyzers.dependency.partialReason, "analyzer_error");
  assert.equal(JSON.stringify(brief.telemetry).includes(fakeToken), false);
  assert.equal(JSON.stringify(brief.telemetry).includes("osv unavailable"), false);
  assert.equal(sentry.captured.length, 1);
  assert.equal(sentry.captured[0].message, "analyzer_error");
  assert.equal(sentry.tags.analyzer, "dependency");
  assert.equal(sentry.tags.repo, "JSONbored/gittensory");
  assert.equal(sentry.tags.pullNumber, "42");
  assert.equal(sentry.tags.event, "rees_analyzer_degraded");
  const analyzerContext = sentry.contexts.rees_analyzer as Record<string, unknown>;
  const capturedTimeoutMs = Number(analyzerContext.timeoutMs);
  assert.ok(capturedTimeoutMs > 0);
  assert.ok(capturedTimeoutMs <= 200);
});

test("captureRouteError applies the route-level fingerprint and allowlisted tags", () => {
  const sentry = sentryHarness();

  captureRouteError(new Error("boom"), {
    route: "/v1/enrich",
    method: "POST",
  });

  assert.deepEqual(sentry.levels, ["error"]);
  assert.deepEqual(sentry.fingerprints, [["rees-route-error", "/v1/enrich", "POST"]]);
  assert.equal(sentry.tags.event, "rees_route_error");
  assert.equal(sentry.tags.route, "/v1/enrich");
  assert.equal(sentry.tags.method, "POST");
  assert.equal(sentry.tags.release, "gittensory-rees@test");
  assert.equal(sentry.tags.environment, "test");
  assert.deepEqual(sentry.contexts.rees_route, {
    event: "rees_route_error",
    route: "/v1/enrich",
    method: "POST",
    release: "gittensory-rees@test",
    environment: "test",
  });
});

test("captureUnhandledError fingerprints process-level failures by event class", () => {
  const sentry = sentryHarness();

  captureUnhandledError(new Error("kaboom"), { event: "rees_uncaught_exception" });

  assert.deepEqual(sentry.fingerprints, [["rees-process-error", "rees_uncaught_exception"]]);
  assert.equal(sentry.tags.event, "rees_uncaught_exception");
  assert.equal(sentry.tags.release, "gittensory-rees@test");
  assert.equal(sentry.tags.environment, "test");
  assert.deepEqual(sentry.contexts.rees_process, {
    event: "rees_uncaught_exception",
    release: "gittensory-rees@test",
    environment: "test",
  });
});

test("captureSourcemapUploadFailure applies stable upload grouping and safe tags", () => {
  const sentry = sentryHarness();

  captureSourcemapUploadFailure(new Error("upload failed"), {
    release: "gittensory-rees@test",
    railwayDeploymentId: "railway-deploy-123",
    strict: true,
    sha: "abcdef1234567890",
    stage: "upload",
  });

  assert.deepEqual(sentry.fingerprints, [["rees-sourcemap-upload-failed"]]);
  assert.equal(sentry.tags.event, "rees_sourcemap_upload_failed");
  assert.equal(sentry.tags.release, "gittensory-rees@test");
  assert.equal(sentry.tags.environment, "test");
  assert.equal(sentry.tags.railwayDeploymentId, "railway-deploy-123");
  assert.deepEqual(sentry.contexts.rees_sourcemap_upload, {
    event: "rees_sourcemap_upload_failed",
    release: "gittensory-rees@test",
    railwayDeploymentId: "railway-deploy-123",
    strict: true,
    sha: "abcdef1234567890",
    stage: "upload",
    environment: "test",
  });
});

test("buildBrief normalizes unsafe analyzer partial reasons before response telemetry", async () => {
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");

  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 42,
      analyzers: ["history"],
      linkedIssue: { number: 9, title: "add history context" },
      diff: `+${fakeToken}`,
      budget: { timeoutMs: 200 },
    },
    {
      history: async (_req, context) => {
        context.diagnostics.partialReason = `unsafe ${fakeToken}`;
        return [{ author: null, similarPastPrs: [], linkedIssueAlignment: null, partial: true }];
      },
    },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.history, "degraded");
  assert.equal(brief.telemetry.analyzers.history.partialReason, "analyzer_partial");
  assert.equal(JSON.stringify(brief.telemetry).includes(fakeToken), false);
});

test("buildBrief returns a timed-out partial response before the caller timeout budget is spent", async () => {
  const started = Date.now();
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/metagraphed",
      prNumber: 2359,
      headSha: "abcdef1234567890",
      analyzers: ["history"],
      githubToken: "token",
      author: "jsonbored",
      files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
      budget: { timeoutMs: 300 },
    },
    {
      history: async () => new Promise(() => undefined),
    },
    { requestId: "req-timeout" },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.history, "timeout");
  assert.deepEqual(brief.findings, {});
  assert.ok(Date.now() - started < 500);
  assert.ok(brief.elapsedMs < 500);
});

test("buildBrief marks analyzer-provided partial findings as degraded while keeping the brief", async () => {
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/metagraphed",
      prNumber: 2359,
      analyzers: ["history"],
      linkedIssue: { number: 9, title: "add history context" },
      diff: "+history context",
    },
    {
      history: async (_req, context) => {
        context.diagnostics.partialReason = "history_budget_exhausted";
        context.diagnostics.captureDegradation = true;
        context.diagnostics.phase = "similar_past_prs";
        context.diagnostics.githubEndpointCategory = "commit_pulls";
        context.diagnostics.fileLookupCount = 1;
        return [
          {
            author: null,
            similarPastPrs: [],
            linkedIssueAlignment: { issue: 9, statedRequirement: "add history context", diffCovers: "full" },
            partial: true,
          },
        ];
      },
    },
    { requestId: "req-partial", traceId: "0123456789abcdef0123456789abcdef" },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.history, "degraded");
  assert.equal(brief.findings.history?.[0]?.partial, true);
  assert.match(brief.promptSection, /Author & change-area history/);
});

test("buildBrief treats an explicit empty analyzer list as run none", async () => {
  let ran = false;

  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 42,
      headSha: "head-sha",
      analyzers: [],
    },
    {
      secret: async () => {
        ran = true;
        return [
          {
            file: "src/config.ts",
            line: 7,
            kind: "generic_secret_assignment",
            confidence: "high",
          },
        ];
      },
      redos: async () => {
        ran = true;
        return [
          {
            file: "src/regex.ts",
            line: 3,
            kind: "nested-quantifier",
            pattern: "(a+)+",
          },
        ];
      },
    },
  );

  assert.equal(ran, false);
  assert.equal(brief.partial, false);
  assert.deepEqual(brief.findings, {});
  assert.equal(brief.analyzerStatus.secret, "skipped");
  assert.equal(brief.analyzerStatus.redos, "skipped");
  assert.equal(brief.promptSection, "");
  assert.equal(brief.systemSuffix, "");
});
