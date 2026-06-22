import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { recordGateBlockOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import {
  computeOpsStats,
  detectOutcomeAnomalies,
  isOpsEnabled,
  type RepoOutcomeSnapshot,
  runOpsAlerts,
} from "../../src/review/ops-wire";
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
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isOpsEnabled({ REVIEWBOT_OPS: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isOpsEnabled({ REVIEWBOT_OPS: on })).toBe(true);
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
  afterEach(() => vi.restoreAllMocks());

  it("emits a structured ops_anomaly log naming the repo + drift on a seeded anomaly", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    await seedGateFalsePositiveAnomaly(env, "owner/repo");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/repo"]?.some((a) => /gate false-positive spike/.test(a))).toBe(true);
    const logged = warn.mock.calls.map((c) => String(c[0])).find((line) => line.includes("ops_anomaly") && line.includes("owner/repo"));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged!) as { ev: string; repo: string; anomalies: string[] };
    expect(parsed.ev).toBe("ops_anomaly");
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const found = await runOpsAlerts(env);

    expect(found["owner/clean"]).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly\""))).toBe(false);
  });

  it("fails safe per-repo: a load error on one repo is logged and the scan continues (ops_anomaly_repo_error)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo");
    // The repo is scanned, but the per-repo precision load throws → caught at the inner catch.
    // gate-precision reads pull_requests (Drizzle, quoted table name) per repo.
    poisonDbPrepare(env, /"pull_requests"/i);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const found = await runOpsAlerts(env); // resolves (never throws)

    expect(found).toEqual({});
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly_repo_error") && line.includes("owner/repo"))).toBe(true);
  });

  it("fails safe at the top level: a repo-scan error is swallowed (ops_anomaly_error), returns {}", async () => {
    const env = createTestEnv();
    // opsScanRepos → listRepositories reads the repositories table (Drizzle, quoted); poison it so the
    // outer try throws.
    poisonDbPrepare(env, /"repositories"/i);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const found = await runOpsAlerts(env); // resolves (never throws)

    expect(found).toEqual({});
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly_error"))).toBe(true);
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
});

describe("GET /v1/internal/ops/stats — bearer-gated, flag-gated endpoint", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv({ REVIEWBOT_OPS: "true" });
    expect((await app.request("/v1/internal/ops/stats", {}, env)).status).toBe(401);
    expect((await app.request("/v1/internal/ops/stats", { headers: { authorization: "Bearer nope" } }, env)).status).toBe(401);
  });

  it("404s when REVIEWBOT_OPS is OFF — the endpoint does not exist (byte-identical to today)", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset → OFF
    const res = await app.request("/v1/internal/ops/stats", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("200s with the aggregate when REVIEWBOT_OPS is ON and authorized", async () => {
    const app = createApp();
    const env = createTestEnv({ REVIEWBOT_OPS: "true" });
    await seedRegisteredRepo(env, "owner/repo");
    await seedGateFalsePositiveAnomaly(env, "owner/repo");
    const res = await app.request("/v1/internal/ops/stats", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<{ repoFullName: string; anomalies: string[] }> };
    expect(body.repos.some((r) => r.repoFullName === "owner/repo" && r.anomalies.length > 0)).toBe(true);
  });
});
