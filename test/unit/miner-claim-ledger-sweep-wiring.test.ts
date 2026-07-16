import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_CLAIM_AGE_MS } from "../../packages/loopover-miner/lib/claim-ledger-expiry.js";
import { closeDefaultClaimLedger, openClaimLedger } from "../../packages/loopover-miner/lib/claim-ledger.js";

// #6156: sweepExpiredClaims existed and worked, but nothing ever called it -- so a claim left behind by a
// crashed/killed miner never expired. That matters because recordClaim's `WHERE status <> 'active'` guard makes
// re-claiming an already-active row a deliberate no-op: with no sweep, the dead process's claim keeps winning
// forever and there is no path that reaches expireClaim. claimIssue now sweeps first, mirroring
// claimNextBatch's sweep-then-claim (portfolio-queue-manager.js).
const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-claim-sweep-"));
  roots.push(root);
  const ledger = openClaimLedger(join(root, "claim-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

/** Move the clock past the default window, so a claim recorded before it is stale by exactly one hour. */
function advancePastDefaultWindow(fromIso: string) {
  vi.setSystemTime(new Date(Date.parse(fromIso) + DEFAULT_MAX_CLAIM_AGE_MS + 60 * 60 * 1000));
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultClaimLedger();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner claim ledger sweep wiring (#6156)", () => {
  it("REGRESSION: a claim stranded by a dead process is expired, so the issue can be claimed again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ledger = tempLedger();
    ledger.claimIssue("acme/widgets", 7, "attempt:crashed-process");

    advancePastDefaultWindow("2026-01-01T00:00:00.000Z");
    const reclaimed = ledger.claimIssue("acme/widgets", 7, "attempt:new-process");

    // The whole point: the new attempt now OWNS the claim. Before the sweep was wired, recordClaim's no-op guard
    // left the dead process's row untouched -- same claimedAt, same note -- while reporting success.
    expect(reclaimed.note).toBe("attempt:new-process");
    expect(reclaimed.status).toBe("active");
    expect(reclaimed.claimedAt).toBe(new Date().toISOString());
    expect(ledger.listClaims({ status: "active" })).toEqual([expect.objectContaining({ issueNumber: 7, note: "attempt:new-process" })]);
  });

  it("expires a stale claim on a DIFFERENT issue too -- the sweep is not scoped to the issue being claimed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ledger = tempLedger();
    ledger.claimIssue("acme/widgets", 1, "attempt:crashed-process");

    advancePastDefaultWindow("2026-01-01T00:00:00.000Z");
    ledger.claimIssue("acme/widgets", 2, "attempt:new-process");

    expect(ledger.listClaims({ status: "expired" }).map((entry) => entry.issueNumber)).toEqual([1]);
    expect(ledger.listClaims({ status: "active" }).map((entry) => entry.issueNumber)).toEqual([2]);
  });

  it("leaves a claim inside the window alone -- claiming does not expire a live sibling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ledger = tempLedger();
    ledger.claimIssue("acme/widgets", 1, "attempt:still-running");

    // One hour short of the window: still the live process's claim.
    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00.000Z") + DEFAULT_MAX_CLAIM_AGE_MS - 60 * 60 * 1000));
    ledger.claimIssue("acme/widgets", 2, "attempt:other");

    expect(ledger.listClaims({ status: "expired" })).toEqual([]);
    expect(ledger.listClaims({ status: "active" }).map((entry) => entry.issueNumber)).toEqual([1, 2]);
  });

  it("reclaimExpiredClaims() expires stale claims on demand and returns the transitioned rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ledger = tempLedger();
    ledger.claimIssue("acme/widgets", 1, "attempt:crashed-process");
    advancePastDefaultWindow("2026-01-01T00:00:00.000Z");

    // Default window -- the no-argument branch.
    expect(ledger.reclaimExpiredClaims()).toEqual([expect.objectContaining({ issueNumber: 1, status: "expired" })]);
    expect(ledger.reclaimExpiredClaims()).toEqual([]);
  });

  it("reclaimExpiredClaims(maxAgeMs) honours an explicit window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ledger = tempLedger();
    ledger.claimIssue("acme/widgets", 1, "attempt:recent");

    // Two hours on: far inside the 14-day default, but past an explicit one-hour window -- so the argument is
    // what decides, not the default.
    vi.setSystemTime(new Date(Date.parse("2026-01-01T02:00:00.000Z")));
    expect(ledger.reclaimExpiredClaims(DEFAULT_MAX_CLAIM_AGE_MS)).toEqual([]);
    expect(ledger.reclaimExpiredClaims(60 * 60 * 1000)).toEqual([expect.objectContaining({ issueNumber: 1, status: "expired" })]);
  });

  it("a released claim is re-claimable as before -- the sweep doesn't disturb the normal lifecycle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ledger = tempLedger();
    ledger.claimIssue("acme/widgets", 1, "attempt:first");
    ledger.releaseClaim("acme/widgets", 1);

    const again = ledger.claimIssue("acme/widgets", 1, "attempt:second");
    expect(again).toEqual(expect.objectContaining({ status: "active", note: "attempt:second" }));
    expect(ledger.listClaims({ status: "expired" })).toEqual([]);
  });
});
