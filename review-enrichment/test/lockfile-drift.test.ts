import { test } from "node:test";
import assert from "node:assert/strict";

import { extractLockfileChanges } from "../dist/analyzers/lockfile-drift.js";

test("extractLockfileChanges matches lockfile basenames case-insensitively", () => {
  const changes = extractLockfileChanges([
    {
      path: "frontend/Yarn.lock",
      patch: [
        "@@ -1,0 +1,2 @@",
        "+lodash@^4.17.21:",
        '+  version "4.17.21"',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    {
      file: "frontend/Yarn.lock",
      line: 2,
      ecosystem: "npm",
      package: "lodash",
      from: null,
      to: "4.17.21",
    },
  ]);
});

test("extractLockfileChanges keeps new-file line numbers correct across ++-content added lines", () => {
  // An added line whose CONTENT begins with `++ ` renders in the diff as `+++ …`. The old anchored
  // `startsWith("+++ ")` guard mistook it for a `+++ b/file` header and `continue`d WITHOUT advancing the
  // new-file line counter, so every finding AFTER it was reported one line too low. The shared
  // isDiffFileHeaderLine helper only skips real `+++ a/`/`b/`/`/dev/null` headers, so the counter stays true.
  const changes = extractLockfileChanges([
    {
      path: "package-lock.json",
      patch: [
        "@@ -9,0 +10,3 @@",
        '+    "node_modules/lodash": {', // new-file line 10
        "+++ not a header — added content whose text begins with ++", // new-file line 11 (must be counted)
        '+      "version": "4.17.21"', // new-file line 12
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    {
      file: "package-lock.json",
      line: 12, // 12, not 11 — the intervening ++-content line is counted, not swallowed as a header
      ecosystem: "npm",
      package: "lodash",
      from: null,
      to: "4.17.21",
    },
  ]);
});

test("extractLockfileChanges does not let unparsed lockfiles consume the scan budget", () => {
  const yarnPatch = [
    "@@ -1,0 +1,2 @@",
    "+lodash@^4.17.21:",
    '+  version "4.17.21"',
  ].join("\n");
  const filler = Array.from({ length: 12 }, (_, index) => ({
    path: `pkg-${index}/pnpm-lock.yaml`,
    patch: "@@ -1,0 +1,1 @@\n+lockfileVersion: 6.0",
  }));

  const changes = extractLockfileChanges([
    ...filler,
    { path: "frontend/Yarn.lock", patch: yarnPatch },
  ]);

  assert.deepEqual(changes, [
    {
      file: "frontend/Yarn.lock",
      line: 2,
      ecosystem: "npm",
      package: "lodash",
      from: null,
      to: "4.17.21",
    },
  ]);
});

test("extractLockfileChanges excludes PyPI direct deps under PEP 503 name normalization", () => {
  // Manifests often use `Django` / `PyYAML` while poetry.lock stores `django` / `pyyaml`.
  // Without PEP 503 normalization those were treated as lockfile-only transitive drift.
  const changes = extractLockfileChanges([
    {
      path: "requirements.txt",
      patch: ["@@ -1,0 +1,2 @@", "+Django==4.2.0", "+PyYAML==6.0"].join("\n"),
    },
    {
      path: "poetry.lock",
      patch: [
        "@@ -1,0 +1,6 @@",
        "+[[package]]",
        '+name = "django"',
        '+version = "4.2.0"',
        "+[[package]]",
        '+name = "pyyaml"',
        '+version = "6.0"',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(changes, []);
});

test("extractLockfileChanges still reports a PyPI lockfile-only package", () => {
  // A package present only in poetry.lock (no manifest entry) remains lockfile drift.
  const changes = extractLockfileChanges([
    {
      path: "poetry.lock",
      patch: [
        "@@ -1,0 +1,3 @@",
        "+[[package]]",
        '+name = "requests"',
        '+version = "2.31.0"',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(changes, [
    {
      file: "poetry.lock",
      line: 3,
      ecosystem: "PyPI",
      package: "requests",
      from: null,
      to: "2.31.0",
    },
  ]);
});

test("extractLockfileChanges reports an upgraded resolved version (from -> to) in each supported lockfile format", () => {
  // The existing cases above only exercise ADDED entries (from: null). An upgrade renders as a `-` old
  // version plus a `+` new version under a CONTEXT package header — the header itself is unchanged.
  const changes = extractLockfileChanges([
    {
      path: "package-lock.json",
      patch: [
        "@@ -10,2 +10,2 @@",
        '     "node_modules/lodash": {',
        '-      "version": "4.17.20",',
        '+      "version": "4.17.21",',
      ].join("\n"),
    },
    {
      path: "yarn.lock",
      patch: [
        "@@ -5,2 +5,2 @@",
        " axios@^1.6.0:",
        '-  version "1.6.0"',
        '+  version "1.6.1"',
      ].join("\n"),
    },
    {
      path: "poetry.lock",
      patch: [
        "@@ -1,3 +1,3 @@",
        " [[package]]",
        ' name = "requests"',
        '-version = "2.31.0"',
        '+version = "2.32.0"',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    { file: "package-lock.json", line: 11, ecosystem: "npm", package: "lodash", from: "4.17.20", to: "4.17.21" },
    { file: "yarn.lock", line: 6, ecosystem: "npm", package: "axios", from: "1.6.0", to: "1.6.1" },
    { file: "poetry.lock", line: 3, ecosystem: "PyPI", package: "requests", from: "2.31.0", to: "2.32.0" },
  ]);
});

test("extractLockfileChanges resolves a scoped npm package from a multi-descriptor yarn header, deduped", () => {
  const changes = extractLockfileChanges([
    {
      path: "yarn.lock",
      patch: [
        "@@ -1,0 +1,2 @@",
        '+"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
        '+  version "7.2.0"',
      ].join("\n"),
    },
  ]);

  // Both descriptors name the same scoped package — one change, not two.
  assert.deepEqual(changes, [
    { file: "yarn.lock", line: 2, ecosystem: "npm", package: "@babel/core", from: null, to: "7.2.0" },
  ]);
});

test("extractLockfileChanges: removed-only and unchanged lockfile entries produce no drift", () => {
  const changes = extractLockfileChanges([
    {
      // Removed-only: the package leaves the lockfile — there is no new resolved version to query.
      path: "package-lock.json",
      patch: [
        "@@ -10,2 +10,1 @@",
        '     "node_modules/lodash": {',
        '-      "version": "4.17.20",',
      ].join("\n"),
    },
    {
      // Same-version rewrite (formatting churn): from === to is not drift.
      path: "yarn.lock",
      patch: [
        "@@ -5,2 +5,2 @@",
        " axios@^1.6.0:",
        '-  version "1.6.1"',
        '+  version "1.6.1"',
      ].join("\n"),
    },
    {
      // Purely-context hunk: nothing added or removed at all.
      path: "poetry.lock",
      patch: [
        "@@ -1,3 +1,3 @@",
        " [[package]]",
        ' name = "requests"',
        ' version = "2.31.0"',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, []);
});

test("extractLockfileChanges skips malformed/partial lockfile hunks rather than throwing", () => {
  // A version line with no preceding package header (a truncated hunk) has no package to attribute the
  // version to — in every format it must be dropped, and never throw.
  const changes = extractLockfileChanges([
    {
      path: "package-lock.json",
      patch: [
        "@@ -1,0 +1,2 @@",
        '+      "version": "4.17.21",',
        "+  garbage { not json",
      ].join("\n"),
    },
    {
      path: "yarn.lock",
      patch: ["@@ -1,0 +1,1 @@", '+  version "1.0.0"'].join("\n"),
    },
    {
      path: "poetry.lock",
      patch: ["@@ -1,0 +1,2 @@", '+version = "1.0"', "+[[package]]"].join("\n"),
    },
  ]);

  assert.deepEqual(changes, []);
});
