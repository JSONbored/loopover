// Units for the shared reverse-patch reconstruction helper (#4739, part of epic #4737). Own file (not
// doc-comment-drift.test.ts / exhaustiveness-drift.test.ts) now that the function lives in its own
// module and is consumed by both of those analyzers. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructOldContent } from "../dist/analyzers/reconstruct-old-content.js";

// The four tests below are relocated verbatim from doc-comment-drift.test.ts (this function's prior home)
// as part of #4739's extraction — same fixtures, same assertions, zero behavior change.

test("reconstructOldContent: reverse-applies a patch to rebuild the pre-PR file", () => {
  const DRIFTED = `/**\n * @param oldName the old one\n */\nexport function doThing(newName) {\n  return newName;\n}\n`;
  const DRIFT_PATCH = `@@ -1,6 +1,6 @@\n /**\n  * @param oldName the old one\n  */\n-export function doThing(oldName) {\n+export function doThing(newName) {\n   return newName;\n }`;
  const old = reconstructOldContent(DRIFTED, DRIFT_PATCH);
  assert.match(old, /function doThing\(oldName\)/); // the old parameter name is restored
  assert.doesNotMatch(old, /newName\) \{/); // the added signature line is dropped
});

test("reconstructOldContent: bails (null) when the patch context does not match the head content", () => {
  // The context line ` other` doesn't exist in newContent → misaligned patch → fail closed.
  assert.equal(reconstructOldContent(`a\nb\n`, `@@ -1,2 +1,2 @@\n-x\n+a\n other`), null);
});

test("reconstructOldContent: rebuilds across MULTIPLE hunks, filling the unchanged gap between them", () => {
  // new file: a / X / c / d. Hunk 1 changed Y→X (line 2); hunk 2 changed D→d (line 4); `c` is the untouched gap.
  const old = reconstructOldContent(
    `a\nX\nc\nd\n`,
    `@@ -1,2 +1,2 @@\n a\n-Y\n+X\n@@ -4,1 +4,1 @@\n-D\n+d`,
  );
  assert.equal(old, `a\nY\nc\nD\n`);
});

test("reconstructOldContent: bails (null) when a hunk starts beyond the head content's length", () => {
  // A hunk anchored at line 99 of a 2-line file can't align → fail closed rather than fabricate old content.
  assert.equal(reconstructOldContent(`a\nb\n`, `@@ -99,1 +99,1 @@\n a`), null);
});

// The tests below are new, added for #4739's full-branch-coverage requirement on the promoted shared
// helper — each pins a branch the four relocated tests above don't already exercise.

test("reconstructOldContent: a non-hunk preamble line before the first @@ header is skipped, not fatal", () => {
  // A raw `diff --git a/x b/x` style line (never present in GitHub's per-file `.patch`, but the loop
  // defensively tolerates it) must be skipped over, not mistaken for hunk content or a parse failure.
  const old = reconstructOldContent("b", "diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n+b");
  assert.equal(old, "a");
});

test("reconstructOldContent: bails (null) when a later hunk starts before the previous hunk's cursor (out of order/overlap)", () => {
  // Hunk 1 consumes new-file lines 1-2 (cursor ends at 2); hunk 2 claims to start at new-file line 2
  // (0-based index 1), which is BEHIND the cursor — an out-of-order or overlapping hunk pair that must
  // fail closed rather than reconstruct a nonsensical result.
  assert.equal(
    reconstructOldContent("a\nb\nc\nd", "@@ -1,2 +1,2 @@\n a\n b\n@@ -2,1 +2,1 @@\n c"),
    null,
  );
});

test("reconstructOldContent: a `\\ No newline at end of file` marker line is skipped, not treated as content", () => {
  // The marker starts with `\` (never `+`/`-`/` `); it must be ignored entirely rather than parsed as a
  // sign+body pair (which would read a bogus sign and desync the cursor, or falsely fail closed).
  const old = reconstructOldContent(
    "a\nb",
    "@@ -1,2 +1,2 @@\n a\n-x\n+b\n\\ No newline at end of file",
  );
  assert.equal(old, "a\nx");
});

test("reconstructOldContent: the trailing unchanged-lines flush is a no-op when the last hunk already reaches EOF", () => {
  // The final `while (cursor < newLines.length)` flush must correctly do NOTHING when the last hunk's
  // context/added lines already consumed every remaining new-file line.
  const old = reconstructOldContent("a\nb", "@@ -1,2 +1,2 @@\n-x\n+a\n b");
  assert.equal(old, "x\nb");
});

test("reconstructOldContent: a wholly new file reconstructs to an empty string, not null — both are falsy", () => {
  // A patch that is 100% additions (old range `-0,0`) has no old-side content to rebuild: the correct
  // reconstruction of "the file did not exist before this PR" is an empty string, not null. Every caller
  // must treat this the same as null via a plain truthiness check (see the module's own doc comment) —
  // patch data alone cannot (and need not) distinguish a brand-new file from a pre-existing 0-byte one.
  const old = reconstructOldContent("a\nb\nc", "@@ -0,0 +1,3 @@\n+a\n+b\n+c");
  assert.equal(old, "");
  assert.ok(!old); // falsy, exactly like null — this is the contract every caller relies on
});
