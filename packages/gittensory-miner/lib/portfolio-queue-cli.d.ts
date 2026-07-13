import type { PortfolioQueueStore, QueueEntry } from "./portfolio-queue.js";
import type { PortfolioQueueManager } from "./portfolio-queue-manager.js";

export type ParsedQueueListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
    }
  | { error: string };

export type ParsedQueueNextArgs =
  | { json: boolean; dryRun: boolean; globalWipCap: number | undefined; perRepoWipCap: number | undefined }
  | { error: string };

export type QueueClaimTarget = { repoFullName: string; identifier: string; apiBaseUrl: string };

export function selectNextEligibleTarget(
  entries: Array<{ repoFullName: string; identifier: string; apiBaseUrl: string; status: string }>,
  caps: { globalWipCap: number; perRepoWipCap: number } | null,
): QueueClaimTarget[];

export type ParsedQueueDoneArgs =
  | {
      repoFullName: string;
      identifier: string;
      dryRun: boolean;
      json: boolean;
      apiBaseUrl: string | undefined;
    }
  | { error: string };

export function parseQueueListArgs(args: string[]): ParsedQueueListArgs;

export function parseQueueNextArgs(args: string[]): ParsedQueueNextArgs;

export function parseQueueDoneArgs(args: string[]): ParsedQueueDoneArgs;

export function parseQueueReleaseArgs(args: string[]): ParsedQueueDoneArgs;

export function parseQueueRequeueArgs(args: string[]): ParsedQueueDoneArgs;

export type ParsedQueueClaimBatchArgs =
  | { json: boolean; dryRun: boolean; globalWipCap: number; perRepoWipCap: number }
  | { error: string };

export function parseQueueClaimBatchArgs(args: string[]): ParsedQueueClaimBatchArgs;

export function renderQueueTable(entries: QueueEntry[]): string;

export function runQueueList(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;

export function runQueueNext(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;

export function runQueueDone(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;

export function runQueueRelease(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;

export function runQueueRequeue(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;

export function runQueueClaimBatch(
  args: string[],
  options?: { initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager },
): number;

export const QUEUE_ITEMS: string;
export const QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS: string;

export function renderPortfolioQueueMetrics(
  queueEntries: Array<{ status: string }>,
  leaseEntries: Array<{ leasedAt: string | null }>,
  nowMs: number,
): string;

export function runQueueMetrics(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore; nowMs?: number },
): number;

export function runQueueCli(
  subcommand: string | undefined,
  args: string[],
  options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
    initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager;
  },
): number;
