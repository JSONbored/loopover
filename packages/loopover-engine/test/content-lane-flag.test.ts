import { test } from "node:test";
import assert from "node:assert/strict";

import { isContentLaneEnabled, isSurfaceVerificationEnabled } from "../dist/review/content-lane/flag.js";

test("isContentLaneEnabled is OFF by default (unset / empty / undefined env)", () => {
  assert.equal(isContentLaneEnabled(undefined), false);
  assert.equal(isContentLaneEnabled(null), false);
  assert.equal(isContentLaneEnabled({}), false);
  assert.equal(isContentLaneEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: "" }), false);
});

test("isContentLaneEnabled is ON for recognized truthy values (case/whitespace insensitive)", () => {
  for (const v of ["1", "true", "on", "yes", "TRUE", " On ", "Yes"]) {
    assert.equal(isContentLaneEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: v }), true);
  }
});

test("isContentLaneEnabled is OFF for non-truthy strings", () => {
  for (const v of ["0", "false", "off", "no", "enabled", "maybe"]) {
    assert.equal(isContentLaneEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: v }), false);
  }
});

// #8908/#8909: live surface verification is its OWN flag, independent of the lane's, so the first
// outbound-probe behavior in this lane can be rolled back without taking the whole lane down.
test("isSurfaceVerificationEnabled is OFF by default (unset / empty / undefined env)", () => {
  assert.equal(isSurfaceVerificationEnabled(undefined), false);
  assert.equal(isSurfaceVerificationEnabled(null), false);
  assert.equal(isSurfaceVerificationEnabled({}), false);
  assert.equal(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: "" }), false);
});

test("isSurfaceVerificationEnabled is ON for recognized truthy values (case/whitespace insensitive)", () => {
  for (const v of ["1", "true", "on", "yes", "TRUE", " On ", "Yes"]) {
    assert.equal(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: v }), true);
  }
});

test("isSurfaceVerificationEnabled is OFF for non-truthy strings", () => {
  for (const v of ["0", "false", "off", "no", "enabled", "maybe"]) {
    assert.equal(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: v }), false);
  }
});

test("isSurfaceVerificationEnabled is independent of the content-lane flag in BOTH directions", () => {
  assert.equal(isSurfaceVerificationEnabled({ LOOPOVER_REVIEW_CONTENT_LANE: "true" }), false);
  assert.equal(isContentLaneEnabled({ LOOPOVER_REVIEW_SURFACE_VERIFICATION: "true" }), false);
});
