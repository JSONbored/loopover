// Contract tests for the in-memory fake settlement backend (#7572): balances move with fund/record/reverse,
// per-event idempotency holds on both the record and reverse sides, and every step is logged in call order.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeSettlementBackendDriver,
  type PayoutEligibleEvent,
} from "../dist/index.js";

const eventFor = (overrides: Partial<PayoutEligibleEvent> = {}): PayoutEligibleEvent => ({
  poolId: "pool-1",
  repoFullName: "acme/widgets",
  prNumber: 42,
  gittensorContributor: "dev",
  amount: 100,
  ...overrides,
});

test("fundPool credits a pool; an unfunded pool reads as 0", async () => {
  const driver = createFakeSettlementBackendDriver();
  assert.equal(await driver.getPoolBalance("pool-1"), 0);

  await driver.fundPool("pool-1", 500);
  assert.equal(await driver.getPoolBalance("pool-1"), 500);
  // Funding again accumulates rather than replaces.
  await driver.fundPool("pool-1", 250);
  assert.equal(await driver.getPoolBalance("pool-1"), 750);
});

test("recordPayoutEligibleEvent decrements the pool balance and records the event", async () => {
  const driver = createFakeSettlementBackendDriver();
  await driver.fundPool("pool-1", 500);

  await driver.recordPayoutEligibleEvent(eventFor({ amount: 100 }));
  assert.equal(await driver.getPoolBalance("pool-1"), 400);
  assert.ok(driver.settledEventKeys.has("pool-1|acme/widgets|42|dev"));
});

test("recordPayoutEligibleEvent is idempotent — a redelivered event never double-decrements", async () => {
  const driver = createFakeSettlementBackendDriver();
  await driver.fundPool("pool-1", 500);

  const event = eventFor({ amount: 100 });
  await driver.recordPayoutEligibleEvent(event);
  // else-branch: same key already settled — no second decrement.
  await driver.recordPayoutEligibleEvent(event);
  assert.equal(await driver.getPoolBalance("pool-1"), 400);
  assert.equal(driver.settledEventKeys.size, 1);
});

test("reversePayout credits the amount back and clears the settled event", async () => {
  const driver = createFakeSettlementBackendDriver();
  await driver.fundPool("pool-1", 500);
  const event = eventFor({ amount: 100 });

  await driver.recordPayoutEligibleEvent(event);
  await driver.reversePayout(event, "dispute");
  assert.equal(await driver.getPoolBalance("pool-1"), 500);
  assert.equal(driver.settledEventKeys.has("pool-1|acme/widgets|42|dev"), false);
});

test("reversePayout is an idempotent no-op for an unrecorded or already-reversed event", async () => {
  const driver = createFakeSettlementBackendDriver();
  await driver.fundPool("pool-1", 500);
  const event = eventFor({ amount: 100 });

  // Never recorded → else-branch no-op, balance untouched, no throw.
  await driver.reversePayout(event, "refund");
  assert.equal(await driver.getPoolBalance("pool-1"), 500);

  await driver.recordPayoutEligibleEvent(event);
  await driver.reversePayout(event, "partial_completion");
  // Second reversal: already reversed → else-branch no-op, does not credit twice.
  await driver.reversePayout(event, "partial_completion");
  assert.equal(await driver.getPoolBalance("pool-1"), 500);
});

test("distinct events (different PR/contributor) settle independently against the same pool", async () => {
  const driver = createFakeSettlementBackendDriver();
  await driver.fundPool("pool-1", 500);

  await driver.recordPayoutEligibleEvent(eventFor({ prNumber: 1, gittensorContributor: "alice", amount: 100 }));
  await driver.recordPayoutEligibleEvent(eventFor({ prNumber: 2, gittensorContributor: "bob", amount: 150 }));
  assert.equal(await driver.getPoolBalance("pool-1"), 250);
  assert.equal(driver.settledEventKeys.size, 2);
});

test("every step is recorded in call order for white-box assertions", async () => {
  const driver = createFakeSettlementBackendDriver();
  const event = eventFor({ amount: 100 });
  await driver.fundPool("pool-1", 500);
  await driver.recordPayoutEligibleEvent(event);
  await driver.reversePayout(event, "refund");

  assert.deepEqual(
    driver.calls.map((call) => call.step),
    ["fundPool", "recordPayoutEligibleEvent", "reversePayout"],
  );
  assert.deepEqual(driver.calls[0], { step: "fundPool", poolId: "pool-1", amount: 500 });
});

test("record -> reverse -> record: a redelivery after a reversal is a no-op, never a second debit", async () => {
  const driver = createFakeSettlementBackendDriver();
  const event = eventFor({ amount: 100 });
  await driver.fundPool("pool-1", 500);

  await driver.recordPayoutEligibleEvent(event); // balance 400
  await driver.reversePayout(event, "refund"); // balance 500
  // The event was ever-recorded, so a redelivered webhook must not re-decrement the pool.
  await driver.recordPayoutEligibleEvent(event);
  assert.equal(await driver.getPoolBalance("pool-1"), 500);

  // The public balances view mirrors what getPoolBalance reports.
  assert.equal(driver.balances.get("pool-1"), 500);
  // Every invocation is still logged, including the no-op redelivery.
  assert.deepEqual(
    driver.calls.map((c) => c.step),
    ["fundPool", "recordPayoutEligibleEvent", "reversePayout", "recordPayoutEligibleEvent"],
  );
});

test("reversePayout credits back the recorded amount, not the amount on the reversal call", async () => {
  const driver = createFakeSettlementBackendDriver();
  await driver.fundPool("pool-1", 500);

  await driver.recordPayoutEligibleEvent(eventFor({ amount: 100 }));
  assert.equal(await driver.getPoolBalance("pool-1"), 400);

  // Same event key (amount is deliberately not part of it) but a wildly different amount: the credit must be
  // the 100 that was actually decremented, restoring exactly the pre-record balance — not pre + 1,000,000.
  await driver.reversePayout(eventFor({ amount: 1_000_000 }), "refund");
  assert.equal(await driver.getPoolBalance("pool-1"), 500);

  // The call log still records the reversal's amount exactly as passed by the caller.
  assert.deepEqual(driver.calls.at(-1), { step: "reversePayout", poolId: "pool-1", amount: 1_000_000 });
});

test("recordPayoutEligibleEvent on a reversed event does not re-add its key to settledEventKeys", async () => {
  const driver = createFakeSettlementBackendDriver();
  const event = eventFor({ amount: 100 });
  await driver.fundPool("pool-1", 500);

  await driver.recordPayoutEligibleEvent(event);
  await driver.reversePayout(event, "dispute");
  await driver.recordPayoutEligibleEvent(event);
  assert.equal(driver.settledEventKeys.has("pool-1|acme/widgets|42|dev"), false);
  assert.equal(driver.settledEventKeys.size, 0);
});

test("recordPayoutEligibleEvent on a never-funded pool decrements from the 0 an unfunded pool reads as", async () => {
  const driver = createFakeSettlementBackendDriver();

  await driver.recordPayoutEligibleEvent(eventFor({ amount: 100 }));
  assert.equal(await driver.getPoolBalance("pool-1"), -100);
  assert.ok(driver.settledEventKeys.has("pool-1|acme/widgets|42|dev"));
});
