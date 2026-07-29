import { CLAIM_STATUSES, openClaimLedger } from "./claim-ledger.js";
import type { ClaimEntry, ClaimLedger, ClaimStatus } from "./claim-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";

const CLAIM_CLAIM_USAGE =
  "Usage: loopover-miner claim claim <owner/repo> <issue#> [--note <text>] [--api-base-url <url>] [--dry-run] [--json]";
const CLAIM_RELEASE_USAGE =
  "Usage: loopover-miner claim release <owner/repo> <issue#> [--api-base-url <url>] [--dry-run] [--json]";
const CLAIM_LIST_USAGE =
  "Usage: loopover-miner claim list [--repo <owner/repo>] [--status active|released|expired] [--json]";
const CLAIM_RECLAIM_USAGE =
  "Usage: loopover-miner claim reclaim [--max-age-ms <n>] [--dry-run] [--json]";

export type ParsedClaimClaimArgs =
  | {
      repoFullName: string;
      issueNumber: number;
      note: string | undefined;
      dryRun: boolean;
      json: boolean;
      apiBaseUrl: string | undefined;
    }
  | { error: string };

export type ParsedClaimReleaseArgs =
  | {
      repoFullName: string;
      issueNumber: number;
      dryRun: boolean;
      json: boolean;
      apiBaseUrl: string | undefined;
    }
  | { error: string };

export type ParsedClaimListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      status: ClaimStatus | null;
    }
  | { error: string };

export type ParsedClaimReclaimArgs =
  | {
      maxAgeMs: number | undefined;
      dryRun: boolean;
      json: boolean;
    }
  | { error: string };

export type ClaimLedgerCliOptions = { openClaimLedger?: () => ClaimLedger };

type ParsedRepoArg = { repoFullName: string } | { error: string };
type ParsedIssueNumberArg = { issueNumber: number } | { error: string };

function parseRepoArg(value: string | undefined, usage: string): ParsedRepoArg {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined || !isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

function parseIssueNumberArg(value: string | undefined, usage: string): ParsedIssueNumberArg {
  if (!value) return { error: usage };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { error: "issue number must be a positive integer." };
  }
  return { issueNumber: parsed };
}

export function parseClaimClaimArgs(args: string[]): ParsedClaimClaimArgs {
  const options: { json: boolean; note: string | undefined; dryRun: boolean; apiBaseUrl: string | undefined } = {
    json: false,
    note: undefined,
    dryRun: false,
    apiBaseUrl: undefined,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #4847: reports what a real claim would do and returns before opening the claim ledger at all.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--note") {
      const note = args[index + 1];
      if (!note || note.startsWith("-")) {
        return { error: CLAIM_CLAIM_USAGE };
      }
      options.note = note;
      index += 1;
      continue;
    }
    // #5563: scope the claim to a non-default forge host, so it doesn't collide with (or get confused for) a
    // same-named repo on the default github.com host.
    if (token === "--api-base-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: CLAIM_CLAIM_USAGE };
      }
      options.apiBaseUrl = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 2) {
    return { error: CLAIM_CLAIM_USAGE };
  }

  const repo = parseRepoArg(positional[0], CLAIM_CLAIM_USAGE);
  if ("error" in repo) return repo;
  const issue = parseIssueNumberArg(positional[1], CLAIM_CLAIM_USAGE);
  if ("error" in issue) return issue;

  return {
    repoFullName: repo.repoFullName,
    issueNumber: issue.issueNumber,
    note: options.note,
    dryRun: options.dryRun,
    json: options.json,
    apiBaseUrl: options.apiBaseUrl,
  };
}

export function parseClaimReleaseArgs(args: string[]): ParsedClaimReleaseArgs {
  const options: { json: boolean; dryRun: boolean; apiBaseUrl: string | undefined } = {
    json: false,
    dryRun: false,
    apiBaseUrl: undefined,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--api-base-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: CLAIM_RELEASE_USAGE };
      }
      options.apiBaseUrl = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 2) {
    return { error: CLAIM_RELEASE_USAGE };
  }

  const repo = parseRepoArg(positional[0], CLAIM_RELEASE_USAGE);
  if ("error" in repo) return repo;
  const issue = parseIssueNumberArg(positional[1], CLAIM_RELEASE_USAGE);
  if ("error" in issue) return issue;

  return {
    repoFullName: repo.repoFullName,
    issueNumber: issue.issueNumber,
    dryRun: options.dryRun,
    json: options.json,
    apiBaseUrl: options.apiBaseUrl,
  };
}

