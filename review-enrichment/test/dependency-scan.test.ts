import { test } from "node:test";
import assert from "node:assert/strict";

import { extractDependencyChanges } from "../dist/analyzers/dependency-scan.js";

test("extractDependencyChanges skips real file headers via the shared discriminator, not spurious deps", () => {
  // The patch carries the unified-diff file headers (`--- a/…`, `+++ b/…`) ahead of the hunk. They must be
  // skipped as headers — never parsed as dependency lines — while the real version bump is extracted. This
  // pins the behavior after swapping the anchored `startsWith("+++ ")`/`startsWith("---")` guard for the
  // shared isDiffFileHeaderLine helper (which only matches `+++ a/`/`b/`/`/dev/null` headers).
  const changes = extractDependencyChanges([
    {
      path: "package.json",
      patch: [
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -5,3 +5,3 @@",
        '     "dependencies": {',
        '-    "lodash": "4.17.20",',
        '+    "lodash": "4.17.21",',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    { ecosystem: "npm", package: "lodash", from: "4.17.20", to: "4.17.21" },
  ]);
});

test("extractDependencyChanges reports a newly ADDED dependency with a null `from`", () => {
  const changes = extractDependencyChanges([
    {
      path: "package.json",
      patch: ["@@ -1,1 +1,2 @@", '     "dependencies": {', '+    "left-pad": "1.3.0",'].join("\n"),
    },
  ]);
  assert.deepEqual(changes, [{ ecosystem: "npm", package: "left-pad", from: null, to: "1.3.0" }]);
});

test("extractDependencyChanges ignores a removed-only dependency (nothing present after the change)", () => {
  const changes = extractDependencyChanges([
    { path: "package.json", patch: ["@@ -1,2 +1,1 @@", '-    "left-pad": "1.3.0",'].join("\n") },
  ]);
  assert.deepEqual(changes, []);
});

test("extractDependencyChanges ignores an unchanged version (added === removed)", () => {
  // A line reformatted/moved but whose version is identical must NOT surface as a change.
  const changes = extractDependencyChanges([
    {
      path: "package.json",
      patch: ["@@ -1,2 +1,2 @@", '-    "lodash": "4.17.21",', '+    "lodash": "4.17.21",'].join("\n"),
    },
  ]);
  assert.deepEqual(changes, []);
});

test("extractDependencyChanges skips a non-manifest file", () => {
  const changes = extractDependencyChanges([
    { path: "src/index.ts", patch: ["@@ -1 +1,1 @@", '+    "lodash": "4.17.21",'].join("\n") },
  ]);
  assert.deepEqual(changes, []);
});

test("extractDependencyChanges extracts multiple version bumps from one manifest, in order", () => {
  const changes = extractDependencyChanges([
    {
      path: "package.json",
      patch: [
        "@@ -1,4 +1,4 @@",
        '-    "react": "18.2.0",',
        '+    "react": "18.3.0",',
        '-    "lodash": "4.17.20",',
        '+    "lodash": "4.17.21",',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(changes, [
    { ecosystem: "npm", package: "react", from: "18.2.0", to: "18.3.0" },
    { ecosystem: "npm", package: "lodash", from: "4.17.20", to: "4.17.21" },
  ]);
});
