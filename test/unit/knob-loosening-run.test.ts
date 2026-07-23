import { afterEach, describe, expect, it, vi } from "vitest";
import { splitBacktestCorpus } from "@loopover/engine";
import * as looseningKnobs from "../../src/services/loosening-knobs";
import { LOOSENABLE_KNOBS, type LoosenableKnob } from "../../src/services/loosening-knobs";
import {
  GENERIC_LIVE_KNOBS,
  genericLiveKnobs,
  getAiReviewCloseConfidenceOverride,
  getKnobOverride,
  getKnobOverrideForRepo,
  repoKnobOverrideFlagKey,
  isKnobAutotuneEnabled,
  isConfigDriftSentinelEnabled,
  KNOB_SUGGESTION_TARGET_PRECISION,
  loadKnobStatus,
  loadLiveKnobStatuses,
  runPerRepoKnobLoosening,
  PER_REPO_LOOSENING_MAX_REPOS_PER_TICK,
  runConfigDriftSentinel,
  runKnobLoosening,
  runScheduledKnobLoosening,
} from "../../src/services/knob-loosening-run";
import {
  SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
  SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY,
} from "../../src/services/satisfaction-floor-loosening-run";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { recordAuditEvent } from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

// #8176: the generic live-knob machinery. The evaluator itself is #8159's (own suite); these tests pin the
// double gating, the validated override read the gate policy consumes, the apply/alert path, and the
// generalized #8161 status projector (including the satisfaction floor's legacy proposal spelling).

const AI_KNOB = LOOSENABLE_KNOBS.ai_review_close_confidence!;
const SATISFACTION_KNOB = LOOSENABLE_KNOBS.satisfaction_floor!;

// cf-typegen types the var as the literal "false" from wrangler.jsonc's default — same `as never`
// escape hatch the satisfaction suite's enabledEnv uses.
const enabledEnv = (overrides: Partial<Env> = {}) => createTestEnv({ AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: "true" as never, ...overrides });

