// #782 deterministic local scorer, extracted from src/signals/local-scorer.ts (#4253) so the published
// gittensory-mcp / gittensory-miner CLIs and the hosted Worker share one implementation. Replicates the
// gittensor-root token-scoring view from changed-file METADATA (paths + line counts) — never source content,
// so the no-upload boundary holds and it runs in every surface. It mirrors buildScorePreview's
// source/test/non-code classification, so feeding its output back in as `localScorer` (mode external_command)
// flips the preview off metadata-only with numbers it would otherwise have derived itself.
//
// The 3 dependent type shapes are narrowly duplicated here (the issue explicitly allows this) rather than
// moving the large, Node-coupled local-branch.ts; they are structurally identical to local-branch.ts's
// definitions. isCodeFile/isTestPath are the same portable classifiers local-branch.ts already delegates to.

import { isCodeFile, isTestPath } from "./signals/test-evidence.js";

export type LocalScorerChangedFile = {
  path: string;
  previousPath?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown" | undefined;
  binary?: boolean | undefined;
};

export type LocalScorerValidation = {
  command: string;
  status: "passed" | "failed" | "not_run" | "skipped" | "focused" | "unknown";
  summary?: string | undefined;
  durationMs?: number | undefined;
  exitCode?: number | undefined;
};

export type LocalScorerResult = {
  mode: "metadata_only" | "external_command" | "gittensor_root";
  activeModel?: string | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  warnings?: string[] | undefined;
};

const fileLines = (file: LocalScorerChangedFile): number => Math.max(0, file.additions ?? 0) + Math.max(0, file.deletions ?? 0);

/**
 * Compute token scores from changed-file metadata + the local validation results. `isCodeFile` already excludes
 * tests, so source / test / non-code are disjoint. Binary files carry no token value and are dropped. A failed
 * validation does not change the scores (they describe the diff) but is surfaced as a warning. Pure.
 */
export function computeLocalScorerTokens(input: { changedFiles: LocalScorerChangedFile[]; validation?: LocalScorerValidation[] | undefined }): LocalScorerResult {
  const files = input.changedFiles.filter((file) => !file.binary);
  const testTokenScore = files.filter((file) => isTestPath(file.path)).reduce((sum, file) => sum + fileLines(file), 0);
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
