// Unit for the shared diff-header discriminator used by analyzers that scan possibly-headerless patch fragments.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isBasicCommentLine, isDiffFileHeaderLine } from "../dist/analyzers/diff-lines.js";

test("isDiffFileHeaderLine matches real file headers only, not ++/--- content", () => {
  // Real unified-diff file headers → skipped.
  for (const header of ["+++ b/src/app.ts", "--- a/src/app.ts", "+++ /dev/null", "--- /dev/null"]) {
    assert.equal(isDiffFileHeaderLine(header), true, header);
  }
  // Added/removed CONTENT whose text begins with `++`/`--` renders as `+++…`/`---…` but is NOT a header and
  // must be scanned; likewise plain content and headerless single-line diffs.
  for (const content of ["+++x", "+++ const key = 1;", '+++ "lodash": "^1.0.0"', "+history analyzer", "---x", "+const y = 2;", "@@ -1,0 +1,1 @@"]) {
    assert.equal(isDiffFileHeaderLine(content), false, content);
  }
});

test("isBasicCommentLine matches //, /*, and * comment openers, leading whitespace included", () => {
  for (const line of ["// a note", "  // indented", "/* block open", "* jsdoc continuation", "   * indented continuation"]) {
    assert.equal(isBasicCommentLine(line), true, line);
  }
  // Not real code either, but outside this shared base's scope — analyzers that need these layer their own
  // override on top (hardcoded-url.ts's `#`/`<!--`, a11y-regression.ts's `<!--`/`import`/`from`).
  for (const line of ["# shell/python comment", "<!-- html comment -->", "import x from 'y'", "from y import x"]) {
    assert.equal(isBasicCommentLine(line), false, line);
  }
  // Real code → never flagged.
  for (const line of ["const x = 1;", "  return a && b;", "export function run() {"]) {
    assert.equal(isBasicCommentLine(line), false, line);
  }
});
