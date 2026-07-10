// Coding-agent execution mode (#4313). Mirrors `AgentActionMode` at `src/settings/agent-execution.ts:23-48`:
// three states (`paused` | `dry_run` | `live`), deny-toward-safety precedence (global/per-repo pause beats
// dry-run beats live), and a single `codingAgentModeExecutes` boolean for callers.
//
// Why three states instead of a boolean? The maintainer-action layer already proved the shape: `paused` is an
// operator kill-switch (attempt never starts), `dry_run` is an observe/shadow path (record intent without the
// expensive/dangerous work), and `live` is the only mode that actually spawns/queries the underlying agent.
// A boolean would collapse `paused` into `dry_run`, losing the distinction between "halt entirely" and
// "shadow what would happen".
//
// Dry-run semantics for a CODING agent (#4313): at the driver invocation boundary, `dry_run` is a **pure no-op**
// — the underlying CLI/SDK session is never spawned. Tradeoff documented here:
//   • Chosen: never spawn (cheapest, safest, mirrors `agentActionModeExecutes` skipping GitHub mutations).
//   • Deferred alternative: run inside an isolated worktree (#4269) but suppress commit/push/PR downstream so
//     file edits remain inspectable — requires the worktree primitive and orchestrator gating on create-phase
//     steps; the attempt log records `attempt_shadow` with mode=`dry_run` so either path stays auditable.

/** Whether a coding-agent attempt actually spawns/queries the underlying session. */
export type CodingAgentExecutionMode = "paused" | "dry_run" | "live";

/** Global kill-switch for miner coding-agent invocations (`MINER_CODING_AGENT_PAUSED`). Same truthy-string
 *  convention as `isGlobalAgentPause` (`AGENT_ACTIONS_PAUSED`). */
export function isGlobalMinerCodingAgentPause(env: {
  MINER_CODING_AGENT_PAUSED?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test(env.MINER_CODING_AGENT_PAUSED ?? "");
}

/** THE single gate before invoking a `CodingAgentDriver`. Precedence (safest wins): global OR per-config pause
 *  → `paused`; else per-config dry-run → `dry_run`; else `live`. Pure. */
export function resolveCodingAgentExecutionMode(input: {
  globalPaused: boolean;
  agentPaused?: boolean | null | undefined;
  agentDryRun?: boolean | null | undefined;
}): CodingAgentExecutionMode {
  if (input.globalPaused || input.agentPaused === true) return "paused";
  if (input.agentDryRun === true) return "dry_run";
  return "live";
}

/** Resolve mode from env + optional per-run overrides (mirrors `resolveAgentActionMode` call sites). */
export function resolveCodingAgentModeFromConfig(config: {
  env?: { MINER_CODING_AGENT_PAUSED?: string | undefined } | undefined;
  agentPaused?: boolean | null | undefined;
  agentDryRun?: boolean | null | undefined;
}): CodingAgentExecutionMode {
  return resolveCodingAgentExecutionMode({
    globalPaused: isGlobalMinerCodingAgentPause(config.env ?? {}),
    agentPaused: config.agentPaused,
    agentDryRun: config.agentDryRun,
  });
}

/** True only for `live` — the only mode that performs a real driver `run()`. `paused` does nothing; `dry_run`
 *  records a shadow result without spawning the underlying agent. */
export function codingAgentModeExecutes(mode: CodingAgentExecutionMode): boolean {
  return mode === "live";
}
