/** The credential env vars the miner resolves `<NAME>_FILE` secret-file indirection for (#5178). */
export const MINER_CREDENTIAL_ENV_VARS: readonly string[];

/**
 * Resolve every credential's `<NAME>_FILE` indirection into `<NAME>` on `env`, in place. An explicit plain
 * `<NAME>` wins over a companion `<NAME>_FILE`; a set `<NAME>_FILE` that is missing, unreadable, or empty
 * throws. The resolved value is never logged or returned -- only its source (env vs file) is emitted.
 */
export function loadMinerFileCredentials(
  env?: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): void;
