import { afterEach, describe, expect, it, vi } from "vitest";

import { runAnomalyAlertsWired } from "../../src/review/alerts-wire";
import { runAnomalyAlerts, type AlertAgentConfig, type AnomalyAlertDeps } from "../../src/review/alerts";
import { computeAgentHealth, computeCalibration } from "../../src/review/ops";

vi.mock("../../src/review/alerts", () => ({ runAnomalyAlerts: vi.fn() }));
vi.mock("../../src/review/ops", () => ({ computeAgentHealth: vi.fn(), computeCalibration: vi.fn() }));

const runAnomalyAlertsMock = vi.mocked(runAnomalyAlerts);
const computeAgentHealthMock = vi.mocked(computeAgentHealth);
const computeCalibrationMock = vi.mocked(computeCalibration);

function lastConfig(): AlertAgentConfig {
  return runAnomalyAlertsMock.mock.calls.at(-1)?.[1] as AlertAgentConfig;
}
function lastDeps(): AnomalyAlertDeps {
  return runAnomalyAlertsMock.mock.calls.at(-1)?.[2] as AnomalyAlertDeps;
}

describe("runAnomalyAlertsWired", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("fires runAnomalyAlerts with the configured GITHUB_APP_SLUG and the DISCORD_WEBHOOK_URL secret ref", async () => {
    runAnomalyAlertsMock.mockResolvedValue(undefined);
    const env = { GITHUB_APP_SLUG: "  my-agent  " } as unknown as Env;

    await runAnomalyAlertsWired(env);

    expect(runAnomalyAlertsMock).toHaveBeenCalledTimes(1);
    expect(runAnomalyAlertsMock).toHaveBeenCalledWith(env, expect.anything(), expect.anything());
    expect(lastConfig()).toEqual({
      slug: "my-agent", // trimmed
      features: { discordNotify: true },
      secrets: { discordWebhook: "DISCORD_WEBHOOK_URL" },
    });
  });

  it("falls back to the 'loopover' slug when GITHUB_APP_SLUG is unset", async () => {
    runAnomalyAlertsMock.mockResolvedValue(undefined);
    const env = {} as unknown as Env;

    await runAnomalyAlertsWired(env);

    expect(lastConfig().slug).toBe("loopover");
  });

  it("falls back to 'loopover' when GITHUB_APP_SLUG is blank/whitespace-only", async () => {
    runAnomalyAlertsMock.mockResolvedValue(undefined);
    const env = { GITHUB_APP_SLUG: "   " } as unknown as Env;

    await runAnomalyAlertsWired(env);

    expect(lastConfig().slug).toBe("loopover");
  });

  it("injects health/calibration deps that delegate to the native ops port keyed by the config slug", async () => {
    runAnomalyAlertsMock.mockResolvedValue(undefined);
    const health = { manualRate: 0 } as unknown as Awaited<ReturnType<typeof computeAgentHealth>>;
    const calibration = { currentFloor: 0 } as unknown as Awaited<ReturnType<typeof computeCalibration>>;
    computeAgentHealthMock.mockResolvedValue(health);
    computeCalibrationMock.mockResolvedValue(calibration);
    const env = { GITHUB_APP_SLUG: "agent-x" } as unknown as Env;

    await runAnomalyAlertsWired(env);

    const deps = lastDeps();
    const config = lastConfig();
    await expect(deps.computeAgentHealth(env, config)).resolves.toBe(health);
    await expect(deps.computeCalibration(env, config)).resolves.toBe(calibration);
    expect(computeAgentHealthMock).toHaveBeenCalledWith(env, { slug: "agent-x", secrets: {} });
    expect(computeCalibrationMock).toHaveBeenCalledWith(env, { slug: "agent-x", secrets: {} });
  });

  it("fails safe: swallows a runAnomalyAlerts error and logs a structured wire-error line", async () => {
    runAnomalyAlertsMock.mockRejectedValue(new Error("no such column: project"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    const env = { GITHUB_APP_SLUG: "agent-y" } as unknown as Env;

    await expect(runAnomalyAlertsWired(env)).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    const log = JSON.parse(errors[0] ?? "{}") as Record<string, unknown>;
    expect(log).toMatchObject({ level: "error", event: "anomaly_alert_wire_error" });
    expect(String(log.message)).toContain("no such column: project");
  });
});
