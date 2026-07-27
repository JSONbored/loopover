import { describe, expect, it, vi } from "vitest";
import { applyCloseAuditHoldout, hmacHexToUnitFloat, holdoutEligibleClose, maybeApplyCloseAuditHoldout } from "../../src/review/close-audit-holdout";
import type { PlannedAgentAction } from "../../src/settings/agent-actions";
import { createTestEnv } from "../helpers/d1";

// #8831: the selective-labels fix. The invariants that make the instrument honest are pinned here: the draw
// consumes the FINAL plan, ε=0 is byte-identical, only heuristic auto-closes are eligible, and a hold whose
// propensity record failed to write NEVER happens (an unlogged hold would silently bias every estimator).
// #9135: the draw is now HMAC-derived (reproducible from the record, unpredictable without the instance
// secret) rather than Math.random(), and every call reports its decision-time holdout outcome for the
// caller to persist onto the decision record and its replay input.
function close(over: Partial<PlannedAgentAction> = {}): PlannedAgentAction {
  return { actionClass: "close", closeKind: "heuristic", requiresApproval: false, reason: "ci failing", ...over } as PlannedAgentAction;
}
const label = (name: string): PlannedAgentAction => ({ actionClass: "label", label: name, labelOp: "add", reason: "r", requiresApproval: false }) as PlannedAgentAction;

describe("holdoutEligibleClose", () => {
  it("matches only heuristic closes executing without a human", () => {
    expect(holdoutEligibleClose([close()])).toBeDefined();
    expect(holdoutEligibleClose([close({ closeKind: "contributor_cap" })])).toBeUndefined(); // enforcement
    expect(holdoutEligibleClose([close({ closeKind: "linked-issue-hard-rule" })])).toBeUndefined();
    expect(holdoutEligibleClose([close({ requiresApproval: true })])).toBeUndefined(); // staged — a human already reviews
    expect(holdoutEligibleClose([label("x")])).toBeUndefined();
  });
});

describe("applyCloseAuditHoldout (pure transform)", () => {
  it("drops the heuristic close, keeps everything else, and adds the manual-review label idempotently", () => {
    const plan = [close(), label("keep-me")];
    const next = applyCloseAuditHoldout(plan, { manualReviewLabel: "needs-human" });
    expect(next.some((a) => a.actionClass === "close")).toBe(false);
    expect(next.some((a) => a.actionClass === "label" && a.label === "keep-me")).toBe(true);
    expect(next.filter((a) => a.actionClass === "label" && a.label === "needs-human")).toHaveLength(1);
    // Already carrying the manual-review label → no duplicate.
    const again = applyCloseAuditHoldout([close(), label("needs-human")], { manualReviewLabel: "needs-human" });
    expect(again.filter((a) => a.actionClass === "label" && a.label === "needs-human")).toHaveLength(1);
    // A policy close is never dropped by this transform.
    const policy = applyCloseAuditHoldout([close({ closeKind: "blacklist" })], { manualReviewLabel: "needs-human" });
    expect(policy.some((a) => a.actionClass === "close")).toBe(true);
  });
});

describe("hmacHexToUnitFloat", () => {
  it("maps the first 4 bytes of a hex digest to a [0,1) float, at the known endpoints", () => {
    expect(hmacHexToUnitFloat("00000000" + "ff".repeat(28))).toBe(0);
    expect(hmacHexToUnitFloat("ffffffff" + "00".repeat(28))).toBe(0.9999999997671694);
    expect(hmacHexToUnitFloat("80000000" + "00".repeat(28))).toBe(0.5);
  });
});

