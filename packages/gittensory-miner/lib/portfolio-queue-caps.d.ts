export function resolvePortfolioQueueCaps(options?: {
  env?: NodeJS.ProcessEnv;
  cliCaps?: { globalWipCap?: number; perRepoWipCap?: number };
}): { globalWipCap: number; perRepoWipCap: number };
