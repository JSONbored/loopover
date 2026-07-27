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
