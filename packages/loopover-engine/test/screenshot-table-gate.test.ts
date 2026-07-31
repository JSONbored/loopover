import { test } from "node:test";
import assert from "node:assert/strict";

import { isScreenshotTableGateInScope, normalizeScreenshotTableGateConfig } from "../dist/review/screenshot-table-gate.js";

// #9996: the invalid-action warning was left naming only "close" or "advisory" after #9964 added the
// non-destructive "block" tier -- an operator who mistyped the value was never told "block" exists.

test("normalizeScreenshotTableGateConfig warns and mentions block for an invalid action", () => {
  const warnings: string[] = [];
  const config = normalizeScreenshotTableGateConfig({ enabled: true, action: "blok" }, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /block/);
  assert.equal(config.action, "close");
});

test("normalizeScreenshotTableGateConfig pushes no action warning when action is absent", () => {
  const warnings: string[] = [];
  const config = normalizeScreenshotTableGateConfig({ enabled: true }, warnings);
  assert.equal(warnings.length, 0);
  assert.equal(config.action, "close");
});

test("normalizeScreenshotTableGateConfig resolves a valid block action with no warning", () => {
  const warnings: string[] = [];
  const config = normalizeScreenshotTableGateConfig({ enabled: true, action: "block" }, warnings);
  assert.equal(warnings.length, 0);
  assert.equal(config.action, "block");
});

// #9993: whenPaths back matchesAnyWithExclusions, whose include half FAILS TOWARD MATCHING for an
// over-complex glob (matchesAny returns true for every path). An unvalidated 3-group glob such as
// `apps/**/src/**/*.tsx` therefore silently put EVERY changed file in scope for a close-tier visual gate.
// whenPaths is now validated with the same hasUnsafeWildcardCount predicate every other manifest glob uses.
test("#9993: a 3-wildcard-group whenPaths glob is dropped, so an unrelated file is no longer in scope", () => {
  const warnings: string[] = [];
  // The over-complex glob alongside a valid one: today the over-complex glob matches README.md (fail-open),
  // putting it in scope. After the fix only the valid glob survives and README.md is out of scope.
  const config = normalizeScreenshotTableGateConfig(
    { enabled: true, whenPaths: ["apps/**/src/**/*.tsx", "apps/ui/src/**"] },
    warnings,
  );
  assert.deepEqual(config.whenPaths, ["apps/ui/src/**"]);
  assert.ok(warnings.some((w) => w.includes("whenPaths[0]")));
  assert.equal(isScreenshotTableGateInScope(config, [], ["README.md"]), false);
  assert.equal(isScreenshotTableGateInScope(config, [], ["apps/ui/src/App.tsx"]), true);
});

test("#9993: an exclusion is judged by its glob BODY, and a bare `!` is dropped", () => {
  const warnings: string[] = [];
  // `!**/*.generated.*` has a 3-group body, so it is dropped (an unvalidated over-complex exclusion compiles
  // to NEVER_MATCHES and excludes nothing). The valid include survives.
  const config = normalizeScreenshotTableGateConfig(
    { enabled: true, whenPaths: ["!**/*.generated.*", "apps/ui/src/**"] },
    warnings,
  );
  assert.deepEqual(config.whenPaths, ["apps/ui/src/**"]);
  assert.ok(warnings.some((w) => w.includes("whenPaths[0]")));

  const bareBang: string[] = [];
  const config2 = normalizeScreenshotTableGateConfig({ enabled: true, whenPaths: ["!"] }, bareBang);
  assert.deepEqual(config2.whenPaths, []);
  assert.ok(bareBang.some((w) => w.includes("whenPaths")));
});

test("#9993: a 2-group whenPaths glob (and a valid exclusion) is preserved unchanged", () => {
  const warnings: string[] = [];
  const config = normalizeScreenshotTableGateConfig(
    { enabled: true, whenPaths: ["apps/ui/public/**/*.json", "!node_modules/**"] },
    warnings,
  );
  assert.deepEqual(config.whenPaths, ["apps/ui/public/**/*.json", "!node_modules/**"]);
  assert.equal(warnings.filter((w) => w.includes("whenPaths")).length, 0);
});
