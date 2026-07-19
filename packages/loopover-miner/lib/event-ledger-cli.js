import { initEventLedger } from "./event-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";
const LEDGER_LIST_USAGE = "Usage: loopover-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]";
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined || !isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
function parseSinceArg(value) {
    const since = Number(value);
    if (!Number.isInteger(since) || since < 0) {
        return { error: "since must be a non-negative integer seq cursor." };
    }
    return { since };
}
export function parseLedgerListArgs(args) {
    const options = {
        json: false,
        repoFullName: null,
        since: null,
        type: null,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--repo") {
            const repoArg = args[index + 1];
            if (!repoArg || repoArg.startsWith("-"))
                return { error: LEDGER_LIST_USAGE };
            const repo = parseRepoArg(repoArg, LEDGER_LIST_USAGE);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        if (token === "--since") {
            const sinceArg = args[index + 1];
            if (!sinceArg || sinceArg.startsWith("--"))
                return { error: LEDGER_LIST_USAGE };
            const parsedSince = parseSinceArg(sinceArg);
            if ("error" in parsedSince)
                return parsedSince;
            options.since = parsedSince.since;
            index += 1;
            continue;
        }
        if (token === "--type") {
            const type = args[index + 1];
            if (!type || type.startsWith("-"))
                return { error: LEDGER_LIST_USAGE };
            options.type = type.trim();
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length > 0)
        return { error: LEDGER_LIST_USAGE };
    return options;
}
export function filterLedgerEvents(events, options = {}) {
    if (!Array.isArray(events))
        return [];
    const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
    if (!type)
        return events;
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
]);
function optionalMetadataString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
/** Project one ledger row to the public, metadata-only audit-feed shape — never returns payload_json. */
export function projectLedgerEventToAuditFeedEntry(entry) {
    const payload = entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
    return {
        eventType: entry.type,
        repoFullName: entry.repoFullName,
        outcome: optionalMetadataString(payload.outcome),
        actor: optionalMetadataString(payload.actor),
        detail: optionalMetadataString(payload.detail),
        createdAt: entry.createdAt,
    };
}
/** Normalize optional MCP/JSON filter args into the shape `ledger list` already uses (#5158). */
export function normalizeAuditFeedMcpFilter(input = {}) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("filter must be an object");
    }
    const filter = {
        repoFullName: null,
        since: null,
        type: null,
    };
    if (input.repoFullName !== undefined && input.repoFullName !== null) {
        const repo = parseRepoArg(String(input.repoFullName), "repoFullName must be in owner/repo form.");
        if ("error" in repo)
            throw new Error(repo.error);
        filter.repoFullName = repo.repoFullName;
    }
    if (input.since !== undefined && input.since !== null) {
        const parsedSince = parseSinceArg(String(input.since));
        if ("error" in parsedSince)
            throw new Error(parsedSince.error);
        filter.since = parsedSince.since;
    }
    if (input.type !== undefined && input.type !== null) {
        const trimmed = String(input.type).trim();
        if (!trimmed)
            throw new Error("type must be a non-empty string.");
        filter.type = trimmed;
    }
    return filter;
}
/** Read-only audit feed shared by the MCP audit-feed tool (#5158). */
export function collectEventLedgerAuditFeed(eventLedger, filter = {}) {
    const events = filterLedgerEvents(eventLedger.readEvents({
        repoFullName: filter.repoFullName,
        since: filter.since,
    }), { type: filter.type });
    return {
        ...(filter.repoFullName ? { repoFullName: filter.repoFullName } : {}),
        events: events.map(projectLedgerEventToAuditFeedEntry),
    };
}
function display(value) {
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderLedgerTable(events) {
    if (!Array.isArray(events) || events.length === 0)
        return "no event ledger entries";
    const header = [
        "seq".padStart(4),
        "type".padEnd(20),
        "repo".padEnd(24),
        "created-at".padEnd(24),
    ].join(" ");
    const lines = events.map((entry) => [
        String(entry.seq).padStart(4),
        entry.type.padEnd(20),
        display(entry.repoFullName).padEnd(24),
        display(entry.createdAt).padEnd(24),
    ].join(" "));
    return [header, ...lines].join("\n");
}
const EVENT_LEDGER_METRICS_USAGE = "Usage: loopover-miner ledger metrics";
// Prometheus metric name for the per-type event-ledger counter. Mirrors the `loopover_miner_*_total` naming and
// the HELP/TYPE/label conventions of the engine's renderMinerPredictionMetrics
// (packages/loopover-engine/src/miner-prediction-metrics.ts) rather than importing across the package boundary.
const MINER_EVENTS_TOTAL = "loopover_miner_events_total";
/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeHelpText(help) {
    return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/** Prometheus label-value escaping — backslash, double-quote, newline — so an arbitrary event `type` string can
 *  never break the metric line (mirrors miner-prediction-metrics.ts's escapeLabelValue). */
function escapeLabelValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
/**
 * Render event-ledger activity as Prometheus text-exposition counters: one `loopover_miner_events_total{type}`
 * series per event type, so a self-hoster's own Grafana/alerting can scrape ledger activity instead of polling
 * `ledger list --json` (#4841). Pure + side-effect-free — the caller supplies the rows and prints the result;
 * deterministic (series emitted in sorted type order); always emits HELP/TYPE so an empty ledger is still a
 * well-formed exposition document.
 */
export function renderEventLedgerMetrics(events) {
    const totalByType = new Map();
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
function withEventLedger(options, run) {
    const ownsLedger = options.initEventLedger === undefined;
    const eventLedger = (options.initEventLedger ?? initEventLedger)();
    try {
        return run(eventLedger);
    }
    finally {
        if (ownsLedger)
            eventLedger.close();
    }
}
export function runLedgerList(args, options = {}) {
    const parsed = parseLedgerListArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return withEventLedger(options, (eventLedger) => {
            const events = filterLedgerEvents(eventLedger.readEvents({
                repoFullName: parsed.repoFullName,
                since: parsed.since,
            }), { type: parsed.type });
            if (parsed.json) {
                console.log(JSON.stringify({ events }, null, 2));
            }
            else {
                console.log(renderLedgerTable(events));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runLedgerMetrics(args, options = {}) {
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
    }
    catch (error) {
        return reportCliFailure(argsWantJson(args), describeCliError(error));
    }
}
export function runLedgerCli(subcommand, args, options = {}) {
    if (subcommand === "list")
        return runLedgerList(args, options);
    if (subcommand === "metrics")
        return runLedgerMetrics(args, options);
    return reportCliFailure(argsWantJson(args), `Unknown ledger subcommand: ${subcommand ?? ""}. ${LEDGER_LIST_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQtbGVkZ2VyLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImV2ZW50LWxlZGdlci1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUVyRCxNQUFNLGlCQUFpQixHQUNyQix1R0FBdUcsQ0FBQztBQUUxRyxTQUFTLFlBQVksQ0FBQyxLQUFhLEVBQUUsS0FBYTtJQUNoRCxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDcEMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLENBQUMsa0JBQWtCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3RHLE9BQU8sRUFBRSxLQUFLLEVBQUUsd0NBQXdDLEVBQUUsQ0FBQztJQUM3RCxDQUFDO0lBQ0QsT0FBTyxFQUFFLFlBQVksRUFBRSxHQUFHLEtBQUssSUFBSSxJQUFJLEVBQUUsRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxLQUFhO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1QixJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxLQUFL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