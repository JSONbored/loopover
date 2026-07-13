export function resolvePortfolioQueueCaps(options?: {
  env?: Record<string, string | undefined>;
  cliCaps?: { globalWipCap?: number; perRepoWipCap?: number };
}): { globalWipCap: number; perRepoWipCap: number };
