export const MAX_LOCAL_SCORER_WARNING_COUNT = 20;
export const MAX_LOCAL_SCORER_WARNING_CHARS = 1000;

export function sanitizeLocalScorerWarnings(warnings: string[] | undefined): string[] {
  if (!warnings?.length) return [];
  return warnings.slice(0, MAX_LOCAL_SCORER_WARNING_COUNT).map((warning) => warning.slice(0, MAX_LOCAL_SCORER_WARNING_CHARS));
}
