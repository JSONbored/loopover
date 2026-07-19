// Governor run-loop halt gate (#2347). Consults non-convergence + budget caps at each iteration boundary,
// releases in-flight portfolio items on a fresh halt, and records the decision to the governor ledger.
import { buildRunLoopHaltGovernorLedgerEvent, evaluateRunLoopHalt, } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
/**
 * Evaluate run-loop halt signals before claiming the next portfolio item.
 */
export function evaluateRunLoopBoundaryGate(input, options = {}) {
    const append = options.append ?? appendGovernorEvent;
    const wasHalted = Boolean(input.runHalted);
    const verdict = evaluateRunLoopHalt({
        runHalted: wasHalted,
        usage: input.usage,
        limits: input.limits,
        convergence: input.convergence,
        ...(input.convergenceThresholds !== undefined
            ? { convergenceThresholds: input.convergenceThresholds }
            : {}),
    });
    const newlyHalted = !wasHalted && verdict.shouldHalt;
    let releasedItem = null;
    if (newlyHalted && input.inFlightItem && typeof input.markFailed === "function") {
        releasedItem = input.markFailed(input.inFlightItem.repoFullName, input.inFlightItem.identifier);
    }
    const recorded = newlyHalted || (!wasHalted && !verdict.shouldHalt)
        ? append(
        // Engine ledger events allow explicit `undefined` on optional fields; the miner append
        // contract uses exactOptionalPropertyTypes (`?: T` without `| undefined`).
        buildRunLoopHaltGovernorLedgerEvent(input.inFlightItem?.repoFullName ?? null, input.inFlightItem?.identifier ?? null, verdict))
        : null;
    return {
        verdict,
        recorded,
        runHalted: verdict.shouldHalt,
        canClaimNext: verdict.canClaimNext,
        releasedItem,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItcnVuLWhhbHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1ydW4taGFsdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwR0FBMEc7QUFDMUcsdUdBQXVHO0FBRXZHLE9BQU8sRUFDTCxtQ0FBbUMsRUFDbkMsbUJBQW1CLEdBTXBCLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUEyQjNEOztHQUVHO0FBQ0gsTUFBTSxVQUFVLDJCQUEyQixDQUN6QyxLQUF1QyxFQUN2QyxVQUFpRixFQUFFO0lBRW5GLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLElBQUksbUJBQW1CLENBQUM7SUFDckQsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUMzQyxNQUFNLE9BQU8sR0FBRyxtQkFBbUIsQ0FBQztRQUNsQyxTQUFTLEVBQUUsU0FBUztRQUNwQixLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUs7UUFDbEIsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNO1FBQ3BCLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztRQUM5QixHQUFHLENBQUMsS0FBSyxDQUFDLHFCQUFxQixLQUFLLFNBQVM7WUFDM0MsQ0FBQyxDQUFDLEVBQUUscUJBQXFCLEVBQUUsS0FBSyxDQUFDLHFCQUFxQixFQUFFO1lBQ3hELENBQUMsQ0FBQyxFQUFFLENBQUM7S0FDUixDQUFDLENBQUM7SUFFSCxNQUFNLFdBQVcsR0FBRyxDQUFDLFNBQVMsSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDO0lBQ3JELElBQUksWUFBWSxHQUFzQixJQUFJLENBQUM7SUFDM0MsSUFBSSxXQUFXLElBQUksS0FBSyxDQUFDLFlBQVksSUFBSSxPQUFPLEtBQUssQ0FBQyxVQUFVLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDaEYsWUFBWSxHQUFHLEtBQUssQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFlBQVksQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUNsRyxDQUFDO0lBRUQsTUFBTSxRQUFRLEdBQ1osV0FBVyxJQUFJLENBQUMsQ0FBQyxTQUFTLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDO1FBQ2hELENBQUMsQ0FBQyxNQUFNO1FBQ0osdUZBQXVGO1FBQ3ZGLDJFQUEyRTtRQUMzRSxtQ0FBbUMsQ0FDakMsS0FBSyxDQUFDLFlBQVksRUFBRSxZQUFZLElBQUksSUFBSSxFQUN4QyxLQUFLLENBQUMsWUFBWSxFQUFFLFVBQVUsSUFBSSxJQUFJLEVBQ3RDLE9BQU8sQ0FDb0IsQ0FDOUI7UUFDSCxDQUFDLENBQUMsSUFBSSxDQUFDO0lBRVgsT0FBTztRQUNMLE9BQU87UUFDUCxRQUFRO1FBQ1IsU0FBUyxFQUFFLE9BQU8sQ0FBQyxVQUFVO1FBQzdCLFlBQVksRUFBRSxPQUFPLENBQUMsWUFBWTtRQUNsQyxZQUFZO0tBQ2IsQ0FBQztBQUNKLENBQUMifQ==