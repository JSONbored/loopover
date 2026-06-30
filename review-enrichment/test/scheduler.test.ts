import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBrief } from "../dist/brief.js";

test("fast profile skips GitHub-heavy defaults without running them", async () => {
  let ran = false;
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      profile: "fast",
      githubToken: "token",
      author: "jsonbored",
      headSha: "abcdef1234567890",
      files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
    },
    {
      history: async () => {
        ran = true;
        return [];
      },
    },
  );

  assert.equal(ran, false);
  assert.equal(brief.partial, false);
  assert.equal(brief.analyzerStatus.history, "skipped");
});

test("explicit analyzer selection overrides profile membership while retaining bounded budgets", async () => {
  let sawProfile = "";
  let sawCostClass = "";
  let sawTimeoutMs = 0;
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      profile: "fast",
      analyzers: ["history"],
      githubToken: "token",
      author: "jsonbored",
      headSha: "abcdef1234567890",
      files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
      budget: { timeoutMs: 2000 },
    },
    {
      history: async (_req, context) => {
        sawProfile = context.profile;
        sawCostClass = context.costClass;
        sawTimeoutMs = context.timeoutMs;
        return [];
      },
    },
  );

  assert.equal(brief.analyzerStatus.history, "ok");
  assert.equal(sawProfile, "fast");
  assert.equal(sawCostClass, "github-heavy");
  assert.ok(sawTimeoutMs > 0);
  assert.ok(sawTimeoutMs < 2000);
});

test("slow analyzers time out inside the reserved response budget", async () => {
  const started = Date.now();
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      analyzers: ["history"],
      githubToken: "token",
      author: "jsonbored",
      headSha: "abcdef1234567890",
      files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
      budget: { timeoutMs: 300 },
    },
    {
      history: async () => new Promise(() => undefined),
    },
  );

  assert.equal(brief.partial, true);
  assert.equal(brief.analyzerStatus.history, "timeout");
  assert.equal(brief.telemetry.profile, "balanced");
  assert.equal(brief.telemetry.requestedAnalyzers[0], "history");
  assert.equal(brief.telemetry.analyzers.history.status, "timeout");
  assert.equal(brief.telemetry.analyzers.history.partialReason, "analyzer_timeout");
  assert.ok((brief.telemetry.analyzers.history.timeoutMs ?? 0) < 300);
  assert.ok(brief.telemetry.responseReserveMs > 0);
  assert.ok(Date.now() - started < 1000);
  assert.ok(brief.elapsedMs < 1000);
});

test("cost classes run in priority order instead of starting all at once", async () => {
  const events: string[] = [];

  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      analyzers: ["secret", "dependency", "history"],
      githubToken: "token",
      author: "jsonbored",
      headSha: "abcdef1234567890",
      files: [
        {
          path: "package.json",
          patch: [
            "@@ -1,3 +1,4 @@",
            ' { "dependencies": {',
            '+  "left-pad": "1.3.0",',
            '+  "apiKey": "test"',
          ].join("\n"),
        },
      ],
      budget: { timeoutMs: 2000 },
    },
    {
      secret: async () => {
        events.push("local:start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push("local:end");
        return [];
      },
      dependency: async () => {
        events.push("registry:start");
        assert.deepEqual(events, ["local:start", "local:end", "registry:start"]);
        events.push("registry:end");
        return [];
      },
      history: async () => {
        events.push("github-heavy:start");
        assert.deepEqual(events, [
          "local:start",
          "local:end",
          "registry:start",
          "registry:end",
          "github-heavy:start",
        ]);
        events.push("github-heavy:end");
        return [];
      },
    },
  );

  assert.equal(brief.partial, false);
  assert.deepEqual(events, [
    "local:start",
    "local:end",
    "registry:start",
    "registry:end",
    "github-heavy:start",
    "github-heavy:end",
  ]);
});

test("registry analyzers skip when their relevant inputs are absent", async () => {
  let dependencyRan = false;
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
    },
    {
      dependency: async () => {
        dependencyRan = true;
        return [];
      },
      secret: async () => [],
    },
  );

  assert.equal(dependencyRan, false);
  assert.equal(brief.analyzerStatus.dependency, "skipped");
  assert.equal(brief.analyzerStatus.secret, "ok");
  assert.equal(brief.telemetry.analyzers.dependency.skipReason, "no_dependency_manifest");
  assert.equal(brief.telemetry.analyzers.secret.status, "ok");
  assert.ok(brief.telemetry.skippedWorkByCategory.analyzer_no_dependency_manifest >= 1);
});
