import { type GovernorCapUsage } from "@loopover/engine";
import type { GovernorRateLimitState, GovernorState } from "./governor-state.js";
export declare const GOVERNOR_RATE_LIMIT_REMAINING_RATIO = "loopover_miner_governor_rate_limit_remaining_ratio";
export declare const GOVERNOR_CAP_USAGE_RATIO = "loopover_miner_governor_cap_usage_ratio";
export type GovernorMetricsCliOptions = {
    openGovernorState?: () => GovernorState;
    nowMs?: number;
};
export declare function renderGovernorMetrics(rateLimitState: GovernorRateLimitState, capUsage: GovernorCapUsage, nowMs: number): string;
export declare function runGovernorMetrics(args: string[], options?: GovernorMetricsCliOptions): Promise<number>;
