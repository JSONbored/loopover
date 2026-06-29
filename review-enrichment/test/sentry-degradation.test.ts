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
  assert.equal(sentry.tags.headSha, "abc123");
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
    headSha: "abc123",
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
  assert.equal(sentry.tags.headSha, "[Filtered]");
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
  assert.equal(sentry.tags.headSha, "head-sha");
  assert.equal(sentry.tags.timeoutMs, "50");
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
