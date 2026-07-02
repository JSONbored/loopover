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

test("added-line analyzers skip uncapped patches with no additions", async () => {
  let secretRan = false;
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      analyzers: ["secret"],
      files: [
        {
          path: "src/context-only.ts",
          patch: "@@ -1,1 +1,1 @@\n const value = true;",
        },
      ],
    },
    {
      secret: async () => {
        secretRan = true;
        return [];
      },
    },
  );

  assert.equal(secretRan, false);
  assert.equal(brief.analyzerStatus.secret, "skipped");
  assert.equal(brief.telemetry.analyzers.secret.skipReason, "no_added_lines");
  assert.equal(brief.telemetry.skippedWorkByCategory.analyzer_no_added_lines, 1);
});

test("added-line analyzers run when patch scan is capped before additions", async () => {
  const ran = new Set();
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1811,
      analyzers: ["redos", "secret", "secretLog"],
      files: [
        {
          path: "src/late-addition.ts",
          patch: `${" context\n".repeat(130000)}+console.log(process.env.TOKEN);`,
        },
      ],
      budget: { timeoutMs: 2000 },
    },
    {
      redos: async () => {
        ran.add("redos");
        return [];
      },
      secret: async () => {
        ran.add("secret");
        return [];
      },
      secretLog: async () => {
        ran.add("secretLog");
        return [];
      },
    },
  );

  assert.deepEqual([...ran].sort(), ["redos", "secret", "secretLog"]);
  assert.equal(brief.analyzerStatus.redos, "ok");
  assert.equal(brief.analyzerStatus.secret, "ok");
  assert.equal(brief.analyzerStatus.secretLog, "ok");
  assert.equal(brief.telemetry.analyzerCount.skipped, 0);
  assert.equal(brief.telemetry.skippedWorkByCategory.analyzer_no_added_lines, undefined);
  assert.ok(brief.telemetry.cappedWorkByCategory.has_added_lines_patch_bytes > 0);
});

test("actionPin runs for mixed-case workflow paths", async () => {
  let actionPinRan = false;
  const brief = await buildBrief(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 2516,
      analyzers: ["actionPin"],
      files: [
        {
          path: ".github/Workflows/CI.YML",
          patch: "@@ -1,0 +5,1 @@\n+    - uses: pnpm/action-setup@v3",
        },
      ],
    },
    {
      actionPin: async () => {
        actionPinRan = true;
        return [{ file: ".github/Workflows/CI.YML", line: 5, action: "pnpm/action-setup", ref: "v3" }];
      },
    },
  );

  assert.equal(actionPinRan, true);
  assert.equal(brief.analyzerStatus.actionPin, "ok");
  assert.notEqual(brief.telemetry.analyzers.actionPin.skipReason, "no_workflow");
});
