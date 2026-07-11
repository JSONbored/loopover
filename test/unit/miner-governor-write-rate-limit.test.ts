import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { evaluateWriteRateLimitGate } from "../../packages/gittensory-miner/lib/governor-write-rate-limit.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("evaluateWriteRateLimitGate (#2344)", () => {
  it("records an allowed write to the governor ledger and advances both buckets", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-write-rate-limit-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const { verdict, recorded, buckets, retryAtMs } = evaluateWriteRateLimitGate(
      {
        actionClass: "open_pr",
        repoFullName: "acme/repo-a",
        buckets: { global: {}, perRepo: {} },
        backoffAttempts: {},
        nowMs: 1_000,
        policies: {
          global: { open_pr: { limit: 5, windowMs: 60_000 } },
          perRepo: { open_pr: { limit: 2, windowMs: 60_000 } },
          backoffBaseMs: 100,
        },
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(verdict.allowed).toBe(true);
    expect(retryAtMs).toBeNull();
    expect(buckets.global.open_pr?.count).toBe(1);
    expect(recorded.eventType).toBe("allowed");
    expect(recorded.actionClass).toBe("open_pr");
  });

  it("schedules a jittered retry and records a throttled denial without advancing buckets", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-write-rate-limit-deny-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const policies = {
      global: { open_pr: { limit: 1, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
      backoffBaseMs: 200,
    };
    const first = evaluateWriteRateLimitGate(
      {
        actionClass: "open_pr",
        repoFullName: "acme/repo-a",
        buckets: { global: {}, perRepo: {} },
        backoffAttempts: {},
        nowMs: 5_000,
        policies,
        randomFn: () => 0.5,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    const denied = evaluateWriteRateLimitGate(
      {
        actionClass: "open_pr",
        repoFullName: "acme/repo-a",
        buckets: first.buckets,
        backoffAttempts: first.backoffAttempts,
        nowMs: 5_100,
        policies,
        randomFn: () => 0.5,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(denied.verdict.allowed).toBe(false);
    expect(denied.retryAtMs).toBe(5_100 + denied.verdict.retryAfterMs);
    expect(denied.verdict.retryAfterMs).toBeGreaterThanOrEqual(200);
    expect(denied.buckets).toEqual(first.buckets);
    expect(denied.recorded.eventType).toBe("throttled");
    expect(denied.recorded.payload).toMatchObject({ blockedBy: "global" });
  });
});
