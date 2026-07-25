import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { POSTHOG_MONITOR_HEARTBEAT_EVENT } from "../../src/selfhost/posthog";

// Drift guard (#8287): self-host PostHog docs must stay aligned with the exported monitor-heartbeat event
// name, mirroring docs-selfhost-sentry-observability.test.ts's identical discipline for Sentry.

const OPERATIONS = "apps/loopover-ui/content/docs/self-hosting-operations.mdx";
const operations = readFileSync(OPERATIONS, "utf8");

describe("self-host PostHog observability docs (#8287)", () => {
  it("documents enabling PostHog as opt-in and parallel-run alongside Sentry", () => {
    expect(operations).toContain("Enabling PostHog error tracking");
    expect(operations).toContain("POSTHOG_API_KEY");
    expect(operations).toContain("opt-in and off by default");
    expect(operations).toContain("parallel with Sentry");
  });

  it("documents the shared redaction module both sinks use", () => {
    expect(operations).toContain("redaction-scrub.ts");
  });

  it("documents exception autocapture", () => {
    expect(operations).toContain("exception autocapture");
  });

  it("documents the cron-monitor heartbeat replacement with the real exported event name", () => {
    expect(operations).toContain("Cron Monitors");
    expect(operations).toContain(POSTHOG_MONITOR_HEARTBEAT_EVENT);
    for (const monitor of ["scheduled-loop", "orb-export", "orb-relay-drain", "orb-relay-register", "queue-dead-letter-revive"]) {
      expect(operations).toContain(monitor);
    }
  });
});
