import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SENTRY_MONITOR_NAMES,
  SENTRY_OPERATIONAL_SUBSYSTEMS,
  SENTRY_OPERATIONAL_TAG_KEYS,
} from "../../src/selfhost/sentry";

// Drift guard (#1824): self-host Sentry docs must stay aligned with exported taxonomy and runbook signals.

const OPERATIONS = "apps/gittensory-ui/src/routes/docs.self-hosting-operations.tsx";
const operations = readFileSync(OPERATIONS, "utf8");

describe("self-host Sentry observability docs (#1824)", () => {
  it("documents enabling Sentry with an operator-owned DSN", () => {
    expect(operations).toContain("Enabling Sentry (your own DSN)");
    expect(operations).toContain("SENTRY_DSN");
    expect(operations).toContain("opt-in and off by default");
    expect(operations).toContain("SENTRY_DSN_FILE");
  });

  it("documents context taxonomy and cron monitor slugs", () => {
    expect(operations).toContain("Sentry context taxonomy");
    expect(operations).toContain("installation_id_hash");
    for (const monitor of SENTRY_MONITOR_NAMES) {
      expect(operations).toContain(monitor);
    }
    for (const subsystem of Object.keys(SENTRY_OPERATIONAL_SUBSYSTEMS)) {
      expect(operations).toContain(subsystem);
    }
    for (const tag of ["kind", "subsystem", "jobType", "operation"]) {
      expect(SENTRY_OPERATIONAL_TAG_KEYS).toContain(tag);
      expect(operations).toContain(tag);
    }
    expect(operations).toContain("repository");
  });

  it("documents alert classes and runbook first-response checks", () => {
    expect(operations).toContain("Sentry alert classes and runbook");
    expect(operations).toContain("selfhost_job_dead");
    expect(operations).toContain("check_run_post_denied");
    expect(operations).toContain("close_breaker_engaged");
    expect(operations).toContain("orb_broker_unavailable");
    expect(operations).toContain("selfhost_backup_advisory");
    expect(operations).toContain("scheduled-loop");
  });
});
