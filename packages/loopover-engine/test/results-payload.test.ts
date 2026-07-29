import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResultsPayload } from "../dist/index.js";
import type { IterationResult } from "../dist/index.js";

const base = (over: Partial<IterationResult> = {}): IterationResult => ({
  repoFullName: "acme/widgets",
  prNumber: 1,
  title: "t",
  changedFiles: [],
  ...over,
});

test("#9611: a valid repo + positive integer PR produces the canonical link and names the repo", () => {
  const p = buildResultsPayload(base({ prNumber: 42 }));
  assert.equal(p.prLink, "https://github.com/acme/widgets/pull/42");
  assert.ok(p.summary.includes("Opened PR #42 in acme/widgets"));
});

test("#9611: an invalid repoFullName (traversal / extra segment / bad char / missing half) yields no link + 'unknown repository'", () => {
  for (const repoFullName of ["acme/widgets/../../evil", "a/b/c", "acme/wid gets", "acme/..", "acme/.", "./widgets", "/widgets", "acme/", "acme"]) {
    const p = buildResultsPayload(base({ repoFullName, prNumber: 1 }));
    assert.equal(p.prLink, null, `expected null prLink for ${repoFullName}`);
    assert.ok(p.summary.includes("unknown repository"), `expected 'unknown repository' for ${repoFullName}`);
    assert.ok(!p.summary.includes("../"), `summary must not leak raw traversal for ${repoFullName}`);
  }
});

test("#9611: a non-positive / non-integer / absent prNumber takes the no-PR branch", () => {
  for (const prNumber of [0, -3, 2.5, null, undefined]) {
    const p = buildResultsPayload(base({ prNumber }));
    assert.equal(p.prLink, null);
    assert.ok(p.summary.includes("No pull request was opened for acme/widgets"));
  }
});

test("#9611: a valid PR number against an invalid repo still yields prLink null", () => {
  const p = buildResultsPayload(base({ repoFullName: "acme/../evil", prNumber: 7 }));
  assert.equal(p.prLink, null);
});

test("#9611: additions/deletions normalize to non-negative integers (negative, fractional, non-finite)", () => {
  const p = buildResultsPayload(
    base({
      changedFiles: [
        { path: "a", additions: -5, deletions: 2.7 },
        { path: "b", additions: Number.NaN, deletions: 3 },
      ],
    }),
  );
  assert.deepEqual(p.diffPreview[0], { path: "a", additions: 0, deletions: 2 });
  assert.deepEqual(p.diffPreview[1], { path: "b", additions: 0, deletions: 3 });
  assert.deepEqual(p.totals, { files: 2, additions: 0, deletions: 5 });
});

test("#9611: absent additions/deletions default to 0 (the ?? 0 arms)", () => {
  const p = buildResultsPayload(base({ changedFiles: [{ path: "a" }] }));
  assert.deepEqual(p.diffPreview[0], { path: "a", additions: 0, deletions: 0 });
});
