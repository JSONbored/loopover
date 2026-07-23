import { afterEach, describe, expect, it, vi } from "vitest";
import { splitBacktestCorpus } from "@loopover/engine";
import {
  getSatisfactionFloorOverride,
  isSatisfactionFloorAutotuneEnabled,
  runSatisfactionFloorLoosening,
  SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
  SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY,
} from "../../src/services/satisfaction-floor-loosening-run";
import * as core from "../../src/services/satisfaction-floor-loosening";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "../../src/services/linked-issue-satisfaction";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { listAuditEventsByType } from "../../src/db/repositories";
import * as repositories from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.restoreAllMocks();
});

const enabledEnv = (overrides: Partial<Env> = {}) => createTestEnv({ SATISFACTION_FLOOR_AUTOTUNE_ENABLED: "true" as never, ...overrides });

async function setOverrideRow(env: Env, value: string) {
  await env.DB.prepare("INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY, value)
    .run();
}

describe("isSatisfactionFloorAutotuneEnabled (#8121)", () => {
  it("accepts the repo's truthy-string spellings and rejects everything else, including absent", () => {
    for (const value of ["1", "true", "on", "yes", " TRUE "]) {
      expect(isSatisfactionFloorAutotuneEnabled(createTestEnv({ SATISFACTION_FLOOR_AUTOTUNE_ENABLED: value as never }))).toBe(true);
    }
    for (const value of ["false", "0", "", "off", undefined]) {
      expect(isSatisfactionFloorAutotuneEnabled(createTestEnv({ SATISFACTION_FLOOR_AUTOTUNE_ENABLED: value as never }))).toBe(false);
    }
  });
});

describe("getSatisfactionFloorOverride (#8121)", () => {
  it("returns null when the autotune flag is off — flipping the flag off instantly restores the shipped floor", async () => {
    const env = createTestEnv();
    await setOverrideRow(env, "0.4");
    expect(await getSatisfactionFloorOverride(env)).toBeNull();
  });

  it("returns a valid stored override, and null when no row exists", async () => {
    const env = enabledEnv();
    expect(await getSatisfactionFloorOverride(env)).toBeNull();
    await setOverrideRow(env, "0.4");
    expect(await getSatisfactionFloorOverride(env)).toBe(0.4);
  });

  it("rejects values that would tighten (>= shipped floor), pass the hard minimum, or fail to parse", async () => {
    const env = enabledEnv();
    for (const bad of [String(LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR), "0.9", String(core.SATISFACTION_FLOOR_HARD_MINIMUM - 0.05), "not-a-number"]) {
      await setOverrideRow(env, bad);
      expect(await getSatisfactionFloorOverride(env)).toBeNull();
    }
  });

  it("fails safe to null on a DB error", async () => {
    const env = enabledEnv();
    env.DB = { prepare: () => { throw new Error("boom"); } } as never;
    expect(await getSatisfactionFloorOverride(env)).toBeNull();
  });
});

describe("runSatisfactionFloorLoosening (#8121)", () => {
  async function seedLooseningFriendlyHistory(env: Env) {
    // Same membership-probe technique as the pure-core suite: ask the real splitter which keys land where,
    // then seed borderline-confirmed history in both slices so 0.5 -> 0.45 clears both gates.
    const pool = Array.from({ length: 120 }, (_, i) => `acme/widgets#${i + 1}`);
    const probe = pool.map((targetKey) => ({
      ruleId: core.SATISFACTION_FLOOR_RULE_ID,
      targetKey,
      outcome: "unaddressed",
      label: "confirmed" as const,
      firedAt: "2026-07-01T00:00:00.000Z",
      decidedAt: "2026-07-02T00:00:00.000Z",
    }));
    const { visible, heldOut } = splitBacktestCorpus(probe, core.SATISFACTION_FLOOR_HELD_OUT_FRACTION, core.SATISFACTION_FLOOR_SPLIT_SEED);
    const store = createSignalStore(env);
    const now = Date.now();
    const keys = [
      ...visible.slice(0, core.SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4).map((c) => c.targetKey),
      ...heldOut.slice(0, core.SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2).map((c) => c.targetKey),
    ];
    for (const [i, targetKey] of keys.entries()) {
      await store.recordRuleFired({
        ruleId: core.SATISFACTION_FLOOR_RULE_ID,
        targetKey,
        outcome: "unaddressed",
        occurredAt: new Date(now - 10_000 - i).toISOString(),
        metadata: { confidence: 0.47 },
      });
      await store.recordHumanOverride({ ruleId: core.SATISFACTION_FLOOR_RULE_ID, targetKey, verdict: "confirmed", occurredAt: new Date(now - i).toISOString() });
    }
    // One genuinely-reversed deep-low-confidence firing per slice, mirroring the pure-core fixture: a true
    // positive must exist on both sides of the comparison or the candidate's precision denominator is 0
    // (null) and the improvement can't register on any axis.
    for (const targetKey of [visible[core.SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 5]!.targetKey, heldOut[core.SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 3]!.targetKey]) {
      await store.recordRuleFired({
        ruleId: core.SATISFACTION_FLOOR_RULE_ID,
        targetKey,
        outcome: "unaddressed",
        occurredAt: new Date(now - 20_000).toISOString(),
        metadata: { confidence: 0.1 },
      });
      await store.recordHumanOverride({ ruleId: core.SATISFACTION_FLOOR_RULE_ID, targetKey, verdict: "reversed", occurredAt: new Date(now - 5000).toISOString() });
    }
  }

  it("returns flag_off without touching anything when the autotune flag is not set", async () => {
    expect(await runSatisfactionFloorLoosening(createTestEnv())).toEqual({ applied: false, reason: "flag_off" });
  });

  it("returns no_proposal on an empty corpus", async () => {
    expect(await runSatisfactionFloorLoosening(enabledEnv())).toEqual({ applied: false, reason: "no_proposal" });
  });

  it("applies a backtest-cleared loosening: writes the override row + the calibration audit event", async () => {
    const env = enabledEnv();
    await seedLooseningFriendlyHistory(env);
    const result = await runSatisfactionFloorLoosening(env);
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error("unreachable");
    expect(result.proposal.proposedFloor).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);

    expect(await getSatisfactionFloorOverride(env)).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
    const audits = await listAuditEventsByType(env, SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE, new Date(Date.now() - 60_000).toISOString());
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata.proposal).toMatchObject({ currentFloor: 0.5, proposedFloor: core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0] });
  });

  it("re-evaluates from the CURRENT (already-loosened) floor — one candidate step per run, never oscillating upward", async () => {
    const env = enabledEnv();
    await seedLooseningFriendlyHistory(env);
    expect((await runSatisfactionFloorLoosening(env)).applied).toBe(true);
    // Second run: current floor is now 0.45; the same corpus (borderline 0.47 cases sit ABOVE it) offers no
    // further improvement, so nothing more is applied and the override stays where it was.
    expect(await runSatisfactionFloorLoosening(env)).toEqual({ applied: false, reason: "no_proposal" });
    expect(await getSatisfactionFloorOverride(env)).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
  });

  it("audit write is best-effort: a failed audit record never blocks an applied loosening", async () => {
    const env = enabledEnv();
    await seedLooseningFriendlyHistory(env);
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("audit down"));
    const result = await runSatisfactionFloorLoosening(env);
    expect(result.applied).toBe(true);
    expect(await getSatisfactionFloorOverride(env)).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
  });

  it("returns already_applied once the live floor sits at/below the hard minimum", async () => {
    const env = enabledEnv();
    await setOverrideRow(env, String(core.SATISFACTION_FLOOR_HARD_MINIMUM));
    expect(await runSatisfactionFloorLoosening(env)).toEqual({ applied: false, reason: "already_applied" });
  });

  it("defense-in-depth: refuses a proposal that is not a strict bounded loosening, whatever the evaluator claims", async () => {
    const env = enabledEnv();
    const bogus: core.SatisfactionFloorLooseningProposal = {
      ruleId: core.SATISFACTION_FLOOR_RULE_ID,
      currentFloor: 0.5,
      proposedFloor: 0.6, // tightening disguised as a proposal — must be refused by the write path itself
      visibleCases: 100,
      heldOutCases: 30,
      visible: {} as never,
      heldOut: {} as never,
    };
    vi.spyOn(core, "evaluateSatisfactionFloorLoosening").mockReturnValue(bogus);
    expect(await runSatisfactionFloorLoosening(env)).toEqual({ applied: false, reason: "no_proposal" });
    expect(await getSatisfactionFloorOverride(env)).toBeNull();
  });
});
