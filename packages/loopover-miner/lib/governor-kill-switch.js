// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .loopover-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.
import { buildMinerKillSwitchTransitionGovernorLedgerEvent, isGlobalMinerKillSwitch, isMinerKillSwitchActive, resolveMinerKillSwitch, } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
/**
 * Resolve the current kill-switch scope for a repo from process env plus a per-repo paused flag (typically
 * `MinerGoalSpec.killSwitch.paused` from the repo's parsed `.loopover-miner.yml`).
 */
export function checkMinerKillSwitch(input = {}) {
    const env = input.env ?? process.env;
    const global = isGlobalMinerKillSwitch(env);
    const scope = resolveMinerKillSwitch({ global, repoPaused: input.repoPaused });
    return { scope, active: isMinerKillSwitchActive(scope) };
}
/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check — callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own.
 */
export function recordMinerKillSwitchTransition(input, options = {}) {
    const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
    if (!event)
        return null;
    const append = options.append ?? appendGovernorEvent;
    return append(event);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3Ita2lsbC1zd2l0Y2guanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1raWxsLXN3aXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw4R0FBOEc7QUFDOUcsd0dBQXdHO0FBQ3hHLDJHQUEyRztBQUMzRyx1R0FBdUc7QUFFdkcsT0FBTyxFQUNMLGlEQUFpRCxFQUNqRCx1QkFBdUIsRUFDdkIsdUJBQXVCLEVBQ3ZCLHNCQUFzQixHQUN2QixNQUFNLGtCQUFrQixDQUFDO0FBRTFCLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBYTNEOzs7R0FHRztBQUNILE1BQU0sVUFBVSxvQkFBb0IsQ0FBQyxRQUFtQyxFQUFFO0lBQ3hFLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxHQUFHLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQztJQUNyQyxNQUFNLE1BQU0sR0FBRyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM1QyxNQUFNLEtBQUssR0FBRyxzQkFBc0IsQ0FBQyxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7SUFDL0UsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsdUJBQXVCLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztBQUMzRCxDQUFDO0FBU0Q7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSwrQkFBK0IsQ0FDN0MsS0FBMkMsRUFDM0MsVUFBaUYsRUFBRTtJQUVuRixNQUFNLEtBQUssR0FBRyxpREFBaUQsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3hCLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLElBQUksbUJBQW1CLENBQUM7SUFDckQsT0FBTyxNQUFNLENBQUMsS0FBaUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMifQ==