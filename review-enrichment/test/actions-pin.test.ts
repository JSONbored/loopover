// Units for the GitHub Actions pin analyzer (#1500/#2101). Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scanActionPins,
  scanWorkflowPins,
} from "../dist/analyzers/actions-pin.js";

const workflowPath = ".github/workflows/ci.yml";
const fullSha = "0123456789abcdef0123456789abcdef01234567";

test("scanWorkflowPins flags mutable third-party action refs with line citations", () => {
  const findings = scanWorkflowPins(
    workflowPath,
    [
      "@@ -1,0 +10,7 @@",
      "+    - uses: pnpm/action-setup@v3",
      "+    - uses: docker/login-action@main",
      `+    - uses: thirdparty/pinned@${fullSha}`,
      "+    - uses: actions/checkout@v4",
      "+    - uses: github/codeql-action/init@v3",
      "+    - run: npm test",
      "-    - uses: stale/action@main",
    ].join("\n"),
  );

  assert.deepEqual(findings, [
    { file: workflowPath, line: 10, action: "pnpm/action-setup", ref: "v3" },
    {
      file: workflowPath,
      line: 11,
      action: "docker/login-action",
      ref: "main",
    },
  ]);
});

test("scanWorkflowPins accepts quoted uses keys and ignores unchanged uses lines", () => {
  const findings = scanWorkflowPins(
    workflowPath,
    [
      "@@ -8,2 +8,4 @@",
      "     steps:",
      "       - uses: mutable/unchanged@main",
      '+      "uses": "vendor/quoted-action@release"',
      "+      'uses': 'vendor/single-quoted@beta'",
    ].join("\n"),
  );

  assert.deepEqual(findings, [
    {
      file: workflowPath,
      line: 10,
      action: "vendor/quoted-action",
      ref: "release",
    },
    {
      file: workflowPath,
      line: 11,
      action: "vendor/single-quoted",
      ref: "beta",
    },
  ]);
});

test("scanWorkflowPins ignores patches without added mutable third-party uses", () => {
  assert.deepEqual(
    scanWorkflowPins(
      workflowPath,
      [
        "@@ -1,0 +1,4 @@",
        "+name: ci",
        "+jobs:",
        `+    - uses: vendor/pinned@${fullSha}`,
        "+    - uses: actions/setup-node@v4",
      ].join("\n"),
    ),
    [],
  );
});

test("scanActionPins scans only changed workflow YAML files with patches", async () => {
  const findings = await scanActionPins({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      {
        path: ".github/workflows/release.yaml",
        patch: "@@ -1,0 +20,1 @@\n+    - uses: softprops/action-gh-release@v2",
      },
      {
        path: ".github/workflows/ci.yml",
        patch: "@@ -1,0 +30,1 @@\n+    - uses: pnpm/action-setup@v3",
      },
      {
        path: "docs/workflow.yml",
        patch: "@@ -1,0 +1,1 @@\n+    - uses: vendor/not-a-workflow@main",
      },
      {
        path: ".github/workflows/no-patch.yml",
      },
    ],
  });

  assert.deepEqual(findings, [
    {
      file: ".github/workflows/release.yaml",
      line: 20,
      action: "softprops/action-gh-release",
      ref: "v2",
    },
    {
      file: ".github/workflows/ci.yml",
      line: 30,
      action: "pnpm/action-setup",
      ref: "v3",
    },
  ]);
});
