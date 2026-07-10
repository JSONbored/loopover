import { test } from "node:test";
import assert from "node:assert/strict";

import { computeLocalScorerTokens } from "../dist/index.js";

test("barrel: the public entrypoint re-exports computeLocalScorerTokens", () => {
  assert.equal(typeof computeLocalScorerTokens, "function");
});

test("classifies source / test / non-code disjointly from changed-file metadata", () => {
  const r = computeLocalScorerTokens({
    changedFiles: [
      { path: "src/a.ts", additions: 10, deletions: 2 }, // source: 12
      { path: "src/a.test.ts", additions: 5, deletions: 1 }, // test: 6
      { path: "README.md", additions: 4, deletions: 0 }, // non-code: 4
    ],
  });
  assert.equal(r.mode, "external_command");
  assert.equal(r.activeModel, "gittensory-deterministic");
  assert.equal(r.sourceTokenScore, 12);
  assert.equal(r.testTokenScore, 6);
  assert.equal(r.nonCodeTokenScore, 4);
  assert.equal(r.totalTokenScore, 22);
  assert.equal(r.warnings, undefined);
});

test("drops binary files and floors sourceLines at 1", () => {
  const r = computeLocalScorerTokens({ changedFiles: [{ path: "img.png", additions: 999, binary: true }] });
  assert.equal(r.totalTokenScore, 0);
  assert.equal(r.sourceLines, 1);
});

test("surfaces a warning when a validation entry failed, without changing scores", () => {
  const r = computeLocalScorerTokens({
    changedFiles: [{ path: "src/a.ts", additions: 3 }],
    validation: [{ command: "npm test", status: "failed" }],
  });
  assert.equal(r.sourceTokenScore, 3);
  assert.ok(r.warnings && r.warnings.length === 1);
});
