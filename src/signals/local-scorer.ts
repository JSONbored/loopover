import { isCodeFile, isTestFile, type LocalBranchChangedFile, type LocalBranchScorer, type LocalBranchValidation } from "./local-branch";

// #782 deterministic local scorer. Replicates the gittensor-root token-scoring view from changed-file METADATA
// (paths + line counts) — never source content, so the no-upload boundary holds and it runs in every surface
// (stdio package AND hosted Worker). It mirrors buildScorePreview's source/test/non-code classification, so
// feeding its output back in as `localScorer` (mode external_command) flips the preview off metadata-only with
// numbers it would otherwise have derived itself — closing the "miner runs the scorer manually" gap.

const fileLines = (file: LocalBranchChangedFile): number => Math.max(0, file.additions ?? 0) + Math.max(0, file.deletions ?? 0);

/**
 * Compute token scores from changed-file metadata + the local validation results. `isCodeFile` already excludes
 * tests, so source / test / non-code are disjoint. Binary files carry no token value and are dropped. A failed
 * validation does not change the scores (they describe the diff) but is surfaced as a warning. Pure.
 */
export function computeLocalScorerTokens(input: { changedFiles: LocalBranchChangedFile[]; validation?: LocalBranchValidation[] | undefined }): LocalBranchScorer {
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
