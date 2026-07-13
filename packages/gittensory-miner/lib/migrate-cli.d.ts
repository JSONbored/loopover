export type MigrateStatus = "skipped" | "up-to-date" | "migrated" | "failed";

export type MigrateResult = {
  name: string;
  dbPath: string;
  ok: boolean;
  status: MigrateStatus;
  detail: string;
  versionBefore: number | null;
  versionAfter: number | null;
};

export type MigrateStoreDescriptor = {
  name: string;
  resolveDbPath: (env?: Record<string, string | undefined>) => string;
  open: (dbPath: string) => { close: () => void };
};

export function runMigrateChecks(
  env?: Record<string, string | undefined>,
  stores?: MigrateStoreDescriptor[],
): MigrateResult[];

export function runMigrate(args?: string[], env?: Record<string, string | undefined>): number;
