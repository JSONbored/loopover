import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { evaluateGovernorChokepointGate } from "../../packages/gittensory-miner/lib/governor-chokepoint.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    actionClass: "open_pr",
    repoFullName: "acme/widgets",
    nowMs: 10_000,
    wouldBeAction: { action: "open_pr", title: "Fix bug" },
    killSwitchGlobal: false,
    killSwitchRepoPaused: false,
    liveModeGlobalOptIn: true,
    liveModeRepoOptIn: "live",
    rateLimitBuckets: { global: {}, perRepo: {} },
    rateLimitBackoffAttempts: {},
    capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 },
    capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
    convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
    ...overrides,
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-chokepoint-"));
  roots.push(root);
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

/** A value whose every property access throws `thrown` -- used to exercise the non-Error `String(error)`
 *  fallback arm of chokepoint.ts's `error instanceof Error ? error.message : String(error)` catches. A plain
 *  `null` override (used below) always throws a genuine `TypeError` (a real `Error` instance), so this is
 *  needed to reach the fallback arm for a thrown non-Error value at each of the five calculator call sites. */
function throwingProxy(thrown: unknown): unknown {
  return new Proxy(
    {},
    {
      get(): never {
        throw thrown;
      },
    },
  );
}

describe("evaluateGovernorChokepointGate (#2340)", () => {
  it("records an allow decision to the ledger and advances the rate-limit bucket", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput(), { append: (event) => ledger.appendGovernorEvent(event) });

    expect(result.decision.allowed).toBe(true);
    expect(result.recorded.eventType).toBe("allowed");
    expect(result.rateLimitBuckets.global.open_pr?.count).toBe(1);
    expect(ledger.readGovernorEvents({ repoFullName: "acme/widgets" })).toHaveLength(1);
  });

  it("a kill-switch denial records to the ledger and leaves rate-limit bucket state untouched", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ killSwitchGlobal: true }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("kill_switch");
    expect(result.recorded.eventType).toBe("kill_switch");
    expect(result.rateLimitBuckets).toEqual({ global: {}, perRepo: {} });
  });

  it("dry-run shadow-logs without touching rate-limit bucket state", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ liveModeGlobalOptIn: false }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.mode).toBe("dry_run");
    expect(result.recorded.decision).toBe("dry_run");
    expect(result.rateLimitBuckets).toEqual({ global: {}, perRepo: {} });
  });

  it("a rate-limit denial bumps backoff attempts without advancing the bucket count", () => {
    const ledger = openLedger();
    const policies = {
      global: { open_pr: { limit: 0, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
      backoffBaseMs: 100,
    };
    const result = evaluateGovernorChokepointGate(baseInput({ rateLimitPolicies: policies }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.stage).toBe("rate_limit");
    expect(result.recorded.eventType).toBe("throttled");
    expect(result.rateLimitBackoffAttempts["open_pr:acme/widgets"]).toBe(1);
  });

  it("a caller-supplied rateLimitRandomFn is threaded through to the rate-limit calculator", () => {
    const ledger = openLedger();
    let called = false;
    const policies = {
      global: { open_pr: { limit: 0, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
      backoffBaseMs: 100,
    };
    const result = evaluateGovernorChokepointGate(
      baseInput({
        rateLimitPolicies: policies,
        rateLimitRandomFn: () => {
          called = true;
          return 0.25;
        },
      }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.stage).toBe("rate_limit");
    expect(called).toBe(true);
  });

  it("a budget-cap denial records to the ledger as denied before non-convergence runs", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(
      baseInput({ capUsage: { budgetSpent: 100, turnsTaken: 0, elapsedMs: 0 }, capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 } }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("budget_cap");
    expect(result.recorded.eventType).toBe("denied");
    expect(result.decision.detail.convergence).toBeUndefined();
  });

  it("a non-convergence denial records to the ledger before reputation/self-plagiarism run", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(
      baseInput({ convergenceInput: { attempts: 5, consecutiveFailures: 5, reenqueues: 0, reachedDone: false } }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("non_convergence");
    expect(result.recorded.eventType).toBe("denied");
    expect(result.decision.detail.reputation).toBeUndefined();
  });

  it("a reputation-throttle denial records to the ledger as throttled before self-plagiarism runs", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ reputationHistory: { decided: 10, unfavorable: 8 } }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("reputation_throttle");
    expect(result.recorded.eventType).toBe("throttled");
    expect(result.decision.detail.selfPlagiarism).toBeUndefined();
  });

  it("reputation throttle runs but does not throttle on insufficient history, reaching allow", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ reputationHistory: { decided: 1, unfavorable: 1 } }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(true);
    expect(result.decision.detail.reputation?.reason).toBe("insufficient_history");
  });

  it("reputation throttle is skipped entirely when reputationHistory is omitted", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput(), { append: (event) => ledger.appendGovernorEvent(event) });

    expect(result.decision.allowed).toBe(true);
    expect(result.decision.detail.reputation).toBeUndefined();
  });

  it("reputation throttle and self-plagiarism are both skipped for a non-open_pr action, even with denying inputs", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(
      baseInput({
        actionClass: "apply_labels",
        wouldBeAction: { action: "apply_labels", labels: ["bug"] },
        reputationHistory: { decided: 10, unfavorable: 10 },
        selfPlagiarismCandidate: { repoFullName: "acme/widgets", fingerprint: "x", submittedAt: "2026-07-11T12:00:00Z" },
        selfPlagiarismRecentSubmissions: [{ repoFullName: "acme/widgets", fingerprint: "x", submittedAt: "2026-07-10T12:00:00Z" }],
      }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.allowed).toBe(true);
    expect(result.decision.detail.reputation).toBeUndefined();
    expect(result.decision.detail.selfPlagiarism).toBeUndefined();
  });

  it("a self-plagiarism denial records to the ledger as throttled", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(
      baseInput({
        selfPlagiarismCandidate: { repoFullName: "acme/widgets", fingerprint: "fix auth bug login", submittedAt: "2026-07-11T12:00:00Z" },
        selfPlagiarismRecentSubmissions: [
          { repoFullName: "acme/widgets", fingerprint: "fix auth bug login", submittedAt: "2026-07-10T12:00:00Z", pullRequestNumber: 42 },
        ],
      }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("self_plagiarism");
    expect(result.recorded.eventType).toBe("throttled");
  });

  it("self-plagiarism runs but allows a fingerprint distinct from recent submissions, reaching allow", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(
      baseInput({
        selfPlagiarismCandidate: { repoFullName: "acme/widgets", fingerprint: "a wholly distinct fingerprint", submittedAt: "2026-07-11T12:00:00Z" },
      }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.allowed).toBe(true);
    expect(result.decision.detail.selfPlagiarism?.reason).toBe("distinct_from_recent_own_submissions");
  });

  it("self-plagiarism denies via a whitespace-only fingerprint with no computed similarity", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(
      baseInput({
        selfPlagiarismCandidate: { repoFullName: "acme/widgets", fingerprint: "   ", submittedAt: "2026-07-11T12:00:00Z" },
      }),
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("self_plagiarism");
    expect(result.decision.reason).toBe("missing_candidate_fingerprint");
  });

  it("self-plagiarism is skipped entirely when selfPlagiarismCandidate is omitted", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput(), { append: (event) => ledger.appendGovernorEvent(event) });

    expect(result.decision.allowed).toBe(true);
    expect(result.decision.detail.selfPlagiarism).toBeUndefined();
  });

  it("a rate-limit calculator error denies closed with stage internal_error, never falling through to allow", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ rateLimitBuckets: null }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toContain("rate_limit_calculator_error");
    expect(result.recorded.eventType).toBe("denied");
  });

  it("a rate-limit calculator throwing a non-Error value still formats a reason via String(error)", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ rateLimitBuckets: throwingProxy("boom: not an Error") }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toBe("rate_limit_calculator_error: boom: not an Error");
  });

  it("a budget-cap calculator error denies closed with stage internal_error", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ capUsage: null }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toContain("budget_cap_calculator_error");
  });

  it("a budget-cap calculator throwing a non-Error value still formats a reason via String(error)", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ capUsage: throwingProxy("boom: not an Error") }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toBe("budget_cap_calculator_error: boom: not an Error");
  });

  it("a non-convergence calculator error denies closed with stage internal_error", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ convergenceInput: null }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toContain("non_convergence_calculator_error");
  });

  it("a non-convergence calculator throwing a non-Error value still formats a reason via String(error)", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ convergenceInput: throwingProxy("boom: not an Error") }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toBe("non_convergence_calculator_error: boom: not an Error");
  });

  it("a reputation-throttle calculator error denies rather than silently skipping the stage", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ reputationHistory: null }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toContain("reputation_throttle_calculator_error");
  });

  it("a reputation-throttle calculator throwing a non-Error value still formats a reason via String(error)", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ reputationHistory: throwingProxy("boom: not an Error") }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toBe("reputation_throttle_calculator_error: boom: not an Error");
  });

  it("a self-plagiarism calculator error denies rather than silently skipping the stage", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ selfPlagiarismCandidate: null }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toContain("self_plagiarism_calculator_error");
  });

  it("a self-plagiarism calculator throwing a non-Error value still formats a reason via String(error)", () => {
    const ledger = openLedger();
    const result = evaluateGovernorChokepointGate(baseInput({ selfPlagiarismCandidate: throwingProxy("boom: not an Error") }), {
      append: (event) => ledger.appendGovernorEvent(event),
    });

    expect(result.decision.stage).toBe("internal_error");
    expect(result.decision.reason).toBe("self_plagiarism_calculator_error: boom: not an Error");
  });
});
