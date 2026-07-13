export const MINER_FILE_SECRET_VARS: readonly string[];

export function loadMinerFileSecrets(
  env?: Record<string, string | undefined>,
  options?: {
    readFile?: (path: string) => string;
    vars?: readonly string[];
  },
): void;
