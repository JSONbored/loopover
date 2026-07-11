import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWriteRateLimitGovernorLedgerEvent,
  evaluateWriteRateLimit,
  recordWriteRateLimitAllowed,
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
