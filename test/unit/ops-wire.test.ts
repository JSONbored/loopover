import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { recordAiUsageEvent, recordAuditEvent, recordGateBlockOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import {
  computeOpsStats,
  detectOutcomeAnomalies,
  isOpsEnabled,
  type RepoOutcomeSnapshot,
  runOpsAlerts,
} from "../../src/review/ops-wire";
import { counterValue, resetMetrics, setSelfHostedMetricsMode } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

// Wrap env.DB.prepare so any SQL matching `pattern` throws, exercising a fail-safe catch; every other
// query delegates to the real test DB unchanged.
function poisonDbPrepare(env: Env, pattern: RegExp): void {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    if (pattern.test(sql)) throw new Error("poisoned query");
    return realPrepare(sql);
  }) as typeof env.DB.prepare;
}

// ── Pure detector fixtures ────────────────────────────────────────────────────────────────────────────────

const healthySnapshot: RepoOutcomeSnapshot = {
  repoFullName: "owner/repo",
  gatePrecision: {
    repoFullName: "owner/repo",
    generatedAt: "2026-06-22T00:00:00.000Z",
    windowDays: null,
    perGateType: [{ gateType: "slop_risk", blocked: 6, blockedThenMerged: 0, overridden: 0, falsePositiveRate: 0 }],
    overall: { blocked: 6, blockedThenMerged: 0, falsePositiveRate: 0 },
    signals: [],
  },
  calibration: {
    repoFullName: "owner/repo",
    generatedAt: "2026-06-22T00:00:00.000Z",
    windowDays: null,
    slop: { totalResolved: 20, bands: [], overallMergeRate: 0.5, discriminates: true },
    recommendations: { total: 10, positive: 8, negative: 2, pending: 0, positiveRate: 0.8 },
    signals: [],
  },
};

describe("isOpsEnabled — default OFF, truthy convention", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isOpsEnabled({ GITTENSORY_REVIEW_OPS: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isOpsEnabled({ GITTENSORY_REVIEW_OPS: on })).toBe(true);
  });
});

