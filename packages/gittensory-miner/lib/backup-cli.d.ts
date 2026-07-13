export type BackupStatus = "skipped" | "backed-up" | "failed";
export type RestoreStatus = "skipped" | "restored" | "exists" | "failed";

export type BackupResult = {
  name: string;
  ok: boolean;
  status: BackupStatus;
  detail: string;
  sourcePath: string;
  destPath: string;
};

export type RestoreResult = {
  name: string;
  ok: boolean;
  status: RestoreStatus;
  detail: string;
  sourcePath: string;
  destPath: string;
};

export type BackupStoreDescriptor = {
  name: string;
  resolveDbPath: (env?: Record<string, string | undefined>) => string;
};

export function runBackupChecks(
  destDir: string,
  env?: Record<string, string | undefined>,
  stores?: BackupStoreDescriptor[],
): Promise<BackupResult[]>;

export function runRestoreChecks(
  srcDir: string,
  env?: Record<string, string | undefined>,
  force?: boolean,
  stores?: BackupStoreDescriptor[],
): RestoreResult[];

export function runBackup(args?: string[], env?: Record<string, string | undefined>): Promise<number>;

export function runRestore(args?: string[], env?: Record<string, string | undefined>): number;
