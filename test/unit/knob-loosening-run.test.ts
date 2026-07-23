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
  loadKnobStatus,
  loadLiveKnobStatuses,
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
async function seedAiLooseningFriendlyHistory(env: Env): Promise<void> {
  const pool = Array.from({ length: 400 }, (_, i) => `acme/widgets#${i + 1}`);
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

  it("degrades on a broken DB (null override, empty history) and lists every live registry knob", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const status = await loadKnobStatus(broken, AI_KNOB);
    expect(status).toMatchObject({ storedOverride: null, applied: [], liveValue: AI_KNOB.shippedValue });

    const statuses = await loadLiveKnobStatuses(createTestEnv());
    expect(statuses.map((s) => s.knobId).sort()).toEqual(["ai_review_close_confidence", "satisfaction_floor"]);
    // Parameterized: a report-only knob is excluded from the surface.
    const reportOnly = { ...AI_KNOB, knobId: "future_knob", applyMode: "report_only" as const };
    expect((await loadLiveKnobStatuses(createTestEnv(), [reportOnly])).map((s) => s.knobId)).toEqual([]);
  });
});
