import { test } from "node:test";
import assert from "node:assert/strict";

import { validateIdeaSubmission } from "../dist/index.js";

// Engine-suite (node:test) coverage for validateIdeaSubmission's targetRepo resolution (#9609) so the
// `engine` Codecov flag credits the changed lines, mirroring test/unit/idea-intake-bridge.test.ts.
function rawIdea(targetRepo: unknown) {
  return { id: "idea-1", title: "One-line intent", body: "A description.", targetRepo };
}

test("resolves a bare owner/name string to an existing target", () => {
  const r = validateIdeaSubmission(rawIdea("owner/name"));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.idea.targetRepo, { kind: "existing", repo: "owner/name" });
});

test("accepts the canonical { kind: 'existing', repo } object it returns (round-trip)", () => {
  const r = validateIdeaSubmission(rawIdea({ kind: "existing", repo: "acme/widgets" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.idea.targetRepo, { kind: "existing", repo: "acme/widgets" });
});

test("accepts a provision object", () => {
  const r = validateIdeaSubmission(rawIdea({ kind: "provision" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.idea.targetRepo, { kind: "provision" });
});

test("rejects a malformed slug in both the string and the existing-object form", () => {
  for (const bad of ["no-slash", "a/b/c", { kind: "existing", repo: "no-slash" }, { kind: "existing", repo: "a/b/c" }]) {
    assert.equal(validateIdeaSubmission(rawIdea(bad)).ok, false);
  }
});

test("requires a target for null, a non-object, a non-string repo, a missing repo, and an unknown kind", () => {
  for (const bad of [null, 42, { kind: "existing" }, { kind: "existing", repo: 5 }, { kind: "banana" }, {}]) {
    const r = validateIdeaSubmission(rawIdea(bad));
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.includes("target_repo_required"));
  }
});
