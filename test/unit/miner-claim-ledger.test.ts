import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_STATUSES,
  closeDefaultClaimLedger,
  openClaimLedger,
  resolveClaimLedgerDbPath,
} from "../../packages/gittensory-miner/lib/claim-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-claim-ledger-"));
  roots.push(root);
  const ledger = openClaimLedger(join(root, "nested", "claim-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultClaimLedger();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner claim ledger (#2314)", () => {
  it("exposes the frozen status vocabulary", () => {
    expect(CLAIM_STATUSES).toEqual(["active", "released", "expired"]);
    expect(Object.isFrozen(CLAIM_STATUSES)).toBe(true);
  });

  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveClaimLedgerDbPath({ GITTENSORY_MINER_CLAIM_LEDGER_DB: "/custom/c.sqlite3" })).toBe(
      "/custom/c.sqlite3",
    );
    expect(resolveClaimLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/claim-ledger.sqlite3",
    );
    expect(resolveClaimLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/claim-ledger.sqlite3",
    );
    expect(resolveClaimLedgerDbPath({})).toMatch(/\/\.config\/gittensory-miner\/claim-ledger\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and lists empty before any claim", () => {
    const ledger = tempLedger();
    expect(statSync(ledger.dbPath).mode & 0o077).toBe(0);
    expect(ledger.listClaims()).toEqual([]);
  });

  it("records a claim and lists it back", () => {
    const ledger = tempLedger();
    const claim = ledger.recordClaim({ repoFullName: "JSONbored/gittensory", issueNumber: 2314, note: "mine" });
    expect(claim).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      issueNumber: 2314,
      status: "active",
      note: "mine",
    });
    expect(typeof claim.claimedAt).toBe("string");
    expect(ledger.listClaims()).toEqual([claim]);
    // A note is optional → null.
    expect(ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 }).note).toBeNull();
  });

  it("is idempotent: re-claiming an already-active issue is a no-op, not a duplicate row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
    const ledger = tempLedger();
    const first = ledger.recordClaim({ repoFullName: "o/a", issueNumber: 7, note: "first" });
    vi.setSystemTime(new Date("2026-07-03T01:00:00Z"));
    const second = ledger.recordClaim({ repoFullName: "o/a", issueNumber: 7, note: "second" });
    // Same row, unchanged (claimed_at + note preserved) — a true no-op while active.
    expect(second).toEqual(first);
    expect(ledger.listClaims({ repoFullName: "o/a" })).toHaveLength(1);
  });

  it("releases a claim, and re-claiming after release re-activates the same row", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 9, note: "v1" });
    const released = ledger.releaseClaim("o/a", 9);
    expect(released?.status).toBe("released");
    expect(ledger.releaseClaim("o/a", 9)).toBeNull();
    // Re-claim after release: same single row, back to active, note refreshed.
    const reclaimed = ledger.recordClaim({ repoFullName: "o/a", issueNumber: 9, note: "v2" });
    expect(reclaimed).toMatchObject({ status: "active", note: "v2", id: released?.id });
    expect(ledger.listClaims({ repoFullName: "o/a" })).toHaveLength(1);
    // Releasing an issue that was never claimed returns null.
    expect(ledger.releaseClaim("o/a", 404)).toBeNull();
  });

  it("filters listClaims by repoFullName and/or status", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 });
    ledger.recordClaim({ repoFullName: "o/b", issueNumber: 1 });
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 2 });
    ledger.releaseClaim("o/a", 2);
    expect(ledger.listClaims({ repoFullName: "o/a" }).map((c) => c.issueNumber)).toEqual([1, 2]);
    expect(ledger.listClaims({ status: "active" }).map((c) => c.repoFullName)).toEqual(["o/a", "o/b"]);
    expect(ledger.listClaims({ repoFullName: "o/a", status: "released" }).map((c) => c.issueNumber)).toEqual([2]);
  });

  it("treats null listClaims filters as unscoped", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 });
    ledger.recordClaim({ repoFullName: "o/b", issueNumber: 2 });
    expect(ledger.listClaims({ repoFullName: null })).toHaveLength(2);
    expect(ledger.listClaims({ status: null })).toHaveLength(2);
    expect(ledger.listClaims({ repoFullName: null, status: null })).toHaveLength(2);
  });

  it("rejects malformed inputs rather than persisting them", () => {
    const ledger = tempLedger();
    expect(() => ledger.recordClaim({ repoFullName: "no-slash", issueNumber: 1 })).toThrow("invalid_repo_full_name");
    expect(() => ledger.recordClaim({ repoFullName: "o/a", issueNumber: 0 })).toThrow("invalid_issue_number");
    expect(() => ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1.5 })).toThrow("invalid_issue_number");
    expect(() => ledger.listClaims({ status: "bogus" as never })).toThrow("invalid_status");
  });
});
