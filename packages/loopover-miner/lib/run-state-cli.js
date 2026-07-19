import { RUN_STATES, getRunState, setRunState } from "./run-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
const STATE_GET_USAGE = "Usage: loopover-miner state get <owner/repo> [--api-base-url <url>] [--json]";
const STATE_SET_USAGE = "Usage: loopover-miner state set <owner/repo> <idle|discovering|planning|preparing> [--api-base-url <url>] [--dry-run] [--json]";
const allowedRunStates = new Set(RUN_STATES);
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
    if ("error" in repo)
        return repo;
    return { repoFullName: repo.repoFullName, ...options };
}
export function parseStateSetArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        apiBaseUrl: undefined,
    };
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
    if ("error" in repo)
        return repo;
    const state = positional[1];
    if (!allowedRunStates.has(state)) {
        return { error: `Invalid state: ${state}. Expected one of ${RUN_STATES.join(", ")}.` };
    }
    return { repoFullName: repo.repoFullName, state: state, ...options };
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
        }
        else {
            console.log(state ?? "none");
        }
        return 0;
    }
    catch (error) {
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
        }
        else {
            console.log(`DRY RUN: would set ${parsed.repoFullName}'s run state to "${parsed.state}". No run-state write was made.`);
        }
        return 0;
    }
    try {
        const write = setRunState(parsed.repoFullName, parsed.state, parsed.apiBaseUrl);
        if (parsed.json) {
            console.log(JSON.stringify(write));
        }
        else {
            console.log(write.state);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runStateCli(subcommand, args) {
    if (subcommand === "get")
        return runStateGet(args);
    if (subcommand === "set")
        return runStateSet(args);
    return reportCliFailure(argsWantJson(args), `Unknown state subcommand: ${subcommand ?? ""}. ${STATE_GET_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVuLXN0YXRlLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJ1bi1zdGF0ZS1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFdEUsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBb0JsRixNQUFNLGVBQWUsR0FBRyw4RUFBOEUsQ0FBQztBQUN2RyxNQUFNLGVBQWUsR0FDbkIsZ0lBQWdJLENBQUM7QUFFbkksTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsQ0FBUyxVQUFVLENBQUMsQ0FBQztBQUVyRCxTQUFTLFlBQVksQ0FBQyxLQUF5QixFQUFFLEtBQWE7SUFDNUQsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQ3BDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzNDLE9BQU8sRUFBRSxLQUFLLEVBQUUsd0NBQXdDLEVBQUUsQ0FBQztJQUM3RCxDQUFDO0lBQ0QsT0FBTyxFQUFFLFlBQVksRUFBRSxHQUFHLEtBQUssSUFBSSxJQUFJLEVBQUUsRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRCxNQUFNLFVBQVUsaUJBQWlCLENBQUMsSUFBYztJQUM5QyxNQUFNLE9BQU8sR0FBc0QsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsQ0FBQztJQUMxRyxNQUFNLFVBQVUs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