async function setOverrideRow(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// Membership-probe seeding (same technique as the satisfaction suites) sized for the AI knob's stricter
// floors: borderline-confirmed history between the first candidate (0.9) and the shipped 0.93 in both
// slices, plus one genuinely-reversed deep-low firing per slice so precision has a denominator.
async function seedAiLooseningFriendlyHistory(env: Env, repo = "acme/widgets"): Promise<void> {
  const pool = Array.from({ length: 400 }, (_, i) => `${repo}#${i + 1}`);
  const probe = pool.map((targetKey) => ({
    ruleId: AI_KNOB.ruleId,
    targetKey,
    outcome: "unaddressed",
    label: "confirmed" as const,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
  }));
  const { visible, heldOut } = splitBacktestCorpus(probe, AI_KNOB.heldOutFraction, AI_KNOB.splitSeed);
  const store = createSignalStore(env);
  const now = Date.now();
  const keys = [
    ...visible.slice(0, AI_KNOB.minVisibleCases + 4).map((c) => c.targetKey),
    ...heldOut.slice(0, AI_KNOB.minHeldOutCases + 2).map((c) => c.targetKey),
  ];
  for (const [i, targetKey] of keys.entries()) {
    await store.recordRuleFired({
      ruleId: AI_KNOB.ruleId,
      targetKey,
      outcome: "unaddressed",
      occurredAt: new Date(now - 10_000 - i).toISOString(),
      metadata: { confidence: 0.91 },
    });
    await store.recordHumanOverride({ ruleId: AI_KNOB.ruleId, targetKey, verdict: "confirmed", occurredAt: new Date(now - i).toISOString() });
  }
  for (const targetKey of [visible[AI_KNOB.minVisibleCases + 5]!.targetKey, heldOut[AI_KNOB.minHeldOutCases + 3]!.targetKey]) {
    await store.recordRuleFired({
      ruleId: AI_KNOB.ruleId,
      targetKey,
      outcome: "unaddressed",
      occurredAt: new Date(now - 20_000).toISOString(),
      metadata: { confidence: 0.2 },
    });
    await store.recordHumanOverride({ ruleId: AI_KNOB.ruleId, targetKey, verdict: "reversed", occurredAt: new Date(now - 5000).toISOString() });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registry ↔ run-module invariants (#8176)", () => {
  it("pins the satisfaction knob's registry literals to the legacy module's exported constants — they can never drift", () => {
    expect(SATISFACTION_KNOB.overrideFlagKey).toBe(SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY);
    expect(SATISFACTION_KNOB.looseningEventType).toBe(SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE);
    expect(SATISFACTION_KNOB.autotuneEnvVar).toBe("SATISFACTION_FLOOR_AUTOTUNE_ENABLED");
  });

  it("GENERIC_LIVE_KNOBS owns every live knob EXCEPT the satisfaction floor (its own module runs it)", () => {
    expect(GENERIC_LIVE_KNOBS.map((knob) => knob.knobId)).toEqual(["ai_review_close_confidence"]);
    // Parameterized form: a report-only knob is excluded even when not the satisfaction floor.
    const reportOnly = { ...AI_KNOB, knobId: "future_knob", applyMode: "report_only" as const };
    expect(genericLiveKnobs([reportOnly, SATISFACTION_KNOB, AI_KNOB]).map((knob) => knob.knobId)).toEqual(["ai_review_close_confidence"]);
  });
});

describe("isKnobAutotuneEnabled / getKnobOverride (#8176 double gating)", () => {
  it("parses the knob's own truthy-string var; unset/false/non-string are OFF", () => {
    for (const value of ["1", "true", "on", "yes", " TRUE "]) {
      expect(isKnobAutotuneEnabled({ AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: value } as unknown as Env, AI_KNOB)).toBe(true);
    }
    for (const value of ["false", "0", "", undefined]) {
      expect(isKnobAutotuneEnabled({ AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: value } as unknown as Env, AI_KNOB)).toBe(false);
    }
    expect(isKnobAutotuneEnabled({ AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: 1 } as unknown as Env, AI_KNOB)).toBe(false);
  });

  it("returns the stored override only when the flag is ON and the value is a strict, bounded loosening", async () => {
    const env = enabledEnv();
    expect(await getKnobOverride(env, AI_KNOB)).toBeNull(); // no row
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, "0.9");
    expect(await getKnobOverride(env, AI_KNOB)).toBe(0.9);
    expect(await getAiReviewCloseConfidenceOverride(env)).toBe(0.9); // the gate policy's convenience read

    // Flag off: the same valid row is IGNORED — flipping the var restores the shipped default instantly.
    expect(await getKnobOverride(createTestEnv({ ...env, AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: "false" as never }), AI_KNOB)).toBeNull();

    // Validation: at/above shipped (tightening-disguised-as-loosening), below hard minimum, non-numeric.
    for (const bad of [String(AI_KNOB.shippedValue), "0.97", String(AI_KNOB.hardMinimum - 0.01), "not-a-number"]) {
      await setOverrideRow(env, AI_KNOB.overrideFlagKey, bad);
      expect(await getKnobOverride(env, AI_KNOB)).toBeNull();
    }
  });

  it("per-repo overrides (#8216): the repo's earned row outranks global, invalid repo rows fall through, flag-off zeroes every scope", async () => {
    const env = enabledEnv();
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, "0.9"); // global
    await setOverrideRow(env, repoKnobOverrideFlagKey(AI_KNOB, "acme/widgets"), "0.85"); // repo-earned
    await setOverrideRow(env, repoKnobOverrideFlagKey(AI_KNOB, "acme/broken"), "0.99"); // invalid: above shipped

    // Repo row wins for its repo; other repos inherit global; invalid repo row falls through to global.
    expect(await getKnobOverrideForRepo(env, AI_KNOB, "acme/widgets")).toBe(0.85);
    expect(await getKnobOverrideForRepo(env, AI_KNOB, "acme/other")).toBe(0.9);
    expect(await getKnobOverrideForRepo(env, AI_KNOB, "acme/broken")).toBe(0.9);
    // Null repo = the plain global read; convenience wrapper threads the repo.
    expect(await getKnobOverrideForRepo(env, AI_KNOB, null)).toBe(0.9);
    expect(await getAiReviewCloseConfidenceOverride(env, "acme/widgets")).toBe(0.85);
    expect(await getAiReviewCloseConfidenceOverride(env)).toBe(0.9);

    // The knob's flag gates EVERY scope.
    const off = { ...env, AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: "false" as never } as Env;
    expect(await getKnobOverrideForRepo(off, AI_KNOB, "acme/widgets")).toBeNull();
  });

  it("fails safe (null) when the flag-store read throws", async () => {
    const env = enabledEnv();
    env.DB = { prepare: () => { throw new Error("boom"); } } as never;
    expect(await getKnobOverride(env, AI_KNOB)).toBeNull();
  });
});

