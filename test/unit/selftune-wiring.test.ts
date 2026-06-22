import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/processors";
import {
  applyOverrideRecommendation,
  loadOverride,
  loadShadowOverride,
  listOverrideAudit,
} from "../../src/review/auto-apply";
import {
  evalRowFromCalibration,
  isSelfTuneEnabled,
  runSelfTune,
  SELFTUNE_BASE_CONFIDENCE_FLOOR,
} from "../../src/review/selftune-wire";
import { computeTuningRecommendations } from "../../src/review/auto-tune";
import { createTestEnv } from "../helpers/d1";

// Wrap env.DB.prepare so any SQL matching `pattern` throws (exercising a fail-safe catch); all other
// queries delegate to the real test DB unchanged.
function poisonDbPrepare(env: Env, pattern: RegExp): void {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    if (pattern.test(sql)) throw new Error("poisoned query");
    return realPrepare(sql);
  }) as typeof env.DB.prepare;
}

// ── Test seeders (raw D1; FKs are enforced in the test sqlite, so we disable them for the orphan seed) ─────

async function seedRegisteredRepo(env: Env, fullName: string, autonomyJson: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
    .bind(fullName, owner, name)
    .run();
  // Opt the repo into the acting-autonomy surface so isAgentConfigured(settings.autonomy) is true (selfTuneRepos filter).
  await env.DB.prepare("INSERT INTO repository_settings (repo_full_name, autonomy_json) VALUES (?, ?)")
    .bind(fullName, autonomyJson)
    .run();
}

// Seed N resolved recommendation outcomes for a repo: `negative` rejected/closed (the dangerous error a
// tightening fixes) + `positive` accepted. Inserted directly (FKs off) — buildRepoOutcomeCalibration reads
// the outcome_state split, which is all the eval mapping needs.
async function seedRecommendationOutcomes(env: Env, repoFullName: string, positive: number, negative: number): Promise<void> {
  await env.DB.prepare("PRAGMA foreign_keys=OFF").run();
  let i = 0;
  const insert = async (state: string) => {
    i += 1;
    await env.DB.prepare(
      `INSERT INTO agent_recommendation_outcomes
        (id, action_id, run_id, actor_login, action_type, outcome_state, outcome_target_type, outcome_repo_full_name,
         maintainer_lane, confidence, reason, source, updated_at)
       VALUES (?, ?, ?, ?, 'review', ?, 'pull_request', ?, 0, 'medium', 'seed', 'inferred', CURRENT_TIMESTAMP)`,
    )
      .bind(`o${i}`, `a${i}`, `r${i}`, "bot", state, repoFullName)
      .run();
  };
  for (let n = 0; n < positive; n += 1) await insert("accepted");
  for (let n = 0; n < negative; n += 1) await insert("rejected");
}

// ── isSelfTuneEnabled — default OFF, truthy convention ─────────────────────────────────────────────────────

describe("isSelfTuneEnabled — default OFF, truthy convention", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isSelfTuneEnabled({ REVIEWBOT_SELFTUNE: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isSelfTuneEnabled({ REVIEWBOT_SELFTUNE: on })).toBe(true);
  });
});

// ── Eval mapping (pure) — tightening-only by construction ──────────────────────────────────────────────────

describe("evalRowFromCalibration — gittensory outcome data → ported GateEvalRow (tightening-only)", () => {
  it("maps the recommendation positive/negative split onto the would-MERGE side only", () => {
    const row = evalRowFromCalibration("owner/repo", 7, 5);
    expect(row).toMatchObject({
      project: "owner/repo",
      wouldMerge: 12,
      mergeConfirmed: 7,
      mergeFalse: 5,
      decided: 12,
      // The close side is held at 0 by construction so no loosening directive can ever be produced.
      wouldClose: 0,
      closeConfirmed: 0,
      closeFalse: 0,
    });
    expect(row.mergePrecision).toBeCloseTo(7 / 12, 5);
    expect(row.closePrecision).toBeNull();
  });

  it("a low merge precision yields ONLY a TIGHTENING recommendation (raise the floor), never a loosening one", () => {
    // 5 confirmed / 15 would-merge = 33% precision over 15 decided → well under the risk floor.
    const row = evalRowFromCalibration("owner/repo", 5, 10);
    const recs = computeTuningRecommendations({ rows: [row], hasSignal: true });
    // The warn rec carries a tightening overridePayload (raise the confidence floor)...
    const tighten = recs.find((r) => r.overridePayload != null);
    expect(tighten?.overridePayload?.confidenceFloor).toBeGreaterThan(0);
    // ...and NO recommendation carries a loosening directive (closeFalse is 0, so the loosening branch is dead).
    expect(recs.some((r) => /[Ll]oosen/.test(r.message))).toBe(false);
  });

  it("a healthy split produces no auto-applicable (tightening) payload", () => {
    const row = evalRowFromCalibration("owner/repo", 12, 0); // 100% precision, no false 'merges'
    const recs = computeTuningRecommendations({ rows: [row], hasSignal: true });
    expect(recs.some((r) => r.overridePayload != null)).toBe(false);
  });
});

