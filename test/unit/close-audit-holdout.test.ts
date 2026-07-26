import { describe, expect, it, vi } from "vitest";
import { applyCloseAuditHoldout, holdoutEligibleClose, maybeApplyCloseAuditHoldout } from "../../src/review/close-audit-holdout";
import type { PlannedAgentAction } from "../../src/settings/agent-actions";
import { createTestEnv } from "../helpers/d1";

// #8831: the selective-labels fix. The invariants that make the instrument honest are pinned here: the draw
// consumes the FINAL plan, ε=0 is byte-identical, only heuristic auto-closes are eligible, and a hold whose
// propensity record failed to write NEVER happens (an unlogged hold would silently bias every estimator).
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

describe("maybeApplyCloseAuditHoldout (the full step)", () => {
  const planWithClose = () => [close()];

  it("ε=0 / absent / non-auto autonomy / no eligible close → plan returned untouched with ZERO writes", async () => {
    const env = createTestEnv();
    const spy = vi.spyOn(env.DB, "prepare");
    const base = { repoFullName: "o/r", pullNumber: 7, labelSettings: {}, closeAutonomyIsAuto: true };
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: planWithClose(), epsilonPct: 0 })).toEqual(planWithClose());
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: planWithClose(), epsilonPct: undefined })).toEqual(planWithClose());
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: planWithClose(), epsilonPct: 5, closeAutonomyIsAuto: false })).toEqual(planWithClose());
    expect(await maybeApplyCloseAuditHoldout(env, { ...base, planned: [label("x")], epsilonPct: 5 })).toEqual([label("x")]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a draw under ε diverts the close, logs the propensity record, and files the pending holdout label", async () => {
    const env = createTestEnv();
    const next = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 7,
      planned: planWithClose(),
      epsilonPct: 5,
      closeAutonomyIsAuto: true,
      labelSettings: { manualReviewLabel: "needs-human" },
      rng: () => 0.01, // 1% < 5%
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(false);
    const audit = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE event_type = 'decision_audit_holdout' AND target_key = 'o/r#7'").first<{ metadata_json: string }>();
    const metadata = JSON.parse(audit!.metadata_json) as Record<string, unknown>;
    expect(metadata).toMatchObject({ epsilonPct: 5, draw: 0.01, counterfactualAction: "close" });
    const row = await env.DB.prepare("SELECT verdict, outcome, stratum, status FROM decision_audit_labels WHERE target_id = 'o/r#7'").first<{ verdict: string; outcome: string | null; stratum: string; status: string }>();
    expect(row).toEqual({ verdict: "close", outcome: null, stratum: "holdout_close", status: "pending" });
  });

  it("a draw at/above ε lets the close proceed and records nothing", async () => {
    const env = createTestEnv();
    const next = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 7,
      planned: planWithClose(),
      epsilonPct: 5,
      closeAutonomyIsAuto: true,
      rng: () => 0.05, // exactly ε — the held region is [0, ε), so this proceeds
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("uses the real RNG when none is injected (the production arm) — ε=100 fires deterministically", async () => {
    const env = createTestEnv();
    const next = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 8,
      planned: planWithClose(),
      epsilonPct: 100 as never, // parse clamps real config to 20; the module itself only compares
      closeAutonomyIsAuto: true,
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(false); // Math.random() < 1.0 always
  });

  it("HARD ORDERING RULE: if the propensity record fails to write, the close PROCEEDS unheld", async () => {
    const env = createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO audit_events") || sql.includes("insert into \"audit_events\"")) throw new Error("ledger down");
      return realPrepare(sql);
    });
    const next = await maybeApplyCloseAuditHoldout(env, {
      repoFullName: "o/r",
      pullNumber: 7,
      planned: planWithClose(),
      epsilonPct: 5,
      closeAutonomyIsAuto: true,
      rng: () => 0.0,
    });
    expect(next.some((a) => a.actionClass === "close")).toBe(true); // the instrument degrades, never the gate
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(rows!.n).toBe(0); // no half-recorded holdout
  });
});