describe("runKnobLoosening (#8176)", () => {
  it("REFUSES a report-only knob before anything else — applyMode is the registry's hard contract", async () => {
    const reportOnly = { ...AI_KNOB, applyMode: "report_only" as const };
    expect(await runKnobLoosening(enabledEnv(), reportOnly)).toEqual({ applied: false, reason: "report_only" });
  });

  it("returns flag_off / no_proposal / already_applied on the corresponding states without writing", async () => {
    expect(await runKnobLoosening(createTestEnv(), AI_KNOB)).toEqual({ applied: false, reason: "flag_off" });
    expect(await runKnobLoosening(enabledEnv(), AI_KNOB)).toEqual({ applied: false, reason: "no_proposal" }); // empty corpus
    const env = enabledEnv();
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, String(AI_KNOB.hardMinimum));
    expect(await runKnobLoosening(env, AI_KNOB)).toEqual({ applied: false, reason: "already_applied" });
  });

  it("applies a backtest-cleared loosening: writes the override row + the knob's own audit event", async () => {
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env);
    const result = await runKnobLoosening(env, AI_KNOB);
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error("unreachable");
    expect(result.proposal.proposedValue).toBe(AI_KNOB.candidates[0]);

    expect(await getKnobOverride(env, AI_KNOB)).toBe(AI_KNOB.candidates[0]);
    const events = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE event_type = ?")
      .bind(AI_KNOB.looseningEventType)
      .all<{ metadata_json: string }>();
    expect(events.results).toHaveLength(1);
    const proposal = (JSON.parse(events.results![0]!.metadata_json) as { proposal: { currentValue: number; proposedValue: number } }).proposal;
    expect(proposal).toMatchObject({ currentValue: AI_KNOB.shippedValue, proposedValue: AI_KNOB.candidates[0] });
  });

  it("defense in depth: the write path independently refuses a non-loosening or below-minimum proposal, whatever the evaluator claims", async () => {
    const env = enabledEnv();
    const base = {
      knobId: AI_KNOB.knobId,
      ruleId: AI_KNOB.ruleId,
      visibleCases: 60,
      heldOutCases: 15,
      visible: {} as never,
      heldOut: {} as never,
    };
    const spy = vi.spyOn(looseningKnobs, "evaluateKnobLoosening");
    spy.mockReturnValueOnce({ ...base, currentValue: AI_KNOB.shippedValue, proposedValue: AI_KNOB.shippedValue });
    expect(await runKnobLoosening(env, AI_KNOB)).toEqual({ applied: false, reason: "no_proposal" });
    spy.mockReturnValueOnce({ ...base, currentValue: AI_KNOB.shippedValue, proposedValue: AI_KNOB.hardMinimum - 0.1 });
    expect(await runKnobLoosening(env, AI_KNOB)).toEqual({ applied: false, reason: "no_proposal" });
    expect(await getKnobOverride(env, AI_KNOB)).toBeNull(); // nothing was written either time
  });
});

describe("runScheduledKnobLoosening (#8176 tick wrapper)", () => {
  it("emits exactly ONE structured error-level alert on an applied step, and none otherwise", async () => {
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const applied = await runScheduledKnobLoosening(env, AI_KNOB);
    expect(applied?.applied).toBe(true);
    const alerts = errorSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("calibration_knob_loosened"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('"ev":"ai_review_close_confidence"');

    errorSpy.mockClear();
    const second = await runScheduledKnobLoosening(env, AI_KNOB); // starts from the loosened value
    expect(second?.applied).toBe(false);
    expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("calibration_knob_loosened"))).toHaveLength(0);
  });

  it("fails SAFE: a thrown evaluation is warned and swallowed (null), never rethrown into the queue", async () => {
    const env = enabledEnv();
    env.DB = { prepare: () => { throw new Error("store down"); } } as never;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await runScheduledKnobLoosening(env, AI_KNOB)).toBeNull();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("knob_loosening_tick_failed"))).toBe(true);

    // A thrown NON-Error degrades to the generic message instead of crashing the formatter.
    const stringThrowEnv = enabledEnv();
    stringThrowEnv.DB = { prepare: () => { throw "string boom"; } } as never;
    expect(await runScheduledKnobLoosening(stringThrowEnv, AI_KNOB)).toBeNull();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('"error":"unknown error"'))).toBe(true);
  });

  it("the audit-event write is best-effort: a rejecting recordAuditEvent still applies the override (the catch arm)", async () => {
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env);
    const repositories = await import("../../src/db/repositories");
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("audit write down"));
    const result = await runKnobLoosening(env, AI_KNOB);
    expect(result.applied).toBe(true);
    expect(await getKnobOverride(env, AI_KNOB)).toBe(AI_KNOB.candidates[0]); // the override write was NOT sacrificed
  });
});

