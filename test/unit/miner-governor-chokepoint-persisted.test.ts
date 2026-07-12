import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { evaluateGovernorChokepointGatePersisted } from "../../packages/gittensory-miner/lib/governor-chokepoint-persisted.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { openGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";

const roots: string[] = [];
const closeables: Array<{ close(): void }> = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-chokepoint-persisted-"));
  roots.push(root);
  const governorState = openGovernorState(join(root, "governor-state.sqlite3"));
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  closeables.push(governorState, ledger);
  return { root, governorState, ledger };
}

/** Reopen a governor-state store at the same on-disk path a fresh CLI process would see. */
function reopenGovernorState(root: string) {
  const governorState = openGovernorState(join(root, "governor-state.sqlite3"));
  closeables.push(governorState);
  return governorState;
}

afterEach(() => {
  for (const closeable of closeables.splice(0)) closeable.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    actionClass: "open_pr",
    repoFullName: "acme/widgets",
    nowMs: 10_000,
    wouldBeAction: { action: "open_pr", title: "Fix bug" },
    killSwitchGlobal: false,
    killSwitchRepoPaused: false,
    liveModeGlobalOptIn: true,
    liveModeRepoOptIn: undefined,
    capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
    convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
    ...overrides,
  };
}

describe("evaluateGovernorChokepointGatePersisted (#5134)", () => {
  it("ACCEPTANCE CRITERION: a rate limit tripped in invocation 1 is honored in invocation 2, across separate store instances", () => {
    const { root, ledger } = tempStore();
    const policies = {
      global: { open_pr: { limit: 1, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
      backoffBaseMs: 100,
    };
    const append = (event: unknown) => ledger.appendGovernorEvent(event as never);

    // Invocation 1: process A opens its own governor-state handle, runs one gate check, closes.
    const governorStateA = reopenGovernorState(root);
    const first = evaluateGovernorChokepointGatePersisted(baseInput({ rateLimitPolicies: policies, nowMs: 10_000 }), {
      governorState: governorStateA,
      append,
    });
    expect(first.decision.allowed).toBe(true);
    expect(first.rateLimitBuckets.global.open_pr?.count).toBe(1);
    governorStateA.close();
    closeables.splice(closeables.indexOf(governorStateA), 1);

    // Invocation 2: a BRAND NEW governor-state handle on the same on-disk file -- simulating a fresh CLI
    // process -- must see invocation 1's bucket count and now deny (limit: 1 already consumed).
    const governorStateB = reopenGovernorState(root);
    const second = evaluateGovernorChokepointGatePersisted(baseInput({ rateLimitPolicies: policies, nowMs: 10_100 }), {
      governorState: governorStateB,
      append,
    });
    expect(second.decision.allowed).toBe(false);
    expect(second.decision.stage).toBe("rate_limit");
    expect(second.recorded.eventType).toBe("throttled");

    // The ledger's own audit trail (a SEPARATE concern from this state) shows both real decisions.
    expect(ledger.readGovernorEvents({ repoFullName: "acme/widgets" }).map((event) => event.decision)).toEqual(["allow", "throttle"]);
  });

  it("loads persisted rate-limit state to auto-supply rateLimitBuckets/backoffAttempts when the caller omits them", () => {
    const { governorState, ledger } = tempStore();
    governorState.saveRateLimitState({
      buckets: { global: { open_pr: { count: 5, windowStartMs: 10_000 } }, perRepo: {} },
      backoffAttempts: {},
    });
    const policies = {
      global: { open_pr: { limit: 5, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 100, windowMs: 60_000 } },
      backoffBaseMs: 100,
    };

    const result = evaluateGovernorChokepointGatePersisted(baseInput({ rateLimitPolicies: policies, nowMs: 10_500 }), {
      governorState,
      append: (event) => ledger.appendGovernorEvent(event as never),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("rate_limit");
  });

  it("an explicit rateLimitBuckets on the input overrides the persisted state instead of being ignored", () => {
    const { governorState, ledger } = tempStore();
    governorState.saveRateLimitState({
      buckets: { global: { open_pr: { count: 999, windowStartMs: 10_000 } }, perRepo: {} },
      backoffAttempts: {},
    });

    const result = evaluateGovernorChokepointGatePersisted(
      baseInput({ rateLimitBuckets: { global: {}, perRepo: {} }, rateLimitBackoffAttempts: {} }),
      { governorState, append: (event) => ledger.appendGovernorEvent(event as never) },
    );

    expect(result.decision.allowed).toBe(true);
  });

  it("loads persisted capUsage to auto-supply the input when the caller omits it, and a budget-cap denial is honored", () => {
    const { governorState, ledger } = tempStore();
    governorState.saveCapUsage({ budgetSpent: 100, turnsTaken: 0, elapsedMs: 0 });

    const result = evaluateGovernorChokepointGatePersisted(baseInput(), {
      governorState,
      append: (event) => ledger.appendGovernorEvent(event as never),
    });

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("budget_cap");
  });

  it("an explicit capUsage on the input overrides the persisted value instead of being ignored", () => {
    const { governorState, ledger } = tempStore();
    governorState.saveCapUsage({ budgetSpent: 100, turnsTaken: 0, elapsedMs: 0 });

    const result = evaluateGovernorChokepointGatePersisted(baseInput({ capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 } }), {
      governorState,
      append: (event) => ledger.appendGovernorEvent(event as never),
    });

    expect(result.decision.allowed).toBe(true);
  });

  it("does NOT persist capUsage -- saving the attempt's real spend after it runs stays the caller's job", () => {
    const { governorState, ledger } = tempStore();
    governorState.saveCapUsage({ budgetSpent: 10, turnsTaken: 1, elapsedMs: 100 });

    evaluateGovernorChokepointGatePersisted(baseInput(), {
      governorState,
      append: (event) => ledger.appendGovernorEvent(event as never),
    });

    expect(governorState.loadCapUsage()).toEqual({ budgetSpent: 10, turnsTaken: 1, elapsedMs: 100 });
  });

  it("opens and closes its own default governor-state store when the caller supplies none", () => {
    const { root, ledger } = tempStore();
    process.env.GITTENSORY_MINER_GOVERNOR_STATE_DB = join(root, "governor-state.sqlite3");
    try {
      const result = evaluateGovernorChokepointGatePersisted(baseInput(), {
        append: (event) => ledger.appendGovernorEvent(event as never),
      });
      expect(result.decision.allowed).toBe(true);
    } finally {
      delete process.env.GITTENSORY_MINER_GOVERNOR_STATE_DB;
    }

    // The default store's mutation was persisted to the same on-disk file a reopened handle can see.
    const reopened = reopenGovernorState(root);
    expect(reopened.loadRateLimitState().buckets.global.open_pr?.count).toBe(1);
  });

  it("still saves the mutated rate-limit state even when the gate denies (a denial still consumes a backoff attempt)", () => {
    const { governorState, ledger } = tempStore();
    const policies = {
      global: { open_pr: { limit: 0, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
      backoffBaseMs: 100,
    };

    evaluateGovernorChokepointGatePersisted(baseInput({ rateLimitPolicies: policies }), {
      governorState,
      append: (event) => ledger.appendGovernorEvent(event as never),
    });

    expect(governorState.loadRateLimitState().backoffAttempts["open_pr:acme/widgets"]).toBe(1);
  });
});
