import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWriteRateLimitGovernorLedgerEvent,
  clearWriteRateLimitBackoff,
  evaluateWriteRateLimit,
  recordWriteRateLimitAllowed,
  recordWriteRateLimitDenied,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports write-rate-limit enforcement (#2344)", () => {
  assert.equal(typeof evaluateWriteRateLimit, "function");
  assert.equal(typeof recordWriteRateLimitAllowed, "function");
  assert.equal(typeof buildWriteRateLimitGovernorLedgerEvent, "function");
});

test("evaluateWriteRateLimit: global and per-repo buckets both gate a write", () => {
  const policies = {
    global: { open_pr: { limit: 1, windowMs: 60_000 } },
    perRepo: { open_pr: { limit: 3, windowMs: 60_000 } },
    backoffBaseMs: 50,
  };
  const allowed = evaluateWriteRateLimit({
    actionClass: "open_pr",
    repoFullName: "acme/widgets",
    buckets: { global: {}, perRepo: {} },
    backoffAttempts: {},
    policies,
    nowMs: 1_000,
  });
  assert.equal(allowed.allowed, true);

  const buckets = recordWriteRateLimitAllowed(
    { global: {}, perRepo: {} },
    "open_pr",
    "acme/widgets",
    1_000,
    policies,
  );
  const blocked = evaluateWriteRateLimit({
    actionClass: "open_pr",
    repoFullName: "acme/widgets",
    buckets,
    backoffAttempts: {},
    policies,
    nowMs: 1_100,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, "global");
});

test("REGRESSION (#9999): actionClass is normalized once and looked up own-property across every function", () => {
  // (1) a whitespace-padded actionClass resolves the SAME global/per-repo policy limits as the trimmed form,
  //     instead of falling through both scopes to PERMISSIVE_CONFIG's 1_000_000 ceiling.
  const padded = evaluateWriteRateLimit({ actionClass: " open_pr ", repoFullName: "o/r", buckets: { global: {}, perRepo: {} }, backoffAttempts: {}, nowMs: 0 });
  const trimmed = evaluateWriteRateLimit({ actionClass: "open_pr", repoFullName: "o/r", buckets: { global: {}, perRepo: {} }, backoffAttempts: {}, nowMs: 0 });
  assert.equal(padded.global.limit, 30);
  assert.equal(padded.perRepo.limit, 3);
  assert.equal(padded.global.limit, trimmed.global.limit);
  assert.equal(padded.perRepo.limit, trimmed.perRepo.limit);

  // (2) recordWriteRateLimitAllowed keys the global bucket under the trimmed class, so a later evaluate with
  //     the trimmed class observes the recorded count (a decision and its recorded state hit the same bucket).
  const afterRecord = recordWriteRateLimitAllowed({ global: {}, perRepo: {} }, " open_pr ", "o/r", 0);
  assert.equal(Object.hasOwn(afterRecord.global, "open_pr"), true);
  assert.equal(Object.hasOwn(afterRecord.global, " open_pr "), false);
  const seen = evaluateWriteRateLimit({ actionClass: "open_pr", repoFullName: "o/r", buckets: afterRecord, backoffAttempts: {}, nowMs: 0 });
  assert.equal(seen.global.remaining, 28); // 30 limit, 1 already recorded, this eval consumes one more view → 28

  // (3) an actionClass naming an Object.prototype member resolves the intended fallback (PERMISSIVE_CONFIG +
  //     empty bucket), not an inherited member — today it returns allowed:false with a fabricated limit:0.
  const proto = evaluateWriteRateLimit({ actionClass: "constructor", repoFullName: "o/r", buckets: { global: {}, perRepo: {} }, backoffAttempts: {}, nowMs: 0 });
  assert.equal(proto.allowed, true);
  assert.equal(proto.reason, "under_limit");
  assert.equal(proto.global.limit, 1_000_000);
  assert.equal(proto.perRepo.limit, 1_000_000);

  // (4) recordWriteRateLimitDenied and clearWriteRateLimitBackoff normalize identically, so a backoff recorded
  //     with the padded class is cleared by the trimmed one.
  const backoff = recordWriteRateLimitDenied({}, " open_pr ", "o/r");
  assert.equal(backoff["open_pr:o/r"], 1);
  const cleared = clearWriteRateLimitBackoff(backoff, "open_pr", "o/r");
  assert.equal(Object.hasOwn(cleared, "open_pr:o/r"), false);
});
