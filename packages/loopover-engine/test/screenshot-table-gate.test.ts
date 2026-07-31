import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeScreenshotTableGateConfig } from "../dist/review/screenshot-table-gate.js";

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