describe("detectOutcomeAnomalies — over gittensory's own outcome data", () => {
  it("returns nothing for a healthy snapshot", () => {
    expect(detectOutcomeAnomalies(healthySnapshot)).toEqual([]);
  });

  it("flags a gate false-positive spike (a gate type blocking PRs that merge anyway)", () => {
    const snap: RepoOutcomeSnapshot = {
      ...healthySnapshot,
      gatePrecision: {
        ...healthySnapshot.gatePrecision,
        perGateType: [{ gateType: "missing_linked_issue", blocked: 10, blockedThenMerged: 5, overridden: 2, falsePositiveRate: 0.5 }],
      },
    };
    const out = detectOutcomeAnomalies(snap);
    expect(out.some((a) => /gate false-positive spike/.test(a) && /missing_linked_issue/.test(a) && /50%/.test(a))).toBe(true);
  });

  it("does NOT flag a below-threshold (or null) gate false-positive rate", () => {
    const snap: RepoOutcomeSnapshot = {
      ...healthySnapshot,
      gatePrecision: {
        ...healthySnapshot.gatePrecision,
        perGateType: [
          { gateType: "low", blocked: 10, blockedThenMerged: 2, overridden: 0, falsePositiveRate: 0.2 }, // under 0.3
          { gateType: "noisy", blocked: 2, blockedThenMerged: 2, overridden: 0, falsePositiveRate: null }, // below sample
        ],
      },
    };
    expect(detectOutcomeAnomalies(snap).some((a) => /gate false-positive/.test(a))).toBe(false);
  });

  it("flags the slop score INVERTING (no longer discriminating)", () => {
    const snap: RepoOutcomeSnapshot = {
      ...healthySnapshot,
      calibration: { ...healthySnapshot.calibration, slop: { totalResolved: 30, bands: [], overallMergeRate: 0.5, discriminates: false } },
    };
    expect(detectOutcomeAnomalies(snap).some((a) => /slop score NOT discriminating/.test(a))).toBe(true);
  });

  it("does NOT flag slop when discrimination is unknown (null)", () => {
    const snap: RepoOutcomeSnapshot = {
      ...healthySnapshot,
      calibration: { ...healthySnapshot.calibration, slop: { totalResolved: 2, bands: [], overallMergeRate: null, discriminates: null } },
    };
    expect(detectOutcomeAnomalies(snap).some((a) => /slop score/.test(a))).toBe(false);
  });

  it("flags recommendations not panning out (high negative rate over enough resolved evidence)", () => {
    const snap: RepoOutcomeSnapshot = {
      ...healthySnapshot,
      calibration: { ...healthySnapshot.calibration, recommendations: { total: 10, positive: 2, negative: 8, pending: 0, positiveRate: 0.2 } },
    };
    expect(detectOutcomeAnomalies(snap).some((a) => /recommendations not panning out/.test(a) && /80% negative/.test(a))).toBe(true);
  });

  it("does NOT flag a high negative rate below the min resolved sample", () => {
    const snap: RepoOutcomeSnapshot = {
      ...healthySnapshot,
      calibration: { ...healthySnapshot.calibration, recommendations: { total: 3, positive: 1, negative: 2, pending: 0, positiveRate: 0.333 } },
    };
    expect(detectOutcomeAnomalies(snap).some((a) => /recommendations not panning out/.test(a))).toBe(false);
  });

  it("surfaces multiple simultaneous anomalies together", () => {
    const snap: RepoOutcomeSnapshot = {
      gatePrecision: {
        ...healthySnapshot.gatePrecision,
        perGateType: [{ gateType: "x", blocked: 10, blockedThenMerged: 9, overridden: 0, falsePositiveRate: 0.9 }],
      },
      repoFullName: "owner/repo",
      calibration: {
        ...healthySnapshot.calibration,
        slop: { totalResolved: 30, bands: [], overallMergeRate: 0.5, discriminates: false },
        recommendations: { total: 10, positive: 1, negative: 9, pending: 0, positiveRate: 0.1 },
      },
    };
    expect(detectOutcomeAnomalies(snap).length).toBe(3);
  });

  it("flags a review burst — the same PR published far more review surfaces than normal iteration in the window (#orb-ci-stuck-repeat)", () => {
    const snap: RepoOutcomeSnapshot = { ...healthySnapshot, reviewBurst: { targetKey: "owner/repo#42", count: 9 } };
    const out = detectOutcomeAnomalies(snap);
    expect(out.some((a) => /review burst/.test(a) && /owner\/repo#42/.test(a) && /9 review surfaces/.test(a))).toBe(true);
  });

  it("does NOT flag a review burst below the threshold", () => {
    const snap: RepoOutcomeSnapshot = { ...healthySnapshot, reviewBurst: { targetKey: "owner/repo#42", count: 2 } };
    expect(detectOutcomeAnomalies(snap).some((a) => /review burst/.test(a))).toBe(false);
  });

  it("flags a review FAILURE burst — repeated inconclusive AI-review calls for the same PR with no successful publish (#review-burst-blind-spot)", () => {
    const snap: RepoOutcomeSnapshot = { ...healthySnapshot, reviewFailureBurst: { targetKey: "owner/repo#42", count: 4 } };
    const out = detectOutcomeAnomalies(snap);
    expect(out.some((a) => /review failure burst/.test(a) && /owner\/repo#42/.test(a) && /4 inconclusive/.test(a))).toBe(true);
  });

  it("does NOT flag a review failure burst below the threshold", () => {
    const snap: RepoOutcomeSnapshot = { ...healthySnapshot, reviewFailureBurst: { targetKey: "owner/repo#42", count: 2 } };
    expect(detectOutcomeAnomalies(snap).some((a) => /review failure burst/.test(a))).toBe(false);
  });

  it("does NOT flag a review failure burst when none was computed (absent/null)", () => {
    expect(detectOutcomeAnomalies({ ...healthySnapshot, reviewFailureBurst: null }).some((a) => /review failure burst/.test(a))).toBe(false);
    expect(detectOutcomeAnomalies(healthySnapshot).some((a) => /review failure burst/.test(a))).toBe(false); // field omitted entirely
  });

  it("does NOT flag a review burst when none was computed (absent/null)", () => {
    expect(detectOutcomeAnomalies({ ...healthySnapshot, reviewBurst: null }).some((a) => /review burst/.test(a))).toBe(false);
    expect(detectOutcomeAnomalies(healthySnapshot).some((a) => /review burst/.test(a))).toBe(false); // field omitted entirely
  });
});

// ── DB-backed cron + endpoint integration over the real migrated schema ─────────────────────────────────────

// Mark a repo registered so opsScanRepos picks it up (the registry sets is_registered=1; we seed it directly).
async function seedRegisteredRepo(env: Env, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
    .bind(fullName, owner, name)
    .run();
}

// A registered repo with a REAL installation + acting-autonomy settings, so opsScanRepos's "prefer
// agent-configured repos" branch picks it up (#sweep-requires-installation: installation_id is required
// alongside the autonomy row, matching the real upsertRepositoryFromGitHub invariant).
async function seedAgentConfiguredRepo(env: Env, fullName: string, installationId: number): Promise<void> {
  const [owner, name] = fullName.split("/");
  await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered, installation_id) VALUES (?, ?, ?, 1, 1, ?)")
    .bind(fullName, owner, name, installationId)
    .run();
  await env.DB.prepare("INSERT INTO repository_settings (repo_full_name, autonomy_json) VALUES (?, ?)")
    .bind(fullName, JSON.stringify({ review: "auto" }))
    .run();
}

// Seed a gate-block ledger anomaly: blocked PRs that later MERGED (false positives) over the min sample.
async function seedGateFalsePositiveAnomaly(env: Env, repoFullName: string): Promise<void> {
  for (let i = 1; i <= 6; i += 1) {
    await recordGateBlockOutcome(env, { repoFullName, pullNumber: i, blockerCodes: ["missing_linked_issue"] });
    await upsertPullRequestFromGitHub(env, repoFullName, {
      number: i,
      title: `PR ${i}`,
      state: "closed",
      // 4 of 6 blocked PRs merged anyway → 4/6 ≈ 67% false-positive, well above the 30% threshold.
      merged_at: i <= 4 ? "2026-06-01T00:00:00.000Z" : null,
    } as never);
  }
}

describe("runOpsAlerts — cron path over gittensory's outcome data", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMetrics();
    setSelfHostedMetricsMode(false);
  });

  it("emits a structured ops_anomaly log naming the repo + drift on a seeded anomaly, at error level (#orb-ci-stuck-repeat -- so it reaches Sentry)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    await seedGateFalsePositiveAnomaly(env, "owner/repo");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/repo"]?.some((a) => /gate false-positive spike/.test(a))).toBe(true);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("ops_anomaly") && line.includes("owner/repo"));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged!) as { level: string; event: string; repo: string; anomalies: string[] };
    expect(parsed.level).toBe("error");
    expect(parsed.event).toBe("ops_anomaly");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.anomalies.some((a) => /missing_linked_issue/.test(a))).toBe(true);
  });

  it("emits NO ops_anomaly log when the outcome data is healthy", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/clean");
    // Blocks that all stayed closed (the gate held) → no false positives, no anomaly.
    for (let i = 1; i <= 6; i += 1) {
      await recordGateBlockOutcome(env, { repoFullName: "owner/clean", pullNumber: i, blockerCodes: ["slop_risk"] });
      await upsertPullRequestFromGitHub(env, "owner/clean", { number: i, title: `PR ${i}`, state: "closed", merged_at: null } as never);
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/clean"]).toBeUndefined();
    expect(errors.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly\""))).toBe(false);
  });

  it("REGRESSION (#sweep-requires-installation): prefers the agent-configured repo and never scans an uninstalled registered repo when a configured one exists", async () => {
    const env = createTestEnv();
    await seedAgentConfiguredRepo(env, "owner/configured", 9501);
    await seedGateFalsePositiveAnomaly(env, "owner/configured");
    // Registered, but no real installation -- must not count as "agent-configured" merely by resolving the
    // operator's global-default autonomy, and must be excluded from the scan once a configured repo exists.
    await seedRegisteredRepo(env, "owner/no-install");
    await seedGateFalsePositiveAnomaly(env, "owner/no-install");

    const found = await runOpsAlerts(env);

    expect(found["owner/configured"]?.some((a) => /gate false-positive spike/.test(a))).toBe(true);
    expect(found["owner/no-install"]).toBeUndefined();
  });

  it("detects and reports a review burst end-to-end (a PR published far more review surfaces than normal in the window)", async () => {
    setSelfHostedMetricsMode(true); // keep the repo label so the counter assertion can target the exact series
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    for (let i = 0; i < 7; i += 1) {
      await recordAuditEvent(env, {
        eventType: "github_app.pr_public_surface_published",
        actor: "contributor",
        targetKey: "owner/repo#99",
        outcome: "completed",
      });
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/repo"]?.some((a) => /review burst/.test(a) && /owner\/repo#99/.test(a))).toBe(true);
    const stats = await computeOpsStats(env);
    const row = stats.repos.find((r) => r.repoFullName === "owner/repo");
    expect(row?.anomalies.some((a) => /review burst/.test(a))).toBe(true);
    // #ops-anomaly-metric: the Prometheus counterpart to the log line, labeled by kind (self-host mode preserves
    // the repo label so the assertion can target the exact series without relying on cloud-worker redaction).
    expect(counterValue("gittensory_ops_anomaly_total", { repo: "owner/repo", kind: "review_burst" })).toBe(1);
  });

  it("detects and reports a review FAILURE burst end-to-end -- reproduces the #3747 incident shape (repeated inconclusive calls, zero publishes) (#review-burst-blind-spot)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    // Mirrors the exact incident: every AI review call for this PR came back inconclusive (zero usable output),
    // and NONE of them ever reached a successful publish -- so findHottestReviewTargetForRepo alone sees nothing.
    for (let i = 0; i < 4; i += 1) {
      await recordAiUsageEvent(env, {
        feature: "ai_review_pr",
        model: "self-host:claude-code",
        status: "ok",
        estimatedNeurons: 100,
        metadata: { repoFullName: "owner/repo", pullNumber: 99, inconclusive: true },
      });
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/repo"]?.some((a) => /review failure burst/.test(a) && /owner\/repo#99/.test(a) && /4 inconclusive/.test(a))).toBe(true);
    expect(found["owner/repo"]?.some((a) => /review burst:/.test(a))).toBe(false); // the publish-only signal stays silent -- proves this is a genuinely new detector, not a duplicate.
    const stats = await computeOpsStats(env);
    const row = stats.repos.find((r) => r.repoFullName === "owner/repo");
    expect(row?.anomalies.some((a) => /review failure burst/.test(a))).toBe(true);
  });

  it("does NOT flag a review failure burst from a healthy mix of successful and merely-occasional inconclusive calls", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    await recordAiUsageEvent(env, {
      feature: "ai_review_pr",
      model: "self-host:claude-code",
      status: "ok",
      estimatedNeurons: 100,
      metadata: { repoFullName: "owner/repo", pullNumber: 5, inconclusive: false },
    });
    await recordAiUsageEvent(env, {
      feature: "ai_review_pr",
      model: "self-host:claude-code",
      status: "ok",
      estimatedNeurons: 100,
      metadata: { repoFullName: "owner/repo", pullNumber: 5, inconclusive: true },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/repo"]).toBeUndefined();
    expect(errors.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly\""))).toBe(false);
  });

  it("fails safe per-repo: a load error on one repo is logged and the scan continues (ops_anomaly_repo_error)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    // The repo is scanned, but the per-repo precision load throws → caught at the inner catch.
    // gate-precision reads pull_requests (Drizzle, quoted table name) per repo.
    poisonDbPrepare(env, /"pull_requests"/i);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env); // resolves (never throws)

    expect(found).toEqual({});
    expect(errors.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly_repo_error") && line.includes("owner/repo"))).toBe(true);
  });

  it("fails safe at the top level: a repo-scan error is swallowed (ops_anomaly_error), returns {}", async () => {
    const env = createTestEnv();
    // opsScanRepos → listRepositories reads the repositories table (Drizzle, quoted); poison it so the
    // outer try throws.
    poisonDbPrepare(env, /"repositories"/i);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await runOpsAlerts(env); // resolves (never throws)

    expect(found).toEqual({});
    expect(errors.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly_error"))).toBe(true);
  });
});

