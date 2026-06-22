import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentHealth,
  type AlertAgentConfig,
  type AnomalyAlertDeps,
  type Calibration,
  detectAnomalies,
  runAnomalyAlerts,
} from "../../src/review/alerts";

const healthy: AgentHealth = {
  byStatus: {},
  byVerdict: {},
  terminalCount: 50,
  nonTerminal: 0,
  manualRate: 0.1,
  stuckRetryable: 0,
  failed: 0,
  dlqCount: 0,
  reversals: 0,
  reversalRate: 0,
  configIssues: [],
};

describe("detectAnomalies", () => {
  it("returns nothing for a healthy snapshot", () => {
    expect(detectAnomalies(healthy)).toEqual([]);
  });
  it("flags config issues, failures, manual-rate spikes, and stuck targets", () => {
    expect(detectAnomalies({ ...healthy, configIssues: ["bad slug"] })[0]).toMatch(/config invariant/);
    expect(detectAnomalies({ ...healthy, failed: 2 })[0]).toMatch(/permanently failed/);
    expect(detectAnomalies({ ...healthy, manualRate: 0.8 })[0]).toMatch(/manual-rate 80%/);
    expect(detectAnomalies({ ...healthy, stuckRetryable: 7 })[0]).toMatch(/stuck in error_retryable/);
  });
  it("does NOT flag a high manual-rate on too few decisions", () => {
    expect(detectAnomalies({ ...healthy, terminalCount: 4, manualRate: 1 })).toEqual([]);
  });
  it("flags a DLQ SPIKE (≥3) and names the dropped PRs, but stays quiet below threshold", () => {
    expect(detectAnomalies({ ...healthy, dlqCount: 2 }).some((a) => /DEAD-LETTERED/.test(a))).toBe(false);
    const out = detectAnomalies({
      ...healthy,
      dlqCount: 54,
      dlqTargets: [{ number: 4011, repo: "JSONbored/awesome-claude", verdict: null, lastError: "ai_quota_exhausted" }],
    });
    const line = out.find((a) => /DEAD-LETTERED/.test(a)) ?? "";
    expect(line).toMatch(/54 review/);
    expect(line).toContain("[#4011](https://github.com/JSONbored/awesome-claude/pull/4011)");
    expect(line).toContain("ai_quota_exhausted");
  });
  it("flags CALIBRATION DRIFT when a human-reverted auto-merge cleared the floor", () => {
    const cal: Calibration = { currentFloor: 0.9, mergedCount: 50, revertedCount: 2, keptAvgConfidence: 0.95, revertedMaxConfidence: 0.93, recommendedFloor: 0.95, note: "raise", closesByReason: [], disputedCloseCount: 0 };
    const out = detectAnomalies(healthy, cal);
    expect(out.some((a) => /calibration drift/.test(a) && /raising confidenceFloor to 0\.95/.test(a) && /93%/.test(a))).toBe(true);
  });
  it("no calibration-drift line when the recommender suggests no change", () => {
    const cal: Calibration = { currentFloor: 0.9, mergedCount: 50, revertedCount: 0, keptAvgConfidence: 0.95, revertedMaxConfidence: null, recommendedFloor: null, note: "adequate", closesByReason: [], disputedCloseCount: 0 };
    expect(detectAnomalies(healthy, cal).some((a) => /calibration drift/.test(a))).toBe(false);
  });
  it("flags DISPUTED CLOSES by reasonCode", () => {
    const cal: Calibration = {
      currentFloor: 0.9, mergedCount: 50, revertedCount: 0, keptAvgConfidence: 0.95, revertedMaxConfidence: null, recommendedFloor: null, note: "adequate",
      closesByReason: [
        { reasonCode: "source_unfetchable", closes: 20, disputed: 3 },
        { reasonCode: "dual_review_declined", closes: 109, disputed: 1 },
        { reasonCode: "strict_duplicate", closes: 19, disputed: 0 },
      ],
      disputedCloseCount: 4,
    };
    const line = detectAnomalies(healthy, cal).find((a) => /disputed closes/.test(a));
    expect(line).toBeDefined();
    expect(line).toMatch(/4 bot-close/);
    expect(line).toMatch(/source_unfetchable \(3\/20\)/); // top disputed reason first
  });
  it("no disputed-closes line when nothing was reopened-and-not-remerged", () => {
    const cal: Calibration = { currentFloor: 0.9, mergedCount: 50, revertedCount: 0, keptAvgConfidence: 0.95, revertedMaxConfidence: null, recommendedFloor: null, note: "adequate", closesByReason: [{ reasonCode: "checks_failed", closes: 43, disputed: 0 }], disputedCloseCount: 0 };
    expect(detectAnomalies(healthy, cal).some((a) => /disputed closes/.test(a))).toBe(false);
  });
  it("flags ANY reversal — a human reopening a bot auto-action is the ground-truth calibration-regression signal", () => {
    const out = detectAnomalies({ ...healthy, reversals: 1, reversalRate: 0.02 });
    expect(out.some((a) => /reverted\/reopened/.test(a) && /reversal-rate 2%/.test(a))).toBe(true);
  });
  it("surfaces MULTIPLE simultaneous anomalies together (so a compound regression isn't masked)", () => {
    const out = detectAnomalies({ ...healthy, failed: 1, manualRate: 0.9, reversals: 3, reversalRate: 0.1 });
    expect(out.length).toBe(3);
  });
  it("NAMES the specific PRs (with links) so the alert is actionable, not a mystery count", () => {
    const out = detectAnomalies({
      ...healthy,
      failed: 2,
      failedTargets: [
        { number: 2420, repo: "JSONbored/awesome-claude", verdict: "merge", lastError: "max_attempts_exceeded" },
        { number: 2318, repo: "JSONbored/awesome-claude", verdict: null, lastError: "max_attempts_exceeded" },
      ],
      reversals: 1,
      reversalRate: 0.01,
      reversedTargets: [{ number: 2643, repo: "JSONbored/awesome-claude", status: "merged", eventType: "reversal_reopened" }],
    });
    const failedLine = out.find((a) => /permanently failed/.test(a)) ?? "";
    expect(failedLine).toContain("[#2420](https://github.com/JSONbored/awesome-claude/pull/2420)");
    expect(failedLine).toContain("merge · max_attempts_exceeded");
    expect(failedLine).toContain("#2318");
    const reversalLine = out.find((a) => /reverted\/reopened/.test(a)) ?? "";
    expect(reversalLine).toContain("[#2643](https://github.com/JSONbored/awesome-claude/pull/2643)");
  });
  it("caps the listed PRs and notes the remainder (keeps the embed readable)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ number: 3000 + i, repo: "o/r", verdict: "close", lastError: "x" }));
    const line = detectAnomalies({ ...healthy, failed: 12, failedTargets: many }).find((a) => /permanently failed/.test(a)) ?? "";
    expect(line).toContain("(+4 more)"); // 12 - MAX_LISTED(8)
  });
});

describe("runAnomalyAlerts guards", () => {
  afterEach(() => vi.unstubAllGlobals());
  // The injected deps must never be reached when the early guards short-circuit.
  const failDeps: AnomalyAlertDeps = {
    computeAgentHealth: async () => {
      throw new Error("should not compute health");
    },
    computeCalibration: async () => {
      throw new Error("should not compute calibration");
    },
  };
  it("no-ops (no fetch) when discordNotify is off", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "x", features: { discordNotify: false }, secrets: {} } as unknown as AlertAgentConfig;
    await runAnomalyAlerts({} as Env, config, failDeps);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("no-ops when no valid webhook is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "x", features: { discordNotify: true }, secrets: {}, discordWebhookUrl: "not-a-url" } as unknown as AlertAgentConfig;
    await runAnomalyAlerts({} as Env, config, failDeps);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
