export function resolveRepoCloneBaseDir(env?: Record<string, string | undefined>): string;

export function resolveRepoCloneDir(repoFullName: string, env?: Record<string, string | undefined>): string;

export const REPO_SEGMENT_PATTERN: RegExp;

export function isPathTraversalSegment(segment: string): boolean;

export function isValidRepoSegment(segment: unknown): boolean;

export type EnsureRepoClonedResult = { ok: boolean; repoPath: string; error?: string };

export type RunGitFn = (args: string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export function parseRepoCloneLock(raw: string): { acquiredAtMs: number; pid: number | null } | null;

export function isRepoCloneLockStale(info: { acquiredAtMs: number } | null, nowMs: number, staleMs: number): boolean;

export type RepoCloneLockFs = {
  open: (path: string) => number;
  write: (fd: number, data: string) => void;
  close: (fd: number) => void;
  read: (path: string) => string;
  unlink: (path: string) => void;
};

export type RepoCloneLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fs?: RepoCloneLockFs;
};

export function acquireRepoCloneLock(lockPath: string, options?: RepoCloneLockOptions): Promise<() => void>;

export function ensureRepoCloned(
  repoFullName: string,
  options?: {
    baseBranch?: string;
    cloneBaseDir?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    remoteUrl?: string;
    runGit?: RunGitFn;
    lock?: RepoCloneLockOptions;
  },
): Promise<EnsureRepoClonedResult>;
