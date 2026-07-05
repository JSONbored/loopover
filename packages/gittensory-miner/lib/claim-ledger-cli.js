import { CLAIM_STATUSES, openClaimLedger } from "./claim-ledger.js";
import { DEFAULT_MAX_CLAIM_AGE_MS, sweepExpiredClaims } from "./claim-ledger-expiry.js";

const CLAIMS_USAGE =
  "Usage: gittensory-miner claims list|claim|release|sweep (run --help for details)";
const CLAIMS_LIST_USAGE =
  "Usage: gittensory-miner claims list [--repo <owner/repo>] [--status active|released|expired] [--json]";
const CLAIMS_CLAIM_USAGE =
  "Usage: gittensory-miner claims claim <owner/repo> <issue#> [--note <text>] [--json]";
const CLAIMS_RELEASE_USAGE = "Usage: gittensory-miner claims release <owner/repo> <issue#> [--json]";
const CLAIMS_SWEEP_USAGE = "Usage: gittensory-miner claims sweep [--max-age-days <n>] [--json]";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

function parseIssueNumber(value) {
  const issueNumber = Number(value);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: "Issue number must be a positive integer." };
  }
  return { issueNumber };
}

function parseJsonFlag(args) {
  const options = { json: false };
  const positional = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  return { positional, ...options };
}

export function parseClaimsListArgs(args) {
  const options = { json: false, repoFullName: null, status: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--repo") {
      const repoArg = args[index + 1];
      if (!repoArg || repoArg.startsWith("--")) return { error: CLAIMS_LIST_USAGE };
      const repo = parseRepoArg(repoArg, CLAIMS_LIST_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token === "--status") {
      const status = args[index + 1];
      if (!status || status.startsWith("--")) return { error: CLAIMS_LIST_USAGE };
      if (!CLAIM_STATUSES.includes(status)) {
        return { error: `Invalid status: ${status}. Expected one of ${CLAIM_STATUSES.join(", ")}.` };
      }
      options.status = status;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: CLAIMS_LIST_USAGE };
  return options;
}

export function parseClaimsClaimArgs(args) {
  const options = { json: false, note: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--note") {
      const note = args[index + 1];
      if (note === undefined) return { error: CLAIMS_CLAIM_USAGE };
      options.note = note;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length !== 2) return { error: CLAIMS_CLAIM_USAGE };

  const repo = parseRepoArg(positional[0], CLAIMS_CLAIM_USAGE);
  if ("error" in repo) return repo;
  const issue = parseIssueNumber(positional[1]);
  if ("error" in issue) return issue;

  return {
    repoFullName: repo.repoFullName,
    issueNumber: issue.issueNumber,
    note: options.note,
    json: options.json,
  };
}

export function parseClaimsReleaseArgs(args) {
  const parsed = parseJsonFlag(args);
  if ("error" in parsed) return parsed;
  if (parsed.positional.length !== 2) return { error: CLAIMS_RELEASE_USAGE };

  const repo = parseRepoArg(parsed.positional[0], CLAIMS_RELEASE_USAGE);
  if ("error" in repo) return repo;
  const issue = parseIssueNumber(parsed.positional[1]);
  if ("error" in issue) return issue;

  return {
    repoFullName: repo.repoFullName,
    issueNumber: issue.issueNumber,
    json: parsed.json,
  };
}

export function parseClaimsSweepArgs(args) {
  const options = { json: false, maxAgeDays: DEFAULT_MAX_CLAIM_AGE_MS / MS_PER_DAY };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--max-age-days") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { error: CLAIMS_SWEEP_USAGE };
      const maxAgeDays = Number(value);
      if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) {
        return { error: "max-age-days must be a positive integer." };
      }
      options.maxAgeDays = maxAgeDays;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: CLAIMS_SWEEP_USAGE };
  return options;
}

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderClaimsTable(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return "no claim ledger entries";
  const header = [
    "repo".padEnd(24),
    "issue".padStart(5),
    "status".padEnd(10),
    "claimed-at".padEnd(24),
    "note".padEnd(16),
  ].join(" ");
  const lines = claims.map((entry) =>
    [
      entry.repoFullName.padEnd(24),
      String(entry.issueNumber).padStart(5),
      entry.status.padEnd(10),
      display(entry.claimedAt).padEnd(24),
      display(entry.note).padEnd(16),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

function withClaimLedger(options, run) {
  const ownsLedger = options.openClaimLedger === undefined;
  const claimLedger = (options.openClaimLedger ?? openClaimLedger)();
  try {
    return run(claimLedger);
  } finally {
    if (ownsLedger) claimLedger.close();
  }
}

function findClaim(claimLedger, repoFullName, issueNumber) {
  return claimLedger
    .listClaims({ repoFullName })
    .find((entry) => entry.issueNumber === issueNumber);
}

function emitClaimResult(claim, json) {
  if (json) {
    console.log(JSON.stringify({ claim }, null, 2));
  } else {
    console.log(claim.status);
  }
}

export function runClaimsList(args, options = {}) {
  const parsed = parseClaimsListArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const claims = claimLedger.listClaims({
        repoFullName: parsed.repoFullName,
        status: parsed.status,
      });
      if (parsed.json) {
        console.log(JSON.stringify({ claims }, null, 2));
      } else {
        console.log(renderClaimsTable(claims));
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimsClaim(args, options = {}) {
  const parsed = parseClaimsClaimArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const claim = claimLedger.recordClaim({
        repoFullName: parsed.repoFullName,
        issueNumber: parsed.issueNumber,
        note: parsed.note ?? undefined,
      });
      emitClaimResult(claim, parsed.json);
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimsRelease(args, options = {}) {
  const parsed = parseClaimsReleaseArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      let claim = claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber);
      if (!claim) {
        const existing = findClaim(claimLedger, parsed.repoFullName, parsed.issueNumber);
        if (existing?.status === "released") {
          claim = existing;
        } else {
          console.error("claim_not_found_or_not_active");
          return 2;
        }
      }
      emitClaimResult(claim, parsed.json);
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimsSweep(args, options = {}) {
  const parsed = parseClaimsSweepArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const nowMs = options.nowMs ?? Date.now();
      const maxAgeMs = parsed.maxAgeDays * MS_PER_DAY;
      const expired = sweepExpiredClaims(claimLedger, nowMs, maxAgeMs);
      if (parsed.json) {
        console.log(JSON.stringify({ expired, maxAgeDays: parsed.maxAgeDays }, null, 2));
      } else if (expired.length === 0) {
        console.log("no expired claims");
      } else {
        console.log(renderClaimsTable(expired));
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimsCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runClaimsList(args, options);
  if (subcommand === "claim") return runClaimsClaim(args, options);
  if (subcommand === "release") return runClaimsRelease(args, options);
  if (subcommand === "sweep") return runClaimsSweep(args, options);
  console.error(`Unknown claims subcommand: ${subcommand ?? ""}. ${CLAIMS_USAGE}`);
  return 2;
}
