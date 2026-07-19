// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .loopover-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.

import {
  buildMinerKillSwitchTransitionGovernorLedgerEvent,
  isGlobalMinerKillSwitch,
  isMinerKillSwitchActive,
  resolveMinerKillSwitch,
} from "@loopover/engine";
import type { MinerKillSwitchScope } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type CheckMinerKillSwitchInput = {
  repoPaused?: boolean;
  env?: Record<string, string | undefined>;
};

export type CheckMinerKillSwitchResult = {
  scope: MinerKillSwitchScope;
  active: boolean;
};

/**
 * Resolve the current kill-switch scope for a repo from process env plus a per-repo paused flag (typically
 * `MinerGoalSpec.killSwitch.paused` from the repo's parsed `.loopover-miner.yml`).
 */
export function checkMinerKillSwitch(input: CheckMinerKillSwitchInput = {}): CheckMinerKillSwitchResult {
  const env = input.env ?? process.env;
  const global = isGlobalMinerKillSwitch(env);
  const scope = resolveMinerKillSwitch({ global, repoPaused: input.repoPaused });
  return { scope, active: isMinerKillSwitchActive(scope) };
}

export type RecordMinerKillSwitchTransitionInput = {
  repoFullName?: string;
  actionClass: string;
  previousScope: MinerKillSwitchScope;
  scope: MinerKillSwitchScope;
};

/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check — callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own.
 */
export function recordMinerKillSwitchTransition(
  input: RecordMinerKillSwitchTransitionInput,
  options: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry } = {},
): GovernorLedgerEntry | null {
  const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
  if (!event) return null;
  const append = options.append ?? appendGovernorEvent;
  return append(event as AppendGovernorEventInput);
}
