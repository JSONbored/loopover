export interface PortfolioRepoSummary {
    apiBaseUrl: string;
    repoFullName: string;
    byStatus: {
        queued: number;
        in_progress: number;
        done: number;
    };
    total: number;
}
export interface PortfolioDashboardSummary {
    total: number;
    byStatus: {
        queued: number;
        in_progress: number;
        done: number;
    };
    repos: PortfolioRepoSummary[];
    oldestQueuedAgeMs: number | null;
}
export interface PortfolioDashboardSources {
    portfolioQueue: {
        listQueue(repoFullName?: string | null): unknown[];
    };
}
/**
 * Pure aggregator over an injected portfolio-queue store (mirrors manage-status.js's `collectManageStatus`).
 * Read-only. Returns global + per-repo status counts and, when a clock is supplied via `options.nowMs`, the age in
 * ms of the oldest still-`queued` item (null when no clock is given or nothing is queued).
 */
export declare function collectPortfolioDashboard(sources: PortfolioDashboardSources, options?: {
    nowMs?: number;
}): PortfolioDashboardSummary;
/** Plain-text render of a dashboard summary (mirrors manage-status.js's `renderManageStatusTable`). */
export declare function renderPortfolioDashboardTable(summary: PortfolioDashboardSummary | null | undefined): string;
export declare function parsePortfolioDashboardArgs(args?: string[]): {
    json: boolean;
} | {
    error: string;
};
/** CLI glue for `loopover-miner queue dashboard [--json]` (mirrors manage-status.js's `runManageStatus`). */
export declare function runPortfolioDashboard(args?: string[], options?: {
    initPortfolioQueue?: () => {
        listQueue(repoFullName: string | null): unknown[];
        close(): void;
    };
    nowMs?: number;
}): number;
