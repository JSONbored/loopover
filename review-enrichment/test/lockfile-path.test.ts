// Units for the lockfile-path helpers — classification (isSupportedLockfile) is deliberately broader
// than the parseable set, so ecosystem lockfiles are categorized even when the drift parser skips them.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSupportedLockfile, lockfileBasename } from "../dist/lockfile-path.js";

test("isSupportedLockfile classifies the recognized ecosystem lockfiles", () => {
  // Established set (npm / yarn / pnpm / poetry / go).
  for (const p of [
    "package-lock.json",
    "app/yarn.lock",
    "pkg/pnpm-lock.yaml",
    "poetry.lock",
    "svc/go.sum",
  ]) {
    assert.equal(isSupportedLockfile(p), true, p);
  }
  // Rust / PHP / Bun lockfiles — classification-only, matching src/review/rag.ts. Their bump should read as
  // a lockfile change, not a source change.
  assert.equal(isSupportedLockfile("Cargo.lock"), true);
  assert.equal(isSupportedLockfile("crates/api/Cargo.lock"), true);
  assert.equal(isSupportedLockfile("composer.lock"), true);
  assert.equal(isSupportedLockfile("bun.lockb"), true);
  // Basename match is case-insensitive and path-anchored (uses the last segment only).
  assert.equal(isSupportedLockfile("services\\web\\CARGO.LOCK"), true);
  // Non-lockfiles are not classified as lockfiles.
  for (const p of [
    "src/index.ts",
    "Cargo.toml",
    "package.json",
    "notes/cargo.lock.md",
  ]) {
    assert.equal(isSupportedLockfile(p), false, p);
  }
});

test("lockfileBasename returns the final path segment across separators", () => {
  assert.equal(lockfileBasename("a/b/Cargo.lock"), "Cargo.lock");
  assert.equal(lockfileBasename("a\\b\\bun.lockb"), "bun.lockb");
  assert.equal(lockfileBasename("composer.lock"), "composer.lock");
});
