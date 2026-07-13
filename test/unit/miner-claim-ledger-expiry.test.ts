import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CLAIM_AGE_MS,
  findExpiredClaims,
  sweepExpiredClaims,
} from "../../packages/gittensory-miner/lib/claim-ledger-expiry.js";
import {
  closeDefaultClaimLedger,
  openClaimLedger,
} from "../../packages/gittensory-miner/lib/claim-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-claim-expiry-"));
  roots.push(root);
  const ledger = openClaimLedger(join(root, "claim-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    apiBaseUrl: "https://api.github.com",
    repoFullName: "o/a",
    issueNumber: 1,
    claimedAt: "2026-01-01T00:00:00.000Z",
    status: "active" as const,
    note: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultClaimLedger();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner claim ledger expiry (#2316)", () => {
  it("documents a 14-day default max age", () => {
    expect(DEFAULT_MAX_CLAIM_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("findExpiredClaims returns no rows when every active claim is within the window", () => {
    const nowMs = Date.parse("2026-07-03T00:00:00.000Z");
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const claims = [
      claim({ issueNumber: 1, claimedAt: "2026-07-01T00:00:00.000Z" }),
      claim({ issueNumber: 2, claimedAt: "2026-06-27T00:00:00.000Z" }), // age === maxAgeMs
    ];
    expect(findExpiredClaims(claims, nowMs, maxAgeMs)).toEqual([]);
  });

  it("findExpiredClaims returns every stale active claim when all are older than maxAgeMs", () => {
    const nowMs = Date.parse("2026-07-03T00:00:00.000Z");
    const maxAgeMs = 1 * 24 * 60 * 60 * 1000;
    const staleA = claim({ issueNumber: 1, claimedAt: "2026-06-30T00:00:00.000Z" });
    const staleB = claim({ issueNumber: 2, claimedAt: "2026-06-01T00:00:00.000Z" });
    expect(findExpiredClaims([staleA, staleB], nowMs, maxAgeMs)).toEqual([staleA, staleB]);
  });

  it("findExpiredClaims ignores non-active rows and keeps only strictly stale actives in mixed input", () => {
    const nowMs = Date.parse("2026-07-03T00:00:00.000Z");
    const maxAgeMs = 2 * 24 * 60 * 60 * 1000;
    const fresh = claim({ issueNumber: 1, claimedAt: "2026-07-02T12:00:00.000Z" });
    const stale = claim({ issueNumber: 2, claimedAt: "2026-06-28T00:00:00.000Z" });
    const released = claim({ issueNumber: 3, claimedAt: "2026-01-01T00:00:00.000Z", status: "released" });
    expect(findExpiredClaims([fresh, stale, released], nowMs, maxAgeMs)).toEqual([stale]);
  });

  it("findExpiredClaims treats age === maxAgeMs as still active (boundary)", () => {
    const nowMs = Date.parse("2026-07-10T00:00:00.000Z");
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const boundary = claim({ claimedAt: "2026-07-03T00:00:00.000Z" });
    const justExpired = claim({ issueNumber: 2, claimedAt: "2026-07-02T23:59:59.999Z" });
    expect(findExpiredClaims([boundary], nowMs, maxAgeMs)).toEqual([]);
    expect(findExpiredClaims([justExpired], nowMs, maxAgeMs)).toEqual([justExpired]);
  });

  it("findExpiredClaims rejects invalid inputs", () => {
    expect(() => findExpiredClaims([], Number.NaN, 1)).toThrow("invalid_now_ms");
    expect(() => findExpiredClaims([], 0, -1)).toThrow("invalid_max_age_ms");
    expect(() => findExpiredClaims(null as never, 0, 1)).toThrow("invalid_claims");
  });

  it("sweepExpiredClaims transitions stale active rows to expired in SQLite", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
    const ledger = tempLedger();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const nowMs = Date.parse("2026-07-03T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-06-20T00:00:00.000Z"));
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 1 });
    vi.setSystemTime(new Date("2026-07-02T00:00:00.000Z"));
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 2 });

    expect(sweepExpiredClaims(ledger, nowMs, maxAgeMs).map((entry) => entry.issueNumber)).toEqual([1]);
    expect(ledger.listClaims({ status: "active" }).map((entry) => entry.issueNumber)).toEqual([2]);
    expect(ledger.listClaims({ status: "expired" }).map((entry) => entry.issueNumber)).toEqual([1]);
    expect(sweepExpiredClaims(ledger, nowMs, maxAgeMs)).toEqual([]);
  });

  it("expireClaim is a no-op for non-active rows and returns null on a second sweep", () => {
    const ledger = tempLedger();
    ledger.recordClaim({ repoFullName: "o/a", issueNumber: 9 });
    ledger.releaseClaim("o/a", 9);
    expect(ledger.expireClaim("o/a", 9)).toBeNull();
    expect(ledger.expireClaim("o/a", 404)).toBeNull();
  });

  it("REGRESSION: sweepExpiredClaims echoes each claim's own apiBaseUrl, so it can't expire the wrong host's row (#5563)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const ledger = tempLedger();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;

    // Two forge hosts each claim the SAME repo/issue pair -- only possible post-#5563's scoped uniqueness. The
    // GHE claim is recorded first (stale by nowMs); the github.com claim is recorded a week later (still fresh).
    ledger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 1, apiBaseUrl: "https://ghe.example.com/api/v3" });
    vi.setSystemTime(new Date("2026-06-08T00:00:00.000Z"));
    ledger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 1, apiBaseUrl: "https://api.github.com" });

    const nowMs = Date.parse("2026-06-09T00:00:00.000Z");
    const transitioned = sweepExpiredClaims(ledger, nowMs, maxAgeMs);
    expect(transitioned).toEqual([expect.objectContaining({ apiBaseUrl: "https://ghe.example.com/api/v3", status: "expired" })]);

    const active = ledger.listClaims({ repoFullName: "acme/widgets", status: "active" });
    expect(active).toEqual([expect.objectContaining({ apiBaseUrl: "https://api.github.com" })]);
  });
});
