import { initEventLedger } from "./event-ledger.js";
import type { EventLedger, LedgerEntry, ReadEventsFilter } from "./event-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";

const LEDGER_LIST_USAGE =
  "Usage: loopover-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]";

function parseRepoArg(value: string, usage: string): { error: string } | { repoFullName: string } {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined || !isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

function parseSinceArg(value: string): { error: string } | { since: number } {
  const since = Number(value);
  if (!Number.isInteger(since) || since < 0) {
    return { error: "since must be a non-negative integer seq cursor." };
  }
  return { since };
}

export type ParsedLedgerListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      since: number | null;
      type: string | null;
    }
  | { error: string };

export function parseLedgerListArgs(args: string[]): ParsedLedgerListArgs {
  const options: { json: boolean; repoFullName: string | null; since: number | null; type: string | null } = {
    json: false,
    repoFullName: null,
    since: null,
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
      if (!repoArg || repoArg.startsWith("-")) return { error: LEDGER_LIST_USAGE };
      const repo = parseRepoArg(repoArg, LEDGER_LIST_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token === "--since") {
      const sinceArg = args[index + 1];
      if (!sinceArg || sinceArg.startsWith("--")) return { error: LEDGER_LIST_USAGE };
      const parsedSince = parseSinceArg(sinceArg);
      if ("error" in parsedSince) return parsedSince;
      options.since = parsedSince.since;
      index += 1;
      continue;
    }
    if (token === "--type") {
      const type = args[index + 1];
      if (!type || type.startsWith("-")) return { error: LEDGER_LIST_USAGE };
      options.type = type.trim();
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: LEDGER_LIST_USAGE };
  return options;
}

export function filterLedgerEvents(events: LedgerEntry[], options: { type?: string | null } = {}): LedgerEntry[] {
  if (!Array.isArray(events)) return [];
  const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
  if (!type) return events;
  return events.filter((entry) => entry.type === type);
}

/** Metadata-only audit-feed columns exposed by the MCP tool (#5158). */
export const AUDIT_FEED_ENTRY_FIELDS = Object.freeze([
  "eventType",
  "repoFullName",
  "outcome",
  "actor",
  "detail",
  "createdAt",
] as const);

function optionalMetadataString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Project one ledger row to the public, metadata-only audit-feed shape — never returns payload_json. */
export function projectLedgerEventToAuditFeedEntry(entry: LedgerEntry): {
  eventType: string;
  repoFullName: string | null;
  outcome: string | null;
  actor: string | null;
  detail: string | null;
  createdAt: string;
} {
  const payload: Record<string, unknown> =
    entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
  return {
    eventType: entry.type,
    repoFullName: entry.repoFullName,
    outcome: optionalMetadataString(payload.outcome),
    actor: optionalMetadataString(payload.actor),
    detail: optionalMetadataString(payload.detail),
    createdAt: entry.createdAt,
  };
}

export type AuditFeedMcpFilterInput = {
  repoFullName?: string | null;
  since?: number | null;
  type?: string | null;
};

/** Normalize optional MCP/JSON filter args into the shape `ledger list` already uses (#5158). */
export function normalizeAuditFeedMcpFilter(input: AuditFeedMcpFilterInput = {}): {
  repoFullName: string | null;
  since: number | null;
  type: string | null;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("filter must be an object");
  }
  const filter: { repoFullName: string | null; since: number | null; type: string | null } = {
    repoFullName: null,
    since: null,
    type: null,
  };
  if (input.repoFullName !== undefined && input.repoFullName !== null) {
    const repo = parseRepoArg(String(input.repoFullName), "repoFullName must be in owner/repo form.");
    if ("error" in repo) throw new Error(repo.error);
    filter.repoFullName = repo.repoFullName;
  }
  if (input.since !== undefined && input.since !== null) {
    const parsedSince = parseSinceArg(String(input.since));
    if ("error" in parsedSince) throw new Error(parsedSince.error);
    filter.since = parsedSince.since;
  }
  if (input.type !== undefined && input.type !== null) {
    const trimmed = String(input.type).trim();
    if (!trimmed) throw new Error("type must be a non-empty string.");
    filter.type = trimmed;
  }
  return filter;
}

