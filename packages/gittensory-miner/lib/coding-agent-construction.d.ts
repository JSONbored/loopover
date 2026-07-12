import type { AgentSdkQueryFn, CliSubprocessSpawnFn, CodingAgentDriver } from "@jsonbored/gittensory-engine";

export function createRealCliSubprocessSpawn(): CliSubprocessSpawnFn;

export type ConstructProductionCodingAgentDriverOptions = {
  spawn?: CliSubprocessSpawnFn;
  query?: AgentSdkQueryFn;
  houseRulesConfig?: unknown;
  houseRulesOptions?: unknown;
};

export function constructProductionCodingAgentDriver(
  env: Record<string, string | undefined>,
  options?: ConstructProductionCodingAgentDriverOptions,
): CodingAgentDriver;
