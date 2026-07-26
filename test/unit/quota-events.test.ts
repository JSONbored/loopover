import { describe, expect, it } from "vitest";

import {
  buildTenantQuotaWarningEvent,
  buildTenantQuotaWarningNotification,
  parseTenantQuotaWarningDedupKey,
  quotaWarningEventsForActor,
} from "../../src/notifications/quota-events";

describe("quota notification events (#7662)", () => {
  it("builds public-safe copy for each dimension label", () => {
    expect(buildTenantQuotaWarningNotification({ warning: { dimension: "compute", severity: "low", remaining: 5, cap: 100 } }).body).toContain(
      "compute units",
    );
    expect(buildTenantQuotaWarningNotification({ warning: { dimension: "time", severity: "critical", remaining: 1, cap: 10 } }).title).toContain(
      "critically low",
    );
    expect(buildTenantQuotaWarningNotification({ warning: { dimension: "concurrency", severity: "low", remaining: 1, cap: 3 } }).body).toContain(
      "concurrent loops",
    );
  });

  it("embeds warning figures in the dedupKey and round-trips through the parser", () => {
    const event = buildTenantQuotaWarningEvent({
      recipientLogin: "Miner",
      warning: { dimension: "compute", severity: "low", remaining: 15, cap: 100 },
      detectedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(event.recipientLogin).toBe("miner");
    expect(parseTenantQuotaWarningDedupKey(event.dedupKey)).toEqual({
      dimension: "compute",
      severity: "low",
      remaining: 15,
      cap: 100,
    });
    expect(parseTenantQuotaWarningDedupKey("tenant_quota_warning:bad")).toBeNull();
    expect(parseTenantQuotaWarningDedupKey("tenant_quota_warning:miner:bad:low:1:2")).toBeNull();
    expect(parseTenantQuotaWarningDedupKey("tenant_quota_warning:miner:compute:urgent:1:2")).toBeNull();
    expect(parseTenantQuotaWarningDedupKey("tenant_quota_warning:miner:compute:low:NaN:2")).toBeNull();
  });

  it("fans out one event per warning", () => {
    const events = quotaWarningEventsForActor("miner", [
      { dimension: "compute", severity: "low", remaining: 15, cap: 100 },
      { dimension: "time", severity: "critical", remaining: 1000, cap: 60_000 },
    ]);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.eventType === "tenant_quota_warning")).toBe(true);
  });
});
