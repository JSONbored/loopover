export function resolveRepoCloneBaseDir(env?: Record<string, string | undefined>): string;

export function resolveRepoCloneDir(repoFullName: string, env?: Record<string, string | undefined>): string;

export type EnsureRepoClonedResult = { ok: boolean; repoPath: string; error?: string };

export type RunGitFn = (args: string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export function ensureRepoCloned(
  repoFullName: string,
  options?: {
    baseBranch?: string;
    cloneBaseDir?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    remoteUrl?: string;
    runGit?: RunGitFn;
  },
): Promise<EnsureRepoClonedResult>;
