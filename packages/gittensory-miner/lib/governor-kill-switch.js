// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .gittensory-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.

import {
  buildMinerKillSwitchTransitionGovernorLedgerEvent,
  isGlobalMinerKillSwitch,
  isMinerKillSwitchActive,
  resolveMinerKillSwitch,
} from "@jsonbored/gittensory-engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Resolve the current kill-switch scope for a repo from process env plus a per-repo paused flag (typically
 * `MinerGoalSpec.killSwitch.paused` from the repo's parsed `.gittensory-miner.yml`).
 *
 * @param {object} [input]
 * @param {boolean} [input.repoPaused]
 * @param {Record<string, string | undefined>} [input.env]
 * @returns {{ scope: import("@jsonbored/gittensory-engine").MinerKillSwitchScope, active: boolean }}
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
 *
 * @param {object} input
 * @param {string} [input.repoFullName]
 * @param {string} input.actionClass
 * @param {import("@jsonbored/gittensory-engine").MinerKillSwitchScope} input.previousScope
 * @param {import("@jsonbored/gittensory-engine").MinerKillSwitchScope} input.scope
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 */
export function recordMinerKillSwitchTransition(input, options = {}) {
  const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
  if (!event) return null;
  const append = options.append ?? appendGovernorEvent;
  return append(event);
}
