import { runGovernorPause, runGovernorResume, runGovernorStatus } from "./governor-pause-cli.js";
import { runGovernorMetrics } from "./governor-metrics-cli.js";
/** Must match `GOVERNOR_LEDGER_EVENT_TYPES` in `@loopover/engine`. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
const GOVERNOR_LEDGER_EVENT_TYPES = Object.freeze([
    "allowed",
    "denied",
    "throttled",
    "kill_switch",
]);
const GOVERNOR_LIST_USAGE = "Usage: loopover-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]";
const GOVERNOR_SUBCOMMAND_USAGE = [
    GOVERNOR_LIST_USAGE,
    "       loopover-miner governor pause [--reason <text>] [--dry-run] [--json]",
    "       loopover-miner governor resume [--dry-run] [--json]",
    "       loopover-miner governor status [--json]",
    "       loopover-miner governor metrics",
].join("\n");
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
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
            if (!repoArg || repoArg.startsWith("-"))
                return { error: GOVERNOR_LIST_USAGE };
            const repo = parseRepoArg(repoArg, GOVERNOR_LIST_USAGE);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        if (token === "--type") {
            const type = args[index + 1];
            if (!type || type.startsWith("-"))
                return { error: GOVERNOR_LIST_USAGE };
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
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length > 0)
        return { error: GOVERNOR_LIST_USAGE };
    return options;
}
export function filterGovernorEvents(events, options = {}) {
    if (!Array.isArray(events))
        return [];
    const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
    if (!type)
        return events;
    return events.filter((entry) => entry.eventType === type);
}
function display(value) {
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderGovernorTable(events) {
    if (!Array.isArray(events) || events.length === 0)
        return "no governor ledger entries";
    const header = [
        "id".padStart(4),
        "type".padEnd(12),
        "repo".padEnd(24),
        "action".padEnd(10),
        "decision".padEnd(10),
        "ts".padEnd(24),
    ].join(" ");
    const lines = events.map((entry) => [
        String(entry.id).padStart(4),
        entry.eventType.padEnd(12),
        display(entry.repoFullName).padEnd(24),
        entry.actionClass.padEnd(10),
        entry.decision.padEnd(10),
        display(entry.ts).padEnd(24),
    ].join(" "));
    return [header, ...lines].join("\n");
}
async function withGovernorLedger(options, run) {
    const ownsLedger = options.initGovernorLedger === undefined;
    const initGovernorLedger = options.initGovernorLedger ?? (await import("./governor-ledger.js")).initGovernorLedger;
    const governorLedger = initGovernorLedger();
    try {
        return run(governorLedger);
    }
    finally {
        if (ownsLedger)
            governorLedger.close();
    }
}
export async function runGovernorList(args, options = {}) {
    const parsed = parseGovernorListArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return await withGovernorLedger(options, (governorLedger) => {
            const events = filterGovernorEvents(governorLedger.readGovernorEvents({
                repoFullName: parsed.repoFullName,
            }), { type: parsed.type });
            if (parsed.json) {
                console.log(JSON.stringify({ events }, null, 2));
            }
            else {
                console.log(renderGovernorTable(events));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runGovernorCli(subcommand, args, options = {}) {
    if (subcommand === "list")
        return runGovernorList(args, options);
    if (subcommand === "pause")
        return runGovernorPause(args, options);
    if (subcommand === "resume")
        return runGovernorResume(args, options);
    if (subcommand === "status")
        return runGovernorStatus(args, options);
    if (subcommand === "metrics")
        return runGovernorMetrics(args, options);
    return reportCliFailure(argsWantJson(args), `Unknown governor subcommand: ${subcommand ?? ""}.\n${GOVERNOR_SUBCOMMAND_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItbGVkZ2VyLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdvdmVybm9yLWxlZGdlci1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLGdCQUFnQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLE1BQU0seUJBQXlCLENBQUM7QUFFakcsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFHL0Qsc0VBQXNFO0FBQ3RFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQVlsRixNQUFNLDJCQUEyQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDaEQsU0FBUztJQUNULFFBQVE7SUFDUixXQUFXO0lBQ1gsYUFBYTtDQUNkLENBQUMsQ0FBQztBQUVILE1BQU0sbUJBQW1CLEdBQ3ZCLGtIQUFrSCxDQUFDO0FBRXJILE1BQU0seUJBQXlCLEdBQUc7SUFDaEMsbUJBQW1CO0lBQ25CLDZFQUE2RTtJQUM3RSw0REFBNEQ7SUFDNUQsZ0RBQWdEO0lBQ2hELHdDQUF3QztDQUN6QyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUViLFNBQVMsWUFBWSxDQUFDLEtBQWEsRUFBRSxLQUFhO0lBQ2hELElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUNwQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0IsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMzQyxPQUFPLEVBQUUsS0FBSyxFQUFFLHdDQUF3QyxF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