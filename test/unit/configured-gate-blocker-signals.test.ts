import { afterEach, describe, expect, it, vi } from "vitest";
import { recordGateScoreSignals,
  RAW_CONTEXT_MAX_DIFF_CHARS,
  recordConfiguredGateBlockerSignals,
  type GateCheckPolicy,
} from "../../src/rules/advisory";
import * as signalTrackingWire from "../../src/review/signal-tracking-wire";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import type { Advisory, AdvisoryFinding } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function finding(over: Partial<AdvisoryFinding> & Pick<AdvisoryFinding, "code">): AdvisoryFinding {
  return {
    title: over.title ?? over.code,
    severity: over.severity ?? "warning",
    detail: over.detail ?? `${over.code} detail`,
    action: over.action ?? "fix it",
    ...over,
  };
}

function advisory(findings: AdvisoryFinding[]): Advisory {
  return {
    id: "advisory-8104",
    targetType: "pull_request",
    targetKey: "owner/repo#7",
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "abc",
    conclusion: "neutral",
    severity: "warning",
    title: "advisory",
    summary: `${findings.length} finding(s)`,
    findings,
    generatedAt: "2026-07-22T00:00:00.000Z",
  };
}

const blockAi: GateCheckPolicy = { aiReviewGateMode: "block" };
const blockLinked: GateCheckPolicy = { linkedIssueGateMode: "block" };
const blockSatisfaction: GateCheckPolicy = { linkedIssueSatisfactionGateMode: "block" };

describe("recordConfiguredGateBlockerSignals (#8104)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a fired signal for ai_consensus_defect when it is a configured gate blocker", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "ai_consensus_defect", confidence: 0.95 })]),
      blockAi,
      "owner/repo",
      7,
    );
    const history = await createSignalStore(env).queryRuleHistory("ai_consensus_defect", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      ruleId: "ai_consensus_defect",
      targetKey: "owner/repo#7",
      outcome: "warning",
      metadata: { confidence: 0.95 },
    });
  });

  it("records a fired signal for ai_review_split when it is a configured gate blocker", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "ai_review_split", severity: "critical" })]),
      blockAi,
      "owner/repo",
      7,
    );
    const history = await createSignalStore(env).queryRuleHistory("ai_review_split", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      ruleId: "ai_review_split",
      targetKey: "owner/repo#7",
      outcome: "critical",
    });
    expect(history.fired[0]?.metadata).toBeUndefined();
  });

  it("records a fired signal for a deterministic code (secret_leak)", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "secret_leak", severity: "critical" })]),
      {},
      "owner/repo",
      7,
    );
    const history = await createSignalStore(env).queryRuleHistory("secret_leak", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      ruleId: "secret_leak",
      targetKey: "owner/repo#7",
      outcome: "critical",
    });
  });

  it("records a fired signal for missing_linked_issue when linkedIssueGateMode is block", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "missing_linked_issue" })]),
      blockLinked,
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired).toHaveLength(1);
  });

  it("records NO fired signal for linked_issue_scope_mismatch even when it is a configured blocker (#8101 owns it)", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "linked_issue_scope_mismatch" }), finding({ code: "secret_leak", severity: "critical" })]),
      blockSatisfaction,
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0)).fired).toEqual([]);
    expect((await createSignalStore(env).queryRuleHistory("secret_leak", 0)).fired).toHaveLength(1);
  });

  it("records NO fired signal when isConfiguredGateBlocker returns false", async () => {
    const env = createTestEnv();
    // missing_linked_issue defaults to advisory — not a configured blocker.
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "missing_linked_issue" })]),
      { linkedIssueGateMode: "advisory" },
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired).toEqual([]);
  });

  it("uses outcome 'blocker' when finding.severity is missing (nullish coalescing arm)", async () => {
    const env = createTestEnv();
    const noSeverity = finding({ code: "secret_leak" });
    delete (noSeverity as { severity?: AdvisoryFinding["severity"] }).severity;
    await recordConfiguredGateBlockerSignals(env, advisory([noSeverity]), {}, "owner/repo", 7);
    expect((await createSignalStore(env).queryRuleHistory("secret_leak", 0)).fired[0]?.outcome).toBe("blocker");
  });

  it("degrades silently when the SignalStore write rejects: nothing throws", async () => {
    vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
      recordRuleFired: async () => {
        throw new Error("signal store down");
      },
      recordHumanOverride: async () => undefined,
      queryRuleHistory: async () => ({ fired: [], overrides: [] }),
    });
    await expect(
      recordConfiguredGateBlockerSignals(
        createTestEnv(),
        advisory([finding({ code: "secret_leak", severity: "critical" })]),
        {},
        "owner/repo",
        7,
      ),
    ).resolves.toBeUndefined();
  });
});

