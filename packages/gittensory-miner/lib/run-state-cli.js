import { RUN_STATES, getRunState, setRunState } from "./run-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

const STATE_GET_USAGE = "Usage: gittensory-miner state get <owner/repo> [--json]";
const STATE_SET_USAGE =
  "Usage: gittensory-miner state set <owner/repo> <idle|discovering|planning|preparing> [--json]";

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
  const options = { json: false };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
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
  const options = { json: false };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
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
    const state = getRunState(parsed.repoFullName);
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

  try {
    const write = setRunState(parsed.repoFullName, parsed.state);
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
