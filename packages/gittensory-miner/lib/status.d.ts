export type MinerStatus = {
  package: { name: string; version: string | null };
  engine: { name: string; version: string | null };
  node: string;
  stateDir: string;
  configFile: string | null;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export function resolveMinerStateDir(env?: Record<string, string | undefined>): string;

export function collectStatus(env?: Record<string, string | undefined>, cwd?: string): MinerStatus;

export type MinerDiagnostics = MinerStatus & {
  configValid: boolean;
  engineVersionSkew: { ok: boolean; detail: string };
  presence: { docker: boolean; claudeCli: boolean; codexCli: boolean };
  doctor: { ok: boolean; checks: DoctorCheck[] };
};

export function collectMinerDiagnostics(
  env?: Record<string, string | undefined>,
  cwd?: string,
): MinerDiagnostics;

export function runStatus(args?: string[], env?: Record<string, string | undefined>, cwd?: string): number;

export function runDoctorChecks(env?: Record<string, string | undefined>): DoctorCheck[];

export function runDoctor(args?: string[], env?: Record<string, string | undefined>): number;

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
