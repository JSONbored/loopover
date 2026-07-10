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
  env?: Record<string, string | undefined>;
  resolveDockerPath?: () => string | null;
}): DoctorCheck;

export function checkClaudeCliPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveClaudePath?: () => string | null;
}): DoctorCheck;

export function checkCodexCliPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveCodexPath?: () => string | null;
  resolveCodexAuthPath?: () => string;
}): DoctorCheck;

export function runInit(args?: string[], env?: Record<string, string | undefined>): number;