describe("processor + endpoint wiring (#8176)", () => {
  it("the shared loosening tick job runs every generic live knob when ITS flag is ON and no-ops when OFF", async () => {
    const offEnv = createTestEnv();
    await seedAiLooseningFriendlyHistory(offEnv);
    await processJob(offEnv, { type: "satisfaction-floor-loosening", requestedBy: "schedule" });
    expect(await getKnobOverride({ ...offEnv, AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: "true" as never } as Env, AI_KNOB)).toBeNull();

    const onEnv = enabledEnv();
    await seedAiLooseningFriendlyHistory(onEnv);
    await processJob(onEnv, { type: "satisfaction-floor-loosening", requestedBy: "schedule" });
    expect(await getKnobOverride(onEnv, AI_KNOB)).toBe(AI_KNOB.candidates[0]);
  });

  it("GET /v1/internal/calibration/knobs: 401 without the internal token; lists every live knob, NOT flag-gated, no private terms", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/internal/calibration/knobs", {}, env)).status).toBe(401);
    const res = await app.request("/v1/internal/calibration/knobs", { headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knobs: Array<{ knobId: string; flagEnabled: boolean }> };
    expect(body.knobs.map((knob) => knob.knobId).sort()).toEqual(["ai_review_close_confidence", "satisfaction_floor"]);
    expect(body.knobs.every((knob) => knob.flagEnabled === false)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/reward|payout|trust|wallet|hotkey|issueText|modelResponse/i);
  });
});