// ── #8130: bounded raw context in fired-event metadata (secret_leak permanently excluded) ───────────────────

describe("recordConfiguredGateBlockerSignals — raw context capture (#8130)", () => {
  it("SECURITY: secret_leak's fired event NEVER carries diff or rawSignal, even with confidence and detail present", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "secret_leak", severity: "critical", confidence: 0.99, detail: "AKIA... committed in config.ts" })]),
      {},
      "owner/repo",
      7,
      { aiReviewDiff: "+const key = 'AKIA-REAL-SECRET';" },
    );
    const [fired] = (await createSignalStore(env).queryRuleHistory("secret_leak", 0)).fired;
    expect(fired!.metadata).toEqual({ confidence: 0.99 });
    expect(fired!.metadata).not.toHaveProperty("diff");
    expect(fired!.metadata).not.toHaveProperty("rawSignal");
  });

  it("captures the AI review's diff (bounded to RAW_CONTEXT_MAX_DIFF_CHARS) for ai_consensus_defect", async () => {
    const env = createTestEnv();
    const oversized = "d".repeat(RAW_CONTEXT_MAX_DIFF_CHARS + 5000);
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "ai_consensus_defect", confidence: 0.95 })]),
      blockAi,
      "owner/repo",
      7,
      { aiReviewDiff: oversized },
    );
    const [fired] = (await createSignalStore(env).queryRuleHistory("ai_consensus_defect", 0)).fired;
    expect((fired!.metadata as { diff: string }).diff).toHaveLength(RAW_CONTEXT_MAX_DIFF_CHARS);
    expect((fired!.metadata as { confidence: number }).confidence).toBe(0.95);
  });

  it("records no diff key for an AI code when the caller has no diff to thread", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(env, advisory([finding({ code: "ai_review_split", confidence: 0.9 })]), blockAi, "owner/repo", 7);
    const [fired] = (await createSignalStore(env).queryRuleHistory("ai_review_split", 0)).fired;
    expect(fired!.metadata).toEqual({ confidence: 0.9 });
  });

  it("captures a non-diff-based code's own evaluated signal (its detail) as rawSignal — the audited fallback", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "missing_linked_issue", detail: "No linked issue reference found in the PR body." })]),
      blockLinked,
      "owner/repo",
      7,
      { aiReviewDiff: "+irrelevant" },
    );
    const [fired] = (await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired;
    expect(fired!.metadata).toEqual({ rawSignal: "No linked issue reference found in the PR body." });
  });

  it("records no metadata at all for a non-diff code with no confidence and an empty detail", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(env, advisory([finding({ code: "missing_linked_issue", detail: "" })]), blockLinked, "owner/repo", 7);
    const [fired] = (await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired;
    expect(fired!.metadata).toBeUndefined();
  });

  it("still skips linked_issue_scope_mismatch entirely (#8101's own site records it)", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "linked_issue_scope_mismatch" }), finding({ code: "missing_linked_issue" })]),
      { ...blockLinked, linkedIssueSatisfactionGateMode: "block" },
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0)).fired).toEqual([]);
    expect((await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired).toHaveLength(1);
  });
});

// ── #8223: score-gate fired signals — slop + quality capture ────────────────────────────────────────────────

