import { runGovernorPause, runGovernorResume, runGovernorStatus } from "./governor-pause-cli.js";
import type { GovernorPauseCliOptions } from "./governor-pause-cli.js";
import { runGovernorMetrics } from "./governor-metrics-cli.js";

/** Must match `GOVERNOR_LEDGER_EVENT_TYPES` in `@loopover/engine`. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import type { GovernorLedger, GovernorLedgerEntry } from "./governor-ledger.js";
import { isValidRepoSegment } from "./repo-clone.js";

export type GovernorLedgerEventType = "allowed" | "denied" | "throttled" | "kill_switch";

const GOVERNOR_LEDGER_EVENT_TYPES: readonly GovernorLedgerEventType[] = Object.freeze([
  "allowed",
  "denied",
  "throttled",
  "kill_switch",
]);

const GOVERNOR_LIST_USAGE =
  "Usage: loopover-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]";

const GOVERNOR_SUBCOMMAND_USAGE = [
  GOVERNOR_LIST_USAGE,
  "       loopover-miner governor pause [--reason <text>] [--dry-run] [--json]",
  "       loopover-miner governor resume [--dry-run] [--json]",
  "       loopover-miner governor status [--json]",
  "       loopover-miner governor metrics",
].join("\n");

export type ParsedGovernorListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      type: GovernorLedgerEventType | null;
    }
  | { error: string };

type ParsedRepoArg = { repoFullName: string } | { error: string };

export type GovernorCliOptions = {
  initGovernorLedger?: () => GovernorLedger;
  nowMs?: number;
} & GovernorPauseCliOptions;

// The sole caller (the --repo branch of parseGovernorListArgs below) always checks `repoArg` is a
// truthy, non-flag-looking string before calling this, so `value` is never empty here.
function parseRepoArg(value: string): ParsedRepoArg {
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  // #7525: extend #5831's path-safety guard to this CLI filter too — a `.`/`..`/control-char segment must not
  // reach the ledger query. Reuse the same error shape as the malformed-input branch above (don't invent one).
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function parseGovernorListArgs(args: string[]): ParsedGovernorListArgs {
  const options: { json: boolean; repoFullName: string | null; type: GovernorLedgerEventType | null } = {
    json: false,
    repoFullName: null,
    type: null,
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
      if (!repoArg || repoArg.startsWith("-")) return { error: GOVERNOR_LIST_USAGE };
      const repo = parseRepoArg(repoArg);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token === "--type") {
      const type = args[index + 1];
      if (!type || type.startsWith("-")) return { error: GOVERNOR_LIST_USAGE };
      const trimmed = type.trim();
      if (!GOVERNOR_LEDGER_EVENT_TYPES.includes(trimmed as GovernorLedgerEventType)) {
        return {
          error: `Invalid type: ${trimmed}. Expected one of ${GOVERNOR_LEDGER_EVENT_TYPES.join(", ")}.`,
        };
      }
      options.type = trimmed as GovernorLedgerEventType;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: GOVERNOR_LIST_USAGE };
  return options;
}

export function filterGovernorEvents(
  events: GovernorLedgerEntry[],
  options: { type?: string | null } = {},
): GovernorLedgerEntry[] {
  if (!Array.isArray(events)) return [];
  const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
  if (!type) return events;
  return events.filter((entry) => entry.eventType === type);
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderGovernorTable(events: GovernorLedgerEntry[]): string {
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

async function withGovernorLedger<T>(
  options: GovernorCliOptions,
  run: (governorLedger: GovernorLedger) => T,
): Promise<T> {
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

export async function runGovernorList(args: string[], options: GovernorCliOptions = {}): Promise<number> {
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

export async function runGovernorCli(
  subcommand: string | undefined,
  args: string[],
  options: GovernorCliOptions = {},
): Promise<number> {
  if (subcommand === "list") return runGovernorList(args, options);
  if (subcommand === "pause") return runGovernorPause(args, options);
  if (subcommand === "resume") return runGovernorResume(args, options);
  if (subcommand === "status") return runGovernorStatus(args, options);
  if (subcommand === "metrics") return runGovernorMetrics(args, options);
  return reportCliFailure(
    argsWantJson(args),
    `Unknown governor subcommand: ${subcommand ?? ""}.\n${GOVERNOR_SUBCOMMAND_USAGE}`,
  );
}
