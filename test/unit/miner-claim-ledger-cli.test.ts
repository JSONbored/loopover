import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultClaimLedger,
  openClaimLedger,
} from "../../packages/loopover-miner/lib/claim-ledger";
import type { ClaimEntry } from "../../packages/loopover-miner/lib/claim-ledger.d.ts";
import {
  parseClaimClaimArgs,
  parseClaimListArgs,
  parseClaimReclaimArgs,
  parseClaimReleaseArgs,
  renderClaimsTable,
  runClaimClaim,
  runClaimCli,
  runClaimList,
  runClaimReclaim,
  runClaimRelease,
} from "../../packages/loopover-miner/lib/claim-ledger-cli";
import { DEFAULT_MAX_CLAIM_AGE_MS } from "../../packages/loopover-miner/lib/claim-ledger-expiry";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempClaimLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-claim-ledger-cli-"));
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

describe("loopover-miner claim ledger CLI (#4290)", () => {
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
      error: expect.stringContaining("Usage: loopover-miner claim claim"),
    });
    expect(parseClaimClaimArgs(["acme", "42"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    // #5831: an unsafe path-traversal/character-set segment must be rejected here too, matching
    // repo-clone.js's own validation, instead of being persisted as a claim-ledger key unvalidated --
    // for both the owner and repo segment independently.
    expect(parseClaimClaimArgs(["../etc", "42"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseClaimClaimArgs(["acme/..", "42"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseClaimClaimArgs(["acme baz/widgets", "42"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseClaimClaimArgs(["acme/widgets baz", "42"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseClaimClaimArgs(["acme/widgets", "0"])).toEqual({
      error: "issue number must be a positive integer.",
    });
    expect(parseClaimClaimArgs(["acme/widgets", "42", "--note"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner claim claim"),
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
      error: expect.stringContaining("Usage: loopover-miner claim release"),
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
      error: expect.stringContaining("Usage: loopover-miner claim list"),
    });
    expect(parseClaimListArgs(["extra"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner claim list"),
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
      error: expect.stringContaining("Usage: loopover-miner claim claim"),
    });

    expect(parseClaimReleaseArgs(["acme/widgets", "7", "--api-base-url", "https://ghe.example.com/api/v3"])).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 7,
      dryRun: false,
      json: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
    expect(parseClaimReleaseArgs(["acme/widgets", "7", "--api-base-url"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner claim release"),
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

  it("parseClaimClaimArgs and parseClaimReleaseArgs reject an empty repo/issue positional", () => {
    expect(parseClaimClaimArgs(["", "42"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner claim claim"),
    });
    expect(parseClaimClaimArgs(["acme/widgets", ""])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner claim claim"),
    });
    expect(parseClaimReleaseArgs(["acme/widgets", "abc"])).toEqual({
      error: "issue number must be a positive integer.",
    });
    expect(parseClaimReleaseArgs(["bad", "7"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
  });

  it("parseClaimListArgs reports an invalid --repo and a missing --status value", () => {
    expect(parseClaimListArgs(["--repo", "bad"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseClaimListArgs(["--status"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner claim list"),
    });
  });

  it("runClaimRelease and runClaimList report a parse-argument error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runClaimRelease(["acme/widgets"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: loopover-miner claim release");
    error.mockClear();
    expect(runClaimList(["--bogus"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option: --bogus");
  });

  it("withClaimLedger opens and closes its own default ledger when no openClaimLedger override is given", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-claim-ledger-cli-default-"));
    roots.push(root);
    const previousDbPath = process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB;
    process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB = join(root, "claim-ledger.sqlite3");
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(runClaimList([])).toBe(0);
      expect(log).toHaveBeenCalledWith("no claim ledger entries");
    } finally {
      if (previousDbPath === undefined) delete process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB;
      else process.env.LOOPOVER_MINER_CLAIM_LEDGER_DB = previousDbPath;
    }
  });
});

describe("loopover-miner claim reclaim (#9686)", () => {
  const CLAIM_RECLAIM_USAGE =
    "Usage: loopover-miner claim reclaim [--max-age-ms <n>] [--dry-run] [--json]";

  it("parseClaimReclaimArgs validates --max-age-ms, --dry-run, and --json", () => {
    expect(parseClaimReclaimArgs([])).toEqual({ maxAgeMs: undefined, dryRun: false, json: false });
    expect(parseClaimReclaimArgs(["--max-age-ms", "1000", "--dry-run", "--json"])).toEqual({
      maxAgeMs: 1000,
      dryRun: true,
      json: true,
    });
    // 0 is a valid age (reclaim everything); the lower bound is inclusive.
    expect(parseClaimReclaimArgs(["--max-age-ms", "0"])).toEqual({ maxAgeMs: 0, dryRun: false, json: false });
    // Fractional, negative, non-numeric, and a missing value all return the usage string.
    expect(parseClaimReclaimArgs(["--max-age-ms", "1.5"])).toEqual({ error: CLAIM_RECLAIM_USAGE });
    expect(parseClaimReclaimArgs(["--max-age-ms", "-1"])).toEqual({ error: CLAIM_RECLAIM_USAGE });
    expect(parseClaimReclaimArgs(["--max-age-ms", "soon"])).toEqual({ error: CLAIM_RECLAIM_USAGE });
    expect(parseClaimReclaimArgs(["--max-age-ms"])).toEqual({ error: CLAIM_RECLAIM_USAGE });
    expect(parseClaimReclaimArgs(["--nope"])).toEqual({ error: "Unknown option: --nope" });
    expect(parseClaimReclaimArgs(["extra"])).toEqual({ error: CLAIM_RECLAIM_USAGE });
  });

  it("reclaims an over-age active claim, transitioning it to expired (default window, --max-age-ms omitted)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const claimLedger = tempClaimLedger();
    claimLedger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 7 });
    // Move the clock one hour past the default window so the claim is over-age.
    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00.000Z") + DEFAULT_MAX_CLAIM_AGE_MS + 60 * 60 * 1000));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runClaimReclaim([], { openClaimLedger: () => claimLedger })).toBe(0);
    expect(log).toHaveBeenCalledWith("acme/widgets#7 expired");
    expect(log).toHaveBeenCalledWith("reclaimed 1");
    expect(claimLedger.listClaims({ status: "expired" }).map((c) => c.issueNumber)).toEqual([7]);
  });

  it("prints 'none' and exits 0 when nothing is over-age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const claimLedger = tempClaimLedger();
    claimLedger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 7 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Still inside the default window -- reclaiming nothing is not a failure.
    expect(runClaimReclaim([], { openClaimLedger: () => claimLedger })).toBe(0);
    expect(log).toHaveBeenCalledWith("none");
    expect(claimLedger.listClaims({ status: "expired" })).toEqual([]);
  });

  it("honours an explicit smaller --max-age-ms, reclaiming a claim inside the default window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const claimLedger = tempClaimLedger();
    claimLedger.recordClaim({ repoFullName: "acme/widgets", issueNumber: 7 });
    // Two hours later: well inside the 14-day default window, but past an explicit 1-hour window.
    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00.000Z") + 2 * 60 * 60 * 1000));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runClaimReclaim(["--max-age-ms", String(60 * 60 * 1000), "--json"], { openClaimLedger: () => claimLedger })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      reclaimed: [expect.objectContaining({ repoFullName: "acme/widgets", issueNumber: 7, status: "expired" })],
    });
  });

  it("an invalid --max-age-ms returns the usage error without opening the ledger", () => {
    const openClaimLedgerSpy = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runClaimReclaim(["--max-age-ms", "-5"], { openClaimLedger: openClaimLedgerSpy })).toBe(2);
    expect(errorLog).toHaveBeenCalledWith(CLAIM_RECLAIM_USAGE);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
  });

  it("--dry-run returns 0 without opening the claim ledger (plain and --json)", () => {
    const openClaimLedgerSpy = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runClaimReclaim(["--dry-run"], { openClaimLedger: openClaimLedgerSpy })).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("DRY RUN: would reclaim claims older than the default max age. No claim-ledger write was made.");

    // Explicit --max-age-ms in the plain-text dry-run path names the exact window (the defined ternary arm).
    log.mockClear();
    expect(runClaimReclaim(["--dry-run", "--max-age-ms", "5000"], { openClaimLedger: openClaimLedgerSpy })).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("DRY RUN: would reclaim claims older than 5000ms. No claim-ledger write was made.");

    log.mockClear();
    expect(runClaimReclaim(["--dry-run", "--max-age-ms", "1000", "--json"], { openClaimLedger: openClaimLedgerSpy })).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ outcome: "dry_run", maxAgeMs: 1000 });
  });

  it("surfaces a ledger error through reportCliFailure (--json)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const thrower = () => {
      throw new Error("ledger boom");
    };
    expect(runClaimReclaim(["--json"], { openClaimLedger: thrower as never })).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
  });

  it("runClaimCli dispatches the reclaim subcommand", () => {
    const openClaimLedgerSpy = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Reachable from the dispatcher: a dry-run proves the reclaim path ran (never opens the ledger).
    expect(runClaimCli("reclaim", ["--dry-run"], { openClaimLedger: openClaimLedgerSpy })).toBe(0);
    expect(openClaimLedgerSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("DRY RUN: would reclaim claims older than the default max age. No claim-ledger write was made.");
  });
});
