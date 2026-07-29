import { describe, expect, it } from "vitest";
import { describeReviewEscalation, resolveReviewKnobs } from "../../src/review/review-knobs";

// #9808/#9821: a hardGuardrailGlobs hit used to buy NO extra analysis — same model, same effort, single pass —
// it only suppressed auto-merge and queued a human. 74 distinct PRs held in 14 days on the production ORB.

const GLOBAL = { provider: "claude-code", model: "claude-sonnet-5", effort: "medium", selfConsistencyRuns: 0 };

describe("resolveReviewKnobs", () => {
  it("REGRESSION: a guarded path escalates instead of reviewing identically to any other file", () => {
    const r = resolveReviewKnobs({
      guardrailHit: true,
      escalation: { effort: "high", selfConsistencyRuns: 3 },
      repo: {},
      global: GLOBAL,
    });
    expect(r.effort).toBe("high");
    expect(r.selfConsistencyRuns).toBe(3);
    expect(r.escalated).toBe(true);
    // The common ask: "same model, think harder" — model/provider inherit rather than being forced along.
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.provider).toBe("claude-code");
  });

  it("INVARIANT: the escalation block is INERT when the PR touches no guarded path", () => {
    const r = resolveReviewKnobs({
      guardrailHit: false,
      escalation: { effort: "max", selfConsistencyRuns: 3 },
      repo: {},
      global: GLOBAL,
    });
    expect(r.effort).toBe("medium");
    expect(r.selfConsistencyRuns).toBe(0);
    expect(r.escalated).toBe(false);
    expect(r.escalatedFields).toEqual([]);
  });

  it("precedence: escalation > per-repo > global, per field independently", () => {
    const r = resolveReviewKnobs({
      guardrailHit: true,
      escalation: { effort: "xhigh" },
      repo: { model: "repo-model", effort: "high", selfConsistencyRuns: 2 },
      global: GLOBAL,
    });
    expect(r.effort).toBe("xhigh"); // escalation wins
    expect(r.model).toBe("repo-model"); // repo wins over global
    expect(r.selfConsistencyRuns).toBe(2); // repo, untouched by escalation
    expect(r.provider).toBe("claude-code"); // global fallback
    expect(r.escalatedFields).toEqual(["effort"]);
  });

  it("per-repo effort/runs apply with no guardrail involved — the parity the manifest was missing", () => {
    const r = resolveReviewKnobs({ guardrailHit: false, repo: { effort: "high", selfConsistencyRuns: 3 }, global: GLOBAL });
    expect({ effort: r.effort, runs: r.selfConsistencyRuns, escalated: r.escalated }).toEqual({ effort: "high", runs: 3, escalated: false });
  });

  it("INVARIANT: selfConsistencyRuns of 0 is a real value, not 'unset'", () => {
    // 0 means "off". A truthiness check here would silently fall through to the global value and re-enable
    // multi-run reviews on a repo that explicitly turned them off.
    const r = resolveReviewKnobs({ guardrailHit: true, escalation: { selfConsistencyRuns: 0 }, global: { ...GLOBAL, selfConsistencyRuns: 3 } });
    expect(r.selfConsistencyRuns).toBe(0);
    expect(r.escalated).toBe(true);
  });

  it("everything absent resolves to nulls rather than throwing", () => {
    expect(resolveReviewKnobs({ guardrailHit: true })).toEqual({
      provider: null, model: null, effort: null, selfConsistencyRuns: null, escalated: false, escalatedFields: [],
    });
  });
});

describe("describeReviewEscalation", () => {
  it("names exactly what changed, for the panel and the decision record", () => {
    const r = resolveReviewKnobs({ guardrailHit: true, escalation: { effort: "high", selfConsistencyRuns: 3 }, global: GLOBAL });
    expect(describeReviewEscalation(r)).toBe("escalated review on a guarded path: effort=high, 3 runs");
  });

  it("returns null when nothing was escalated, so a caller needs no branch of its own", () => {
    expect(describeReviewEscalation(resolveReviewKnobs({ guardrailHit: false, global: GLOBAL }))).toBeNull();
  });

  it("reports a model/provider escalation too", () => {
    const r = resolveReviewKnobs({ guardrailHit: true, escalation: { provider: "anthropic", model: "claude-opus-5" }, global: GLOBAL });
    expect(describeReviewEscalation(r)).toBe("escalated review on a guarded path: provider=anthropic, model=claude-opus-5");
  });
});