describe("computeOpsStats — cross-repo outcome aggregate", () => {
  it("rolls up the gate ledger + the active anomalies per repo (aggregate counts, no PR content)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    await seedGateFalsePositiveAnomaly(env, "owner/repo");

    const payload = await computeOpsStats(env);
    const row = payload.repos.find((r) => r.repoFullName === "owner/repo");
    expect(row).toBeDefined();
    expect(row!.gate).toMatchObject({ blocked: 6, blockedThenMerged: 4 });
    expect(row!.anomalies.some((a) => /gate false-positive spike/.test(a))).toBe(true);
    // Privacy: aggregate only — never actor logins / trust internals.
    expect(JSON.stringify(payload)).not.toMatch(/login|actor|reward|payout|trust|wallet|hotkey|credibility/i);
  });

  it("rolls up real BYOK token/cost usage over the trailing window (#hosted-ai-usage-observability)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    await recordAiUsageEvent(env, {
      feature: "ai_review_pr",
      model: "byok:anthropic",
      provider: "anthropic",
      status: "ok",
      estimatedNeurons: 0,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      costUsd: 0.045,
      metadata: { repoFullName: "owner/repo", pullNumber: 7, inconclusive: false },
    });
    await recordAiUsageEvent(env, {
      feature: "ai_review_pr",
      model: "byok:anthropic",
      provider: "anthropic",
      status: "ok",
      estimatedNeurons: 0,
      inputTokens: 2000,
      outputTokens: 800,
      totalTokens: 2800,
      costUsd: 0.09,
      metadata: { repoFullName: "owner/repo", pullNumber: 8, inconclusive: false },
    });

    const payload = await computeOpsStats(env);
    const row = payload.repos.find((r) => r.repoFullName === "owner/repo");
    expect(row?.byokUsage).toEqual({ calls: 2, inputTokens: 3000, outputTokens: 1300, totalTokens: 4300, costUsd: 0.135 });
  });

  it("reports zero BYOK usage for a repo with no BYOK calls in the window", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");

    const payload = await computeOpsStats(env);
    const row = payload.repos.find((r) => r.repoFullName === "owner/repo");
    expect(row?.byokUsage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  });
});

describe("GET /v1/internal/ops/stats — bearer-gated, flag-gated endpoint", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_OPS: "true" });
    expect((await app.request("/v1/internal/ops/stats", {}, env)).status).toBe(401);
    expect((await app.request("/v1/internal/ops/stats", { headers: { authorization: "Bearer nope" } }, env)).status).toBe(401);
  });

  it("404s when GITTENSORY_REVIEW_OPS is OFF — the endpoint does not exist (byte-identical to today)", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset → OFF
    const res = await app.request("/v1/internal/ops/stats", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("200s with the aggregate when GITTENSORY_REVIEW_OPS is ON and authorized", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_OPS: "true" });
    await seedRegisteredRepo(env, "owner/repo");
    await seedGateFalsePositiveAnomaly(env, "owner/repo");
    const res = await app.request("/v1/internal/ops/stats", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<{ repoFullName: string; anomalies: string[] }> };
    expect(body.repos.some((r) => r.repoFullName === "owner/repo" && r.anomalies.length > 0)).toBe(true);
  });
});
