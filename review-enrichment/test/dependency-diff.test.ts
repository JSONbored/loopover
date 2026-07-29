// Units for the dependency-diff analyzer (#2020). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDependencyInventoryChanges,
  extractDependencyChanges,
} from "../dist/analyzers/dependency-scan.js";
import {
  scanDependencyDiff,
  scanDependencyDiffInventory,
} from "../dist/analyzers/dependency-diff.js";
import { renderBrief } from "../dist/render.js";

const npmPatch = (lines: string[]) =>
  [`@@ -1,3 +1,3 @@`, ...lines.map((l) => (l.startsWith("+") || l.startsWith("-") ? l : ` ${l}`))].join(
    "\n",
  );

test("extractDependencyInventoryChanges: reports npm add, remove, and change", () => {
  const files = [
    {
      path: "package.json",
      patch: npmPatch(['-"lodash": "4.17.20",', '+"lodash": "4.17.21",', '+"axios": "1.6.0",', '-"left-pad": "1.0.0",']),
    },
  ];
  assert.deepEqual(extractDependencyInventoryChanges(files), [
    {
      ecosystem: "npm",
      package: "lodash",
      from: "4.17.20",
      to: "4.17.21",
      direction: "change",
    },
    { ecosystem: "npm", package: "axios", from: null, to: "1.6.0", direction: "add" },
    { ecosystem: "npm", package: "left-pad", from: "1.0.0", to: null, direction: "remove" },
  ]);
  assert.deepEqual(extractDependencyChanges(files), [
    {
      ecosystem: "npm",
      package: "lodash",
      from: "4.17.20",
      to: "4.17.21",
    },
    { ecosystem: "npm", package: "axios", from: null, to: "1.6.0" },
  ]);
});

test("extractDependencyInventoryChanges: reports PyPI requirements.txt changes", () => {
  const files = [
    {
      path: "requirements.txt",
      patch: ["@@ -1,2 +1,2 @@", "-requests==2.31.0", "+requests==2.32.0"].join("\n"),
    },
  ];
  assert.deepEqual(extractDependencyInventoryChanges(files), [
    {
      ecosystem: "PyPI",
      package: "requests",
      from: "2.31.0",
      to: "2.32.0",
      direction: "change",
    },
  ]);
});

test("extractDependencyInventoryChanges: respects the findings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => [`+"pkg${i}": "1.0.0",`]).flat();
  const files = [{ path: "package.json", patch: npmPatch(lines) }];
  assert.equal(extractDependencyInventoryChanges(files, {}, 3).length, 3);
});

test("extractDependencyInventoryChanges: keeps add/remove separate across manifest files", () => {
  const files = [
    {
      path: "apps/a/package.json",
      patch: npmPatch(['-"axios": "1.6.0",']),
    },
    {
      path: "apps/b/package.json",
      patch: npmPatch(['+"axios": "1.6.0",']),
    },
  ];
  assert.deepEqual(extractDependencyInventoryChanges(files), [
    { ecosystem: "npm", package: "axios", from: "1.6.0", to: null, direction: "remove" },
    { ecosystem: "npm", package: "axios", from: null, to: "1.6.0", direction: "add" },
  ]);
});

test("scanDependencyDiffInventory: renders a public-safe brief", async () => {
  const findings = await scanDependencyDiffInventory({
    files: [
      {
        path: "package.json",
        patch: npmPatch(['+"axios": "1.6.0",']),
      },
    ],
  });
  assert.deepEqual(findings, [
    { ecosystem: "npm", package: "axios", from: null, to: "1.6.0", direction: "add" },
  ]);
  const { promptSection } = renderBrief({ dependencyDiff: findings });
  assert.match(promptSection, /Dependency inventory changes/);
  assert.match(promptSection, /axios/);
});
