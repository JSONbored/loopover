export type RunState = "idle" | "discovering" | "planning" | "preparing";

export type RunStateWrite = {
  repoFullName: string;
  state: RunState;
  updatedAt: string;
};

export type RunStateRow = {
  repoFullName: string;
  state: RunState;
  updatedAt: string;
};

export type RunStateStore = {
  dbPath: string;
  getRunState(repoFullName: string): RunState | null;
  setRunState(repoFullName: string, state: RunState): RunStateWrite;
  listRunStates(): RunStateRow[];
  close(): void;
};

export const RUN_STATES: readonly RunState[];

export function resolveRunStateDbPath(env?: Record<string, string | undefined>): string;

export function initRunStateStore(dbPath?: string): RunStateStore;

export function getRunState(repoFullName: string): RunState | null;

export function setRunState(repoFullName: string, state: RunState): RunStateWrite;

export function listRunStates(): RunStateRow[];

export function closeDefaultRunStateStore(): void;
