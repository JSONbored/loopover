import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultClaimLedger,
  openClaimLedger,
} from "../../packages/gittensory-miner/lib/claim-ledger.js";
import type { ClaimEntry } from "../../packages/gittensory-miner/lib/claim-ledger.d.ts";
import {
  parseClaimClaimArgs,
  parseClaimListArgs,
  parseClaimReleaseArgs,
  renderClaimsTable,
  runClaimClaim,
  runClaimCli,
  runClaimList,
  runClaimRelease,
} from "../../packages/gittensory-miner/lib/claim-ledger-cli.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempClaimLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-claim-ledger-cli-"));
  roots.push(root);
  const ledger = openClaimLedger(join(root, "claim-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultClaimLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner claim ledger CLI (#4290)", () => {
  it("parseClaimClaimArgs, parseClaimReleaseArgs, and parseClaimListArgs validate argv", () => {
    expect(parseClaimClaimArgs(["acme/widgets", "42", "--note", "wip", "--dry-run", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      note: "wip",
      dryRun: true,
      json: true,
    });
    expect(parseClaimClaimArgs(["acme/widgets", "42"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      note: undefined,
      dryRun: false,
      json: false,
    });
    expect(parseClaimClaimArgs(["acme/widgets"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim claim"),
    });
    expect(parseClaimClaimArgs(["acme", "42"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseClaimClaimArgs(["acme/widgets", "0"])).toEqual({
      error: "issue number must be a positive integer.",
    });
    expect(parseClaimClaimArgs(["acme/widgets", "42", "--note"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim claim"),
    });
    expect(parseClaimClaimArgs(["acme/widgets", "42", "--verbose"])).toEqual({
      error: "Unknown option: --verbose",
    });

    expect(parseClaimReleaseArgs(["acme/widgets", "7", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      dryRun: false,
      json: true,
    });
    expect(parseClaimReleaseArgs(["acme/widgets"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim release"),
    });
    expect(parseClaimReleaseArgs(["acme/widgets", "7", "--bad"])).toEqual({
      error: "Unknown option: --bad",
    });

    expect(parseClaimListArgs([])).toEqual({
      json: false,
      repoFullName: null,
      status: null,
    });
    expect(parseClaimListArgs(["--repo", "acme/widgets", "--status", "active", "--json"])).toEqual({
      json: true,
      repoFullName: "acme/widgets",
      status: "active",
    });
    expect(parseClaimListArgs(["--status", "bogus"])).toEqual({
      error: "status must be one of: active, released, expired.",
    });
    expect(parseClaimListArgs(["--repo"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim list"),
    });
    expect(parseClaimListArgs(["extra"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim list"),
    });
    expect(parseClaimListArgs(["--status", "released", "--unknown"])).toEqual({
      error: "Unknown option: --unknown",
    });
  });

  it("parseClaimClaimArgs and parseClaimReleaseArgs accept --api-base-url (#5563)", () => {
    expect(parseClaimClaimArgs(["acme/widgets", "42", "--api-base-url", "https://ghe.example.com/api/v3"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      note: undefined,
      dryRun: false,
      json: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
    expect(parseClaimClaimArgs(["acme/widgets", "42", "--api-base-url"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim claim"),
    });

    expect(parseClaimReleaseArgs(["acme/widgets", "7", "--api-base-url", "https://ghe.example.com/api/v3"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      dryRun: false,
      json: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
    expect(parseClaimReleaseArgs(["acme/widgets", "7", "--api-base-url"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner claim release"),
    });
  });

  it("renderClaimsTable formats claim rows and empty output", () => {
    const entries: ClaimEntry[] = [
      {
        id: 1,
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        issueNumber: 7,
        status: "active",
        claimedAt: "2026-07-04T12:00:00.000Z",
        note: "wip",
      },
    ];
    expect(renderClaimsTable([])).toBe("no claim ledger entries");
    expect(renderClaimsTable(entries)).toContain("acme/widgets");
    expect(renderClaimsTable(entries)).toContain("     7");
    expect(renderClaimsTable(entries)).toContain("wip");
    expect(
      renderClaimsTable([
        {
          ...entries[0]!,
          note: null,
        },
      ]),
    ).toContain("-");
  });

  it("runClaimClaim records a claim and prints table or JSON output", () => {
    const claimLedger = tempClaimLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      runClaimClaim(["acme/widgets", "42", "--note", "on it"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("active");

    log.mockClear();
    expect(
      runClaimClaim(["acme/widgets", "42", "--json"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      claim: expect.objectContaining({
        repoFullName: "acme/widgets",
        issueNumber: 42,
        status: "active",
        note: "on it",
      }),
    });
  });

  it("runClaimClaim and runClaimRelease thread --api-base-url through, so two hosts don't collide (#5563)", () => {
    const claimLedger = tempClaimLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      runClaimClaim(["acme/widgets", "1", "--api-base-url", "https://api.github.com"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(
      runClaimClaim(["acme/widgets", "1", "--api-base-url", "https://ghe.example.com/api/v3"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(claimLedger.listClaims({ repoFullName: "acme/widgets" })).toHaveLength(2);

    // Releasing the GHE host's claim must not touch the github.com host's claim.
    log.mockClear();
    expect(
      runClaimRelease(["acme/widgets", "1", "--api-base-url", "https://ghe.example.com/api/v3", "--json"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      claim: expect.objectContaining({ apiBaseUrl: "https://ghe.example.com/api/v3", status: "released" }),
    });
    const active = claimLedger.listClaims({ repoFullName: "acme/widgets", status: "active" });
    expect(active).toEqual([expect.objectContaining({ apiBaseUrl: "https://api.github.com" })]);
  });

  it("#4847: --dry-run reports what would happen and returns 0 without opening the claim ledger", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const openClaimLedgerSpy = vi.fn();

    expect(
      runClaimClaim(["acme/widgets", "42", "--note", "on it", "--dry-run", "--json"], {
        openClaimLedger: openClaimLedgerSpy,
      }),
    ).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "dry_run",
      repoFullName: "acme/widgets",
      issueNumber: 42,
      note: "on it",
    });

    log.mockClear();
    expect(runClaimClaim(["acme/widgets", "42", "--dry-run"], { openClaimLedger: openClaimLedgerSpy })).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("DRY RUN: would claim acme/widgets#42");
    expect(String(log.mock.calls[0]?.[0])).not.toContain("note:");

    log.mockClear();
    expect(
      runClaimClaim(["acme/widgets", "42", "--note", "on it", "--dry-run"], { openClaimLedger: openClaimLedgerSpy }),
    ).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("DRY RUN: would claim acme/widgets#42 (note: on it)");

    log.mockClear();
    expect(runClaimRelease(["acme/widgets", "42", "--dry-run"], { openClaimLedger: openClaimLedgerSpy })).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("DRY RUN: would release the claim on acme/widgets#42");

    log.mockClear();
    expect(
      runClaimRelease(["acme/widgets", "42", "--dry-run", "--json"], { openClaimLedger: openClaimLedgerSpy }),
    ).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "dry_run",
      repoFullName: "acme/widgets",
      issueNumber: 42,
    });
  });

  it("runClaimRelease releases a claim and rejects missing entries", () => {
    const claimLedger = tempClaimLedger();
    claimLedger.claimIssue("acme/widgets", 9);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runClaimRelease(["acme/widgets", "9"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("released");

    log.mockClear();
    claimLedger.claimIssue("acme/widgets", 10);
    expect(
      runClaimRelease(["acme/widgets", "10", "--json"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      claim: expect.objectContaining({ status: "released", issueNumber: 10 }),
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runClaimRelease(["acme/widgets", "404"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("claim_not_found");
    error.mockClear();
    log.mockClear();
    expect(
      runClaimRelease(["acme/widgets", "404", "--json"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "claim_not_found",
    });
  });

  it("runClaimList prints table and JSON output with repo and status filters", () => {
    const claimLedger = tempClaimLedger();
    claimLedger.claimIssue("acme/widgets", 1);
    claimLedger.claimIssue("acme/other", 2);
    claimLedger.releaseClaim("acme/other", 2);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runClaimList([], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("acme/widgets");

    log.mockClear();
    expect(
      runClaimList(["--repo", "acme/other", "--status", "released", "--json"], {
        openClaimLedger: () => claimLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      claims: [expect.objectContaining({ repoFullName: "acme/other", status: "released" })],
    });
  });

  it("runClaimCli dispatches claim, release, and list subcommands", () => {
    const claimLedger = tempClaimLedger();
    const options = { openClaimLedger: () => claimLedger };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runClaimCli("claim", ["acme/widgets", "3", "--json"], options)).toBe(0);
    expect(runClaimCli("list", ["--json"], options)).toBe(0);
    expect(runClaimCli("release", ["acme/widgets", "3"], options)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("rejects unknown claim subcommands, options, and ledger failures", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runClaimCli("peek", [])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown claim subcommand");
    expect(runClaimCli(undefined, [])).toBe(2);

    expect(runClaimClaim(["acme/widgets"])).toBe(2);
    expect(
      runClaimClaim(["acme/widgets", "1"], {
        openClaimLedger: () => {
          throw new Error("ledger_broken");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("ledger_broken");
    error.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runClaimClaim(["acme/widgets", "1", "--json"], {
        openClaimLedger: () => {
          throw new Error("ledger_broken");
        },
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "ledger_broken",
    });

    error.mockClear();
    expect(
      runClaimRelease(["acme/widgets", "1"], {
        openClaimLedger: () => {
          throw new Error("release_broken");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("release_broken");

    error.mockClear();
    expect(
      runClaimList([], {
        openClaimLedger: () => {
          throw new Error("list_broken");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("list_broken");
  });
});
