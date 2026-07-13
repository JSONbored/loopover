export type MinerDriverStatus = {
  provider: string | null;
  modelEnvVar: string | null;
  cliPresent: boolean | null;
};

export type MinerStatus = {
  package: { name: string; version: string | null };
  engine: { name: string; version: string | null };
  node: string;
  stateDir: string;
  configFile: string | null;
  driver: MinerDriverStatus;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export function resolveMinerStateDir(env?: Record<string, string | undefined>): string;

export function collectStatus(env?: Record<string, string | undefined>, cwd?: string): MinerStatus;

export function runStatus(args?: string[], env?: Record<string, string | undefined>, cwd?: string): number;

export function checkConfigContent(cwd: string, readImpl?: (path: string, encoding: "utf8") => string): DoctorCheck;

export function checkGitHubTokenPresent(env?: Record<string, string | undefined>): DoctorCheck;

export function checkCodingAgentCredential(
  env?: Record<string, string | undefined>,
  resolveAuthPath?: (env: Record<string, string | undefined>) => string,
): DoctorCheck;

export function runDoctorChecks(env?: Record<string, string | undefined>, cwd?: string): DoctorCheck[];

export function runDoctor(args?: string[], env?: Record<string, string | undefined>, cwd?: string): number;

export function readInstalledEnginePackageVersionFromPaths(
  resolvedEntry: string,
  workspacePkg: string,
  deps?: { existsSync: (path: string) => boolean; readFileSync: (path: string, encoding: "utf8") => string },
): string | null;

export function readInstalledEnginePackageVersion(): string | null;

export function readExpectedEnginePackageVersionFromPaths(
  monorepoEnginePkg: string,
  pinFile: string,
  deps?: { existsSync: (path: string) => boolean; readFileSync: (path: string, encoding: "utf8") => string },
): string | null;

export function readExpectedEnginePackageVersion(): string | null;

export function compareInstalledEngineVersion(installed: string, expected: string): -1 | 0 | 1;

export function buildEngineVersionSkewCheck(
  readInstalled?: () => string | null,
  readExpected?: () => string | null,
): DoctorCheck;

export function buildEngineVersionDisplay(readInstalled?: () => string | null): string | null;