describe("runConfigDriftSentinel (#8213)", () => {
  const driftEnv = (base?: Env) => ({ ...(base ?? enabledEnv()), CONFIG_DRIFT_SENTINEL_ENABLED: "true" as never }) as Env;

  // A corpus where TIGHTENING wins: reversed cases sit at 0.91 — a 0.85 live floor misses them, the
  // shipped 0.93 catches them (recall up, no precision loss) — the stale-config shape the sentinel exists
  // to flag. Same membership-probe technique as the loosening seeder.
  async function seedDriftFriendlyHistory(env: Env): Promise<void> {
    const pool = Array.from({ length: 400 }, (_, i) => `acme/widgets#${i + 1}`);
    const probe = pool.map((targetKey) => ({
      ruleId: AI_KNOB.ruleId, targetKey, outcome: "unaddressed", label: "confirmed" as const,
      firedAt: "2026-07-01T00:00:00.000Z", decidedAt: "2026-07-02T00:00:00.000Z",
    }));
    const { visible, heldOut } = splitBacktestCorpus(probe, AI_KNOB.heldOutFraction, AI_KNOB.splitSeed);
    const store = createSignalStore(env);
    const now = Date.now();
    const seed = async (targetKey: string, confidence: number, verdict: "confirmed" | "reversed", i: number) => {
      await store.recordRuleFired({ ruleId: AI_KNOB.ruleId, targetKey, outcome: "unaddressed", occurredAt: new Date(now - 10_000 - i).toISOString(), metadata: { confidence } });
      await store.recordHumanOverride({ ruleId: AI_KNOB.ruleId, targetKey, verdict, occurredAt: new Date(now - i).toISOString() });
    };
    let i = 0;
    for (const c of visible.slice(0, AI_KNOB.minVisibleCases + 4)) await seed(c.targetKey, 0.91, "reversed", i++);
    for (const c of heldOut.slice(0, AI_KNOB.minHeldOutCases + 2)) await seed(c.targetKey, 0.91, "reversed", i++);
    await seed(visible[AI_KNOB.minVisibleCases + 5]!.targetKey, 0.2, "reversed", i++);
    await seed(heldOut[AI_KNOB.minHeldOutCases + 3]!.targetKey, 0.2, "reversed", i++);
  }

  it("flag parse mirrors the house convention", () => {
    expect(isConfigDriftSentinelEnabled({ CONFIG_DRIFT_SENTINEL_ENABLED: "true" } as unknown as Env)).toBe(true);
    expect(isConfigDriftSentinelEnabled({ CONFIG_DRIFT_SENTINEL_ENABLED: "false" } as unknown as Env)).toBe(false);
    expect(isConfigDriftSentinelEnabled({} as unknown as Env)).toBe(false);
  });

  it("alerts ONCE per drift episode, stays silent while it stands, re-alerts on change, clears on recovery", async () => {
    const env = driftEnv();
    // A live override at the hard minimum with a corpus proving the SHIPPED value dominates it → a
    // 'shipped'-direction (revert) drift, the actionable class.
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, String(AI_KNOB.hardMinimum));
    await seedDriftFriendlyHistory(env); // reversed cluster at 0.91: shipped 0.93 dominates a 0.85 live floor
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await runConfigDriftSentinel(env);
    expect(first.find((r) => r.knobId === AI_KNOB.knobId)?.state).toBe("alerted");
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("config_drift_detected"))).toHaveLength(1);

    errorSpy.mockClear();
    const second = await runConfigDriftSentinel(env);
    expect(second.find((r) => r.knobId === AI_KNOB.knobId)?.state).toBe("standing");
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("config_drift_detected"))).toHaveLength(0);

    // Recovery: remove the override -- live returns to shipped, nothing dominates, fingerprint clears.
    await env.DB.prepare("DELETE FROM system_flags WHERE key = ?").bind(AI_KNOB.overrideFlagKey).run();
    const third = await runConfigDriftSentinel(env);
    expect(third.find((r) => r.knobId === AI_KNOB.knobId)?.state).toBe("clean");
    // And a NEW episode after recovery alerts again.
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, String(AI_KNOB.hardMinimum));
    const fourth = await runConfigDriftSentinel(env);
    expect(fourth.find((r) => r.knobId === AI_KNOB.knobId)?.state).toBe("alerted");
  });

  it("suppresses a LOOSER-dominating result (the loosening loop owns that direction) and clears any stale fingerprint", async () => {
    const env = driftEnv();
    await seedAiLooseningFriendlyHistory(env); // from shipped 0.93, candidate 0.9 dominates → looser
    await env.DB.prepare("INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .bind(`config_drift_fingerprint:${AI_KNOB.knobId}`, "stale")
      .run();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const results = await runConfigDriftSentinel(env);
    expect(results.find((r) => r.knobId === AI_KNOB.knobId)?.state).toBe("suppressed_looser");
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("config_drift_detected"))).toHaveLength(0);
    const fp = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(`config_drift_fingerprint:${AI_KNOB.knobId}`).first();
    expect(fp ?? null).toBeNull(); // TestD1 returns undefined where live D1 returns null
  });

  it("is clean on an empty corpus and fail-safe per knob on a broken store", async () => {
    const clean = await runConfigDriftSentinel(driftEnv());
    expect(clean.every((r) => r.state === "clean")).toBe(true);

    const broken = driftEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const results = await runConfigDriftSentinel(broken);
    expect(results.every((r) => r.state === "clean")).toBe(true);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("config_drift_tick_failed"))).toBe(true);

    // Non-Error throw degrades to the generic message; a report-only knob is skipped entirely.
    const stringThrow = driftEnv();
    stringThrow.DB = { prepare: () => { throw "string boom"; } } as never;
    await runConfigDriftSentinel(stringThrow);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('"error":"unknown error"'))).toBe(true);
    const reportOnly = { ...AI_KNOB, knobId: "future_knob", applyMode: "report_only" as const };
    expect(await runConfigDriftSentinel(driftEnv(), [reportOnly])).toEqual([]);
  });

  it("the calibration tick job runs the sentinel only when its flag is ON (dispatch wiring)", async () => {
    const env = driftEnv();
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, String(AI_KNOB.hardMinimum));
    await seedDriftFriendlyHistory(env);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await processJob(env, { type: "satisfaction-floor-loosening", requestedBy: "schedule" });
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("config_drift_detected"))).toBe(true);

    errorSpy.mockClear();
    const off = { ...enabledEnv(), DB: env.DB } as Env; // sentinel flag unset
    await processJob(off, { type: "satisfaction-floor-loosening", requestedBy: "schedule" });
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("config_drift_detected"))).toBe(false);
  });
});

