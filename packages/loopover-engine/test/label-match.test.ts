import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearLabelPatternRegExpCacheForTest,
  labelMatchesPattern,
  labelPatternRegExpCacheKeysForTest,
} from "../dist/scoring/label-match.js";

// #9994: the fnmatch compiler emits one `.*` per `*` and has no `**` concept, so `*a**b` compiles to THREE
// `.*` groups. The old guard reused change-guardrail's path-glob counter, which scores a `**` pair as ONE
// group, undercounting `**` and admitting a pattern this compiler builds into a catastrophic-backtracking
// RegExp. Counting is now fnmatch-specific (one per raw `*`), so `**`-containing patterns over the cap are
// rejected — they fail SAFE toward no-multiplier (never match).
test("#9994: a pattern whose COMPILED groups exceed the cap via `**` is rejected (never matches)", () => {
  clearLabelPatternRegExpCacheForTest();
  assert.equal(labelMatchesPattern("anything", "*a**b"), false); // 3 stars → 3 groups → rejected
  assert.equal(labelMatchesPattern("x/y", "**/**"), false); // 4 stars → 4 groups → rejected
});

test("#9994: the preserved 2-group and non-`*` cases still match exactly", () => {
  assert.equal(labelMatchesPattern("type:bug-fix", "type:*"), true);
  assert.equal(labelMatchesPattern("priority:1", "priority:?"), true); // `?` is not a counted group
  assert.equal(labelMatchesPattern("a-b-c", "a*b*c"), true); // 2 stars, at the cap
  assert.equal(labelMatchesPattern("kind:bug", "kind:[bc]ug"), true); // classes are not counted groups
});

test("#9994: a rejected over-complex pattern is still cached (repeated read served from cache)", () => {
  clearLabelPatternRegExpCacheForTest();
  assert.equal(labelMatchesPattern("anything", "*a**b"), false);
  assert.ok(labelPatternRegExpCacheKeysForTest().includes("*a**b"));
  assert.equal(labelMatchesPattern("something-else", "*a**b"), false); // cache-hit arm, still false
  assert.equal(labelPatternRegExpCacheKeysForTest().filter((k) => k === "*a**b").length, 1);
});
