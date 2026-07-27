// FleetRunManifest tolerant parser (#4299) + per-repo default decoupling (#9324).
// Runs against compiled dist/ — this is what Codecov's `engine` flag grades for
// packages/loopover-engine/src/fleet-run-manifest.ts (root vitest alone is not enough).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FLEET_RUN_MANIFEST,
  DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES,
  parseFleetRunManifest,
  parseFleetRunManifestContent,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the FleetRunManifest parser API", () => {
  assert.equal(typeof parseFleetRunManifest, "function");
  assert.equal(typeof parseFleetRunManifestContent, "function");
  assert.equal(DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES, 1);
  assert.equal(DEFAULT_FLEET_RUN_MANIFEST.totalConcurrentWorktrees, 1);
});

test("parseFleetRunManifest: missing raw input returns an absent safe-default manifest", () => {
  for (const raw of [undefined, null]) {
    const parsed = parseFleetRunManifest(raw);
    assert.equal(parsed.present, false);
    assert.deepEqual(parsed.manifest, DEFAULT_FLEET_RUN_MANIFEST);
    assert.deepEqual(parsed.warnings, []);
  }
});

test("parseFleetRunManifest: a non-mapping raw value degrades to safe defaults with a warning", () => {
  const parsed = parseFleetRunManifest(["not", "a", "mapping"]);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.manifest, DEFAULT_FLEET_RUN_MANIFEST);
  assert.match(parsed.warnings.join(" "), /must be a mapping/i);
});

test("parseFleetRunManifest: normalizes string + object repos, floors budgets, dedupes, skips invalid", () => {
  const parsed = parseFleetRunManifest({
    repos: [
      "owner/a",
      { repoFullName: "owner/b", maxConcurrentWorktrees: 3.9 },
      { repoFullName: "owner/b", maxConcurrentWorktrees: 2 },
      "owner/a",
      "not-a-repo",
      "owner/repo/extra",
      "/only-repo",
      { repoFullName: "no-slash" },
      { repoFullName: 123 },
      { repoFullName: "owner/c", maxConcurrentWorktrees: "x" },
      42,
    ],
    totalConcurrentWorktrees: 5,
  });
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.manifest.repos, [
    { repoFullName: "owner/a", maxConcurrentWorktrees: 1 },
    { repoFullName: "owner/b", maxConcurrentWorktrees: 3 },
    { repoFullName: "owner/c", maxConcurrentWorktrees: 1 },
  ]);
  assert.equal(parsed.manifest.totalConcurrentWorktrees, 5);
  const w = parsed.warnings.join(" ");
  assert.match(w, /duplicate entry for owner\/b/);
  assert.match(w, /invalid "owner\/repo" name/);
  assert.match(w, /non-string, non-mapping/);
  assert.match(w, /"maxConcurrentWorktrees" must be a positive whole number/);
});

test("#9324: bare-string and omitted-object per-repo defaults use the dedicated constant", () => {
  const divergentFleetTotal = 99;
  const bare = parseFleetRunManifest({
    repos: ["owner/a"],
    totalConcurrentWorktrees: divergentFleetTotal,
  });
  assert.equal(bare.manifest.totalConcurrentWorktrees, divergentFleetTotal);
  assert.deepEqual(bare.manifest.repos, [
    {
      repoFullName: "owner/a",
      maxConcurrentWorktrees: DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES,
    },
  ]);
  assert.notEqual(
    bare.manifest.repos[0]?.maxConcurrentWorktrees,
    divergentFleetTotal,
  );

  const omittedObject = parseFleetRunManifest({
    repos: [{ repoFullName: "owner/b" }],
    totalConcurrentWorktrees: divergentFleetTotal,
  });
  assert.equal(
    omittedObject.manifest.repos[0]?.maxConcurrentWorktrees,
    DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES,
  );

  // Explicit object budget still wins; the constant is only the omit/malformed fallback.
  const explicit = parseFleetRunManifest({
    repos: [{ repoFullName: "owner/c", maxConcurrentWorktrees: 4 }],
  });
  assert.equal(explicit.manifest.repos[0]?.maxConcurrentWorktrees, 4);

  // Sub-1 object budget falls back through normalizePositiveInteger to the dedicated constant.
  const subOne = parseFleetRunManifest({
    repos: [{ repoFullName: "owner/d", maxConcurrentWorktrees: 0 }],
  });
  assert.equal(
    subOne.manifest.repos[0]?.maxConcurrentWorktrees,
    DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES,
  );
  assert.match(subOne.warnings.join(" "), /"maxConcurrentWorktrees" must be >= 1/);
});

test("parseFleetRunManifestContent: blank content is an absent manifest; YAML/JSON parse", () => {
  for (const content of [undefined, null, "", "   "]) {
    const parsed = parseFleetRunManifestContent(content);
    assert.equal(parsed.present, false);
    assert.deepEqual(parsed.manifest, DEFAULT_FLEET_RUN_MANIFEST);
  }

  const yaml = parseFleetRunManifestContent(
    "repos:\n  - owner/a\n  - repoFullName: owner/b\n    maxConcurrentWorktrees: 2\ntotalConcurrentWorktrees: 4\n",
  );
  assert.equal(yaml.present, true);
  assert.deepEqual(
    yaml.manifest.repos.map((r) => r.repoFullName),
    ["owner/a", "owner/b"],
  );
  assert.equal(yaml.manifest.repos[0]?.maxConcurrentWorktrees, DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES);
  assert.equal(yaml.manifest.repos[1]?.maxConcurrentWorktrees, 2);
  assert.equal(yaml.manifest.totalConcurrentWorktrees, 4);
});
