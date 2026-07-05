import type { PortfolioQueueStore, QueueEntry } from "./portfolio-queue.js";

export type ParsedQueueListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
    }
  | { error: string };

export type ParsedQueueNextArgs = { json: boolean } | { error: string };

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

export function runQueueCli(
  subcommand: string | undefined,
  args: string[],
  options?: { initPortfolioQueue?: () => PortfolioQueueStore },
): number;
