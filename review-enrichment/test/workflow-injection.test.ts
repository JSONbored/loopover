// Units for the GitHub Actions workflow-injection / pwn-request analyzer (#2101-class). Kept separate so
// analyzer PRs avoid collisions, mirroring the actions-pin/iac-misconfig sibling test files.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scanPatchForWorkflowInjection,
  scanWorkflowInjection,
} from "../dist/analyzers/workflow-injection.js";
import {
  ANALYZER_DESCRIPTORS,
  getAnalyzerDescriptor,
} from "../dist/analyzers/registry.js";
import { buildBrief } from "../dist/brief.js";
import { renderBrief } from "../dist/render.js";

const workflowPath = ".github/workflows/ci.yml";

/** Build an add-only unified-diff patch starting at new-file line `startLine`. The old-file range is irrelevant
 *  to the analyzer (only the `+X,Y` new-range is parsed), so a placeholder `-0,0` is always used. */
function addedPatch(startLine: number, lines: string[]): string {
  return [`@@ -0,0 +${startLine},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

test("scanPatchForWorkflowInjection flags an untrusted checkout under pull_request_target with no environment gate", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.event.pull_request.head.sha }}",
    ]),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 7, kind: "untrusted-checkout" },
  ]);
});

test("scanPatchForWorkflowInjection flags an untrusted checkout under workflow_run via the github.head_ref form", () => {
  // workflow_run is the second elevated-trust trigger; github.head_ref is the alternate untrusted-ref form.
  // hasPullRequestTarget stays false here, so no missing-permissions finding should ride along.
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  workflow_run:",
      "steps:",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.head_ref }}",
    ]),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 5, kind: "untrusted-checkout" },
  ]);
});

test("scanPatchForWorkflowInjection does not flag an untrusted checkout guarded by an environment gate", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "environment: production",
      "steps:",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.event.pull_request.head.sha }}",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowInjection does not flag pull_request_target workflows that never check out an untrusted ref", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      "  uses: actions/checkout@v4",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowInjection flags a run: step that inline-interpolates an untrusted event field", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      '  - run: echo "${{ github.event.pull_request.title }}"',
    ]),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 6, kind: "unsafe-interpolation" },
  ]);
});

test("scanPatchForWorkflowInjection flags an unsafe interpolation inside a multi-line run: block scalar and stops at the closing sibling key", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      "  run: |",
      '    echo "hello"',
      '    echo "${{ github.event.pull_request.title }}"',
      "  if: always()",
    ]),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 8, kind: "unsafe-interpolation" },
  ]);
});

test("scanPatchForWorkflowInjection does not flag every remaining event field kind when each is present verbatim", () => {
  // Exercises the rest of the UNSAFE_EVENT_FIELD_RE alternation directly (issue title/body, comment body,
  // github.head_ref) in one pass, each on its own single-line run: step.
  const cases: string[] = [
    '  - run: echo "${{ github.event.pull_request.body }}"',
    '  - run: echo "${{ github.event.pull_request.head.ref }}"',
    '  - run: echo "${{ github.event.pull_request.head.label }}"',
    '  - run: echo "${{ github.event.issue.title }}"',
    '  - run: echo "${{ github.event.issue.body }}"',
    '  - run: echo "${{ github.event.comment.body }}"',
    '  - run: echo "${{ github.head_ref }}"',
  ];
  for (const line of cases) {
    const findings = scanPatchForWorkflowInjection(
      workflowPath,
      addedPatch(1, [
        "on:",
        "  pull_request_target:",
        "permissions:",
        "  contents: read",
        "steps:",
        line,
      ]),
    );
    assert.deepEqual(
      findings,
      [{ file: workflowPath, line: 6, kind: "unsafe-interpolation" }],
      `expected an unsafe-interpolation finding for: ${line}`,
    );
  }
});

test("scanPatchForWorkflowInjection does not flag event fields safely routed through env: first", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      "  env:",
      "    TITLE: ${{ github.event.pull_request.title }}",
      "  run: |",
      '    echo "$TITLE"',
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowInjection ignores unchanged (context) lines for both the run-block start and its interior", () => {
  // A fully pre-existing, unmodified run: block that already carries the unsafe pattern must not be reported —
  // it is not new risk this PR introduced. All lines below are context lines (unified-diff leading space).
  const patch = [
    "@@ -1,7 +1,7 @@",
    " on:",
    "   pull_request_target:",
    " permissions:",
    "   contents: read",
    " steps:",
    "   run: |",
    '     echo "${{ github.event.pull_request.title }}"',
  ].join("\n");
  assert.deepEqual(scanPatchForWorkflowInjection(workflowPath, patch), []);
});

test("scanPatchForWorkflowInjection flags a pull_request_target workflow missing a top-level permissions block", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "jobs:",
      "  build:",
      "steps:",
      "  run: echo hi",
    ]),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 2, kind: "missing-permissions" },
  ]);
});

test("scanPatchForWorkflowInjection does not flag a pull_request_target workflow that declares permissions", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      "  run: echo hi",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowInjection never flags a plain pull_request trigger, even with an otherwise-unsafe body", () => {
  // pull_request gets a read-only GITHUB_TOKEN for a fork PR, so none of the three rules apply — no missing
  // permissions, no untrusted checkout, no unsafe interpolation — despite every other ingredient being present.
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request:",
      "steps:",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.event.pull_request.head.sha }}",
      '  - run: echo "${{ github.event.pull_request.title }}"',
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowInjection degrades gracefully (no throw) on malformed/non-YAML patch content", () => {
  const garbage = addedPatch(1, [
    "{{{{{ ][[ garbled ::::   not yaml at all ---",
    "\ttab-indented\tline\twith\ttabs",
    "ref: not-a-valid-value-at-all $$$",
  ]);
  assert.doesNotThrow(() => scanPatchForWorkflowInjection(workflowPath, garbage));
  assert.deepEqual(scanPatchForWorkflowInjection(workflowPath, garbage), []);
});

test("scanPatchForWorkflowInjection skips a pre-hunk preamble without shifting line numbers", () => {
  const patch = [
    "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
    "index 1111111..2222222 100644",
    "--- a/.github/workflows/ci.yml",
    "+++ b/.github/workflows/ci.yml",
    "@@ -1,0 +1,2 @@",
    "+on:",
    "+  pull_request_target:",
  ].join("\n");
  assert.deepEqual(scanPatchForWorkflowInjection(workflowPath, patch), [
    { file: workflowPath, line: 2, kind: "missing-permissions" },
  ]);
});

test("scanPatchForWorkflowInjection keeps line numbers correct across a removed line and a no-newline marker", () => {
  const patch = [
    "@@ -1,1 +1,2 @@",
    "-on: pull_request",
    "\\ No newline at end of file",
    "+on:",
    "+  pull_request_target:",
  ].join("\n");
  assert.deepEqual(scanPatchForWorkflowInjection(workflowPath, patch), [
    { file: workflowPath, line: 2, kind: "missing-permissions" },
  ]);
});

test("scanPatchForWorkflowInjection skips a line longer than the safety cap", () => {
  const longRef = `ref: \${{ github.event.pull_request.head.sha }}${"x".repeat(2200)}`;
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "steps:",
      longRef,
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowInjection returns nothing when maxFindings is exhausted up front", () => {
  assert.deepEqual(
    scanPatchForWorkflowInjection(
      workflowPath,
      addedPatch(1, ["on:", "  pull_request_target:"]),
      0,
    ),
    [],
  );
});

test("scanPatchForWorkflowInjection caps its own findings at maxFindings", () => {
  const findings = scanPatchForWorkflowInjection(
    workflowPath,
    addedPatch(1, [
      "on:",
      "  pull_request_target:",
      "steps:",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.event.pull_request.head.sha }}",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.event.pull_request.head.ref }}",
      "  uses: actions/checkout@v4",
      "  ref: ${{ github.event.pull_request.head.label }}",
    ]),
    2,
  );
  assert.equal(findings.length, 2);
});

test("scanWorkflowInjection scans only changed workflow YAML files with patches", async () => {
  const findings = await scanWorkflowInjection({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      {
        path: ".github/workflows/ci.yml",
        patch: addedPatch(1, ["on:", "  pull_request_target:"]),
      },
      {
        path: "docs/workflow.yml",
        patch: addedPatch(1, ["on:", "  pull_request_target:"]),
      },
      {
        path: ".github/workflows/no-patch.yml",
      },
    ],
  });

  assert.deepEqual(findings, [
    { file: ".github/workflows/ci.yml", line: 2, kind: "missing-permissions" },
  ]);
});

test("scanWorkflowInjection degrades gracefully (no throw) end to end on malformed patch content", async () => {
  await assert.doesNotReject(
    scanWorkflowInjection({
      repoFullName: "o/r",
      prNumber: 1,
      files: [
        {
          path: ".github/workflows/ci.yml",
          patch: addedPatch(1, ["]]][[[ not yaml   ---"]),
        },
      ],
    }),
  );
});

test("scanWorkflowInjection stops once the overall finding cap is reached, without scanning later files", async () => {
  const manyRefLines = Array.from({ length: 30 }, () =>
    "  ref: ${{ github.event.pull_request.head.sha }}",
  );
  const findings = await scanWorkflowInjection({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      {
        path: ".github/workflows/first.yml",
        patch: addedPatch(1, ["on:", "  pull_request_target:", "permissions:", "  contents: read", ...manyRefLines]),
      },
      {
        path: ".github/workflows/second.yml",
        patch: addedPatch(1, [
          "on:",
          "  pull_request_target:",
          "permissions:",
          "  contents: read",
          "  ref: ${{ github.event.pull_request.head.sha }}",
        ]),
      },
    ],
  });

  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === ".github/workflows/first.yml"));
});

test("workflowInjection is registered with the expected descriptor shape", () => {
  const descriptor = getAnalyzerDescriptor("workflowInjection");
  assert.ok(descriptor, "workflowInjection descriptor is missing from the registry");
  assert.equal(descriptor!.category, "security");
  assert.equal(descriptor!.cost, "local");
  assert.equal(descriptor!.defaultEnabled, true);
  assert.deepEqual(descriptor!.requires, ["files"]);
  assert.ok(descriptor!.docs.summary.length > 10);
  assert.ok(descriptor!.docs.looksAt.length > 10);
  assert.ok(descriptor!.docs.reports.length > 10);
  assert.ok(descriptor!.docs.network.length > 10);
  assert.ok(ANALYZER_DESCRIPTORS.some((d) => d.name === "workflowInjection"));
});

test("buildBrief skips workflowInjection when no workflow file changed, and runs it when one does", async () => {
  const skipped = await buildBrief({
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "src/index.ts", patch: "@@ -0,0 +1,1 @@\n+export {};" }],
  });
  assert.equal(skipped.analyzerStatus.workflowInjection, "skipped");
  assert.equal(skipped.telemetry.analyzers.workflowInjection?.skipReason, "no_workflow");

  const ran = await buildBrief({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      {
        path: ".github/workflows/ci.yml",
        patch: addedPatch(1, ["on:", "  pull_request_target:"]),
      },
    ],
  });
  assert.equal(ran.analyzerStatus.workflowInjection, "ok");
  assert.deepEqual(ran.findings.workflowInjection, [
    { file: ".github/workflows/ci.yml", line: 2, kind: "missing-permissions" },
  ]);
  assert.match(ran.promptSection, /workflow-injection \/ pwn-request risk/);
});

test("renderBrief renders every workflow-injection finding kind and omits the section when empty", () => {
  const { promptSection } = renderBrief({
    workflowInjection: [
      { file: workflowPath, line: 7, kind: "untrusted-checkout" },
      { file: workflowPath, line: 6, kind: "unsafe-interpolation" },
      { file: workflowPath, line: 2, kind: "missing-permissions" },
    ],
  });
  assert.match(promptSection, /GitHub Actions workflow-injection \/ pwn-request risk/);
  assert.match(promptSection, /checks out the untrusted PR head/);
  assert.match(promptSection, /interpolates an untrusted event field/);
  assert.match(promptSection, /no top-level `permissions:` block/);
  assert.match(promptSection, new RegExp(`${workflowPath.replace(/\./g, "\\.")}:7`));

  const empty = renderBrief({ workflowInjection: [] });
  assert.equal(empty.promptSection, "");
});
