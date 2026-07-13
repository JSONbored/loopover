import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttemptLogDriverUsagePayload } from "../dist/miner/attempt-log-usage-payload.js";

test("buildAttemptLogDriverUsagePayload stamps driverProvider only when present", () => {
  assert.deepEqual(buildAttemptLogDriverUsagePayload({}), {});
  assert.deepEqual(buildAttemptLogDriverUsagePayload({ driverProvider: "" }), {});
  assert.deepEqual(buildAttemptLogDriverUsagePayload({ driverProvider: "claude-cli" }), {
    driverProvider: "claude-cli",
  });
});

test("buildAttemptLogDriverUsagePayload includes metering only when requested", () => {
  assert.deepEqual(
    buildAttemptLogDriverUsagePayload({
      driverProvider: "agent-sdk",
      meterTotals: { tokens: 0, turns: 3, wallClockMs: 100, costUsd: 0.12 },
      includeMetering: true,
    }),
    { driverProvider: "agent-sdk", turnsUsed: 3, tokensUsed: 0, costUsd: 0.12 },
  );
  assert.deepEqual(
    buildAttemptLogDriverUsagePayload({
      meterTotals: { tokens: 1, turns: 2, wallClockMs: 50, costUsd: 0.5 },
      includeMetering: false,
    }),
    {},
  );
});
