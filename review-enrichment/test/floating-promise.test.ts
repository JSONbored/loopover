// Units for the floating-promise analyzer (#2023). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectFloatingPromise,
  scanFloatingPromise,
  scanPatchForFloatingPromise,
} from "../dist/analyzers/floating-promise.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectFloatingPromise: flags bare promise-shaped calls", () => {
  assert.equal(detectFloatingPromise("loadUserAsync();"), "loadUserAsync");
  assert.equal(detectFloatingPromise("  service.saveAsync(payload);"), "service.saveAsync");
  assert.equal(detectFloatingPromise("fetch('/api/users');"), "fetch");
  assert.equal(detectFloatingPromise("Promise.all(items.map(runAsync));"), "Promise.all");
  assert.equal(detectFloatingPromise("new Promise((resolve) => resolve(1));"), "Promise");
});

test("detectFloatingPromise: does not flag awaited, returned, voided, or chained calls", () => {
  assert.equal(detectFloatingPromise("await loadUserAsync();"), null);
  assert.equal(detectFloatingPromise("return await loadUserAsync();"), null);
  assert.equal(detectFloatingPromise("return loadUserAsync();"), null);
  assert.equal(detectFloatingPromise("void fetch('/health');"), null);
  assert.equal(detectFloatingPromise("fetch('/x').catch(() => {});"), null);
  assert.equal(detectFloatingPromise("fetch('/x').then(handleOk);"), null);
  assert.equal(detectFloatingPromise("fetch('/x').finally(cleanup);"), "fetch");
});

test("detectFloatingPromise: skips assignments, non-promise calls, and comments", () => {
  assert.equal(detectFloatingPromise("const user = loadUserAsync();"), null);
  assert.equal(detectFloatingPromise("console.log('hi');"), null);
  assert.equal(detectFloatingPromise("saveUser(user);"), null);
  assert.equal(detectFloatingPromise("// await loadUserAsync();"), null);
});

test("scanPatchForFloatingPromise: flags added lines with correct locations", () => {
  const findings = scanPatchForFloatingPromise(
    "src/worker.ts",
    patchOf([
      "export function run() {",
      "  syncSetup();",
      "  flushQueueAsync();",
      "}",
    ]),
  );
  assert.deepEqual(findings, [{ file: "src/worker.ts", line: 3, call: "flushQueueAsync" }]);
});

test("scanPatchForFloatingPromise: skips test files and non-JS/TS paths", () => {
  assert.deepEqual(
    scanPatchForFloatingPromise("src/worker.test.ts", patchOf(["loadUserAsync();"])),
    [],
  );
  assert.deepEqual(
    scanPatchForFloatingPromise("lib/worker.py", patchOf(["load_user_async()"])),
    [],
  );
});

test("scanPatchForFloatingPromise: respects the findings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `task${i}Async();`);
  assert.equal(scanPatchForFloatingPromise("src/a.ts", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanFloatingPromise: aggregates across files and renders in the brief", async () => {
  const findings = await scanFloatingPromise({
    files: [
      { path: "src/a.ts", patch: patchOf(["fetch('/api');"]) },
      { path: "src/b.ts", patch: patchOf(["syncJobAsync();"]) },
    ],
  });
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, call: "fetch" },
    { file: "src/b.ts", line: 1, call: "syncJobAsync" },
  ]);

  const { promptSection } = renderBrief({ floatingPromise: findings });
  assert.match(promptSection, /Floating promises/);
  assert.match(promptSection, /src\/a\.ts:1/);
  assert.match(promptSection, /src\/b\.ts:1/);
});
