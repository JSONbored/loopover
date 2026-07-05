export type LaptopInitResult = {
  stateDir: string;
  dbPath: string;
  created: boolean;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export function resolveLaptopStateDbPath(env?: Record<string, string | undefined>): string;

export function initLaptopState(env?: Record<string, string | undefined>): LaptopInitResult;

export function checkLaptopStateSqlite(env?: Record<string, string | undefined>): DoctorCheck;

export function checkDockerPresent(options?: {
  resolveDockerPath?: () => string | null;
}): DoctorCheck;

export function runInit(args?: string[], env?: Record<string, string | undefined>): number;
