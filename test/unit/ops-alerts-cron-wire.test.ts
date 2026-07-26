import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../../src/queue/job-dispatch";
import { isOpsEnabled, runOpsAlerts } from "../../src/review/ops-wire";
import { runAnomalyAlerts } from "../../src/review/alerts";
import type { JobMessage } from "../../src/types";

vi.mock("../../src/review/ops-wire", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/review/ops-wire")>();
  return {
    ...actual,
    runOpsAlerts: vi.fn().mockResolvedValue({}),
    isOpsEnabled: vi.fn().mockReturnValue(true),
    resolveOpsManifestOverride: vi.fn().mockResolvedValue(null),
  };
});
// Mock only the leaf alerter (the real alerts-wire adapter still runs, so its config/dep wiring is exercised
// end-to-end) — its D1 throttle-claim writes are what we do NOT want to hit here.
vi.mock("../../src/review/alerts", () => ({ runAnomalyAlerts: vi.fn().mockResolvedValue(undefined) }));

const runOpsAlertsMock = vi.mocked(runOpsAlerts);
const runAnomalyAlertsMock = vi.mocked(runAnomalyAlerts);
const isOpsEnabledMock = vi.mocked(isOpsEnabled);

const opsAlertsJob = { type: "ops-alerts", requestedBy: "schedule" } as unknown as JobMessage;

describe("processJob ops-alerts cron wiring (#8905)", () => {
  beforeEach(() => {
    isOpsEnabledMock.mockReturnValue(true);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fires BOTH runOpsAlerts (PagerDuty/log) and runAnomalyAlerts (Discord) on the enabled cron tick", async () => {
    const env = { GITHUB_APP_SLUG: "loopover" } as unknown as Env;

    await processJob(env, opsAlertsJob);

    expect(runOpsAlertsMock).toHaveBeenCalledTimes(1);
    expect(runOpsAlertsMock).toHaveBeenCalledWith(env);
    // The Discord channel fires through the real alerts-wire adapter on the same tick.
    expect(runAnomalyAlertsMock).toHaveBeenCalledTimes(1);
    expect(runAnomalyAlertsMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ slug: "loopover", features: { discordNotify: true } }),
      expect.objectContaining({ computeAgentHealth: expect.any(Function), computeCalibration: expect.any(Function) }),
    );
  });

  it("does NEITHER when ops is disabled (a stale in-flight job after a flag-flip no-ops)", async () => {
    isOpsEnabledMock.mockReturnValue(false);
    const env = {} as unknown as Env;

    await processJob(env, opsAlertsJob);

    expect(runOpsAlertsMock).not.toHaveBeenCalled();
    expect(runAnomalyAlertsMock).not.toHaveBeenCalled();
  });
});
