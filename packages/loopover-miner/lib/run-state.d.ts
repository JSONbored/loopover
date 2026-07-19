export type RunState = "idle" | "discovering" | "planning" | "preparing";
export type RunStateWrite = {
    apiBaseUrl: string;
    repoFullName: string;
    state: RunState;
    updatedAt: string;
};
export type RunStateRow = {
    apiBaseUrl: string;
    repoFullName: string;
    state: RunState;
    updatedAt: string;
};
export type RunStateStore = {
    dbPath: string;
    getRunState(repoFullName: string, apiBaseUrl?: string): RunState | null;
    setRunState(repoFullName: string, state: RunState, apiBaseUrl?: string): RunStateWrite;
    listRunStates(): RunStateRow[];
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export declare const RUN_STATES: readonly RunState[];
export declare function resolveRunStateDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the 100% local/client-side miner run-state store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents. (#2289, #5563)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema migrations / purge still use the underlying DatabaseSync until those helpers are migrated.
 * Public API stays synchronous so loop/CLI/MCP callers need no async cascade in this part-1 slice.
 */
export declare function initRunStateStore(dbPath?: string): RunStateStore;
export declare function getRunState(repoFullName: string, apiBaseUrl?: string): RunState | null;
export declare function setRunState(repoFullName: string, state: RunState, apiBaseUrl?: string): RunStateWrite;
export declare function listRunStates(): RunStateRow[];
export declare function closeDefaultRunStateStore(): void;
