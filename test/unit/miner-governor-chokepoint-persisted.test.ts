import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { evaluateGovernorChokepointGatePersisted } from "../../packages/loopover-miner/lib/governor-chokepoint-persisted.js";
import { closeDefaultGovernorLedger, initGovernorLedger, readGovernorEvents } from "../../packages/loopover-miner/lib/governor-ledger.js";
import { openGovernorState } from "../../packages/loopover-miner/lib/governor-state.js";

const chokepointChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-concurrent-stores/chokepoint-child.mjs",
);

const roots: string[] = [];
const closeables: Array<{ close(): void }> = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-chokepoint-persisted-"));
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
    liveModeRepoOptIn: "live",
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
    process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = join(root, "governor-state.sqlite3");
    try {
      const result = evaluateGovernorChokepointGatePersisted(baseInput(), {
        append: (event) => ledger.appendGovernorEvent(event as never),
      });
      expect(result.decision.allowed).toBe(true);
    } finally {
      delete process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB;
    }

    // The default store's mutation was persisted to the same on-disk file a reopened handle can see.
    const reopened = reopenGovernorState(root);
    expect(reopened.loadRateLimitState().buckets.global.open_pr?.count).toBe(1);
  });

  it("REGRESSION: uses the REAL default appendGovernorEvent (not just an injected override) when options.append is omitted", () => {
    const { root } = tempStore();
    process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = join(root, "governor-state.sqlite3");
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = join(root, "governor-ledger-default.sqlite3");
    try {
      const result = evaluateGovernorChokepointGatePersisted(baseInput());
      expect(result.decision.allowed).toBe(true);
      // The event actually landed in the REAL default ledger (module-singleton appendGovernorEvent), not just
      // some caller-supplied stub -- proves the `options.append === undefined` branch truly ran the default.
      expect(readGovernorEvents({ repoFullName: "acme/widgets" })).toHaveLength(1);
    } finally {
      closeDefaultGovernorLedger();
      delete process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB;
      delete process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
    }
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

  it("REGRESSION (#8856): two overlapping chokepoint evaluations against the same bucket both advance the count (no lost update)", async () => {
    // Two real Node processes on one governor-state file, barrier-started together -- the same fleet-container
    // race the issue describes. Without one atomic load+evaluate+save transaction both would read count=0 and
    // the second save would clobber the first; with the fix the final persisted count must be 2.
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-chokepoint-concurrent-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");
    const ledgerPath = join(root, "governor-ledger.sqlite3");
    const bootstrap = openGovernorState(dbPath);
    bootstrap.close();

    const children = [
      spawn(process.execPath, [chokepointChildScript, dbPath, ledgerPath, "10000"]),
      spawn(process.execPath, [chokepointChildScript, dbPath, ledgerPath, "10100"]),
    ];
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let buffer = "";
            child.stdout.on("data", (chunk) => {
              buffer += chunk.toString();
              if (buffer.includes("READY\n")) resolve();
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code !== 0 && code !== null) reject(new Error(`child exited before READY (${code})`));
            });
          }),
      ),
    );
    for (const child of children) child.stdin.write("go\n");
    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ ok: boolean; allowed?: boolean; count?: number; message?: string }>((resolve, reject) => {
            let stdout = "";
            child.stdout.on("data", (chunk) => {
              stdout += chunk.toString();
            });
            child.once("error", reject);
            child.once("exit", () => {
              const line = stdout
                .split("\n")
                .map((entry) => entry.trim())
                .find((entry) => entry.startsWith("{"));
              if (!line) {
                reject(new Error(`child produced no JSON result: ${stdout}`));
                return;
              }
              resolve(JSON.parse(line) as { ok: boolean; allowed?: boolean; count?: number; message?: string });
            });
          }),
      ),
    );

    expect(results.every((result) => result.ok && result.allowed)).toBe(true);

    const reopened = reopenGovernorState(root);
    expect(reopened.loadRateLimitState().buckets.global.open_pr?.count).toBe(2);
  });
});
