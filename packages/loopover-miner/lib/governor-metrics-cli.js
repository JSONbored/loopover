import { DEFAULT_AMS_POLICY_SPEC, DEFAULT_WRITE_RATE_LIMIT_POLICIES, evaluateGovernorCaps, evaluateLocalRateLimit, } from "@loopover/engine";
import { openGovernorState } from "./governor-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
// `governor metrics` (#5187): render the governor's persisted rate-limit + cap-usage state (#5134,
// governor-state.js) as Prometheus text-exposition, so an operator's Alertmanager can page on rate-limit/
// budget pressure without hand-rolling a scrape. Strictly read-only, mirroring queue-cli.js's `queue metrics`
// (#5186) and event-ledger-cli.js's `ledger metrics` (#4841): opens the local governor-state store, composes
// its EXISTING loadRateLimitState()/loadCapUsage() with the engine's already-exported PURE calculators
// (evaluateLocalRateLimit, evaluateGovernorCaps) against the SAME defaults the production loop (loop-cli.js)
// already falls back to when no `.loopover-ams.yml` override is configured (DEFAULT_WRITE_RATE_LIMIT_POLICIES,
// DEFAULT_AMS_POLICY_SPEC.capLimits) -- it never invents a threshold of its own, and it does not gate, retry,
// mutate, or otherwise touch governor decision logic (governor-chokepoint.js/governor-chokepoint-persisted.js
// are completely untouched by this file).
//
// capLimits is intentionally NOT read per-repo: governor-state.js's capUsage row is a single global scalar (a
// run-scoped cumulative counter, not indexed by repo -- see governor-state.js's own header comment), so a
// per-repo capLimits override from a resolved `.loopover-miner.yml` has no matching per-repo usage row to
// pair it with here. Using the fleet-wide DEFAULT_AMS_POLICY_SPEC.capLimits is the same approximation
// loop-cli.js itself already makes for any repo without its own override.
const GOVERNOR_METRICS_USAGE = "Usage: loopover-miner governor metrics";
export const GOVERNOR_RATE_LIMIT_REMAINING_RATIO = "loopover_miner_governor_rate_limit_remaining_ratio";
export const GOVERNOR_CAP_USAGE_RATIO = "loopover_miner_governor_cap_usage_ratio";
/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeMetricsHelpText(help) {
    return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/** Prometheus label-value escaping — backslash, double-quote, newline (mirrors event-ledger-cli.js's
 *  escapeLabelValue). */
function escapeLabelValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
/** buckets.perRepo is keyed by writeRateLimitRepoKey(actionClass, repoFullName) = "actionClass:repoFullName"
 *  (write-rate-limit.ts). actionClass is a fixed identifier (never contains ":"), so splitting on the FIRST
 *  colon recovers both parts even though repoFullName itself contains a "/". */
function splitPerRepoKey(key) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex === -1)
        return { actionClass: key, repoFullName: "" };
    return { actionClass: key.slice(0, separatorIndex), repoFullName: key.slice(separatorIndex + 1) };
}
// evaluateLocalRateLimit's own `remaining` field answers "how many MORE writes are allowed AFTER one more write
// right now" (rate-limit.ts: `remaining = allowed ? limit - effectiveCount - 1 : 0`) -- it is NOT current
// headroom. At count=2/limit=3 that field is already 0, identical to a fully exhausted count=3/limit=3 bucket,
// even though the count=2 bucket still has one write available. Recover true current headroom algebraically
// instead: when allowed, decision.remaining + 1 is exactly limit - effectiveCount (undo the "-1 for this next
// write" the decision already applied); when not allowed, headroom is 0. Every actionClass this loop reaches
// has already passed the DEFAULT_WRITE_RATE_LIMIT_POLICIES lookup above, so decision.limit is always one of the
// frozen, non-zero policy limits -- no zero-limit guard needed.
function remainingRatio(decision) {
    const headroom = decision.allowed ? decision.remaining + 1 : 0;
    return headroom / decision.limit;
}
function collectRateLimitRows(buckets, nowMs) {
    const rows = [];
    for (const [actionClass, bucket] of Object.entries(buckets.global)) {
        const config = DEFAULT_WRITE_RATE_LIMIT_POLICIES.global[actionClass];
        if (!config)
            continue;
        rows.push({
            scope: "global",
            actionClass,
            repoFullName: "",
            ratio: remainingRatio(evaluateLocalRateLimit(bucket, config, nowMs)),
        });
    }
    for (const [key, bucket] of Object.entries(buckets.perRepo)) {
        const { actionClass, repoFullName } = splitPerRepoKey(key);
        const config = DEFAULT_WRITE_RATE_LIMIT_POLICIES.perRepo[actionClass];
        if (!config)
            continue;
        rows.push({
            scope: "per_repo",
            actionClass,
            repoFullName,
            ratio: remainingRatio(evaluateLocalRateLimit(bucket, config, nowMs)),
        });
    }
    rows.sort((a, b) => {
        if (a.scope !== b.scope)
            return a.scope.localeCompare(b.scope);
        if (a.actionClass !== b.actionClass)
            return a.actionClass.localeCompare(b.actionClass);
        return a.repoFullName.localeCompare(b.repoFullName);
    });
    return rows;
}
// DEFAULT_AMS_POLICY_SPEC.capLimits is a frozen, non-zero constant for every dimension -- no zero-limit guard
// needed, mirroring remainingRatio()'s reasoning above.
function collectCapUsageRows(capUsage) {
    const report = evaluateGovernorCaps(capUsage, DEFAULT_AMS_POLICY_SPEC.capLimits);
    return [
        { dimension: "budget", dimensionReport: report.budget },
        { dimension: "turns", dimensionReport: report.turns },
        { dimension: "elapsed_ms", dimensionReport: report.termination },
    ].map(({ dimension, dimensionReport }) => ({
        dimension,
        ratio: dimensionReport.used / dimensionReport.limit,
    }));
}
export function renderGovernorMetrics(rateLimitState, capUsage, nowMs) {
    const rateLimitRows = collectRateLimitRows(rateLimitState.buckets, nowMs);
    const capRows = collectCapUsageRows(capUsage);
    const lines = [
        `# HELP ${GOVERNOR_RATE_LIMIT_REMAINING_RATIO} ${escapeMetricsHelpText("Remaining headroom in the governor's current write-rate-limit window, as a fraction of the configured limit (1 = empty bucket, 0 = exhausted). Evaluated against DEFAULT_WRITE_RATE_LIMIT_POLICIES.")}`,
        `# TYPE ${GOVERNOR_RATE_LIMIT_REMAINING_RATIO} gauge`,
    ];
    for (const row of rateLimitRows) {
        const repoLabel = row.scope === "per_repo" ? `,repo="${escapeLabelValue(row.repoFullName)}"` : "";
        lines.push(`${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="${row.scope}",action_class="${escapeLabelValue(row.actionClass)}"${repoLabel}} ${row.ratio}`);
    }
    lines.push(`# HELP ${GOVERNOR_CAP_USAGE_RATIO} ${escapeMetricsHelpText("The governor's persisted cumulative cap usage as a fraction of DEFAULT_AMS_POLICY_SPEC.capLimits (1 = ceiling reached). dimension is one of budget|turns|elapsed_ms.")}`);
    lines.push(`# TYPE ${GOVERNOR_CAP_USAGE_RATIO} gauge`);
    for (const row of capRows) {
        lines.push(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="${row.dimension}"} ${row.ratio}`);
    }
    return `${lines.join("\n")}\n`;
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
export async function runGovernorMetrics(args, options = {}) {
    if (args.length > 0) {
        return reportCliFailure(argsWantJson(args), GOVERNOR_METRICS_USAGE);
    }
    try {
        return await withGovernorState(options, (governorState) => {
            const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
            const rateLimitState = governorState.loadRateLimitState();
            const capUsage = governorState.loadCapUsage();
            console.log(renderGovernorMetrics(rateLimitState, capUsage, nowMs).trimEnd());
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(argsWantJson(args), describeCliError(error));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItbWV0cmljcy1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1tZXRyaWNzLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQ0wsdUJBQXVCLEVBQ3ZCLGlDQUFpQyxFQUNqQyxvQkFBb0IsRUFDcEIsc0JBQXNCLEdBS3ZCLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFFeEQsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRWxGLG1HQUFtRztBQUNuRywwR0FBMEc7QUFDMUcsOEdBQThHO0FBQzlHLDZHQUE2RztBQUM3Ryx1R0FBdUc7QUFDdkcsNkdBQTZHO0FBQzdHLCtHQUErRztBQUMvRyw4R0FBOEc7QUFDOUcsOEdBQThHO0FBQzlHLDBDQUEwQztBQUMxQyxFQUFFO0FBQ0YsOEdBQThHO0FBQzlHLDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsc0dBQXNHO0FBQ3RHLDBFQUEwRTtBQUUxRSxNQUFNLHNCQUFzQixHQUFHLHdDQUF3QyxDQUFDO0FBRXhFLE1BQU0sQ0FBQyxNQUFNLG1DQUFtQyxHQUFHLG9EQUFvRCxDQUFDO0FBQ3hHLE1BQU0sQ0FBQyxNQUFNLHdCQUF3QixHQUFHLHlDQUF5QyxDQUFDO0FBbUJsRix1R0FBdUc7QUFDdkcsU0FBUyxxQkFBcUIsQ0FBQyxJQUFZO0lBQ3pDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztBQUMzRCxDQUFDO0FBRUQ7eUJBQ3lCO0FBQ3pCLFNBQVMsZ0JBQWdCLENBQUMsS0FBYTtJQUNyQyxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztBQUNqRixDQUFDO0FBRUQ7O2dGQUVnRjtBQUNoRixTQUFTLGVBQWUsQ0FBQyxHQUFXO0lBQ2xDLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDeEMsSUFBSSxjQUFjLEtBQUssQ0FBQyxDQUFDO1FBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxHQUFHLEVBQUUsWUFBWSxFQUFFLEVBQUUsRUFBRSxDQUFDO0lBQ3pFLE9BQU8sRUFBRSxXQUFXLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsY0FBYyxDQUFDLEVBQUUsWUFBWSxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsY0FBYyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDcEcsQ0FBQztBQUVELGdIQUFnSDtBQUNoSCwwR0FBMEc7QUFDMUcsK0dBQStHO0FBQy9HLDRHQUE0RztBQUM1Ryw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLGdIQUFnSDtBQUNoSCxnRUFBZ0U7QUFDaEUsU0FBUyxjQUFjLENBQUMsUUFBZ0M7SUFDdEQsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFNBQVMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMvRCxPQUFPLFFBQVEsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDO0FBQ25DLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUFDLE9BQWtDLEVBQUUsS0FBYTtJQUM3RSxNQUFNLElBQUksR0FBeUIsRUFBRSxDQUFDO0lBQ3RDLEtBQUssTUFBTSxDQUFDLFdBQVcsRUFBRSxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQWdDLEVBQUUsQ0FBQztRQUNsRyxNQUFNLE1BQU0sR0FBRyxpQ0FBaUMsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDckUsSUFBSSxDQUFDLE1BQU07WUFBRSxTQUFTO1FBQ3RCLElBQUksQ0FBQyxJQUFJLENBQUM7WUFDUixLQUFLLEVBQUUsUUFBUTtZQUNmLFdBQVc7WUFDWCxZQUFZLEVBQUUsRUFBRTtZQUNoQixLQUFLLEVBQUUsY0FBYyxDQUFDLHNCQUFzQixDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7U0FDckUsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUNELEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQWdDLEVBQUUsQ0FBQztRQUMzRixNQUFNLEVBQUUsV0FBVyxFQUFFLFlBQVksRUFBRSxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMzRCxNQUFNLE1BQU0sR0FBRyxpQ0FBaUMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDdEUsSUFBSSxDQUFDLE1BQU07WUFBRSxTQUFTO1FBQ3RCLElBQUksQ0FBQyxJQUFJLENBQUM7WUFDUixLQUFLLEVBQUUsVUFBVTtZQUNqQixXQUFXO1lBQ1gsWUFBWTtZQUNaLEtBQUssRUFBRSxjQUFjLENBQUMsc0JBQXNCLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsQ0FBQztTQUNyRSxDQUFDLENBQUM7SUFDTCxDQUFDO0lBQ0QsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUNqQixJQUFJLENBQUMsQ0FBQyxLQUFLLEtBQUssQ0FBQyxDQUFDLEtBQUs7WUFBRSxPQUFPLENBQUMsQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMvRCxJQUFJLENBQUMsQ0FBQyxXQUFXLEtBQUssQ0FBQyxDQUFDLFdBQVc7WUFBRSxPQUFPLENBQUMsQ0FBQyxXQUFXLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUN2RixPQUFPLENBQUMsQ0FBQyxZQUFZLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUN0RCxDQUFDLENBQUMsQ0FBQztJQUNILE9BQU8sSUFBSSxDQUFDO0FBQ2QsQ0FBQztBQUVELDhHQUE4RztBQUM5Ryx3REFBd0Q7QUFDeEQsU0FBUyxtQkFBbUIsQ0FBQyxRQUEwQjtJQUNyRCxNQUFNLE1BQU0sR0FBRyxvQkFBb0IsQ0FBQyxRQUFRLEVBQUUsdUJBQXVCLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDakYsT0FBTztRQUNMLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxlQUFlLEVBQUUsTUFBTSxDQUFDLE1BQU0sRUFBRTtRQUN2RCxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sQ0FBQyxLQUFLLEVBQUU7UUFDckQsRUFBRSxTQUFTLEVBQUUsWUFBWSxFQUFFLGVBQWUsRUFBRSxNQUFNLENBQUMsV0FBVyxFQUFFO0tBQ2pFLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsZUFBZSxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDekMsU0FBUztRQUNULEtBQUssRUFBRSxlQUFlLENBQUMsSUFBSSxHQUFHLGVBQWUsQ0FBQyxLQUFLO0tBQ3BELENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQztBQUVELE1BQU0sVUFBVSxxQkFBcUIsQ0FDbkMsY0FBc0MsRUFDdEMsUUFBMEIsRUFDMUIsS0FBYTtJQUViLE1BQU0sYUFBYSxHQUFHLG9CQUFvQixDQUFDLGNBQWMsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDMUUsTUFBTSxPQUFPLEdBQUcsbUJBQW1CLENBQUMsUUFBUSxDQUFDLENBQUM7SUFFOUMsTUFBTSxLQUFLLEdBQUc7UUFDWixVQUFVLG1DQUFtQyxJQUFJLHFCQUFxQixDQUNwRSxxTUFBcU0sQ0FDdE0sRUFBRTtRQUNILFVBQVUsbUNBQW1DLFFBQVE7S0FDdEQsQ0FBQztJQUNGLEtBQUssTUFBTSxHQUFHLElBQUksYUFBYSxFQUFFLENBQUM7UUFDaEMsTUFBTSxTQUFTLEdBQUcsR0FBRyxDQUFDLEtBQUssS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLFVBQVUsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNsRyxLQUFLLENBQUMsSUFBSSxDQUNSLEdBQUcsbUNBQW1DLFdBQVcsR0FBRyxDQUFDLEtBQUssbUJBQW1CLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxTQUFTLEtBQUssR0FBRyxDQUFDLEtBQUssRUFBRSxDQUM1SSxDQUFDO0lBQ0osQ0FBQztJQUVELEtBQUssQ0FBQyxJQUFJLENBQ1IsVUFBVSx3QkFBd0IsSUFBSSxxQkFBcUIsQ0FDekQsc0tBQXNLLENBQ3ZLLEVBQUUsQ0FDSixDQUFDO0lBQ0YsS0FBSyxDQUFDLElBQUksQ0FBQyxVQUFVLHdCQUF3QixRQUFRLENBQUMsQ0FBQztJQUN2RCxLQUFLLE1BQU0sR0FBRyxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQzFCLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyx3QkFBd0IsZUFBZSxHQUFHLENBQUMsU0FBUyxNQUFNLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZGLENBQUM7SUFFRCxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQ2pDLENBQUM7QUFFRCxLQUFLLFVBQVUsaUJBQWlCLENBQzlCLE9BQWtDLEVBQ2xDLEdBQXFEO0lBRXJELE1BQU0saUJBQWlCLEdBQUcsT0FBTyxDQUFDLGlCQUFpQixLQUFLLFNBQVMsQ0FBQztJQUNsRSxNQUFNLGFBQWEsR0FBRyxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsSUFBSSxpQkFBaUIsQ0FBQyxFQUFFLENBQUM7SUFDekUsSUFBSSxDQUFDO1FBQ0gsT0FBTyxNQUFNLEdBQUcsQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUNsQyxDQUFDO1lBQVMsQ0FBQztRQUNULElBQUksaUJBQWlCO1lBQUUsYUFBYSxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQy9DLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxDQUFDLEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxJQUFjLEVBQUUsVUFBcUMsRUFBRTtJQUM5RixJQUFJLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDcEIsT0FBTyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztJQUN0RSxDQUFDO0lBRUQsSUFBSSxDQUFDO1FBQ0gsT0FBTyxNQUFNLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxDQUFDLGFBQWEsRUFBRSxFQUFFO1lBQ3hELE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBRSxPQUFPLENBQUMsS0FBZ0IsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3RGLE1BQU0sY0FBYyxHQUFHLGFBQWEsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1lBQzFELE1BQU0sUUFBUSxHQUFHLGFBQWEsQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUM5QyxPQUFPLENBQUMsR0FBRyxDQUFDLHFCQUFxQixDQUFDLGNBQWMsRUFBRSxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUM5RSxPQUFPLENBQUMsQ0FBQztRQUNYLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7QUFDSCxDQUFDIn0=