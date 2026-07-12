/**
 * Resolve `<NAME>_FILE` secret-file indirection into `<NAME>` in place (fleet-mode Docker/Swarm/K8s secret
 * mounts). An explicit plain `<NAME>` wins over `<NAME>_FILE`; an unreadable `_FILE` path throws. The secret
 * value is never logged or returned.
 */
export function loadFileCredentials(
  env?: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): void;
