import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateGovernorChokepoint, type GovernorChokepointInput } from "../dist/index.js";

function baseInput(overrides: Partial<GovernorChokepointInput> = {}): GovernorChokepointInput {
  return {
    actionClass: "open_pr",
    repoFullName: "acme/widgets",
    nowMs: 10_000,
    wouldBeAction: { action: "open_pr", title: "Fix bug" },
    killSwitchGlobal: false,
    killSwitchRepoPaused: false,
    liveModeGlobalOptIn: true,
    liveModeRepoOptIn: undefined,
    rateLimitBuckets: { global: {}, perRepo: {} },
    rateLimitBackoffAttempts: {},
    capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 },
    capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
    convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the Governor chokepoint (#2340)", () => {
  assert.equal(typeof evaluateGovernorChokepoint, "function");
});

test("full allow path: live mode, every stage clear, produces an allowed verdict + allow ledger event", () => {
  const decision = evaluateGovernorChokepoint(baseInput());
  assert.equal(decision.allowed, true);
  assert.equal(decision.mode, "live");
  assert.equal(decision.stage, "allow");
  assert.equal(decision.ledgerEvent.eventType, "allowed");
  assert.equal(decision.ledgerEvent.decision, "allow");
});

test("kill-switch (global) wins even with a live-mode opt-in present", () => {
  const decision = evaluateGovernorChokepoint(baseInput({ killSwitchGlobal: true }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.mode, "paused");
  assert.equal(decision.stage, "kill_switch");
  assert.equal(decision.ledgerEvent.eventType, "kill_switch");
  assert.equal(decision.detail.rateLimit, undefined, "later stages must not have been evaluated");
});

test("kill-switch (per-repo) halts even when the global switch is inactive", () => {
  const decision = evaluateGovernorChokepoint(baseInput({ killSwitchRepoPaused: true }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "kill_switch");
});

test("dry-run: no live-mode opt-in anywhere shadow-logs the would-be action before any resource stage runs", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ liveModeGlobalOptIn: false, liveModeRepoOptIn: undefined }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.mode, "dry_run");
  assert.equal(decision.stage, "dry_run");
  assert.equal(decision.ledgerEvent.decision, "dry_run");
  assert.deepEqual(decision.ledgerEvent.payload, { wouldBeAction: { action: "open_pr", title: "Fix bug" } });
  assert.equal(decision.detail.rateLimit, undefined, "rate-limit must not run under dry-run");
});

test("rate limit: an exhausted bucket denies before budget/convergence stages run", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({
      rateLimitPolicies: {
        global: { open_pr: { limit: 0, windowMs: 60_000 } },
        perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
        backoffBaseMs: 100,
      },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "rate_limit");
  assert.equal(decision.ledgerEvent.eventType, "throttled");
  assert.equal(decision.detail.budgetCap, undefined, "budget-cap must not run once rate-limit denies");
});

test("budget cap: an exceeded budget denies before non-convergence runs", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ capUsage: { budgetSpent: 100, turnsTaken: 0, elapsedMs: 0 }, capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "budget_cap");
  assert.equal(decision.ledgerEvent.eventType, "denied");
  assert.equal(decision.detail.convergence, undefined, "non-convergence must not run once budget-cap denies");
});

test("budget cap: the termination ceiling denies with a kill_switch eventType (hard wall-clock stop)", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 2_000_000 }, capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 } }),
  );
  assert.equal(decision.stage, "budget_cap");
  assert.equal(decision.ledgerEvent.eventType, "kill_switch");
});

test("non-convergence: a stuck item denies before reputation/self-plagiarism run", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ convergenceInput: { attempts: 5, consecutiveFailures: 5, reenqueues: 0, reachedDone: false } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "non_convergence");
  assert.equal(decision.detail.reputation, undefined);
});

test("reputation throttle: a degraded track record denies open_pr before self-plagiarism runs", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ reputationHistory: { decided: 10, unfavorable: 8 } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "reputation_throttle");
  assert.equal(decision.ledgerEvent.eventType, "throttled");
  assert.equal(decision.detail.selfPlagiarism, undefined);
});

test("reputation throttle: insufficient history fails OPEN (not evidence of a problem) and reaches allow", () => {
  const decision = evaluateGovernorChokepoint(baseInput({ reputationHistory: { decided: 1, unfavorable: 1 } }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.detail.reputation?.reason, "insufficient_history");
});

test("self-plagiarism: a losing near-duplicate claim denies open_pr", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({
      selfPlagiarismCandidate: { repoFullName: "acme/widgets", fingerprint: "fix auth bug login", submittedAt: "2026-07-11T12:00:00Z" },
      selfPlagiarismRecentSubmissions: [
        { repoFullName: "acme/widgets", fingerprint: "fix auth bug login", submittedAt: "2026-07-10T12:00:00Z", pullRequestNumber: 42 },
      ],
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "self_plagiarism");
  assert.equal(decision.ledgerEvent.eventType, "throttled");
});

test("self-plagiarism and reputation are skipped entirely for a non-open_pr action, even with denying inputs", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({
      actionClass: "apply_labels",
      wouldBeAction: { action: "apply_labels", labels: ["bug"] },
      reputationHistory: { decided: 10, unfavorable: 10 },
      selfPlagiarismCandidate: { repoFullName: "acme/widgets", fingerprint: "x", submittedAt: "2026-07-11T12:00:00Z" },
      selfPlagiarismRecentSubmissions: [{ repoFullName: "acme/widgets", fingerprint: "x", submittedAt: "2026-07-10T12:00:00Z" }],
    }),
  );
  assert.equal(decision.allowed, true, "non-open_pr actions must not be gated by submission-specific stages");
  assert.equal(decision.detail.reputation, undefined);
  assert.equal(decision.detail.selfPlagiarism, undefined);
});

test("fail-closed: a rate-limit calculator error denies with stage internal_error, never falls through to allow", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ rateLimitBuckets: null as unknown as GovernorChokepointInput["rateLimitBuckets"] }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "internal_error");
  assert.match(decision.reason, /rate_limit_calculator_error/);
});

test("fail-closed: a budget-cap calculator error denies with stage internal_error", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ capUsage: null as unknown as GovernorChokepointInput["capUsage"] }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "internal_error");
  assert.match(decision.reason, /budget_cap_calculator_error/);
});

test("fail-closed: a non-convergence calculator error denies with stage internal_error", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ convergenceInput: null as unknown as GovernorChokepointInput["convergenceInput"] }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "internal_error");
  assert.match(decision.reason, /non_convergence_calculator_error/);
});

test("fail-closed: a reputation-throttle calculator error denies rather than silently skipping the stage", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ reputationHistory: null as unknown as GovernorChokepointInput["reputationHistory"] }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "internal_error");
  assert.match(decision.reason, /reputation_throttle_calculator_error/);
});

test("fail-closed: a self-plagiarism calculator error denies rather than silently skipping the stage", () => {
  const decision = evaluateGovernorChokepoint(
    baseInput({ selfPlagiarismCandidate: null as unknown as GovernorChokepointInput["selfPlagiarismCandidate"] }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "internal_error");
  assert.match(decision.reason, /self_plagiarism_calculator_error/);
});

test("the repo-side live opt-in alone (no global env opt-in) is sufficient to reach the resource stages", () => {
  const decision = evaluateGovernorChokepoint(baseInput({ liveModeGlobalOptIn: false, liveModeRepoOptIn: "live" }));
  assert.equal(decision.mode, "live");
  assert.equal(decision.allowed, true);
});
