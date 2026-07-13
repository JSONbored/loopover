import { RUN_STATES, getRunState, setRunState } from "./run-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

const STATE_GET_USAGE = "Usage: gittensory-miner state get <owner/repo> [--api-base-url <url>] [--json]";
const STATE_SET_USAGE =
  "Usage: gittensory-miner state set <owner/repo> <idle|discovering|planning|preparing> [--api-base-url <url>] [--dry-run] [--json]";

const allowedRunStates = new Set(RUN_STATES);

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function parseStateGetArgs(args) {
  const options = { json: false, apiBaseUrl: undefined };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #5563: scope the lookup to a non-default forge host, so it doesn't collide with (or get confused for) a
    // same-named repo on the default github.com host.
    if (token === "--api-base-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: STATE_GET_USAGE };
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

  if (positional.length !== 1) {
    return { error: STATE_GET_USAGE };
  }

  const repo = parseRepoArg(positional[0], STATE_GET_USAGE);
  if ("error" in repo) return repo;

  return { repoFullName: repo.repoFullName, ...options };
}

export function parseStateSetArgs(args) {
  const options = { json: false, dryRun: false, apiBaseUrl: undefined };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #4847: reports what a real state set would do and returns before writing to the run-state store.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--api-base-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: STATE_SET_USAGE };
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
    return { error: STATE_SET_USAGE };
  }

  const repo = parseRepoArg(positional[0], STATE_SET_USAGE);
  if ("error" in repo) return repo;

  const state = positional[1];
  if (!allowedRunStates.has(state)) {
    return { error: `Invalid state: ${state}. Expected one of ${RUN_STATES.join(", ")}.` };
  }

  return { repoFullName: repo.repoFullName, state, ...options };
}

export function runStateGet(args) {
  const parsed = parseStateGetArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    const state = getRunState(parsed.repoFullName, parsed.apiBaseUrl);
    if (parsed.json) {
      console.log(JSON.stringify({ repoFullName: parsed.repoFullName, state }));
    } else {
      console.log(state ?? "none");
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runStateSet(args) {
  const parsed = parseStateSetArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, state: parsed.state };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult));
    } else {
      console.log(`DRY RUN: would set ${parsed.repoFullName}'s run state to "${parsed.state}". No run-state write was made.`);
    }
    return 0;
  }

  try {
    const write = setRunState(parsed.repoFullName, parsed.state, parsed.apiBaseUrl);
    if (parsed.json) {
      console.log(JSON.stringify(write));
    } else {
      console.log(write.state);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runStateCli(subcommand, args) {
  if (subcommand === "get") return runStateGet(args);
  if (subcommand === "set") return runStateSet(args);
  return reportCliFailure(argsWantJson(args), `Unknown state subcommand: ${subcommand ?? ""}. ${STATE_GET_USAGE}`);
}
