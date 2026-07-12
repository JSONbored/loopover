export function parsePrNumberFromExecResult(
  execResult: { stdout?: string | undefined; code?: number | null | undefined; timedOut?: boolean | undefined } | null | undefined,
  repoFullName: string,
): number | null;
