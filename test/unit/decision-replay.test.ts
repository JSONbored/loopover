import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deriveBlockerClass, deriveDecisionReasonCode, persistDecisionReplayInput, persistDecisionReplayInputForGate, replayDecision, type DecisionReplayInput } from "../../src/review/decision-replay";
import { runReplayBundle } from "../../scripts/replay-decision";
import { evaluateGateCheck } from "../../src/rules/advisory";
import { createTestEnv } from "../helpers/d1";

// #8838: the deterministic replay harness. Contracts: the fixed fixture corpus replays to match on every
// run (the CI smoke the issue requires), divergences report the FIRST divergent stage only, the reasonCode
// mapping is shared with the finalize site, and replay is a pure function (no-requery by construction).

type Bundle = { record: { id: string; reason_code: string; action: string }; replayInput: DecisionReplayInput };

const fixtureDir = "test/fixtures/decision-replay";
const bundles = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => [name, JSON.parse(readFileSync(`${fixtureDir}/${name}`, "utf8")) as Bundle] as const);

const replayable = (bundle: Bundle) => ({ id: bundle.record.id, reasonCode: bundle.record.reason_code, action: bundle.record.action });

describe("decision replay (#8838)", () => {
  it("CI smoke: the fixed fixture corpus is non-empty and every bundle replays to MATCH", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(4);
    for (const [name, bundle] of bundles) {
      const outcome = replayDecision(replayable(bundle), bundle.replayInput);
      expect(outcome.verdict, `${name} must replay bit-exactly`).toBe("match");
      if (outcome.verdict === "match") {
        expect(outcome.reasonCode).toBe(bundle.record.reason_code);
        expect(outcome.pinnedAction).toBe(bundle.record.action);
      }
    }
  });

  it("stage 1 — a tampered policy diverges at `conclusion` and reports nothing downstream", () => {
    const [, bundle] = bundles.find(([name]) => name === "ai-consensus-close.json")!;
    const tampered = { ...bundle.replayInput, policy: {} }; // drop block mode: the defect no longer blocks
    const outcome = replayDecision(replayable(bundle), tampered);
    expect(outcome).toMatchObject({ verdict: "divergence", stage: "conclusion", expected: "failure", actual: "success" });
  });

  it("stage 2 — same conclusion, different blocker set diverges at `blocker_codes`", () => {
    const [, bundle] = bundles.find(([name]) => name === "secret-leak-close.json")!;
    const extra = { ...bundle.replayInput, findings: [...bundle.replayInput.findings, { code: "ai_consensus_defect", title: "x", severity: "critical", detail: "d", confidence: 0.99 } as never], policy: { ...bundle.replayInput.policy, aiReviewGateMode: "block" as const, aiReviewCloseConfidence: 0.93 } };
    const outcome = replayDecision(replayable(bundle), extra);
    expect(outcome.verdict).toBe("divergence");
    if (outcome.verdict === "divergence") {
      expect(outcome.stage).toBe("blocker_codes");
      expect(outcome.actual).toContain("secret_leak");
      expect(outcome.actual).not.toBe(outcome.expected);
    }
  });

  it("stage 3 — a tampered public record reasonCode diverges at `reason_code`", () => {
    const [, bundle] = bundles.find(([name]) => name === "policy-close.json")!;
    const outcome = replayDecision({ ...replayable(bundle), reasonCode: "policy_close:doctored" }, bundle.replayInput);
    expect(outcome).toMatchObject({ verdict: "divergence", stage: "reason_code", expected: "policy_close:doctored", actual: "policy_close:stale_superseded" });
  });

  // #9135: the PUBLIC record's `divertedByHoldout` claim and the PRIVATE replay input's own `holdout.diverted`
  // outcome are written from the SAME holdout result at the SAME call site (processors.ts) — they can only
  // disagree if one was updated without the other, a real bug the pipeline's own re-derivation could never
  // catch (the holdout sits entirely outside evaluateGateCheck).
  it("stage 4 — holdout_consistency: an unexplained divergence between the record's claim and the replay input's own account is reported, not silently matched", () => {
    const [, bundle] = bundles.find(([name]) => name === "ai-consensus-close.json")!;
    // Case A: the record says diverted, but the replay input recorded no diversion (or none at all) — a hold
    // that was silently mislabeled as an ordinary decision, or the reverse.
    const recordClaimsDiverted = { ...replayable(bundle), divertedByHoldout: true };
    const inputSaysNotDiverted = { ...bundle.replayInput, holdout: { epsilonPct: 5, draw: 0.9, diverted: false } };
    expect(replayDecision(recordClaimsDiverted, inputSaysNotDiverted)).toMatchObject({
      verdict: "divergence",
      stage: "holdout_consistency",
      expected: "true",
      actual: "false",
    });
    // No holdout recorded at all (undefined) normalizes to false — same divergence.
    expect(replayDecision(recordClaimsDiverted, { ...bundle.replayInput, holdout: undefined })).toMatchObject({
      verdict: "divergence",
      stage: "holdout_consistency",
    });

    // Case B: the reverse — the record does NOT claim a diversion, but the replay input says it diverted.
    const recordClaimsNotDiverted = { ...replayable(bundle), divertedByHoldout: false };
    const inputSaysDiverted = { ...bundle.replayInput, holdout: { epsilonPct: 5, draw: 0.02, diverted: true } };
    expect(replayDecision(recordClaimsNotDiverted, inputSaysDiverted)).toMatchObject({
      verdict: "divergence",
      stage: "holdout_consistency",
      expected: "false",
      actual: "true",
    });

    // Consistent on both sides (including the common absent/absent case, which defaults false on both): MATCH.
    expect(replayDecision(recordClaimsNotDiverted, { ...bundle.replayInput, holdout: null }).verdict).toBe("match");
    expect(replayDecision({ ...replayable(bundle) }, bundle.replayInput).verdict).toBe("match"); // divertedByHoldout absent on the record too
    expect(replayDecision(recordClaimsDiverted, inputSaysDiverted).verdict).toBe("match");
  });

  it("persistDecisionReplayInputForGate (#9135): the holdout outcome rides along when supplied, and defaults null otherwise", async () => {
    const env = createTestEnv();
    const input = bundles[0]![1].replayInput;
    await persistDecisionReplayInputForGate(
      env,
      "record:o/r#20@s",
      { conclusion: "failure", blockers: [{ code: "secret_leak" }], replay: { findings: input.findings, policy: input.policy } },
      "kind",
      { epsilonPct: 5, draw: 0.9, diverted: false },
    );
    const withHoldout = await env.DB.prepare("SELECT replay_json FROM decision_replay_inputs WHERE record_id = 'record:o/r#20@s'").first<{ replay_json: string }>();
    expect((JSON.parse(withHoldout!.replay_json) as DecisionReplayInput).holdout).toEqual({ epsilonPct: 5, draw: 0.9, diverted: false });

    await persistDecisionReplayInputForGate(
      env,
      "record:o/r#21@s",
      { conclusion: "failure", blockers: [{ code: "secret_leak" }], replay: { findings: input.findings, policy: input.policy } },
      "kind",
    );
    const withoutHoldout = await env.DB.prepare("SELECT replay_json FROM decision_replay_inputs WHERE record_id = 'record:o/r#21@s'").first<{ replay_json: string }>();
    expect((JSON.parse(withoutHoldout!.replay_json) as DecisionReplayInput).holdout).toBeNull();
  });

  it("deriveDecisionReasonCode: blockerClass beats policy_close beats conclusion — the finalize site's exact mapping", () => {
    expect(deriveDecisionReasonCode("secret_leak", "stale", "failure")).toBe("secret_leak");
    expect(deriveDecisionReasonCode("none", "stale", "failure")).toBe("policy_close:stale");
    expect(deriveDecisionReasonCode("none", null, "success")).toBe("success");
  });

  it("deriveBlockerClass: first blocker code, else the neutral-hold reason, else none", () => {
    expect(deriveBlockerClass({ blockers: [{ code: "a" }, { code: "b" }], conclusion: "failure", warnings: [] })).toBe("a");
    expect(deriveBlockerClass({ blockers: [], conclusion: "success", warnings: [] })).toBe("none");
  });

  it("evaluateGateCheck attaches its exact inputs as `replay` on both the plain and dry-run paths", () => {
    const advisory = { id: "r", targetType: "pull_request", targetKey: "o/r#1", repoFullName: "o/r", pullNumber: 1, conclusion: "neutral", severity: "info", title: "t", summary: "s", findings: [], generatedAt: "2026-01-01T00:00:00.000Z" } as never;
    const plain = evaluateGateCheck(advisory, { aiReviewGateMode: "block" });
    expect(plain.replay?.policy).toEqual({ aiReviewGateMode: "block" });
    expect(plain.replay?.findings).toEqual([]);
    const dry = evaluateGateCheck(advisory, { dryRun: true });
    expect(dry.replay?.policy).toEqual({ dryRun: true });
  });

  it("persistDecisionReplayInput: insert, latest-wins upsert, and the fail-open warn arm", async () => {
    const env = createTestEnv();
    const input = bundles[0]![1].replayInput;
    await persistDecisionReplayInput(env, "record:o/r#1@s", input);
    await persistDecisionReplayInput(env, "record:o/r#1@s", { ...input, policyCloseKind: "updated" });
    const row = await env.DB.prepare("SELECT replay_json FROM decision_replay_inputs WHERE record_id = 'record:o/r#1@s'").first<{ replay_json: string }>();
    expect((JSON.parse(row!.replay_json) as DecisionReplayInput).policyCloseKind).toBe("updated");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = createTestEnv();
    vi.spyOn(broken.DB, "prepare").mockImplementation(() => {
      throw new Error("db down");
    });
    await persistDecisionReplayInput(broken, "record:o/r#1@s", input);
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("persistDecisionReplayInputForGate: a synthetic gate (no replay) is a silent no-op; a real one persists", async () => {
    const env = createTestEnv();
    await persistDecisionReplayInputForGate(env, "record:o/r#9@s", { conclusion: "success", blockers: [] }, null);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_replay_inputs").first<{ n: number }>()).toMatchObject({ n: 0 });
    const input = bundles[0]![1].replayInput;
    await persistDecisionReplayInputForGate(env, "record:o/r#9@s", { conclusion: "failure", blockers: [{ code: "secret_leak" }], replay: { findings: input.findings, policy: input.policy } }, "kind");
    const row = await env.DB.prepare("SELECT replay_json FROM decision_replay_inputs WHERE record_id = 'record:o/r#9@s'").first<{ replay_json: string }>();
    const stored = JSON.parse(row!.replay_json) as DecisionReplayInput;
    expect(stored.policyCloseKind).toBe("kind");
    expect(stored.evaluated).toEqual({ conclusion: "failure", blockerCodes: ["secret_leak"] });
  });

  it("CLI bundle normalization: snake_case rows replay; garbage and incomplete bundles report unusable", () => {
    const [, bundle] = bundles[0]!;
    const ok = runReplayBundle(JSON.stringify(bundle));
    expect(ok.outcome?.verdict).toBe("match");
    const camel = runReplayBundle(JSON.stringify({ record: { id: bundle.record.id, reasonCode: bundle.record.reason_code, action: bundle.record.action }, replayInput: bundle.replayInput }));
    expect(camel.outcome?.verdict).toBe("match");
    expect(runReplayBundle("{nope").outcome).toBeNull();
    expect(runReplayBundle(JSON.stringify({ record: { id: "x" } })).outcome).toBeNull();
    expect(runReplayBundle(JSON.stringify({ replayInput: bundle.replayInput })).outcome).toBeNull();
  });
});

// #9028: wall-clock capture. Time is a decision INPUT — `gate.requireFreshRebaseWindow` compares the base
// branch's tip against "now", so a decision shaped by it is only replayable if the instant it used was
// recorded. These are the seeded per-rule regressions the issue requires: replay at the recorded instant is
// bit-exact, replay at a DIFFERENT instant is never silently accepted.
describe("staleness rules are clock-injected and replayable (#9028)", () => {
  // A fixed seed instant, so every assertion below is a pure function of literals — no ambient Date.now().
  const SEEDED_NOW_MS = 1_800_000_000_000;

  it("requireFreshRebaseWindow: PURE and clock-injected — both arms, at a seeded instant", async () => {
    const { isWithinFreshRebaseWindow, MS_PER_MINUTE } = await import("../../src/review/staleness-clock");
    const windowMinutes = 30;
    // Inside the window: the base moved 29m before the captured instant.
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs: SEEDED_NOW_MS - 29 * MS_PER_MINUTE, windowMinutes, nowMs: SEEDED_NOW_MS })).toBe(true);
    // Exactly at the boundary is OUTSIDE (`>=` in the original guard) — pinned so the edge cannot drift.
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs: SEEDED_NOW_MS - 30 * MS_PER_MINUTE, windowMinutes, nowMs: SEEDED_NOW_MS })).toBe(false);
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs: SEEDED_NOW_MS - 31 * MS_PER_MINUTE, windowMinutes, nowMs: SEEDED_NOW_MS })).toBe(false);
    // Clock skew: a base commit dated AFTER the captured instant reads as "just moved", never as stale.
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs: SEEDED_NOW_MS + MS_PER_MINUTE, windowMinutes, nowMs: SEEDED_NOW_MS })).toBe(true);
    // Unreadable base commit → fail-open (no manufactured rebase), matching the live call site's guard.
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs: Number.NaN, windowMinutes, nowMs: SEEDED_NOW_MS })).toBe(false);
  });

  it("requireFreshRebaseWindow: the SAME inputs flip answer as the instant moves — which is why it must be recorded", async () => {
    const { isWithinFreshRebaseWindow, MS_PER_MINUTE } = await import("../../src/review/staleness-clock");
    const baseAdvancedAtMs = SEEDED_NOW_MS - 10 * MS_PER_MINUTE;
    const windowMinutes = 30;
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs, windowMinutes, nowMs: SEEDED_NOW_MS })).toBe(true);
    // Replaying the identical rule inputs an hour later reaches the OPPOSITE answer. This is the whole
    // hazard #9028 closes: without the recorded instant, that flip is invisible and reads as a match.
    expect(isWithinFreshRebaseWindow({ baseAdvancedAtMs, windowMinutes, nowMs: SEEDED_NOW_MS + 60 * MS_PER_MINUTE })).toBe(false);
  });

  it("staleBaseAheadByThreshold: PURE and provably instant-INDEPENDENT (a commit count carries no 'now')", async () => {
    const { isBaseStaleByAheadBy } = await import("../../src/review/staleness-clock");
    expect(isBaseStaleByAheadBy({ aheadBy: 20, threshold: 20 })).toBe(true); // boundary is inclusive (`>=`)
    expect(isBaseStaleByAheadBy({ aheadBy: 19, threshold: 20 })).toBe(false);
    expect(isBaseStaleByAheadBy({ aheadBy: 21, threshold: 20 })).toBe(true);
    // Unreadable compare-API response → fail-open, matching the live `typeof aheadBy === "number"` guard.
    expect(isBaseStaleByAheadBy({ aheadBy: Number.NaN, threshold: 20 })).toBe(false);
    // The instant-independence property itself: the signature admits no clock, so no reachable instant can
    // change the answer. Pinned against the same seeded instants the fresh-rebase rule flips across above.
    const args = { aheadBy: 20, threshold: 20 };
    vi.useFakeTimers();
    vi.setSystemTime(SEEDED_NOW_MS);
    const atSeed = isBaseStaleByAheadBy(args);
    vi.setSystemTime(SEEDED_NOW_MS + 365 * 24 * 60 * 60 * 1000);
    expect(isBaseStaleByAheadBy(args)).toBe(atSeed);
    vi.useRealTimers();
  });

  it("stage 0 — replay at the RECORDED instant is bit-exact; a DIFFERENT instant diverges at `clock`", () => {
    const [, bundle] = bundles.find(([name]) => name === "clean-merge.json")!;
    const withClock: DecisionReplayInput = { ...bundle.replayInput, clock: { nowMs: SEEDED_NOW_MS } };
    // No instant named → replay at the recorded one → bit-exact match (the CLI default).
    expect(replayDecision(replayable(bundle), withClock).verdict).toBe("match");
    // The recorded instant, named explicitly → still a match.
    expect(replayDecision(replayable(bundle), withClock, { nowMs: SEEDED_NOW_MS }).verdict).toBe("match");
    // A different instant → NOT silently accepted. `clock` is checked before every other stage.
    expect(replayDecision(replayable(bundle), withClock, { nowMs: SEEDED_NOW_MS + 1 })).toMatchObject({
      verdict: "divergence",
      stage: "clock",
      expected: String(SEEDED_NOW_MS),
      actual: String(SEEDED_NOW_MS + 1),
    });
  });

  it("stage 0 — a pre-#9028 record has no recorded instant, so the clock stage is skipped, not guessed", () => {
    const [, bundle] = bundles.find(([name]) => name === "clean-merge.json")!;
    // No `clock` at all (every record written before this change): nothing to contradict, so the remaining
    // stages still replay normally rather than the harness inventing an instant and failing every old record.
    expect(replayDecision(replayable(bundle), bundle.replayInput, { nowMs: SEEDED_NOW_MS }).verdict).toBe("match");
    expect(replayDecision(replayable(bundle), { ...bundle.replayInput, clock: null }, { nowMs: SEEDED_NOW_MS }).verdict).toBe("match");
  });

  it("the captured instant round-trips through persistence into replay_json", async () => {
    const env = createTestEnv();
    const input = bundles[0]![1].replayInput;
    await persistDecisionReplayInputForGate(
      env,
      "record:o/r#42@s",
      { conclusion: "success", blockers: [], replay: { findings: input.findings, policy: input.policy } },
      null,
      null,
      { nowMs: SEEDED_NOW_MS },
    );
    const row = await env.DB.prepare("SELECT replay_json FROM decision_replay_inputs WHERE record_id = 'record:o/r#42@s'").first<{ replay_json: string }>();
    expect((JSON.parse(row!.replay_json) as DecisionReplayInput).clock).toEqual({ nowMs: SEEDED_NOW_MS });
    // Omitting the capture stores an explicit null (a pre-#9028-shaped row), never an invented instant.
    await persistDecisionReplayInputForGate(env, "record:o/r#43@s", { conclusion: "success", blockers: [], replay: { findings: input.findings, policy: input.policy } }, null);
    const bare = await env.DB.prepare("SELECT replay_json FROM decision_replay_inputs WHERE record_id = 'record:o/r#43@s'").first<{ replay_json: string }>();
    expect((JSON.parse(bare!.replay_json) as DecisionReplayInput).clock).toBeNull();
  });

  it("CLI --at: the recorded instant matches, a different one exits with a clock divergence", () => {
    const [, bundle] = bundles.find(([name]) => name === "clean-merge.json")!;
    const withClock = { ...bundle, replayInput: { ...bundle.replayInput, clock: { nowMs: SEEDED_NOW_MS } } };
    const raw = JSON.stringify(withClock);
    expect(runReplayBundle(raw).outcome?.verdict).toBe("match");
    expect(runReplayBundle(raw, SEEDED_NOW_MS).outcome?.verdict).toBe("match");
    expect(runReplayBundle(raw, SEEDED_NOW_MS + 86_400_000).outcome).toMatchObject({ verdict: "divergence", stage: "clock" });
  });
});
