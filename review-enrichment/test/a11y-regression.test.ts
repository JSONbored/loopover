// Units for the accessibility-regression analyzer (#2026). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectA11yIssues,
  scanPatchForA11y,
  scanA11y,
} from "../dist/analyzers/a11y-regression.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

// --- detectA11yIssues (pure per-tag rule unit) ---

test("detectA11yIssues: flags <img> without alt", () => {
  assert.deepEqual(detectA11yIssues("img", ' src="x.png"'), ["img-alt"]);
});

test("detectA11yIssues: does not flag <img> with alt", () => {
  assert.deepEqual(detectA11yIssues("img", ' src="x.png" alt="a cat"'), []);
});

test("detectA11yIssues: flags onClick on a non-interactive element with no keyboard handler or role", () => {
  assert.deepEqual(detectA11yIssues("div", ' onClick={handleClick}'), [
    "click-events-have-key-events",
  ]);
});

test("detectA11yIssues: does not flag onClick when a keyboard handler is present", () => {
  assert.deepEqual(
    detectA11yIssues("div", ' onClick={handleClick} onKeyDown={handleKey}'),
    [],
  );
});

test("detectA11yIssues: onKeyPress alone does NOT satisfy the keyboard-accessible check (deprecated event)", () => {
  assert.deepEqual(
    detectA11yIssues("div", ' onClick={handleClick} onKeyPress={handleKey}'),
    ["click-events-have-key-events"],
  );
});

test("detectA11yIssues: does not flag onClick when a role is present", () => {
  assert.deepEqual(detectA11yIssues("span", ' onClick={handleClick} role="button"'), []);
});

test("detectA11yIssues: does not flag onClick on an inherently interactive element", () => {
  assert.deepEqual(detectA11yIssues("button", ' onClick={handleClick}'), []);
});

test("detectA11yIssues: flags a form control with no label association", () => {
  assert.deepEqual(detectA11yIssues("input", ' type="text"'), ["label-control"]);
});

test("detectA11yIssues: does not flag a form control with an id", () => {
  assert.deepEqual(detectA11yIssues("input", ' type="text" id="name"'), []);
});

test("detectA11yIssues: does not flag a form control with aria-label", () => {
  assert.deepEqual(detectA11yIssues("textarea", ' aria-label="Comments"'), []);
});

test("detectA11yIssues: does not flag labelless input types", () => {
  assert.deepEqual(detectA11yIssues("input", ' type="hidden" value="1"'), []);
  assert.deepEqual(detectA11yIssues("input", ' type="submit" value="Go"'), []);
});

test("detectA11yIssues: flags a positive tabindex", () => {
  assert.deepEqual(detectA11yIssues("div", ' tabIndex={2}'), ["positive-tabindex"]);
  assert.deepEqual(detectA11yIssues("div", ' tabindex="1"'), ["positive-tabindex"]);
});

test("detectA11yIssues: does not flag tabindex 0 or -1", () => {
  assert.deepEqual(detectA11yIssues("div", ' tabIndex={0}'), []);
  assert.deepEqual(detectA11yIssues("div", ' tabindex="-1"'), []);
});

test("detectA11yIssues: a single tag can trip more than one rule", () => {
  assert.deepEqual(
    detectA11yIssues("div", ' onClick={go} tabIndex={3}'),
    ["click-events-have-key-events", "positive-tabindex"],
  );
});

// --- scanPatchForA11y (diff-line scanning) ---

test("scanPatchForA11y: reports file/line for a flagged tag", () => {
  const patch = patchOf(['<img src="x.png" />']);
  assert.deepEqual(scanPatchForA11y("src/Widget.tsx", patch), [
    { file: "src/Widget.tsx", line: 1, rule: "img-alt" },
  ]);
});

test("scanPatchForA11y: a compliant element yields no findings", () => {
  const patch = patchOf(['<img src="x.png" alt="a cat" />']);
  assert.deepEqual(scanPatchForA11y("src/Widget.tsx", patch), []);
});

test("scanPatchForA11y: skips non-markup file extensions", () => {
  const patch = patchOf(['<img src="x.png" />']);
  assert.deepEqual(scanPatchForA11y("src/widget.ts", patch), []);
});

test("scanPatchForA11y: skips test paths even for markup extensions", () => {
  const patch = patchOf(['<img src="x.png" />']);
  assert.deepEqual(scanPatchForA11y("src/Widget.test.tsx", patch), []);
});

test("scanPatchForA11y: skips commented-out markup", () => {
  const patch = patchOf(['{/* <img src="x.png" /> */}']);
  assert.deepEqual(scanPatchForA11y("src/Widget.jsx", patch), []);
});

test("scanPatchForA11y: respects the maxFindings cap", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `<img src="${i}.png" />`);
  const patch = patchOf(lines);
  assert.equal(scanPatchForA11y("src/Widget.tsx", patch, { maxFindings: 2 }).length, 2);
});

test("scanPatchForA11y: line numbers advance correctly across a hunk", () => {
  const patch = [
    "@@ -1,2 +1,3 @@",
    " <div>",
    '+  <img src="x.png" />',
    " </div>",
  ].join("\n");
  assert.deepEqual(scanPatchForA11y("src/Widget.html", patch), [
    { file: "src/Widget.html", line: 2, rule: "img-alt" },
  ]);
});

test("scanPatchForA11y: abort signal stops scanning", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      scanPatchForA11y("src/Widget.tsx", patchOf(['<img src="x.png" />']), {
        signal: controller.signal,
      }),
    /analyzer_aborted/,
  );
});

// --- scanA11y (analyzer entrypoint) ---

test("scanA11y: aggregates findings across files and respects the global cap", async () => {
  const patch = patchOf(['<img src="x.png" />']);
  const findings = await scanA11y({
    files: Array.from({ length: 30 }, (_, i) => ({ path: `src/W${i}.tsx`, patch })),
  });
  assert.equal(findings.length, 25);
});

test("scanA11y: renders a public-safe brief", async () => {
  const findings = await scanA11y({
    files: [{ path: "src/Widget.tsx", patch: patchOf(['<img src="x.png" />']) }],
  });
  assert.equal(findings[0]?.rule, "img-alt");
  const { promptSection } = renderBrief({ a11y: findings });
  assert.match(promptSection, /Accessibility regressions/);
  assert.match(promptSection, /src\/Widget\.tsx:1/);
});

test("scanA11y: no files yields no findings", async () => {
  assert.deepEqual(await scanA11y({}), []);
});

test("scanA11y: abort signal stops the analyzer entrypoint", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      scanA11y(
        { files: [{ path: "src/Widget.tsx", patch: patchOf(['<img src="x.png" />']) }] },
        controller.signal,
      ),
    /analyzer_aborted/,
  );
});