// ── Migration round-trip on the 3 tables (live D1-backed store over the real migrated schema) ───────────────

describe("0047 self-improve tunables migration — round-trip on the 3 tables", () => {
  it("tunables_overrides + override_audit round-trip via a force-apply (LIVE write + audit)", async () => {
    const env = createTestEnv();
    const res = await applyOverrideRecommendation(env as never, "owner/repo", { confidenceFloor: 0.95 }, { force: true, soakMs: 1000, nowMs: 0 });
    expect(res.applied).toBe(true);
    // Round-trip read from tunables_overrides.
    const live = await loadOverride(env as never, "owner/repo");
    expect(live?.confidenceFloor).toBe(0.95);
    // override_audit recorded the apply.
    const audit = await listOverrideAudit(env as never, "owner/repo");
    expect(audit.some((a) => a.eventType === "override_applied")).toBe(true);
  });

  it("tunables_overrides_shadow round-trips via a shadow-soak write", async () => {
    const env = createTestEnv();
    const res = await applyOverrideRecommendation(env as never, "owner/repo", { confidenceFloor: 0.95 }, { force: false, soakMs: 60_000, nowMs: 0 });
    expect(res.shadowed).toBe(true);
    const shadow = await loadShadowOverride(env as never, "owner/repo");
    expect(shadow?.override.confidenceFloor).toBe(0.95);
    expect(shadow?.validatedUntil).toBe(new Date(60_000).toISOString());
    // Nothing went live, and the shadow event is audited.
    expect(await loadOverride(env as never, "owner/repo")).toBeNull();
    expect((await listOverrideAudit(env as never, "owner/repo")).some((a) => a.eventType === "override_shadowed")).toBe(true);
  });
});

// ── runSelfTune — flag-gated cron tick (shadow-soak, tightening-only, flag-OFF no-op) ────────────────────────

const ACTING_AUTONOMY = JSON.stringify({ review: "auto" }); // opts the repo into the acting-autonomy surface

