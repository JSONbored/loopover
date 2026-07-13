import type { GovernorCapUsage } from "@loopover/engine";
import type { GovernorRateLimitState, GovernorState } from "./governor-state.js";

export const GOVERNOR_RATE_LIMIT_REMAINING_RATIO: string;
export const GOVERNOR_CAP_USAGE_RATIO: string;

export function renderGovernorMetrics(
  rateLimitState: GovernorRateLimitState,
  capUsage: GovernorCapUsage,
  nowMs: number,
): string;

export function runGovernorMetrics(
  args: string[],
  options?: { openGovernorState?: () => GovernorState; nowMs?: number },
): Promise<number>;