export function parseClaimListArgs(args: string[]): ParsedClaimListArgs {
  const options: { json: boolean; repoFullName: string | null; status: ClaimStatus | null } = {
    json: false,
    repoFullName: null,
    status: null,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--repo") {
      const repoArg = args[index + 1];
      if (!repoArg || repoArg.startsWith("-")) {
        return { error: CLAIM_LIST_USAGE };
      }
      const repo = parseRepoArg(repoArg, CLAIM_LIST_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token === "--status") {
      const statusArg = args[index + 1];
      if (!statusArg || statusArg.startsWith("-")) {
        return { error: CLAIM_LIST_USAGE };
      }
      if (!CLAIM_STATUSES.includes(statusArg as ClaimStatus)) {
        return { error: `status must be one of: ${CLAIM_STATUSES.join(", ")}.` };
      }
      options.status = statusArg as ClaimStatus;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length > 0) {
    return { error: CLAIM_LIST_USAGE };
  }

  return options;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderClaimsTable(entries: ClaimEntry[]): string {
  if (!Array.isArray(entries) || entries.length === 0) return "no claim ledger entries";
  const header = [
    "repo".padEnd(24),
    "issue".padStart(6),
    "status".padEnd(10),
    "claimed-at".padEnd(24),
    "note".padEnd(16),
  ].join(" ");
  const lines = entries.map((entry) =>
    [
      entry.repoFullName.padEnd(24),
      display(entry.issueNumber).padStart(6),
      entry.status.padEnd(10),
      display(entry.claimedAt).padEnd(24),
      display(entry.note).padEnd(16),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

function withClaimLedger<T>(options: ClaimLedgerCliOptions, run: (claimLedger: ClaimLedger) => T): T {
  const ownsLedger = options.openClaimLedger === undefined;
  const claimLedger = (options.openClaimLedger ?? openClaimLedger)();
  try {
    return run(claimLedger);
  } finally {
    if (ownsLedger) claimLedger.close();
  }
}

export function runClaimClaim(args: string[], options: ClaimLedgerCliOptions = {}): number {
  const parsed = parseClaimClaimArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber, note: parsed.note ?? null };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(
        `DRY RUN: would claim ${parsed.repoFullName}#${parsed.issueNumber}${parsed.note ? ` (note: ${parsed.note})` : ""}. No claim-ledger write was made.`,
      );
    }
    return 0;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const claim = claimLedger.claimIssue(
        parsed.repoFullName,
        parsed.issueNumber,
        parsed.note,
        parsed.apiBaseUrl,
      );
      if (parsed.json) {
        console.log(JSON.stringify({ claim }, null, 2));
      } else {
        console.log(claim.status);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runClaimRelease(args: string[], options: ClaimLedgerCliOptions = {}): number {
  const parsed = parseClaimReleaseArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(`DRY RUN: would release the claim on ${parsed.repoFullName}#${parsed.issueNumber}. No claim-ledger write was made.`);
    }
    return 0;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const claim = claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber, parsed.apiBaseUrl);
      if (!claim) {
        return reportCliFailure(parsed.json, "claim_not_found");
      }
      if (parsed.json) {
        console.log(JSON.stringify({ claim }, null, 2));
      } else {
        console.log(claim.status);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runClaimList(args: string[], options: ClaimLedgerCliOptions = {}): number {
  const parsed = parseClaimListArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const filter: { repoFullName?: string; status?: ClaimStatus } = {};
      if (parsed.repoFullName !== null) filter.repoFullName = parsed.repoFullName;
      if (parsed.status !== null) filter.status = parsed.status;
      const claims = claimLedger.listClaims(filter);
      if (parsed.json) {
        console.log(JSON.stringify({ claims }, null, 2));
      } else {
        console.log(renderClaimsTable(claims));
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function parseClaimReclaimArgs(args: string[]): ParsedClaimReclaimArgs {
  const options: { json: boolean; dryRun: boolean; maxAgeMs: number | undefined } = {
    json: false,
    dryRun: false,
    maxAgeMs: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--max-age-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: CLAIM_RECLAIM_USAGE };
      }
      const parsed = Number(value);
      // Only a finite integer >= 0 is a valid claim age; reject fractional, negative, and non-numeric input so
      // a typo can never be silently coerced into an unbounded or nonsensical reclaim window.
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { error: CLAIM_RECLAIM_USAGE };
      }
      options.maxAgeMs = parsed;
      index += 1;
      continue;
    }
    return { error: token.startsWith("-") ? `Unknown option: ${token}` : CLAIM_RECLAIM_USAGE };
  }

  return { maxAgeMs: options.maxAgeMs, dryRun: options.dryRun, json: options.json };
}

/** `reclaim [--max-age-ms <n>] [--dry-run] [--json]`: expire claims orphaned by a crashed/killed attempt,
 *  the manual counterpart to the automatic sweep claimIssue runs (mirrors `queue release` for the analogous
 *  portfolio-queue lease). Omitting --max-age-ms uses the ledger's own DEFAULT_MAX_CLAIM_AGE_MS. Exit 0 even
 *  when nothing is over-age -- reclaiming nothing is not a failure. */
export function runClaimReclaim(args: string[], options: ClaimLedgerCliOptions = {}): number {
  const parsed = parseClaimReclaimArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    // Short-circuit BEFORE withClaimLedger so a dry run never opens the ledger at all, matching runQueueRelease.
    const dryRunResult = { outcome: "dry_run", maxAgeMs: parsed.maxAgeMs ?? null };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      const window = parsed.maxAgeMs === undefined ? "the default max age" : `${parsed.maxAgeMs}ms`;
      console.log(`DRY RUN: would reclaim claims older than ${window}. No claim-ledger write was made.`);
    }
    return 0;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const reclaimed = claimLedger.reclaimExpiredClaims(parsed.maxAgeMs);
      if (parsed.json) {
        console.log(JSON.stringify({ reclaimed }, null, 2));
      } else if (reclaimed.length === 0) {
        console.log("none");
      } else {
        for (const claim of reclaimed) {
          console.log(`${claim.repoFullName}#${claim.issueNumber} ${claim.status}`);
        }
        console.log(`reclaimed ${reclaimed.length}`);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runClaimCli(subcommand: string | undefined, args: string[], options: ClaimLedgerCliOptions = {}): number {
  if (subcommand === "claim") return runClaimClaim(args, options);
  if (subcommand === "release") return runClaimRelease(args, options);
  if (subcommand === "list") return runClaimList(args, options);
  if (subcommand === "reclaim") return runClaimReclaim(args, options);
  return reportCliFailure(argsWantJson(args), `Unknown claim subcommand: ${subcommand ?? ""}. ${CLAIM_LIST_USAGE}`);
}
