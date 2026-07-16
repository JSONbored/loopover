export type SyncLockfileWorkspace = {
  workspacePath: string;
  version: string;
};

export type SyncLockfileHooks = {
  onFailure?: (workspacePath: string) => void;
  onAlready?: (workspacePath: string, version: string) => void;
  onSynced?: (workspacePath: string, version: string) => void;
};

export type SyncLockfileResult = {
  content: string;
  changed: boolean;
  failures: string[];
};

export function syncLockfileVersions(
  content: string,
  workspaces: SyncLockfileWorkspace[],
  hooks?: SyncLockfileHooks,
): SyncLockfileResult;

export type SyncLockfileIo = {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(argv?: string[], io?: SyncLockfileIo): number;
