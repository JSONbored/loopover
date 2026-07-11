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
    liveModeRepoOptIn: undefined,
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
});
