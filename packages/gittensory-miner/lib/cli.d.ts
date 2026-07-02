export function printVersion(input: { packageName: string; packageVersion: string }): void;
export function printHelp(input: { packageName: string }): void;
export function resolveMinerConfigDir(env?: Record<string, string | undefined>): string;
export function resolveMinerStatePath(env?: Record<string, string | undefined>): string;
export function initMinerState(env?: Record<string, string | undefined>): {
  configDir: string;
  statePath: string;
  createdConfigDir: boolean;
  createdStateFile: boolean;
};
export function inspectDoctor(env?: Record<string, string | undefined>): {
  nodeVersion: string;
  configDir: string;
  statePath: string;
  stateExists: boolean;
  stateWritable: boolean;
  dockerPresent: boolean;
};
export function runCli(cliArgs: string[], input: { packageName: string }): number;
