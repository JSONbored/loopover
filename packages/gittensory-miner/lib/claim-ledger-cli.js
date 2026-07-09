import { CLAIM_STATUSES, openClaimLedger } from "./claim-ledger.js";

const CLAIM_CLAIM_USAGE =
  "Usage: gittensory-miner claim claim <owner/repo> <issue#> [--note <text>] [--json]";
const CLAIM_RELEASE_USAGE = "Usage: gittensory-miner claim release <owner/repo> <issue#> [--json]";
const CLAIM_LIST_USAGE =
  "Usage: gittensory-miner claim list [--repo <owner/repo>] [--status active|released|expired] [--json]";

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

function parseIssueNumberArg(value, usage) {
  if (!value) return { error: usage };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { error: "issue number must be a positive integer." };
  }
  return { issueNumber: parsed };
}

export function parseClaimClaimArgs(args) {
  const options = { json: false, note: undefined };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
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
    json: options.json,
  };
}

export function parseClaimReleaseArgs(args) {
  const options = { json: false };
  const positional = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
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
    json: options.json,
  };
}

export function parseClaimListArgs(args) {
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
      if (!CLAIM_STATUSES.includes(statusArg)) {
        return { error: `status must be one of: ${CLAIM_STATUSES.join(", ")}.` };
      }
      options.status = statusArg;
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

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderClaimsTable(entries) {
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

function withClaimLedger(options, run) {
  const ownsLedger = options.openClaimLedger === undefined;
  const claimLedger = (options.openClaimLedger ?? openClaimLedger)();
  try {
    return run(claimLedger);
  } finally {
    if (ownsLedger) claimLedger.close();
  }
}

export function runClaimClaim(args, options = {}) {
  const parsed = parseClaimClaimArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const claim = claimLedger.claimIssue(
        parsed.repoFullName,
        parsed.issueNumber,
        parsed.note,
      );
      if (parsed.json) {
        console.log(JSON.stringify({ claim }, null, 2));
      } else {
        console.log(claim.status);
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimRelease(args, options = {}) {
  const parsed = parseClaimReleaseArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const claim = claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber);
      if (!claim) {
        console.error("claim_not_found");
        return 2;
      }
      if (parsed.json) {
        console.log(JSON.stringify({ claim }, null, 2));
      } else {
        console.log(claim.status);
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimList(args, options = {}) {
  const parsed = parseClaimListArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withClaimLedger(options, (claimLedger) => {
      const filter = {};
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
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runClaimCli(subcommand, args, options = {}) {
  if (subcommand === "claim") return runClaimClaim(args, options);
  if (subcommand === "release") return runClaimRelease(args, options);
  if (subcommand === "list") return runClaimList(args, options);
  console.error(`Unknown claim subcommand: ${subcommand ?? ""}. ${CLAIM_LIST_USAGE}`);
  return 2;
}