describe("runPerRepoKnobLoosening (#8217)", () => {
  it("a dense repo earns its OWN override while a sparse repo inherits global untouched", async () => {
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env, "acme/dense");
    // Sparse repo: a handful of cases, far under the knob's floors.
    const store = createSignalStore(env);
    for (let i = 1; i <= 3; i += 1) {
      await store.recordRuleFired({ ruleId: AI_KNOB.ruleId, targetKey: `acme/sparse#${i}`, outcome: "unaddressed", occurredAt: new Date(Date.now() - 5000).toISOString(), metadata: { confidence: 0.91 } });
      await store.recordHumanOverride({ ruleId: AI_KNOB.ruleId, targetKey: `acme/sparse#${i}`, verdict: "confirmed", occurredAt: new Date().toISOString() });
    }

    const results = await runPerRepoKnobLoosening(env, AI_KNOB);
    expect(results).toEqual([{ repoFullName: "acme/dense", applied: true, reason: "applied" }]);
    expect(await getKnobOverrideForRepo(env, AI_KNOB, "acme/dense")).toBe(AI_KNOB.candidates[0]);
    // Sparse repo: no repo row; resolution falls through to global (none here) -> null.
    expect(await getKnobOverrideForRepo(env, AI_KNOB, "acme/sparse")).toBeNull();
    // The repo-scoped audit event carries the scope + repo.
    const events = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE event_type = ?").bind(AI_KNOB.looseningEventType).all<{ metadata_json: string }>();
    const metadata = JSON.parse(events.results![0]!.metadata_json) as { scope?: string; repoFullName?: string };
    expect(metadata).toMatchObject({ scope: "repo", repoFullName: "acme/dense" });
  });

  it("second tick evaluates the earned repo from ITS value (no proposal left) — never oscillates; already-at-minimum reports as such", async () => {
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env, "acme/dense");
    await runPerRepoKnobLoosening(env, AI_KNOB);
    const second = await runPerRepoKnobLoosening(env, AI_KNOB);
    expect(second).toEqual([{ repoFullName: "acme/dense", applied: false, reason: "no_proposal" }]);

    await setOverrideRow(env, repoKnobOverrideFlagKey(AI_KNOB, "acme/dense"), String(AI_KNOB.hardMinimum));
    const third = await runPerRepoKnobLoosening(env, AI_KNOB);
    expect(third).toEqual([{ repoFullName: "acme/dense", applied: false, reason: "already_applied" }]);
  });

  it("gates: report-only knob and flag-off both do nothing; a broken store fails safe with a warn", async () => {
    const reportOnly = { ...AI_KNOB, applyMode: "report_only" as const };
    expect(await runPerRepoKnobLoosening(enabledEnv(), reportOnly)).toEqual([]);
    expect(await runPerRepoKnobLoosening(createTestEnv(), AI_KNOB)).toEqual([]);

    const broken = enabledEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await runPerRepoKnobLoosening(broken, AI_KNOB)).toEqual([]);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("per_repo_loosening_tick_failed"))).toBe(true);
  });

  it("empty eligibility returns cleanly; audit rejection is best-effort; a mid-repo error fails safe per repo; non-Error throws degrade", async () => {
    // Enabled but only sparse data -> zero eligible repos -> the early return, no cursor written.
    const sparseOnly = enabledEnv();
    const store = createSignalStore(sparseOnly);
    await store.recordRuleFired({ ruleId: AI_KNOB.ruleId, targetKey: "acme/sparse#1", outcome: "unaddressed", occurredAt: new Date().toISOString(), metadata: { confidence: 0.91 } });
    await store.recordHumanOverride({ ruleId: AI_KNOB.ruleId, targetKey: "acme/sparse#1", verdict: "confirmed", occurredAt: new Date().toISOString() });
    expect(await runPerRepoKnobLoosening(sparseOnly, AI_KNOB)).toEqual([]);

    // Audit write rejection: the override still lands (best-effort trail, never sacrificed writes).
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env, "acme/dense");
    const repositories = await import("../../src/db/repositories");
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("audit down"));
    const results = await runPerRepoKnobLoosening(env, AI_KNOB);
    expect(results).toEqual([{ repoFullName: "acme/dense", applied: true, reason: "applied" }]);
    expect(await getKnobOverrideForRepo(env, AI_KNOB, "acme/dense")).toBe(AI_KNOB.candidates[0]);
    vi.restoreAllMocks();

    // Mid-repo evaluator throw: that repo reports error, the tick survives.
    const env2 = enabledEnv();
    await seedAiLooseningFriendlyHistory(env2, "acme/dense");
    const looseningKnobsModule = await import("../../src/services/loosening-knobs");
    vi.spyOn(looseningKnobsModule, "evaluateKnobLoosening").mockImplementation(() => { throw "evaluator string boom"; });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errored = await runPerRepoKnobLoosening(env2, AI_KNOB);
    expect(errored).toEqual([{ repoFullName: "acme/dense", applied: false, reason: "error" }]);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("per_repo_loosening_failed") && String(c[0]).includes('"error":"unknown error"'))).toBe(true);
    vi.restoreAllMocks();

    // Inner catch with a REAL Error message, and the outer catch's non-Error arm via a string-throwing store.
    const env3 = enabledEnv();
    await seedAiLooseningFriendlyHistory(env3, "acme/dense");
    const knobsModule = await import("../../src/services/loosening-knobs");
    vi.spyOn(knobsModule, "evaluateKnobLoosening").mockImplementation(() => { throw new Error("evaluator real error"); });
    const warn3 = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runPerRepoKnobLoosening(env3, AI_KNOB);
    expect(warn3.mock.calls.some((c) => String(c[0]).includes("evaluator real error"))).toBe(true);
    vi.restoreAllMocks();

    const stringStore = enabledEnv();
    stringStore.DB = { prepare: () => { throw "outer string boom"; } } as never;
    const warn4 = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await runPerRepoKnobLoosening(stringStore, AI_KNOB)).toEqual([]);
    expect(warn4.mock.calls.some((c) => String(c[0]).includes("per_repo_loosening_tick_failed") && String(c[0]).includes('"error":"unknown error"'))).toBe(true);
  });

  it("caps the batch and rotates the cursor across ticks (deterministic order)", async () => {
    expect(PER_REPO_LOOSENING_MAX_REPOS_PER_TICK).toBe(10);
    const env = enabledEnv();
    // Two dense repos; cursor after tick 1 should sit at the last processed repo. With a batch cap of 10
    // both fit in one tick, so pin the cursor bookkeeping rather than the wraparound (covered by the
    // rotation arithmetic itself being deterministic on the sorted list).
    await seedAiLooseningFriendlyHistory(env, "acme/alpha");
    await seedAiLooseningFriendlyHistory(env, "acme/beta");
    const results = await runPerRepoKnobLoosening(env, AI_KNOB);
    expect(results.map((r) => r.repoFullName)).toEqual(["acme/alpha", "acme/beta"]);
    const cursor = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(`per_repo_loosening_cursor:${AI_KNOB.knobId}`).first<{ value: string }>();
    expect(cursor?.value).toBe("acme/beta");
    // Next tick starts AFTER the cursor: wraps to alpha first again (both still eligible).
    const second = await runPerRepoKnobLoosening(env, AI_KNOB);
    expect(second.map((r) => r.repoFullName)).toEqual(["acme/alpha", "acme/beta"]);
  });
});

