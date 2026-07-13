/** Must match `GOVERNOR_LEDGER_EVENT_TYPES` in `@jsonbored/gittensory-engine`. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

const GOVERNOR_LEDGER_EVENT_TYPES = Object.freeze([
  "allowed",
  "denied",
  "throttled",
  "kill_switch",
]);

const GOVERNOR_LIST_USAGE =
  "Usage: gittensory-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]";

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function parseGovernorListArgs(args) {
  const options = { json: false, repoFullName: null, type: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--repo") {
      const repoArg = args[index + 1];
      if (!repoArg || repoArg.startsWith("-")) return { error: GOVERNOR_LIST_USAGE };
      const repo = parseRepoArg(repoArg, GOVERNOR_LIST_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token === "--type") {
      const type = args[index + 1];
      if (!type || type.startsWith("-")) return { error: GOVERNOR_LIST_USAGE };
      const trimmed = type.trim();
      if (!GOVERNOR_LEDGER_EVENT_TYPES.includes(trimmed)) {
        return {
          error: `Invalid type: ${trimmed}. Expected one of ${GOVERNOR_LEDGER_EVENT_TYPES.join(", ")}.`,
        };
      }
      options.type = trimmed;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: GOVERNOR_LIST_USAGE };
  return options;
}

export function filterGovernorEvents(events, options = {}) {
  if (!Array.isArray(events)) return [];
  const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
  if (!type) return events;
  return events.filter((entry) => entry.eventType === type);
}

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderGovernorTable(events) {
  if (!Array.isArray(events) || events.length === 0) return "no governor ledger entries";
  const header = [
    "id".padStart(4),
    "type".padEnd(12),
    "repo".padEnd(24),
    "action".padEnd(10),
    "decision".padEnd(10),
    "ts".padEnd(24),
  ].join(" ");
  const lines = events.map((entry) =>
    [
      String(entry.id).padStart(4),
      entry.eventType.padEnd(12),
      display(entry.repoFullName).padEnd(24),
      entry.actionClass.padEnd(10),
      entry.decision.padEnd(10),
      display(entry.ts).padEnd(24),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

async function withGovernorLedger(options, run) {
  const ownsLedger = options.initGovernorLedger === undefined;
  const initGovernorLedger =
    options.initGovernorLedger ?? (await import("./governor-ledger.js")).initGovernorLedger;
  const governorLedger = initGovernorLedger();
  try {
    return run(governorLedger);
  } finally {
    if (ownsLedger) governorLedger.close();
  }
}

export async function runGovernorList(args, options = {}) {
  const parsed = parseGovernorListArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    return await withGovernorLedger(options, (governorLedger) => {
      const events = filterGovernorEvents(
        governorLedger.readGovernorEvents({
          repoFullName: parsed.repoFullName,
        }),
        { type: parsed.type },
      );
      if (parsed.json) {
        console.log(JSON.stringify({ events }, null, 2));
      } else {
        console.log(renderGovernorTable(events));
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export async function runGovernorCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runGovernorList(args, options);
  return reportCliFailure(argsWantJson(args), `Unknown governor subcommand: ${subcommand ?? ""}. ${GOVERNOR_LIST_USAGE}`);
}
