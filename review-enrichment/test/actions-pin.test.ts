// Units for the unpinned GitHub Actions analyzer (#1500). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanActionPins, scanWorkflowPins } from "../dist/analyzers/actions-pin.js";

const workflowPatch = (action, ref) =>
  `@@ -1,2 +1,3 @@\n jobs:\n   test:\n+      - uses: ${action}@${ref}\n`;

test("scanWorkflowPins: accepts uppercase 40-char SHA pins", () => {
  const sha = "A".repeat(40);
  assert.deepEqual(
    scanWorkflowPins(".github/workflows/ci.yml", workflowPatch("tj-actions/changed-files", sha)),
    [],
  );
});

test("scanWorkflowPins: flags mutable third-party refs that are not full SHAs", () => {
  const findings = scanWorkflowPins(
    ".github/workflows/ci.yml",
    workflowPatch("tj-actions/changed-files", "v35"),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.action, "tj-actions/changed-files");
  assert.equal(findings[0]!.ref, "v35");
});

test("scanWorkflowPins: skips official actions even when unpinned", () => {
  assert.deepEqual(
    scanWorkflowPins(".github/workflows/ci.yml", workflowPatch("actions/setup-node", "v4")),
    [],
  );
});

test("scanActionPins: scans changed workflow files only", async () => {
  const sha = "B".repeat(40);
  const out = await scanActionPins({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: ".github/workflows/ci.yml", patch: workflowPatch("tj-actions/changed-files", sha) },
      { path: "src/a.ts", patch: workflowPatch("tj-actions/changed-files", "main") },
    ],
  });
  assert.deepEqual(out, []);
});