describe("maybeApplyCloseAuditHoldout (the full step)", () => {
  const planWithClose = () => [close()];

  it("ε=0 / absent / non-auto autonomy / no eligible close → plan returned untouched with ZERO writes, holdout: null", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(env.DB, "prepare");
    const base = { repoFullName: "o/r", pullNumber: 7, headSha: "abc123", labelSettings: {}, closeAutonomyIsAuto: true };
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: planWithClose(), epsilonPct: 0 })).toEqual({ planned: planWithClose(), holdout: null });
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: planWithClose(), epsilonPct: undefined })).toEqual({ planned: planWithClose(), holdout: null });
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: planWithClose(), epsilonPct: 5, closeAutonomyIsAuto: false })).toEqual({ planned: planWithClose(), holdout: null });
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: [label("x")], epsilonPct: 5 })).toEqual({ planned: [label("x")], holdout: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a draw under ε diverts the close, logs the propensity record, files the pending holdout label, and reports diverted:true", async () => {
    const env = createTestEnv();
    const { planned: next, holdout } = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 7,
      headSha: "abc123",
      planned: planWithClose(),
      epsilonPct: 5,
      closeAutonomyIsAuto: true,
      labelSettings: { manualReviewLabel: "needs-human" },
      rng: () => 0.01, // 1% < 5%
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(false);
    expect(holdout).toEqual({ epsilonPct: 5, draw: 0.01, diverted: true });
    const audit = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE event_type = 'decision_audit_holdout' AND target_key = 'o/r#7'").first<{ metadata_json: string }>();
    const metadata = JSON.parse(audit!.metadata_json) as Record<string, unknown>;
    expect(metadata).toMatchObject({ epsilonPct: 5, draw: 0.01, counterfactualAction: "close" });
    const row = await env.DB.prepare("SELECT verdict, outcome, stratum, status FROM decision_audit_labels WHERE target_id = 'o/r#7'").first<{ verdict: string; outcome: string | null; stratum: string; status: string }>();
    expect(row).toEqual({ verdict: "close", outcome: null, stratum: "holdout_close", status: "pending" });
  });

  it("a draw at/above ε lets the close proceed, records nothing, and reports diverted:false", async () => {
    const env = createTestEnv();
    const { planned: next, holdout } = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 7,
      headSha: "abc123",
      planned: planWithClose(),
      epsilonPct: 5,
      closeAutonomyIsAuto: true,
      rng: () => 0.05, // exactly ε — the held region is [0, ε), so this proceeds
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(true);
    expect(holdout).toEqual({ epsilonPct: 5, draw: 0.05, diverted: false });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("uses the deterministic HMAC-derived draw when none is injected — reproducible for the same (repo, pr, head sha), and ε=100 always diverts", async () => {
    const env = createTestEnv();
    const call = () =>
      maybeApplyCloseAuditHoldout(env, {
        repoFullName: "o/r",
        pullNumber: 8,
        headSha: "deadbeef",
        planned: planWithClose(),
        epsilonPct: 100 as never, // parse clamps real config to 20; the module itself only compares
        closeAutonomyIsAuto: true,
      });
    const first = await call();
    expect(first.planned.some((a) => a.actionClass === "close")).toBe(false); // any draw in [0,1) < 1.0
    expect(first.holdout?.diverted).toBe(true);

    // A SECOND, independent decision for the SAME (repo, pr, head sha) must reproduce the IDENTICAL draw —
    // the whole point of deriving it from a recorded seed instead of raw entropy. Use a tiny ε so the test
    // actually distinguishes "same draw" from "any draw" (both would divert at ε=100).
    const secondEnv = createTestEnv();
    const a = await maybeApplyCloseAuditHoldout(secondEnv, {
      repoFullName: "o/r2",
      pullNumber: 9,
      headSha: "cafef00d",
      planned: planWithClose(),
      epsilonPct: 100,
      closeAutonomyIsAuto: true,
    });
    const b = await maybeApplyCloseAuditHoldout(secondEnv, {
      repoFullName: "o/r2",
      pullNumber: 9,
      headSha: "cafef00d",
      planned: planWithClose(),
      epsilonPct: 100,
      closeAutonomyIsAuto: true,
    });
    expect(a.holdout?.draw).toBe(b.holdout?.draw);

    // A DIFFERENT head sha for the same repo/PR must NOT reliably reproduce the same draw (different seed).
    const c = await maybeApplyCloseAuditHoldout(secondEnv, {
      repoFullName: "o/r2",
      pullNumber: 9,
      headSha: "different-head",
      planned: planWithClose(),
      epsilonPct: 100,
      closeAutonomyIsAuto: true,
    });
    expect(c.holdout?.draw).not.toBe(a.holdout?.draw);
  });

  it("an absent headSha still derives a deterministic draw (seed falls back to 'unknown')", async () => {
    const env = createTestEnv();
    const call = () => maybeApplyCloseAuditHoldout(env, { repoFullName: "o/r3", pullNumber: 5, planned: planWithClose(), epsilonPct: 100, closeAutonomyIsAuto: true });
    const first = await call();
    const second = await call();
    expect(first.holdout?.draw).toBe(second.holdout?.draw);
  });

  it("persists ONE dedicated secret across calls (system_flags), race-safe across a concurrent first write", async () => {
    const env = createTestEnv();
    await Promise.all([
      maybeApplyCloseAuditHoldout(env, { repoFullName: "o/a", pullNumber: 1, headSha: "h1", planned: planWithClose(), epsilonPct: 100, closeAutonomyIsAuto: true }),
      maybeApplyCloseAuditHoldout(env, { repoFullName: "o/b", pullNumber: 2, headSha: "h2", planned: planWithClose(), epsilonPct: 100, closeAutonomyIsAuto: true }),
    ]);
    const rows = await env.DB.prepare("SELECT value FROM system_flags WHERE key = 'close_audit_holdout:secret'").all<{ value: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("HARD ORDERING RULE: if the propensity record fails to write, the close PROCEEDS unheld and holdout.diverted is false", async () => {
    const env = createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO audit_events") || sql.includes("insert into \"audit_events\"")) throw new Error("ledger down");
      return realPrepare(sql);
    });
    const { planned: next, holdout } = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 7,
      headSha: "abc123",
      planned: planWithClose(),
      epsilonPct: 5,
      closeAutonomyIsAuto: true,
      rng: () => 0.0,
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(true); // the instrument degrades, never the gate
    expect(holdout).toEqual({ epsilonPct: 5, draw: 0, diverted: false });
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(rows!.n).toBe(0); // no half-recorded holdout
  });
});
