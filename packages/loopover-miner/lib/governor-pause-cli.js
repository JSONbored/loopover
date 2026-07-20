// The governor pause/resume control surface (#4851): a real, persisted pause flag an operator (or, in a future
// wave, the governor itself) can toggle via this CLI, that loop-cli.js's iteration loop actually checks before
// each cycle. Distinct from governor-kill-switch.js (a read-only resolver over pre-existing env/YAML inputs this
// package never itself writes) and governor-run-halt.js (a one-way, run-scoped terminal breaker with no resume
// path) -- this is the first genuinely operator/governor-writable stop/go control. Persisted on governor-state.js's
// existing single-row scalar-state table, not a new store: a pause flag has no relational key of its own, the
// same reasoning that table's other scalar fields (rate-limit buckets, cap usage) already rely on.
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { openGovernorState } from "./governor-state.js";
const GOVERNOR_PAUSE_USAGE = "Usage: loopover-miner governor pause [--reason <text>] [--dry-run] [--json]";
const GOVERNOR_RESUME_USAGE = "Usage: loopover-miner governor resume [--dry-run] [--json]";
const GOVERNOR_STATUS_USAGE = "Usage: loopover-miner governor status [--json]";
export function parseGovernorPauseArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        reason: null,
    };
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what pausing would do and returns before writing to governor-state.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--reason") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: GOVERNOR_PAUSE_USAGE };
            options.reason = value;
            index += 1;
            continue;
        }
        return { error: `Unknown option: ${token}` };
    }
    return options;
}
export function parseGovernorResumeArgs(args) {
    const options = { json: false, dryRun: false };
    for (const token of args) {
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what resuming would do and returns before writing to governor-state.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        return { error: GOVERNOR_RESUME_USAGE };
    }
    return options;
}
function parseNoArgsSubcommand(args, usage) {
    if (args.length === 0)
        return { json: false };
    if (args.length === 1 && args[0] === "--json")
        return { json: true };
    return { error: usage };
}
async function withGovernorState(options, run) {
    const ownsGovernorState = options.openGovernorState === undefined;
    const governorState = (options.openGovernorState ?? openGovernorState)();
    try {
        return await run(governorState);
    }
    finally {
        if (ownsGovernorState)
            governorState.close();
    }
}
function renderPauseState(pauseState) {
    if (!pauseState.paused)
        return "governor is not paused";
    const reason = pauseState.reason ? ` (${pauseState.reason})` : "";
    return `governor is PAUSED since ${pauseState.pausedAt}${reason}`;
}
export async function runGovernorPause(args, options = {}) {
    const parsed = parseGovernorPauseArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", paused: true, reason: parsed.reason };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult));
        }
        else {
            const reason = parsed.reason ? ` (${parsed.reason})` : "";
            console.log(`DRY RUN: would pause the governor${reason}. No governor-state write was made.`);
        }
        return 0;
    }
    try {
        return await withGovernorState(options, (governorState) => {
            const pauseState = governorState.savePauseState({ paused: true, reason: parsed.reason });
            if (parsed.json) {
                console.log(JSON.stringify(pauseState));
            }
            else {
                console.log(renderPauseState(pauseState));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runGovernorResume(args, options = {}) {
    const parsed = parseGovernorResumeArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", paused: false };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult));
        }
        else {
            console.log("DRY RUN: would resume the governor. No governor-state write was made.");
        }
        return 0;
    }
    try {
        return await withGovernorState(options, (governorState) => {
            const pauseState = governorState.savePauseState({ paused: false });
            if (parsed.json) {
                console.log(JSON.stringify(pauseState));
            }
            else {
                console.log(renderPauseState(pauseState));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runGovernorStatus(args, options = {}) {
    const parsed = parseNoArgsSubcommand(args, GOVERNOR_STATUS_USAGE);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return await withGovernorState(options, (governorState) => {
            const pauseState = governorState.loadPauseState();
            if (parsed.json) {
                console.log(JSON.stringify(pauseState));
            }
            else {
                console.log(renderPauseState(pauseState));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItcGF1c2UtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZ292ZXJub3ItcGF1c2UtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRywrR0FBK0c7QUFDL0csaUhBQWlIO0FBQ2pILCtHQUErRztBQUMvRyxvSEFBb0g7QUFDcEgsOEdBQThHO0FBQzlHLG1HQUFtRztBQUVuRyxPQUFPLEVBQUUsWUFBWSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEYsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFHeEQsTUFBTSxvQkFBb0IsR0FBRyw2RUFBNkUsQ0FBQztBQUMzRyxNQUFNLHFCQUFxQixHQUFHLDREQUE0RCxDQUFDO0FBQzNGLE1BQU0scUJBQXFCLEdBQUcsZ0RBQWdELENBQUM7QUFjL0UsTUFBTSxVQUFVLHNCQUFzQixDQUFDLElBQWM7SUFDbkQsTUFBTSxPQUFPLEdBQThEO1FBQ3pFLElBQUksRUFBRSxLQUFLO1FBQ1gsTUFBTSxFQUFFLEtBQUs7UUFDYixNQUFNLEVBQUUsSUFBSTtLQUNiLENBQUM7SUFFRixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDcEQsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1lBQ3BCLFNBQVM7UUFDWCxDQUFDO1FBQ0QscUZBQXFGO1FBQ3JGLElBQUksS0FBSyxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQzFCLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1lBQ3RCLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFL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