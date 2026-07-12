import type { AgentSdkHooks, AgentSdkQueryFn, CliSubprocessSpawnFn, CodingAgentDriver } from "@jsonbored/gittensory-engine";

export function createRealCliSubprocessSpawn(): CliSubprocessSpawnFn;

export type ConstructProductionCodingAgentDriverOptions = {
  spawn?: CliSubprocessSpawnFn;
  query?: AgentSdkQueryFn;
  hooks?: AgentSdkHooks;
  houseRulesConfig?: unknown;
  houseRulesOptions?: unknown;
};

export function constructProductionCodingAgentDriver(
  env: Record<string, string | undefined>,
  options?: ConstructProductionCodingAgentDriverOptions,
): CodingAgentDriver;
