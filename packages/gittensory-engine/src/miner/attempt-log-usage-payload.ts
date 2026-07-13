// Bounded attempt-log payload fields extracted into AMS reporting exports (#5185). Free-form payload_json is
// dropped from Grafana-facing snapshots; these keys are the only driver-usage signals operators need.

import type { AttemptMeterTotals } from "./attempt-metering.js";

export function buildAttemptLogDriverUsagePayload(input: {
  driverProvider?: string | undefined;
  meterTotals?: AttemptMeterTotals | undefined;
  includeMetering?: boolean | undefined;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.driverProvider !== undefined && input.driverProvider !== "") {
    payload.driverProvider = input.driverProvider;
  }
  if (input.includeMetering && input.meterTotals !== undefined) {
    payload.turnsUsed = input.meterTotals.turns;
    payload.tokensUsed = input.meterTotals.tokens;
    payload.costUsd = input.meterTotals.costUsd;
  }
  return payload;
}
