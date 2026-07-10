export type WorktreeAllocation = {
  slotIndex: number;
  worktreePath: string;
  attemptId: string | null;
  repoFullName: string | null;
  status: "free" | "active";
  ownerPid: number | null;
  allocatedAt: string | null;
};

export type WorktreeAllocator = {
  dbPath: string;
  worktreeBaseDir: string;
  maxConcurrency: number;
  processPid: number;
  acquire(attemptId: string, repoFullName: string): WorktreeAllocation;
  release(attemptId: string): WorktreeAllocation | null;
  listSlots(): WorktreeAllocation[];
  close(): void;
};

export function resolveWorktreeAllocatorDbPath(env?: Record<string, string | undefined>): string;

export function resolveWorktreeBaseDir(env?: Record<string, string | undefined>): string;

export function isProcessAlive(pid: number): boolean;

export function openWorktreeAllocator(options?: {
  dbPath?: string;
  worktreeBaseDir?: string;
  maxConcurrency?: number;
  processPid?: number;
}): WorktreeAllocator;

export function acquireWorktree(attemptId: string, repoFullName: string): WorktreeAllocation;

export function releaseWorktree(attemptId: string): WorktreeAllocation | null;

export function closeDefaultWorktreeAllocator(): void;
