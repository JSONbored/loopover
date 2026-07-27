import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FLEET_RUN_MANIFEST,
  DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES,
  parseFleetRunManifest,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the fleet run-manifest parser API (#9324)", () => {
  assert.equal(typeof parseFleetRunManifest, "function");
  assert.equal(DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES, 1);
});

test("normalizeRepoList: a string entry and a fieldless mapping both take the dedicated per-repo default", () => {
  const parsed = parseFleetRunManifest({ repos: ["owner/a", { repoFullName: "owner/b" }] });
  assert.deepEqual(parsed.manifest.repos, [
    { repoFullName: "owner/a", maxConcurrentWorktrees: DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES },
    { repoFullName: "owner/b", maxConcurrentWorktrees: DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES },
  ]);
  assert.deepEqual(parsed.warnings, []);
});

test("normalizeRepoList: a mapping's own maxConcurrentWorktrees overrides the per-repo default", () => {
  const parsed = parseFleetRunManifest({
    repos: [
      { repoFullName: "owner/a", maxConcurrentWorktrees: 4 }, // explicit budget honoured
      { repoFullName: "owner/b", maxConcurrentWorktrees: "x" }, // non-numeric → default + warning
    ],
  });
  assert.deepEqual(parsed.manifest.repos, [
    { repoFullName: "owner/a", maxConcurrentWorktrees: 4 },
    { repoFullName: "owner/b", maxConcurrentWorktrees: DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES },
  ]);
  assert.match(parsed.warnings.join(" "), /"maxConcurrentWorktrees" must be a positive whole number/);
});

test("the per-repo default is a distinct source of truth from the fleet-wide total default", () => {
  // Both currently equal 1, but they are deliberately separate constants (#9324).
  const parsed = parseFleetRunManifest({ repos: ["owner/a"] });
  assert.equal(parsed.manifest.repos[0]?.maxConcurrentWorktrees, DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES);
  assert.equal(DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES, DEFAULT_FLEET_RUN_MANIFEST.totalConcurrentWorktrees);
});
