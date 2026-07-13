import type { PortfolioQueueStore, QueueEntry } from "./portfolio-queue.js";
import type { PortfolioQueueManager } from "./portfolio-queue-manager.js";

export type ParsedQueueListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
    }
  | { error: string };

export type ParsedQueueNextArgs =
  | { json: boolean; globalWipCap?: number; perRepoWipCap?: number }
  | { error: string };

export type ParsedQueueDoneArgs =
  | {
      repoFullName: string;
      identifier: string;
      json: boolean;
    }
  | { error: string };

export function parseQueueListArgs(args: string[]): ParsedQueueListArgs;

export function parseQueueNextArgs(args: string[]): ParsedQueueNextArgs;

export function parseQueueDoneArgs(args: string[]): ParsedQueueDoneArgs;

export function parseQueueReleaseArgs(args: string[]): ParsedQueueDoneArgs;

export function parseQueueRequeueArgs(args: string[]): ParsedQueueDoneArgs;

export type ParsedQueueClaimBatchArgs =
  | { json: boolean; globalWipCap?: number; perRepoWipCap?: number }
  | { error: string };

export function parseQueueClaimBatchArgs(args: string[]): ParsedQueueClaimBatchArgs;

export function renderQueueTable(entries: QueueEntry[]): string;

export function runQueueList(
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;

export function runQueueNext(
  args: string[],
  options?: {
    env?: Record<string, string | undefined>;
    dbPath?: string;
    initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager;
  },
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
  options?: {
    env?: Record<string, string | undefined>;
    dbPath?: string;
    initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager;
  },
): number;

export function runQueueCli(
  subcommand: string | undefined,
  args: string[],
  options?: {
    env?: Record<string, string | undefined>;
    dbPath?: string;
    initPortfolioQueue?: () => PortfolioQueueStore;
    initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager;
  },
): number;
