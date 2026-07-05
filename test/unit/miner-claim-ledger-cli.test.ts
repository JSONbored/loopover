import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultClaimLedger,
  openClaimLedger,
} from "../../packages/gittensory-miner/lib/claim-ledger.js";
import {
  parseClaimsClaimArgs,
  parseClaimsListArgs,
  parseClaimsReleaseArgs,
  parseClaimsSweepArgs,
  renderClaimsTable,
  runClaimsClaim,
  runClaimsCli,
  runClaimsList,
  runClaimsRelease,
  runClaimsSweep,
} from "../../packages/gittensory-miner/lib/claim-ledger-cli.js";
import type { ClaimEntry } from "../../packages/gittensory-miner/lib/claim-ledger.d.ts";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-claim-cli-"));
  roots.push(root);
  const ledger = openClaimLedger(join(root, "claim-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultClaimLedger();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner claims CLI (#2314/#2316)", () => {
  it("parseClaimsListArgs, parseClaimsClaimArgs, parseClaimsReleaseArgs, and parseClaimsSweepArgs validate argv", () => {
    expect(parseClaimsListArgs(["--repo", "acme/widgets", "--status", "active", "--json"])).toEqual({
      json: true,
      repoFullName: "acme/widgets",
      status: "active",
    });
    expect(parseClaimsClaimArgs(["acme/widgets", "42", "--note", "mine"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      note: "mine",
      json: false,
    });
    expect(parseClaimsClaimArgs(["acme/widgets", "42", "--note", "-blocked"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      note: "-blocked",
      json: false,
    });
    expect(parseClaimsReleaseArgs(["acme/widgets", "7", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      json: true,
    });
    expect(parseClaimsSweepArgs(["--max-age-days", "3", "--json"])).toEqual({
      json: true,
      maxAgeDays: 3,
    });
    expect(parseClaimsClaimArgs(["acme/widgets"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claims claim"),
    });
  });

  it("renderClaimsTable formats claim rows and empty output", () => {
    const claims: ClaimEntry[] = [
      {
        id: 1,
        repoFullName: "acme/widgets",
        issueNumber: 9,
        status: "active",
        claimedAt: "2026-07-04T12:00:00.000Z",
        note: "working",
      },
    ];
    expect(renderClaimsTable([])).toBe("no claim ledger entries");
    expect(renderClaimsTable(claims)).toContain("working");
    expect(renderClaimsTable(claims)).toContain("    9");
  });

  it("runClaimsList prints table and JSON output", () => {
    const claimLedger = tempLedger();
    claimLedger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 1, note: "a" });
    claimLedger.recordClaim({ repoFullName: "acme/other", issueNumber: 2 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runClaimsList([], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("acme/widgets");

    log.mockClear();
    expect(
      runClaimsList(["--repo", "acme/other", "--json"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      claims: [expect.objectContaining({ issueNumber: 2, repoFullName: "acme/other" })],
    });
  });

  it("runClaimsClaim and runClaimsRelease mutate the ledger", () => {
    const claimLedger = tempLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      runClaimsClaim(["acme/widgets", "12", "--note", "phase-2"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("active");
    expect(claimLedger.listClaims({ status: "active" })).toHaveLength(1);

    log.mockClear();
    expect(
      runClaimsRelease(["acme/widgets", "12"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("released");
  });

  it("runClaimsRelease is idempotent for already-released claims", () => {
    const claimLedger = tempLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const options = { openClaimLedger: () => claimLedger };

    expect(runClaimsClaim(["acme/widgets", "12"], options)).toBe(0);
    expect(runClaimsRelease(["acme/widgets", "12"], options)).toBe(0);

    log.mockClear();
    expect(runClaimsRelease(["acme/widgets", "12"], options)).toBe(0);
    expect(log).toHaveBeenCalledWith("released");
  });

  it("runClaimsRelease fails closed when the claim is missing or not active", () => {
    const claimLedger = tempLedger();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runClaimsRelease(["acme/widgets", "404"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("claim_not_found_or_not_active");
  });

  it("runClaimsSweep expires stale active claims", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:00.000Z"));
    const claimLedger = tempLedger();
    claimLedger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 1 });
    vi.setSystemTime(new Date("2026-07-02T00:00:00.000Z"));
    claimLedger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 2 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runClaimsSweep(["--max-age-days", "7", "--json"], {
        openClaimLedger: () => claimLedger,
        nowMs: Date.parse("2026-07-03T00:00:00.000Z"),
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      expired: [expect.objectContaining({ issueNumber: 1, status: "expired" })],
      maxAgeDays: 7,
    });
    expect(claimLedger.listClaims({ status: "active" }).map((entry) => entry.issueNumber)).toEqual([2]);
  });

  it("runClaimsCli dispatches list, claim, release, and sweep subcommands", () => {
    const claimLedger = tempLedger();
    const options = { openClaimLedger: () => claimLedger, nowMs: Date.parse("2026-07-03T00:00:00.000Z") };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runClaimsCli("list", ["--json"], options)).toBe(0);
    expect(runClaimsCli("claim", ["acme/widgets", "3"], options)).toBe(0);
    expect(runClaimsCli("release", ["acme/widgets", "3"], options)).toBe(0);
    expect(runClaimsCli("sweep", [], options)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("rejects unknown claims subcommands and options", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runClaimsCli("peek", [])).toBe(2);
    expect(runClaimsList(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown claims subcommand");
    expect(String(error.mock.calls[0]?.[0])).toContain("list|claim|release|sweep");
  });
});