describe("runSelfTune — shadow-soak over gittensory's own outcome data", () => {
  it("FLAG-ON: a low-precision repo gets a TIGHTENING override SHADOW-SOAKED (not live yet) + audited", async () => {
    const env = createTestEnv({ REVIEWBOT_SELFTUNE: "true" });
    await seedRegisteredRepo(env, "owner/repo", ACTING_AUTONOMY);
    // 5 positive / 10 negative = 33% precision over 15 decided → a clear tightening signal.
    await seedRecommendationOutcomes(env, "owner/repo", 5, 10);

    await runSelfTune(env);

    // A tightening override was queued to the shadow soak (a future validated_until), NOT applied live.
    const shadow = await loadShadowOverride(env as never, "owner/repo");
    expect(shadow?.override.confidenceFloor).toBeGreaterThan(0);
    expect(await loadOverride(env as never, "owner/repo")).toBeNull(); // not promoted within one tick (still soaking)
    expect((await listOverrideAudit(env as never, "owner/repo")).some((a) => a.eventType === "override_shadowed")).toBe(true);
  });

  it("FLAG-ON: promotes a SOAKED tightening shadow override to live on a later tick (tightening + evidence + soaked)", async () => {
    const env = createTestEnv({ REVIEWBOT_SELFTUNE: "true" });
    await seedRegisteredRepo(env, "owner/repo", ACTING_AUTONOMY);
    await seedRecommendationOutcomes(env, "owner/repo", 5, 10);
    // Pre-seed a shadow override whose soak deadline is already in the past → eligible to promote this tick.
    await env.DB.prepare(
      "INSERT INTO tunables_overrides_shadow (project, confidence_floor, scope_cap_files, scope_cap_lines, applied_at, validated_until) VALUES (?, ?, NULL, NULL, CURRENT_TIMESTAMP, ?)",
    )
      .bind("owner/repo", 0.95, "2000-01-01T00:00:00.000Z")
      .run();

    await runSelfTune(env);

    // Promoted to live; the shadow row is cleared; the promotion is audited.
    expect((await loadOverride(env as never, "owner/repo"))?.confidenceFloor).toBe(0.95);
    expect(await loadShadowOverride(env as never, "owner/repo")).toBeNull();
    expect((await listOverrideAudit(env as never, "owner/repo")).some((a) => a.eventType === "override_promoted")).toBe(true);
  });

  it("a LOOSENING change is NEVER applied — only tightening auto-applies", async () => {
    const env = createTestEnv({ REVIEWBOT_SELFTUNE: "true" });
    await seedRegisteredRepo(env, "owner/repo", ACTING_AUTONOMY);
    await seedRecommendationOutcomes(env, "owner/repo", 5, 10);
    // Pre-seed a LIVE floor of 0.99 and a SOAKED shadow override of 0.80 (a DROP = loosening). Even though the
    // soak deadline has passed, the promotion gate must REFUSE it (a floor drop is not strictly tightening).
    await env.DB.prepare(
      "INSERT INTO tunables_overrides (project, confidence_floor, scope_cap_files, scope_cap_lines, applied_at) VALUES (?, ?, NULL, NULL, CURRENT_TIMESTAMP)",
    )
      .bind("owner/repo", 0.99)
      .run();
    await env.DB.prepare(
      "INSERT INTO tunables_overrides_shadow (project, confidence_floor, scope_cap_files, scope_cap_lines, applied_at, validated_until) VALUES (?, ?, NULL, NULL, CURRENT_TIMESTAMP, ?)",
    )
      .bind("owner/repo", 0.8, "2000-01-01T00:00:00.000Z")
      .run();

    await runSelfTune(env);

    // The live floor was NOT loosened to 0.80 — it stays at the tighter 0.99, and the loosening shadow is held.
    expect((await loadOverride(env as never, "owner/repo"))?.confidenceFloor).toBe(0.99);
    expect((await listOverrideAudit(env as never, "owner/repo")).some((a) => a.eventType === "override_promoted")).toBe(false);
  });

  it("FLAG-OFF (default): runSelfTune does ZERO tuning work — no shadow, no override, no audit", async () => {
    const env = createTestEnv({ REVIEWBOT_SELFTUNE: "false" });
    await seedRegisteredRepo(env, "owner/repo", ACTING_AUTONOMY);
    await seedRecommendationOutcomes(env, "owner/repo", 5, 10);

    // The processor is the real flag gate the cron hits — flag-OFF it must no-op even if the job lands.
    await processJob(env, { type: "selftune", requestedBy: "schedule" });

    expect(await loadShadowOverride(env as never, "owner/repo")).toBeNull();
    expect(await loadOverride(env as never, "owner/repo")).toBeNull();
    expect((await listOverrideAudit(env as never, "owner/repo")).length).toBe(0);
  });

  it("FLAG-ON via the processor: a stale in-flight selftune job runs the tick (defense-in-depth gate)", async () => {
    const env = createTestEnv({ REVIEWBOT_SELFTUNE: "true" });
    await seedRegisteredRepo(env, "owner/repo", ACTING_AUTONOMY);
    await seedRecommendationOutcomes(env, "owner/repo", 5, 10);

    await processJob(env, { type: "selftune", requestedBy: "schedule" });

    expect((await loadShadowOverride(env as never, "owner/repo"))?.override.confidenceFloor).toBeGreaterThan(0);
  });

  it("fails safe per-repo: an eval-build error on one repo is logged and the pass continues (selftune_repo_error)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/repo", ACTING_AUTONOMY);
    // The repo is scanned (settings read OK), but buildEvalRow's calibration read of pull_requests throws.
    poisonDbPrepare(env, /"pull_requests"/i);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runSelfTune(env); // resolves (never throws)

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("selftune_repo_error") && line.includes("owner/repo"))).toBe(true);
    warn.mockRestore();
  });

  it("fails safe at the top level: a repo-scan error is swallowed (selftune_error)", async () => {
    const env = createTestEnv();
    // selfTuneRepos → listRepositories reads repositories (Drizzle, quoted); poison it so the outer try throws.
    poisonDbPrepare(env, /"repositories"/i);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runSelfTune(env); // resolves (never throws)

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("selftune_error"))).toBe(true);
    warn.mockRestore();
  });
});

// ── Config-application is DEFERRED — sanity: the base floor seam is the unset/loosest state ──────────────────

describe("config-application deferred (documented seam)", () => {
  it("the base confidence floor is the loosest state, so any positive floor recommendation is strictly tightening", () => {
    expect(SELFTUNE_BASE_CONFIDENCE_FLOOR).toBe(0);
  });
});
