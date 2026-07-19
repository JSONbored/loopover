import { type AgentSdkHooks, type AgentSdkQueryFn, type CliSubprocessSpawnFn, type CodingAgentDriver } from "@loopover/engine";
import { type HouseRulesConfig, type HouseRulesOptions } from "./coding-agent-house-rules.js";
/**
 * Real `child_process.spawn`-backed implementation of the engine's `CliSubprocessSpawnFn` contract. Captures
 * stdout/stderr and RESOLVES (never rejects) on timeout or spawn error, so the caller always sees whatever
 * output accumulated rather than an unhandled rejection -- mirrors `src/selfhost/ai.ts`'s `defaultSpawn`'s own
 * resolve-not-reject rationale (a killed/errored subprocess's partial output may hold the real diagnosable
 * error, e.g. an auth failure line on stderr).
 */
export declare function createRealCliSubprocessSpawn(): CliSubprocessSpawnFn;
export type ConstructProductionCodingAgentDriverOptions = {
    spawn?: CliSubprocessSpawnFn;
    query?: AgentSdkQueryFn;
    hooks?: AgentSdkHooks;
    listChangedFiles?: (cwd: string) => Promise<string[]>;
    houseRulesConfig?: HouseRulesConfig;
    houseRulesOptions?: HouseRulesOptions;
};
/**
 * Resolve `MINER_CODING_AGENT_PROVIDER` from `env` and construct a REAL, production `CodingAgentDriver` —
 * house-rule-enforced by default (#2343) via `buildHouseRulesAgentSdkHooks`, matching the same
 * automatic-enforcement guarantee `runHouseRulesEnforcedCodingAgentAttempt` gives task-level callers, but at
 * the raw driver-construction level `attempt-runner.js`'s `deps.driver` actually needs.
 *
 * The default only applies to `agent-sdk`, the one provider with a real hook-registration surface. CLI
 * subprocess providers (`claude-cli`/`codex-cli`) have none, and the engine's `createCliProvider` fails closed
 * if `hooks` is supplied at all (driver-factory.ts) -- filling the default for them here would make every CLI
 * construction throw. An explicitly-supplied `options.hooks` always wins and is forwarded as-is, so a caller
 * that deliberately asks a CLI provider to enforce hooks still gets that same fail-closed rejection.
 *
 * Fails closed (throws) when no provider is configured, or when a CLI provider is selected without a real
 * spawn available — never silently falls back to a driver that can never run.
 */
export declare function constructProductionCodingAgentDriver(env: Record<string, string | undefined>, options?: ConstructProductionCodingAgentDriverOptions): CodingAgentDriver;
