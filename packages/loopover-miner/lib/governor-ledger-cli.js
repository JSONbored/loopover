import { runGovernorPause, runGovernorResume, runGovernorStatus } from "./governor-pause-cli.js";
import { runGovernorMetrics } from "./governor-metrics-cli.js";
/** Must match `GOVERNOR_LEDGER_EVENT_TYPES` in `@loopover/engine`. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";
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
// The sole caller (the --repo branch of parseGovernorListArgs below) always checks `repoArg` is a
// truthy, non-flag-looking string before calling this, so `value` is never empty here.
function parseRepoArg(value) {
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
export function parseGovernorListArgs(args) {
    const options = {
        json: false,
        repoFullName: null,
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
                return { error: GOVERNOR_LIST_USAGE };
            const repo = parseRepoArg(repoArg);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItbGVkZ2VyLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdvdmVybm9yLWxlZGdlci1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLGdCQUFnQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLE1BQU0seUJBQXlCLENBQUM7QUFFakcsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFFL0Qsc0VBQXNFO0FBQ3RFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVsRixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUlyRCxNQUFNLDJCQUEyQixHQUF1QyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ3BGLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLGFBQWE7Q0FDZCxDQUFDLENBQUM7QUFFSCxNQUFNLG1CQUFtQixHQUN2QixrSEFBa0gsQ0FBQztBQUVySCxNQUFNLHlCQUF5QixHQUFHO0lBQ2hDLG1CQUFtQjtJQUNuQiw2RUFBNkU7SUFDN0UsNERBQTREO0lBQzVELGdEQUFnRDtJQUNoRCx3Q0FBd0M7Q0FDekMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7QUFpQmIsa0dBQWtHO0FBQ2xHLHVGQUF1RjtBQUN2RixTQUFTLFlBQVksQ0FBQyxLQUFhO0lBQ2pDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzNDLE9BQU8sRUFBRSxLQUFLLEVBQUUsd0NBQXdD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