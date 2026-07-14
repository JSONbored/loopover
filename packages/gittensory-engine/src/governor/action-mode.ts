// Governor dry-run-by-default enforcement (#2342): resolves the miner's overall action mode -- "safest wins"
// precedence mirroring `resolveAgentActionMode` (`src/settings/agent-execution.ts`): paused > dry_run > live.
// A freshly-configured miner (no opt-in present anywhere) MUST default to dry_run, never live -- this is the
// deny-by-default floor `src/settings/autonomy.ts`'s `DEFAULT_AUTONOMY_LEVEL = "observe"` establishes for the
// review-stack, extended here to the miner's own runtime.
//
// DETECTOR ONLY -- no IO, no persistence. Consulting this alongside the other pure calculators (rate-limit,
// budget caps, reputation, self-plagiarism, non-convergence) and recording every CHECK is the Governor
// chokepoint's job (#2340), which consults this module (after the kill-switch) in its precedence ladder.

import type { GovernorLedgerEvent } from "../governor-ledger.js";
import { isMinerKillSwitchActive, type MinerKillSwitchScope } from "./kill-switch.js";

/** Whether the miner actually executes a write, only shadow-logs what it WOULD do, or is halted entirely. */
export type MinerActionMode = "paused" | "dry_run" | "live";

/**
 * The ONLY value that opts a miner into LIVE write execution. Deliberately a specific string literal, not a
 * boolean -- a fat-fingered `liveModeOptIn: true`, `"yes"`, `"on"`, or `LOOPOVER_MINER_LIVE_MODE=1` must never
 * accidentally unlock writes the way a truthy-coerced flag could. Per the issue's explicit requirement: "not a
 * generic boolean flag that could be accidentally true."
 */
export const MINER_LIVE_MODE_OPT_IN = "live";

/** Env var an operator sets (to exactly {@link MINER_LIVE_MODE_OPT_IN}) to opt their own miner instance into
 *  live write execution. Repo-side opt-in alone is never enough to execute writes. */
export const MINER_LIVE_MODE_ENV_VAR = "LOOPOVER_MINER_LIVE_MODE";

/** True only when `value` is EXACTLY the {@link MINER_LIVE_MODE_OPT_IN} string -- no truthy coercion, no case
 *  folding, no alternate spellings. Everything else (including `true`, `"Live"`, `"1"`) reads as not opted in. */
export function isExplicitMinerLiveModeOptIn(value: unknown): boolean {
  return value === MINER_LIVE_MODE_OPT_IN;
}

/** True when the operator's global env-level live-mode opt-in is set to exactly {@link MINER_LIVE_MODE_OPT_IN}. */
export function isGlobalMinerLiveModeOptIn(env: Record<string, string | undefined>): boolean {
  return env[MINER_LIVE_MODE_ENV_VAR] === MINER_LIVE_MODE_OPT_IN;
}

/**
 * Resolve the miner's overall action mode. Precedence (safest wins, mirroring `resolveAgentActionMode`):
 * 1. Kill-switch active (either scope, #2341) -> `"paused"` -- always wins, regardless of any live-mode opt-in.
 * 2. BOTH the operator's global env config AND the target repo's own `.gittensory-miner.yml`
 *    (`MinerGoalSpec.execution.liveModeOptIn`) explicitly opt in -> `"live"`. The repo field is a repo-side
 *    allowance, not an operator-authored authorization to execute writes under the miner's credentials.
 * 3. Otherwise -> `"dry_run"`. No config anywhere, either side omitted, or a malformed/partial config that fails
 *    to normalize to the exact opt-in literal, all fall through to this branch -- absence or ambiguity always
 *    means dry-run.
 *
 * A target repo that wants to guarantee it never receives live automated writes -- even from an operator whose
 * own miner instance is globally live -- can omit its repo opt-in or set its OWN kill-switch (`killSwitch.paused:
 * true`, #2341), which takes precedence over any live-mode opt-in per step 1 above.
 */
export function resolveMinerActionMode(input: {
  killSwitchScope: MinerKillSwitchScope;
  repoLiveModeOptIn?: unknown;
  globalLiveModeOptIn: boolean;
}): MinerActionMode {
  if (isMinerKillSwitchActive(input.killSwitchScope)) return "paused";
  if (input.globalLiveModeOptIn && isExplicitMinerLiveModeOptIn(input.repoLiveModeOptIn)) return "live";
  return "dry_run";
}

/** True only for `"live"` -- the only mode that performs a real write. `"paused"` does nothing; `"dry_run"`
 *  records a shadow action but never mutates. */
export function minerActionModeExecutes(mode: MinerActionMode): boolean {
  return mode === "live";
}

/**
 * Governor-ledger row for a dry-run SHADOW action (#2342's "logs the WOULD-BE action... without ever invoking
 * the actual command" deliverable). `eventType` stays within the existing closed vocabulary (`"allowed"` -- the
 * Governor's other checks did not deny this action, dry-run mode is simply choosing to shadow-log instead of
 * execute); `decision: "dry_run"` is the distinct marker this deliverable calls for. `wouldBeAction` is left as
 * a generic record (not the concrete `LocalWriteActionSpec` type) so this package stays decoupled from the
 * main app's `src/mcp/local-write-tools.ts` -- the caller wiring a real action spec into this call owns that
 * shape.
 */
export function buildMinerDryRunGovernorLedgerEvent(input: {
  repoFullName?: string | null | undefined;
  actionClass: string;
  wouldBeAction: Record<string, unknown>;
}): GovernorLedgerEvent {
  return {
    eventType: "allowed",
    repoFullName: input.repoFullName ?? null,
    actionClass: input.actionClass,
    decision: "dry_run",
    reason: "dry_run_mode_active",
    payload: { wouldBeAction: input.wouldBeAction },
  };
}
