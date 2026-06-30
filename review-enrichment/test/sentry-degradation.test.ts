import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { buildBrief } from "../dist/brief.js";
import {
  captureAnalyzerDegradation,
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
  assert.equal(sentry.tags.headShaPrefix, "abc123");
  assert.equal(sentry.tags.timeoutMs, "8000");
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
  assert.equal(sentry.tags.headShaPrefix, "[Filtered]");
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
    partialStatus: "partial",
    partialReason: "history_budget_exhausted",
    phase: "similar_past_prs",
    subcall: "commit_pulls",
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
  assert.equal(sentry.tags.headShaPrefix, "abcdef123456");
  assert.equal(sentry.tags.timeoutMs, "7000");
  assert.equal(sentry.tags.analyzerStatus, "degraded");
  assert.equal(sentry.tags.partialStatus, "partial");
  assert.equal(sentry.tags.phase, "similar_past_prs");
  assert.equal(sentry.tags.githubEndpointCategory, "commit_pulls");
  assert.equal(sentry.tags.cacheHits, "4");
  assert.equal(sentry.tags.cacheMisses, "9");
  assert.equal(sentry.tags.requestId, "req-123");
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
    partialStatus: "partial",
    partialReason: "history_budget_exhausted",
    phase: "similar_past_prs",
    subcall: "commit_pulls",
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

  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 42,
      headSha: "head-sha",
      budget: { timeoutMs: 50 },
    },
    {
      dependency: async () => {
        throw new Error("osv unavailable");
      },
    },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.dependency, "degraded");
  assert.deepEqual(brief.findings, {});
  assert.equal(brief.repoFullName, "JSONbored/gittensory");
  assert.equal(brief.prNumber, 42);
  assert.equal(sentry.captured.length, 1);
  assert.equal(sentry.captured[0].message, "osv unavailable");
  assert.equal(sentry.tags.analyzer, "dependency");
  assert.equal(sentry.tags.repo, "JSONbored/gittensory");
  assert.equal(sentry.tags.pullNumber, "42");
  assert.equal(sentry.tags.headShaPrefix, "head-sha");
  assert.equal(sentry.tags.timeoutMs, "50");
});

test("buildBrief returns a degraded partial response before the caller timeout budget is spent", async () => {
  const started = Date.now();
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/metagraphed",
      prNumber: 2359,
      headSha: "abcdef1234567890",
      budget: { timeoutMs: 20 },
    },
    {
      history: async () => new Promise(() => undefined),
    },
    { requestId: "req-timeout" },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.history, "degraded");
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