/** Read-only audit feed shared by the MCP audit-feed tool (#5158). */
export function collectEventLedgerAuditFeed(
  eventLedger: EventLedger,
  filter: { repoFullName?: string | null; since?: number | null; type?: string | null } = {},
): {
  repoFullName?: string;
  events: Array<{
    eventType: string;
    repoFullName: string | null;
    outcome: string | null;
    actor: string | null;
    detail: string | null;
    createdAt: string;
  }>;
} {
  const events = filterLedgerEvents(
    eventLedger.readEvents({
      repoFullName: filter.repoFullName,
      since: filter.since,
    } as ReadEventsFilter),
    { type: filter.type } as { type?: string | null },
  );
  return {
    ...(filter.repoFullName ? { repoFullName: filter.repoFullName } : {}),
    events: events.map(projectLedgerEventToAuditFeedEntry),
  };
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderLedgerTable(events: LedgerEntry[]): string {
  if (!Array.isArray(events) || events.length === 0) return "no event ledger entries";
  const header = [
    "seq".padStart(4),
    "type".padEnd(20),
    "repo".padEnd(24),
    "created-at".padEnd(24),
  ].join(" ");
  const lines = events.map((entry) =>
    [
      String(entry.seq).padStart(4),
      entry.type.padEnd(20),
      display(entry.repoFullName).padEnd(24),
      display(entry.createdAt).padEnd(24),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

const EVENT_LEDGER_METRICS_USAGE = "Usage: loopover-miner ledger metrics";

// Prometheus metric name for the per-type event-ledger counter. Mirrors the `loopover_miner_*_total` naming and
// the HELP/TYPE/label conventions of the engine's renderMinerPredictionMetrics
// (packages/loopover-engine/src/miner-prediction-metrics.ts) rather than importing across the package boundary.
const MINER_EVENTS_TOTAL = "loopover_miner_events_total";

/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeHelpText(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Prometheus label-value escaping — backslash, double-quote, newline — so an arbitrary event `type` string can
 *  never break the metric line (mirrors miner-prediction-metrics.ts's escapeLabelValue). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render event-ledger activity as Prometheus text-exposition counters: one `loopover_miner_events_total{type}`
 * series per event type, so a self-hoster's own Grafana/alerting can scrape ledger activity instead of polling
 * `ledger list --json` (#4841). Pure + side-effect-free — the caller supplies the rows and prints the result;
 * deterministic (series emitted in sorted type order); always emits HELP/TYPE so an empty ledger is still a
 * well-formed exposition document.
 */
export function renderEventLedgerMetrics(events: readonly LedgerEntry[]): string {
  const totalByType = new Map<string, number>();
  for (const entry of events) {
    totalByType.set(entry.type, (totalByType.get(entry.type) ?? 0) + 1);
  }
  const lines = [
    `# HELP ${MINER_EVENTS_TOTAL} ${escapeHelpText("Event-ledger entries the miner has recorded, by event type.")}`,
    `# TYPE ${MINER_EVENTS_TOTAL} counter`,
  ];
  for (const [type, count] of [...totalByType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${MINER_EVENTS_TOTAL}{type="${escapeLabelValue(type)}"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

function withEventLedger<T>(
  options: { initEventLedger?: () => EventLedger },
  run: (eventLedger: EventLedger) => T,
): T {
  const ownsLedger = options.initEventLedger === undefined;
  const eventLedger = (options.initEventLedger ?? initEventLedger)();
  try {
    return run(eventLedger);
  } finally {
    if (ownsLedger) eventLedger.close();
  }
}

export function runLedgerList(args: string[], options: { initEventLedger?: () => EventLedger } = {}): number {
  const parsed = parseLedgerListArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    return withEventLedger(options, (eventLedger) => {
      const events = filterLedgerEvents(
        eventLedger.readEvents({
          repoFullName: parsed.repoFullName,
          since: parsed.since,
        }),
        { type: parsed.type },
      );
      if (parsed.json) {
        console.log(JSON.stringify({ events }, null, 2));
      } else {
        console.log(renderLedgerTable(events));
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runLedgerMetrics(args: string[], options: { initEventLedger?: () => EventLedger } = {}): number {
  if (args.length > 0) {
    return reportCliFailure(argsWantJson(args), EVENT_LEDGER_METRICS_USAGE);
  }

  try {
    return withEventLedger(options, (eventLedger) => {
      // renderEventLedgerMetrics returns a newline-terminated document; console.log re-adds the terminator, so
      // trim it to emit exactly one trailing newline (mirrors metrics-cli.js's runMetrics).
      console.log(renderEventLedgerMetrics(eventLedger.readEvents()).trimEnd());
      return 0;
    });
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  }
}

export function runLedgerCli(
  subcommand: string | undefined,
  args: string[],
  options: { initEventLedger?: () => EventLedger } = {},
): number {
  if (subcommand === "list") return runLedgerList(args, options);
  if (subcommand === "metrics") return runLedgerMetrics(args, options);
  return reportCliFailure(argsWantJson(args), `Unknown ledger subcommand: ${subcommand ?? ""}. ${LEDGER_LIST_USAGE}`);
}
