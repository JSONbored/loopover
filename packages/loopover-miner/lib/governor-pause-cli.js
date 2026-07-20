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
    const options = { json: false, dryRun: false, reason: null };
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
        return run(governorState);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItcGF1c2UtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZ292ZXJub3ItcGF1c2UtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRywrR0FBK0c7QUFDL0csaUhBQWlIO0FBQ2pILCtHQUErRztBQUMvRyxvSEFBb0g7QUFDcEgsOEdBQThHO0FBQzlHLG1HQUFtRztBQUVuRyxPQUFPLEVBQUUsWUFBWSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEYsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFleEQsTUFBTSxvQkFBb0IsR0FBRyw2RUFBNkUsQ0FBQztBQUMzRyxNQUFNLHFCQUFxQixHQUFHLDREQUE0RCxDQUFDO0FBQzNGLE1BQU0scUJBQXFCLEdBQUcsZ0RBQWdELENBQUM7QUFFL0UsTUFBTSxVQUFVLHNCQUFzQixDQUFDLElBQWM7SUFDbkQsTUFBTSxPQUFPLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLElBQXFCLEVBQUUsQ0FBQztJQUU5RSxLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDcEQsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1lBQ3BCLFNBQVM7UUFDWCxDQUFDO1FBQ0QscUZBQXFGO1FBQ3JGLElBQUksS0FBSyxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQzFCLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1lBQ3RCLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDekIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO2dCQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsb0JBQW9CLEVBQUUsQ0FBQztZQUM1RSxPQUFPLENBQUMsTUFBTSxHQUFHLEtBQUssQ0FBQztZQUN2QixLQUFLLElBQUksQ0FBQyxDQUFDO1lBQ1gsU0FBUztRQUNYLENBQUM7UUFDRCxPQUFPLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixLQUFLLEVBQUUsRUFBRSxDQUFDO0lBQy9DLENBQUM7SUFFRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsTUFBTSxVQUFVLHVCQUF1QixDQUFDLElBQWM7SUFDcEQsTUFBTSxPQUFPLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUUvQyxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ3pCLElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1lBQ3BCLFNBQVM7UUFDWCxDQUFDO1FBQ0Qsc0ZBQXNGO1FBQ3RGLElBQUksS0FBSyxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQzFCLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1lBQ3RCLFNBQVM7UUFDWCxDQUFDO1FBQ0QsT0FBTyxFQUFFLEtBQUssRUFBRSxxQkFBcUIsRUFBRSxDQUFDO0lBQzFDLENBQUM7SUFFRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUyxxQkFBcUIsQ0FBQyxJQUFjLEVBQUUsS0FBYTtJQUMxRCxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDOUMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUTtRQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDckUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztBQUMxQixDQUFDO0FBRUQsS0FBSyxVQUFVLGlCQUFpQixDQUFJLE9BQWdDLEVBQUUsR0FBd0M7SUFDNUcsTUFBTSxpQkFBaUIsR0FBRyxPQUFPLENBQUMsaUJBQWlCLEtBQUssU0FBUyxDQUFDO0lBQ2xFLE1BQU0sYUFBYSxHQUFHLENBQUMsT0FBTyxDQUFDLGlCQUFpQixJQUFJLGlCQUFpQixDQUFDLEVBQUUsQ0FBQztJQUN6RSxJQUFJLENBQUM7UUFDSCxPQUFPLEdBQUcsQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUM1QixDQUFDO1lBQVMsQ0FBQztRQUNULElBQUksaUJBQWlCO1lBQUUsYUFBYSxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQy9DLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxnQkFBZ0IsQ0FBQyxVQUE4QjtJQUN0RCxJQUFJLENBQUMsVUFBVSxDQUFDLE1BQU07UUFBRSxPQUFPLHdCQUF3QixDQUFDO0lBQ3hELE1BQU0sTUFBTSxHQUFHLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssVUFBVSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDbEUsT0FBTyw0QkFBNEIsVUFBVSxDQUFDLFFBQVEsR0FBRyxNQUFNLEVBQUUsQ0FBQztBQUNwRSxDQUFDO0FBRUQsTUFBTSxDQUFDLEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxJQUFjLEVBQUUsVUFBbUMsRUFBRTtJQUMxRixNQUFNLE1BQU0sR0FBRyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM1QyxJQUFJLE9BQU8sSUFBSSxNQUFNLEVBQUUsQ0FBQztRQUN0QixPQUFPLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUQsQ0FBQztJQUVELElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2xCLE1BQU0sWUFBWSxHQUFHLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDakYsSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7UUFDNUMsQ0FBQzthQUFNLENBQUM7WUFDTixNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQzFELE9BQU8sQ0FBQyxHQUFHLENBQUMsb0NBQW9DLE1BQU0scUNBQXFDLENBQUMsQ0FBQztRQUMvRixDQUFDO1FBQ0QsT0FBTyxDQUFDLENBQUM7SUFDWCxDQUFDO0lBRUQsSUFBSSxDQUFDO1FBQ0gsT0FBTyxNQUFNLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxDQUFDLGFBQWEsRUFBRSxFQUFFO1lBQ3hELE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxjQUFjLENBQUMsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUN6RixJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7WUFDMUMsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztZQUM1QyxDQUFDO1lBQ0QsT0FBTyxDQUFDLENBQUM7UUFDWCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDaEUsQ0FBQztBQUNILENBQUM7QUFFRCxNQUFNLENBQUMsS0FBSyxVQUFVLGlCQUFpQixDQUFDLElBQWMsRUFBRSxVQUFtQyxFQUFFO0lBQzNGLE1BQU0sTUFBTSxHQUFHLHVCQUF1QixDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzdDLElBQUksT0FBTyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQ3RCLE9BQU8sZ0JBQWdCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1RCxDQUFDO0lBRUQsSUFBSSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDbEIsTUFBTSxZQUFZLEdBQUcsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsQ0FBQztRQUMzRCxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNoQixPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztRQUM1QyxDQUFDO2FBQU0sQ0FBQztZQUNOLE9BQU8sQ0FBQyxHQUFHLENBQUMsdUVBQXVFLENBQUMsQ0FBQztRQUN2RixDQUFDO1FBQ0QsT0FBTyxDQUFDLENBQUM7SUFDWCxDQUFDO0lBRUQsSUFBSSxDQUFDO1FBQ0gsT0FBTyxNQUFNLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxDQUFDLGFBQWEsRUFBRSxFQUFFO1lBQ3hELE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxjQUFjLENBQUMsRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztZQUNuRSxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7WUFDMUMsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztZQUM1QyxDQUFDO1lBQ0QsT0FBTyxDQUFDLENBQUM7UUFDWCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDaEUsQ0FBQztBQUNILENBQUM7QUFFRCxNQUFNLENBQUMsS0FBSyxVQUFVLGlCQUFpQixDQUFDLElBQWMsRUFBRSxVQUFtQyxFQUFFO0lBQzNGLE1BQU0sTUFBTSxHQUFHLHFCQUFxQixDQUFDLElBQUksRUFBRSxxQkFBcUIsQ0FBQyxDQUFDO0lBQ2xFLElBQUksT0FBTyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQ3RCLE9BQU8sZ0JBQWdCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1RCxDQUFDO0lBRUQsSUFBSSxDQUFDO1FBQ0gsT0FBTyxNQUFNLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxDQUFDLGFBQWEsRUFBRSxFQUFFO1lBQ3hELE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNsRCxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7WUFDMUMsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztZQUM1QyxDQUFDO1lBQ0QsT0FBTyxDQUFDLENBQUM7UUFDWCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDaEUsQ0FBQztBQUNILENBQUMifQ==