import { test } from "node:test";
import assert from "node:assert/strict";

import { extractDependencyChanges } from "../dist/analyzers/dependency-scan.js";

test("extractDependencyChanges skips real file headers via the shared discriminator, not spurious deps", () => {
  // The patch carries the unified-diff file headers (`--- a/…`, `+++ b/…`) ahead of the hunk. They must be
  // skipped as headers — never parsed as dependency lines — while the real version bump is extracted. This
  // pins the behavior after swapping the anchored `startsWith("+++ ")`/`startsWith("---")` guard for the
  // shared isDiffFileHeaderLine helper (which only matches `+++ a/`/`b/`/`/dev/null` headers).
  const changes = extractDependencyChanges([
    {
      path: "package.json",
      patch: [
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -5,3 +5,3 @@",
        '     "dependencies": {',
        '-    "lodash": "4.17.20",',
        '+    "lodash": "4.17.21",',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    { ecosystem: "npm", package: "lodash", from: "4.17.20", to: "4.17.21" },
  ]);
});