describe("recordGateScoreSignals (#8223)", () => {
  it("fires slop_gate_score in block mode with the normalized score, threshold-crossing outcome, and rawSignal (never diff)", async () => {
    const env = createTestEnv();
    await recordGateScoreSignals(env, { slopGateMode: "block", slopRisk: 72, slopGateMinScore: 60 }, "owner/repo", 7);
    const history = await createSignalStore(env).queryRuleHistory("slop_gate_score", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      targetKey: "owner/repo#7",
      outcome: "above_threshold",
      metadata: { confidence: 0.72, rawSignal: "deterministic slop risk 72/100 vs threshold 60/100 (mode block)" },
    });
    expect(JSON.stringify(history.fired[0]!.metadata)).not.toContain("diff");
  });

  it("fires slop below-threshold with the default block threshold when no minScore is configured", async () => {
    const env = createTestEnv();
    await recordGateScoreSignals(env, { slopGateMode: "block", slopRisk: 30 }, "owner/repo", 7);
    const history = await createSignalStore(env).queryRuleHistory("slop_gate_score", 0);
    expect(history.fired[0]).toMatchObject({ outcome: "below_threshold", metadata: { confidence: 0.3 } });
  });

  it("fires slop under the merge-readiness composite promotion even when slopGateMode itself is unset (#551 parity)", async () => {
    // mergeReadinessGateMode: block promotes the slop sub-gate to block exactly as evaluateGateCheckCore's
    // own applyMergeReadinessGate does — the raw slopGateMode stays unset, and the write must still happen.
    const env = createTestEnv();
    await recordGateScoreSignals(env, { mergeReadinessGateMode: "block", slopRisk: 72, slopGateMinScore: 60 }, "owner/repo", 7);
    const history = await createSignalStore(env).queryRuleHistory("slop_gate_score", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({ outcome: "above_threshold", metadata: { confidence: 0.72 } });
  });

  it("records NOTHING for slop outside block mode or with a null risk — the gate never evaluated the score", async () => {
    const env = createTestEnv();
    await recordGateScoreSignals(env, { slopGateMode: "advisory", slopRisk: 72 }, "owner/repo", 7);
    await recordGateScoreSignals(env, { slopGateMode: "block" }, "owner/repo", 7);
    expect((await createSignalStore(env).queryRuleHistory("slop_gate_score", 0)).fired).toEqual([]);
  });

  it("fires quality_gate_score in advisory mode too — pass AND fail evaluations both leave corpus evidence", async () => {
    const env = createTestEnv();
    await recordGateScoreSignals(env, { qualityGateMode: "advisory", readinessScore: 80, qualityGateMinScore: 70 }, "owner/repo", 7);
    await recordGateScoreSignals(env, { qualityGateMode: "advisory", readinessScore: 40, qualityGateMinScore: 70 }, "owner/repo", 8);
    const history = await createSignalStore(env).queryRuleHistory("quality_gate_score", 0);
    expect(history.fired).toHaveLength(2);
    expect(history.fired.map((event) => event.outcome).sort()).toEqual(["at_or_above_threshold", "below_threshold"]);
    expect(history.fired.map((event) => event.metadata?.confidence).sort()).toEqual([0.4, 0.8]);
  });

  it("records NOTHING for quality when the mode is off or a score/threshold is missing", async () => {
    const env = createTestEnv();
    await recordGateScoreSignals(env, { qualityGateMode: "off", readinessScore: 40, qualityGateMinScore: 70 }, "owner/repo", 7);
    await recordGateScoreSignals(env, { qualityGateMode: "advisory", qualityGateMinScore: 70 }, "owner/repo", 7);
    await recordGateScoreSignals(env, { qualityGateMode: "advisory", readinessScore: 40 }, "owner/repo", 7);
    expect((await createSignalStore(env).queryRuleHistory("quality_gate_score", 0)).fired).toEqual([]);
  });

  it("degrades silently when the SignalStore write rejects — the call resolves normally", async () => {
    vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
      recordRuleFired: async () => {
        throw new Error("signal store down");
      },
      recordHumanOverride: async () => undefined,
      queryRuleHistory: async () => ({ fired: [], overrides: [] }),
    });
    await expect(
      recordGateScoreSignals(createTestEnv(), { slopGateMode: "block", slopRisk: 72, qualityGateMode: "advisory", readinessScore: 40, qualityGateMinScore: 70 }, "owner/repo", 7),
    ).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("INVARIANT (#8243): recorded confidence VARIES with finding inputs — constant-confidence capture can never return silently", async () => {
    // The historical ledger's decision layer stamped 1.0 on every close while 38% reversed; the live
    // capture is the corpus the loops now act on, so this pins that its confidence axis is real: three
    // findings with three different confidences must record three different values, byte-for-byte.
    const env = createTestEnv();
    for (const [pr, confidence] of [[1, 0.55], [2, 0.72], [3, 0.97]] as const) {
      await recordConfiguredGateBlockerSignals(
        env,
        advisory([finding({ code: "ai_consensus_defect", confidence })]),
        blockAi,
        "acme/widgets",
        pr,
        { aiReviewDiff: "diff --git a/x b/x" },
      );
    }
    const rows = await env.DB.prepare(
      "SELECT target_key, json_extract(metadata_json, '$.confidence') AS c FROM audit_events WHERE event_type = 'signal.rule_fired:ai_consensus_defect' ORDER BY target_key",
    ).all<{ target_key: string; c: number }>();
    const recorded = (rows.results ?? []).map((row) => row.c);
    expect(recorded).toEqual([0.55, 0.72, 0.97]);
    expect(new Set(recorded).size).toBe(3); // the axis varies — never a constant
  });
});
