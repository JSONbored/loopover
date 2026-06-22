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

// ── runAnomalyAlerts send path ───────────────────────────────────────────────────────────────────────
// gittensory's migrated `notification_deliveries` table is the badge read-model — a DIFFERENT schema than
// the native port's claim SQL (project/target_id/notification_key). So we emulate the claim store: the
// INSERT ... ON CONFLICT(project, target_id, notification_key) DO NOTHING returns changes=1 the first time a
// (project, target_id, notification_key) tuple is seen and changes=0 on a repeat (the per-hour throttle).
function claimEnv(extra: Record<string, unknown> = {}): Env {
  const seen = new Set<string>();
  return {
    ...extra,
    DB: {
      prepare: (_sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            // bind order: id, project (slug), notification_key. target_id is the literal in the SQL
            // ('__healthcheck__' / '__anomaly__') — fold it in via the key text so the two claims never collide.
            const key = `${String(binds[1])}::${String(binds[2])}`;
            const firstTime = !seen.has(key);
            seen.add(key);
            return { meta: { changes: firstTime ? 1 : 0 } };
          },
        }),
      }),
    },
  } as unknown as Env;
}

const WEBHOOK = "https://discord.com/api/webhooks/123/abc";

const anomalousHealth: AgentHealth = { ...healthy, failed: 1, dlqCount: 3, dlqTargets: [{ number: 9, repo: "o/r", verdict: null, lastError: "storm" }] };
const driftCal: Calibration = {
  currentFloor: 0.9, mergedCount: 50, revertedCount: 2, keptAvgConfidence: 0.95, revertedMaxConfidence: 0.93,
  recommendedFloor: 0.95, note: "raise",
  closesByReason: [{ reasonCode: "source_unfetchable", closes: 10, disputed: 2 }],
  disputedCloseCount: 2,
};

describe("runAnomalyAlerts — send path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs a Discord embed when anomalies fire, resolving the webhook from discordWebhookUrl", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "ac", name: "Awesome", features: { discordNotify: true }, secrets: {}, discordWebhookUrl: WEBHOOK } as AlertAgentConfig;
    const deps: AnomalyAlertDeps = { computeAgentHealth: async () => anomalousHealth, computeCalibration: async () => driftCal };

    await runAnomalyAlerts(claimEnv(), config, deps);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { username: string; embeds: Array<{ title: string; description: string }> };
    expect(body.username).toBe("Awesome"); // config.name preferred over slug
    expect(body.embeds[0]?.title).toContain("ac: health anomaly");
    expect(body.embeds[0]?.description).toMatch(/calibration drift|DEAD-LETTERED|permanently failed/);
  });

  it("resolves the webhook from a named secret (config.secrets.discordWebhook → env[name])", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "mg", features: { discordNotify: true }, secrets: { discordWebhook: "MG_DISCORD" } } as AlertAgentConfig;
    const env = claimEnv({ MG_DISCORD: WEBHOOK });
    const deps: AnomalyAlertDeps = { computeAgentHealth: async () => anomalousHealth, computeCalibration: async () => driftCal };

    await runAnomalyAlerts(env, config, deps);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(WEBHOOK);
  });

  it("does NOT fetch when there are no anomalies (healthy snapshot behind the claim)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "ac", features: { discordNotify: true }, secrets: {}, discordWebhookUrl: WEBHOOK } as AlertAgentConfig;
    const deps: AnomalyAlertDeps = { computeAgentHealth: async () => healthy, computeCalibration: async () => ({ ...driftCal, recommendedFloor: null, disputedCloseCount: 0 }) };
    await runAnomalyAlerts(claimEnv(), config, deps);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throttles per condition-set: a SECOND run the same hour does not re-POST (anomaly claim conflicts)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "ac", features: { discordNotify: true }, secrets: {}, discordWebhookUrl: WEBHOOK } as AlertAgentConfig;
    // Health check claim differs from the anomaly claim (distinct target_id text), so to exercise the
    // anomaly-key short-circuit specifically, let the health claim succeed both times but the anomaly
    // claim conflict the 2nd time. The shared `seen` set in claimEnv does exactly that across both calls.
    const env = claimEnv();
    let healthCalls = 0;
    const deps: AnomalyAlertDeps = {
      computeAgentHealth: async () => { healthCalls += 1; return anomalousHealth; },
      computeCalibration: async () => driftCal,
    };
    await runAnomalyAlerts(env, config, deps); // 1st: health claim + anomaly claim succeed → POST
    await runAnomalyAlerts(env, config, deps); // 2nd: health claim already taken → returns before computing health
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(healthCalls).toBe(1); // the hourly health claim short-circuited the 2nd tick before computing
  });

  it("logs and does NOT reject when the webhook fetch throws", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "ac", features: { discordNotify: true }, secrets: {}, discordWebhookUrl: WEBHOOK } as AlertAgentConfig;
    const deps: AnomalyAlertDeps = { computeAgentHealth: async () => anomalousHealth, computeCalibration: async () => driftCal };
    await expect(runAnomalyAlerts(claimEnv(), config, deps)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid (non-discord-host) webhook before computing health", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const config = { slug: "ac", features: { discordNotify: true }, secrets: {}, discordWebhookUrl: "https://evil.example.com/api/webhooks/1/2" } as AlertAgentConfig;
    let computed = false;
    const deps: AnomalyAlertDeps = { computeAgentHealth: async () => { computed = true; return anomalousHealth; }, computeCalibration: async () => driftCal };
    await runAnomalyAlerts(claimEnv(), config, deps);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(computed).toBe(false); // bailed at the webhook-validity guard, never reached the claim/health
  });
});
