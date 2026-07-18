export function resolveRepoCloneBaseDir(env?: Record<string, string | undefined>): string;

export function resolveRepoCloneDir(repoFullName: string, env?: Record<string, string | undefined>): string;

export const REPO_SEGMENT_PATTERN: RegExp;

export function isPathTraversalSegment(segment: string): boolean;

export function isValidRepoSegment(segment: unknown): boolean;

export type EnsureRepoClonedResult = { ok: boolean; repoPath: string; error?: string };

export type RunGitFn = (args: string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export type RepoCloneLockOptions = {
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
  nowMs?: () => number;
  lockSleep?: (ms: number) => Promise<unknown>;
  isProcessAlive?: (pid: number) => boolean;
  openLock?: (lockPath: string) => number;
  writeLock?: (fd: number, data: string) => void;
};

export function isRepoCloneLockStale(
  lockPath: string,
  nowMs: number,
  staleMs: number,
  isAlive?: (pid: number) => boolean,
): boolean;

export function acquireRepoCloneLock(repoPath: string, options?: RepoCloneLockOptions): Promise<() => void>;

export function ensureRepoCloned(
  repoFullName: string,
  options?: {
    baseBranch?: string;
    cloneBaseDir?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    remoteUrl?: string;
    runGit?: RunGitFn;
  } & RepoCloneLockOptions,
): Promise<EnsureRepoClonedResult>;
