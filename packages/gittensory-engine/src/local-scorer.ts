import { isTestPath } from "./test-evidence.js";

// Shapes mirrored from `src/signals/local-branch.ts` — types only, no cross-package import (#2277).
export type LocalBranchChangedFile = {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
  binary?: boolean | undefined;
};

export type LocalBranchValidation = {
  command: string;
  status: "passed" | "failed" | "not_run" | "skipped" | "focused" | "unknown";
  summary?: string | undefined;
  durationMs?: number | undefined;
  exitCode?: number | undefined;
};

export type LocalBranchScorer = {
  mode: "metadata_only" | "external_command" | "gittensor_root";
  activeModel?: string | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  warnings?: string[] | undefined;
};

function isTestFile(file: string): boolean {
  return isTestPath(file);
}

/** Mirrors `src/signals/path-matchers.ts` `isCodeFile` for metadata-only local scoring. */
function isCodeFile(file: string): boolean {
  return (
    /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs|kt|scala|java|go|sql|cs|swift|groovy|php|cpp|cc|c|h|hpp|m|vue|svelte|astro|dart)$/i.test(
      file,
    ) && !isTestFile(file)
  );
}

const fileLines = (file: LocalBranchChangedFile): number => Math.max(0, file.additions ?? 0) + Math.max(0, file.deletions ?? 0);

/**
 * Compute token scores from changed-file metadata + the local validation results. `isCodeFile` already excludes
 * tests, so source / test / non-code are disjoint. Binary files carry no token value and are dropped. A failed
 * validation does not change the scores (they describe the diff) but is surfaced as a warning. Pure.
 */
export function computeLocalScorerTokens(input: {
  changedFiles: LocalBranchChangedFile[];
  validation?: LocalBranchValidation[] | undefined;
}): LocalBranchScorer {
  const files = input.changedFiles.filter((file) => !file.binary);
  const testTokenScore = files.filter((file) => isTestFile(file.path)).reduce((sum, file) => sum + fileLines(file), 0);
  const sourceTokenScore = files.filter((file) => isCodeFile(file.path)).reduce((sum, file) => sum + fileLines(file), 0);
  const totalTokenScore = files.reduce((sum, file) => sum + fileLines(file), 0);
  const nonCodeTokenScore = Math.max(0, totalTokenScore - sourceTokenScore - testTokenScore);
  const failed = (input.validation ?? []).some((entry) => entry.status === "failed");
  const warnings = failed ? ["Local validation reported failures — token scores describe the diff, not a passing build."] : [];
  return {
    mode: "external_command",
    activeModel: "gittensory-deterministic",
    sourceTokenScore,
    totalTokenScore,
    sourceLines: Math.max(1, sourceTokenScore || totalTokenScore || 1),
    testTokenScore,
    nonCodeTokenScore,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
