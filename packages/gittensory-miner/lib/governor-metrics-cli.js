import {
  DEFAULT_AMS_POLICY_SPEC,
  DEFAULT_WRITE_RATE_LIMIT_POLICIES,
  evaluateGovernorCaps,
  evaluateLocalRateLimit,
} from "@loopover/engine";
import { openGovernorState } from "./governor-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// `governor metrics` (#5187): render the governor's persisted rate-limit + cap-usage state (#5134,
// governor-state.js) as Prometheus text-exposition, so an operator's Alertmanager can page on rate-limit/
// budget pressure without hand-rolling a scrape. Strictly read-only, mirroring queue-cli.js's `queue metrics`
// (#5186) and event-ledger-cli.js's `ledger metrics` (#4841): opens the local governor-state store, composes
// its EXISTING loadRateLimitState()/loadCapUsage() with the engine's already-exported PURE calculators
// (evaluateLocalRateLimit, evaluateGovernorCaps) against the SAME defaults the production loop (loop-cli.js)
// already falls back to when no `.gittensory-ams.yml` override is configured (DEFAULT_WRITE_RATE_LIMIT_POLICIES,
// DEFAULT_AMS_POLICY_SPEC.capLimits) -- it never invents a threshold of its own, and it does not gate, retry,
// mutate, or otherwise touch governor decision logic (governor-chokepoint.js/governor-chokepoint-persisted.js
// are completely untouched by this file).
//
// capLimits is intentionally NOT read per-repo: governor-state.js's capUsage row is a single global scalar (a
// run-scoped cumulative counter, not indexed by repo -- see governor-state.js's own header comment), so a
// per-repo capLimits override from a resolved `.gittensory-miner.yml` has no matching per-repo usage row to
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
  if (separatorIndex === -1) return { actionClass: key, repoFullName: "" };
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
    if (!config) continue;
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
    if (!config) continue;
    rows.push({
      scope: "per_repo",
      actionClass,
      repoFullName,
      ratio: remainingRatio(evaluateLocalRateLimit(bucket, config, nowMs)),
    });
  }
  rows.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    if (a.actionClass !== b.actionClass) return a.actionClass.localeCompare(b.actionClass);
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

/**
 * @param {import("./governor-state.js").GovernorRateLimitState} rateLimitState
 * @param {import("@loopover/engine").GovernorCapUsage} capUsage
 * @param {number} nowMs
 */
export function renderGovernorMetrics(rateLimitState, capUsage, nowMs) {
  const rateLimitRows = collectRateLimitRows(rateLimitState.buckets, nowMs);
  const capRows = collectCapUsageRows(capUsage);

  const lines = [
    `# HELP ${GOVERNOR_RATE_LIMIT_REMAINING_RATIO} ${escapeMetricsHelpText(
      "Remaining headroom in the governor's current write-rate-limit window, as a fraction of the configured limit (1 = empty bucket, 0 = exhausted). Evaluated against DEFAULT_WRITE_RATE_LIMIT_POLICIES.",
    )}`,
    `# TYPE ${GOVERNOR_RATE_LIMIT_REMAINING_RATIO} gauge`,
  ];
  for (const row of rateLimitRows) {
    const repoLabel = row.scope === "per_repo" ? `,repo="${escapeLabelValue(row.repoFullName)}"` : "";
    lines.push(
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="${row.scope}",action_class="${escapeLabelValue(row.actionClass)}"${repoLabel}} ${row.ratio}`,
    );
  }

  lines.push(
    `# HELP ${GOVERNOR_CAP_USAGE_RATIO} ${escapeMetricsHelpText(
      "The governor's persisted cumulative cap usage as a fraction of DEFAULT_AMS_POLICY_SPEC.capLimits (1 = ceiling reached). dimension is one of budget|turns|elapsed_ms.",
    )}`,
  );
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
    return run(governorState);
  } finally {
    if (ownsGovernorState) governorState.close();
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
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  }
}