describe("loadKnobStatus / loadLiveKnobStatuses (#8161 generalized)", () => {
  it("reports a lingering override row even with the flag OFF, and the live value only when ON", async () => {
    const env = createTestEnv();
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, "0.9");
    const off = await loadKnobStatus(env, AI_KNOB);
    expect(off).toMatchObject({ knobId: "ai_review_close_confidence", flagEnabled: false, storedOverride: 0.9, liveValue: AI_KNOB.shippedValue });
    expect(off.repoOverrides).toEqual([]);

    const on = await loadKnobStatus({ ...env, AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED: "true" as never } as Env, AI_KNOB);
    expect(on).toMatchObject({ flagEnabled: true, liveValue: 0.9 });

    // An out-of-bounds row is reported as no override at all (same validation as the consumption read).
    await setOverrideRow(env, AI_KNOB.overrideFlagKey, "0.99");
    expect((await loadKnobStatus(env, AI_KNOB)).storedOverride).toBeNull();

    // Per-repo listing (#8216): validated rows only, sorted by repo, invalid rows silently excluded.
    await setOverrideRow(env, repoKnobOverrideFlagKey(AI_KNOB, "zeta/repo"), "0.9");
    await setOverrideRow(env, repoKnobOverrideFlagKey(AI_KNOB, "acme/widgets"), "0.85");
    await setOverrideRow(env, repoKnobOverrideFlagKey(AI_KNOB, "bad/row"), "not-a-number");
    expect((await loadKnobStatus(env, AI_KNOB)).repoOverrides).toEqual([
      { repoFullName: "acme/widgets", value: 0.85 },
      { repoFullName: "zeta/repo", value: 0.9 },
    ]);
  });

  it("projects applied history from the knob's events — reading BOTH proposal spellings — and keeps corrupt rows visible as nulls", async () => {
    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env);
    await runKnobLoosening(env, AI_KNOB);
    const status = await loadKnobStatus(env, AI_KNOB);
    expect(status.applied).toHaveLength(1);
    expect(status.applied[0]!).toMatchObject({ currentValue: AI_KNOB.shippedValue, proposedValue: AI_KNOB.candidates[0], visibleVerdict: "improved" });

    // The satisfaction floor's legacy spelling renders through the same projector.
    await recordAuditEvent(env, {
      eventType: SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
      targetKey: SATISFACTION_KNOB.ruleId,
      outcome: "completed",
      metadata: { proposal: { currentFloor: 0.5, proposedFloor: 0.45, visibleCases: 24, heldOutCases: 7, visible: { verdict: "improved" }, heldOut: { verdict: "unchanged" } } },
    });
    const legacy = await loadKnobStatus(env, SATISFACTION_KNOB);
    expect(legacy.applied[0]!).toMatchObject({ currentValue: 0.5, proposedValue: 0.45, visibleVerdict: "improved", heldOutVerdict: "unchanged" });

    // A corrupt metadata row stays visible (an apply happened) with null fields.
    await env.DB.prepare("UPDATE audit_events SET metadata_json = 'corrupt' WHERE event_type = ?").bind(AI_KNOB.looseningEventType).run();
    const corrupt = await loadKnobStatus(env, AI_KNOB);
    expect(corrupt.applied).toHaveLength(1);
    expect(corrupt.applied[0]!.proposedValue).toBeNull();
  });

  it("reliability view (#8227): curve + derived suggestion ride the status; empty corpus and read blips degrade to null", async () => {
    expect(KNOB_SUGGESTION_TARGET_PRECISION).toBe(0.9);
    const empty = await loadKnobStatus(createTestEnv(), AI_KNOB);
    expect(empty.reliability).toBeNull(); // no cases at all -> no curve, never a fake one

    const env = enabledEnv();
    await seedAiLooseningFriendlyHistory(env);
    const status = await loadKnobStatus(env, AI_KNOB);
    expect(status.reliability).not.toBeNull();
    expect(status.reliability!.curve.buckets.length).toBeGreaterThan(0);
    const decided = status.reliability!.curve.buckets.reduce((sum, b) => sum + b.cases, 0);
    expect(decided).toBeGreaterThan(0);
    // The suggestion, when present, respects the knob's own hard minimum — same bound as every evaluator.
    if (status.reliability!.suggestion !== null) {
      expect(status.reliability!.suggestion).toBeGreaterThanOrEqual(AI_KNOB.hardMinimum);
    }
  });

  it("degrades on a broken DB (null override, empty history) and lists every live registry knob", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const status = await loadKnobStatus(broken, AI_KNOB);
    expect(status).toMatchObject({ storedOverride: null, applied: [], liveValue: AI_KNOB.shippedValue, drift: null });
    expect(status).toMatchObject({ storedOverride: null, applied: [], liveValue: AI_KNOB.shippedValue, reliability: null });

    const statuses = await loadLiveKnobStatuses(createTestEnv());
    expect(statuses.map((s) => s.knobId).sort()).toEqual(["ai_review_close_confidence", "satisfaction_floor"]);
    // Parameterized: a report-only knob is excluded from the surface.
    const reportOnly = { ...AI_KNOB, knobId: "future_knob", applyMode: "report_only" as const };
    expect((await loadLiveKnobStatuses(createTestEnv(), [reportOnly])).map((s) => s.knobId)).toEqual([]);
  });
});
