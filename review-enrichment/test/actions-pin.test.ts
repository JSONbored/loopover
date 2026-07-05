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

test("scanWorkflowPins excludes official actions/github refs case-insensitively", () => {
  const findings = scanWorkflowPins(
    workflowPath,
    [
      "@@ -1,0 +5,4 @@",
      "+    - uses: Actions/checkout@v4",
      "+    - uses: GitHub/codeql-action/init@v3",
      "+    - uses: ACTIONS/setup-node@v4",
      "+    - uses: pnpm/action-setup@v3",
    ].join("\n"),
  );

  // GitHub org names are case-insensitive, so official actions/* and github/* refs are excluded regardless of
  // casing; only the genuine mutable third-party ref is flagged.
  assert.deepEqual(findings, [
    { file: workflowPath, line: 8, action: "pnpm/action-setup", ref: "v3" },
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

test("scanWorkflowPins does not let a no-newline marker skew the line number", () => {
  // `\ No newline at end of file` is not a new-file line; advancing past it would cite the
  // mutable uses: one line too high (same class as the iac-misconfig / redos regression).
  // First added line is an official action (not flagged) so only the third-party pin is asserted.
  const findings = scanWorkflowPins(
    workflowPath,
    [
      "@@ -1,1 +1,2 @@",
      "-    - uses: actions/checkout@v3",
      "\\ No newline at end of file",
      "+    - uses: actions/checkout@v4",
      "+    - uses: pnpm/action-setup@v3",
    ].join("\n"),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 2, action: "pnpm/action-setup", ref: "v3" },
  ]);
});

test("scanWorkflowPins accepts uppercase and mixed-case 40-char SHA pins", () => {
  // Git SHAs are case-insensitive; an uppercase/mixed-case full SHA is still an immutable pin.
  const upperSha = "A".repeat(40);
  const mixedSha = `${"a".repeat(20)}${"B".repeat(20)}`;
  assert.deepEqual(
    scanWorkflowPins(
      workflowPath,
      [
        "@@ -1,0 +1,2 @@",
        `+    - uses: tj-actions/changed-files@${upperSha}`,
        `+    - uses: docker/login-action@${mixedSha}`,
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

test("scanActionPins matches workflow paths case-insensitively", async () => {
  const findings = await scanActionPins({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      {
        path: ".github/Workflows/CI.YML",
        patch: "@@ -1,0 +5,1 @@\n+    - uses: pnpm/action-setup@v3",
      },
      {
        path: "docs/workflow.yml",
        patch: "@@ -1,0 +1,1 @@\n+    - uses: vendor/not-a-workflow@main",
      },
    ],
  });

  assert.deepEqual(findings, [
    {
      file: ".github/Workflows/CI.YML",
      line: 5,
      action: "pnpm/action-setup",
      ref: "v3",
    },
  ]);
});
