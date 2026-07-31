import { test } from "node:test";
import assert from "node:assert/strict";

import { AWESOME_CLAUDE_CONTENT_SPEC } from "../dist/review/content-lane/content-repo-spec.js";

// Mirrors the derived pairing assertion at test/unit/content-lane-duplicates.test.ts (protectedFrontmatterFields)
// and test/unit/content-lane-source-evidence.test.ts (urlFields): a hand-enumerated alias list can't catch the
// next camelCase URL field added to the spec without a matching snake_case alias — a derived walk can (#9992).
test("every camelCase urlFields member has its snake_case alias present in both urlFields and sourceUrlFields", () => {
  const toSnakeCase = (field: string): string => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  for (const field of AWESOME_CLAUDE_CONTENT_SPEC.urlFields) {
    if (!/[A-Z]/.test(field)) continue;
    const snakeCase = toSnakeCase(field);
    assert.equal(AWESOME_CLAUDE_CONTENT_SPEC.urlFields.has(snakeCase), true);
    assert.equal(AWESOME_CLAUDE_CONTENT_SPEC.sourceUrlFields.includes(snakeCase), true);
  }
});

test("documentation_url is present in both urlFields and sourceUrlFields (#9992)", () => {
  assert.equal(AWESOME_CLAUDE_CONTENT_SPEC.urlFields.has("documentation_url"), true);
  assert.equal(AWESOME_CLAUDE_CONTENT_SPEC.sourceUrlFields.includes("documentation_url"), true);
});
