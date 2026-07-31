import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { POSTHOG_AI_DEGRADED_EVENT, POSTHOG_MONITOR_HEARTBEAT_EVENT } from "../../src/selfhost/posthog";

// Drift guard (#8287, #1468 -- 2026-07-25 Sentry removal): self-host PostHog docs must stay aligned with the
// exported monitor-heartbeat event name. Sentry's own docs test (docs-selfhost-sentry-observability.test.ts)
// was deleted alongside src/selfhost/sentry.ts -- PostHog is this surface's only error-tracking sink now.

const OPERATIONS = "apps/loopover-ui/content/docs/self-hosting-operations.mdx";
const operations = readFileSync(OPERATIONS, "utf8");

describe("self-host PostHog observability docs (#8287)", () => {
  it("documents enabling PostHog as opt-in and REPLACING Sentry", () => {
    expect(operations).toContain("Enabling PostHog error tracking");
    expect(operations).toContain("POSTHOG_API_KEY");
    expect(operations).toContain("opt-in and off by default");
    expect(operations).toContain("replaces Sentry");
  });

  it("documents the shared redaction module both sinks use", () => {
    expect(operations).toContain("redaction-scrub.ts");
  });

  it("documents exception autocapture", () => {
    expect(operations).toContain("exception autocapture");
  });

  it("documents the degraded-request event with its real exported name and both reasons (#10186)", () => {
    // Same drift guard as the heartbeat below: an operator reading this page must be able to search
    // PostHog for the exact event name the code emits.
    expect(operations).toContain(POSTHOG_AI_DEGRADED_EVENT);
    for (const reason of ["circuit_open", "chain_exhausted"]) {
      expect(operations).toContain(reason);
    }
  });

  it("documents that $ai_model is the resolved model on the failure path too (#10186)", () => {
    expect(operations).toContain("Model labelling");
    expect(operations).toContain("<provider>-default");
  });

  it("documents the cron-monitor heartbeat replacement with the real exported event name", () => {
    expect(operations).toContain("Cron Monitors");
    expect(operations).toContain(POSTHOG_MONITOR_HEARTBEAT_EVENT);
    for (const monitor of ["scheduled-loop", "orb-export", "orb-relay-drain", "orb-relay-register", "queue-dead-letter-revive"]) {
      expect(operations).toContain(monitor);
    }
  });
});
