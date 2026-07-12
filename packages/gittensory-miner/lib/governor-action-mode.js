// Governor dry-run-by-default gate (#2342). Resolves the miner's overall action mode (paused > dry_run > live,
// "safest wins") and records dry-run SHADOW actions to the append-only governor ledger. A freshly-configured
// miner defaults to dry_run -- live execution requires explicit, hard-to-fat-finger operator and repo opt-ins.

import {
  buildMinerDryRunGovernorLedgerEvent,
  isGlobalMinerLiveModeOptIn,
  minerActionModeExecutes,
  resolveMinerActionMode,
} from "@jsonbored/gittensory-engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Resolve the miner's overall action mode from the kill-switch scope (see `checkMinerKillSwitch` in
 * `./governor-kill-switch.js`), the repo's own `.gittensory-miner.yml` opt-in, and the operator's global env
 * opt-in. Both sides must opt in before real writes execute; repo config alone only preserves dry-run.
 *
 * @param {object} input
 * @param {import("@jsonbored/gittensory-engine").MinerKillSwitchScope} input.killSwitchScope
 * @param {unknown} [input.repoLiveModeOptIn] `MinerGoalSpec.execution.liveModeOptIn` from the target repo
 * @param {Record<string, string | undefined>} [input.env]
 * @returns {{ mode: import("@jsonbored/gittensory-engine").MinerActionMode, executes: boolean }}
 */
export function resolveMinerActionModeGate(input) {
  const env = input.env ?? process.env;
  const mode = resolveMinerActionMode({
    killSwitchScope: input.killSwitchScope,
    repoLiveModeOptIn: input.repoLiveModeOptIn,
    globalLiveModeOptIn: isGlobalMinerLiveModeOptIn(env),
  });
  return { mode, executes: minerActionModeExecutes(mode) };
}

/**
 * Record a dry-run shadow action (the WOULD-BE `LocalWriteActionSpec`) to the governor ledger, without ever
 * invoking the actual command.
 *
 * @param {object} input
 * @param {string} [input.repoFullName]
 * @param {string} input.actionClass
 * @param {Record<string, unknown>} input.wouldBeAction
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 */
export function recordMinerDryRunShadow(input, options = {}) {
  const append = options.append ?? appendGovernorEvent;
  return append(buildMinerDryRunGovernorLedgerEvent(input));
}
