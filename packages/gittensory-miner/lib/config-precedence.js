/** Documented config-resolution helpers for precedence tests (#5198). Thin wrappers over existing resolvers —
 *  no new precedence rules. See `docs/config-precedence.md`. */

import {
  isGlobalMinerCodingAgentPause,
  resolveCodingAgentExecutionMode,
  resolveMinerActionMode,
  resolveMinerKillSwitch,
} from "@loopover/engine";
import { resolveForgeConfig } from "./forge-config.js";

/** Kill-switch scope from operator env + parsed goal-spec `killSwitch.paused`. */
export function resolveDocumentedKillSwitchScope(env, repoPaused) {
  const global = /^(1|true|yes|on)$/i.test(env.LOOPOVER_MINER_KILL_SWITCH ?? "");
  return resolveMinerKillSwitch({ global, repoPaused });
}

/** Governor action mode from kill-switch scope + env/yml live opt-ins. */
export function resolveDocumentedGovernorActionMode(input) {
  return resolveMinerActionMode(input);
}

/** Coding-agent mode from operator env pause + CLI `--live` (via agentDryRun). */
export function resolveDocumentedCodingAgentMode(env, cliLiveFlag) {
  return resolveCodingAgentExecutionMode({
    globalPaused: isGlobalMinerCodingAgentPause(env),
    agentDryRun: cliLiveFlag ? false : true,
  });
}

/** Discover credential env var name: CLI > programmatic > forge default. Mirrors discover-cli.js. */
export function resolveDocumentedDiscoverTokenEnvVar(input = {}) {
  const parsedTokenEnv = input.cliTokenEnv ?? null;
  const optionsTokenEnv = input.optionsTokenEnv ?? null;
  if (parsedTokenEnv !== null) return parsedTokenEnv;
  if (optionsTokenEnv !== null) return optionsTokenEnv;
  return resolveForgeConfig(input.forge).tokenEnvVar;
}
