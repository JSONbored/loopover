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

export function runStatus(args?: string[], env?: Record<string, string | undefined>, cwd?: string): number;

export function runDoctorChecks(env?: Record<string, string | undefined>): DoctorCheck[];

export function runDoctor(args?: string[], env?: Record<string, string | undefined>): number;
