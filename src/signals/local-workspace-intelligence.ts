import type { LocalBranchAnalysis, LocalBranchAnalysisInput, LocalBranchChangedFile, LocalBranchValidation } from "./local-branch";
import { isTestPath } from "./test-evidence";
import { sanitizeLocalScorerWarnings } from "./local-scorer-diagnostics";

export type LocalWorkspaceIntelligence = {
  version: 2;
  sourceUpload: {
    enabled: false;
    detail: string;
  };
  branch: {
    name?: string | undefined;
    baseRef?: string | undefined;
    headSha?: string | undefined;
    pendingCommitCount: number;
  };
  changedFiles: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    binary: number;
    paths: string[];
  };
  testEvidence: {
    level: "test_files" | "validation_commands" | "both" | "none";
    testFileCount: number;
    passedValidationCount: number;
    commands: LocalBranchValidation[];
  };
  linkedIssues: number[];
  baseFreshness: LocalBranchAnalysis["baseFreshness"];
  ciStatusHints: string[];
  localScorerDiagnostics?: {
    mode: string;
    activeModel?: string | undefined;
    warnings: string[];
    metadataOnly: boolean;
  };
  blockers: {
    branchQuality: string[];
    accountState: string[];
  };
  rerunWhen: string;
};

export function buildLocalWorkspaceIntelligence(args: {
  input: LocalBranchAnalysisInput;
  analysis: Pick<
    LocalBranchAnalysis,
    "baseFreshness" | "branchQualityBlockers" | "accountStateBlockers" | "recommendedRerunCondition" | "prPacket"
  >;
  changedFiles: LocalBranchChangedFile[];
}): LocalWorkspaceIntelligence {
  const validation = args.input.validation ?? [];
  const testFileCount = args.changedFiles.filter((file) => isTestPath(file.path)).length;
  const passedValidationCount = validation.filter((entry) => entry.status === "passed").length;
  const hasTestFiles = testFileCount > 0;
  const hasValidation = passedValidationCount > 0;
  const testEvidenceLevel = hasTestFiles && hasValidation ? "both" : hasTestFiles ? "test_files" : hasValidation ? "validation_commands" : "none";
  const scorer = args.input.localScorer;

  return {
    version: 2,
    sourceUpload: {
      enabled: false,
      detail: "Local workspace intelligence uses git metadata and optional local scorer output only; source contents are not uploaded.",
    },
    branch: {
      ...(args.input.branchName ? { name: args.input.branchName } : {}),
      ...(args.input.baseRef ? { baseRef: args.input.baseRef } : {}),
      ...(args.input.headSha ? { headSha: args.input.headSha } : {}),
      pendingCommitCount: nonNegative(args.input.pendingCommitCount),
    },
    changedFiles: summarizeChangedFiles(args.changedFiles),
    testEvidence: {
      level: testEvidenceLevel,
      testFileCount,
      passedValidationCount,
      commands: validation,
    },
    linkedIssues: [...(args.input.linkedIssues ?? [])].sort((left, right) => left - right),
    baseFreshness: args.analysis.baseFreshness,
    ciStatusHints: [...(args.input.ciStatusHints ?? [])],
    ...(scorer
      ? {
          localScorerDiagnostics: {
            mode: scorer.mode,
            ...(scorer.activeModel ? { activeModel: scorer.activeModel } : {}),
            warnings: sanitizeLocalScorerWarnings(scorer.warnings),
            metadataOnly: scorer.mode === "metadata_only",
          },
        }
      : {}),
    blockers: {
      branchQuality: args.analysis.branchQualityBlockers,
      accountState: args.analysis.accountStateBlockers,
    },
    rerunWhen: args.analysis.recommendedRerunCondition,
  };
}

function summarizeChangedFiles(files: LocalBranchChangedFile[]): LocalWorkspaceIntelligence["changedFiles"] {
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, binary: 0 };
  for (const file of files) {
    if (file.binary) counts.binary += 1;
    if (file.status === "added") counts.added += 1;
    else if (file.status === "deleted") counts.deleted += 1;
    else if (file.status === "renamed" || file.status === "copied" || file.previousPath) counts.renamed += 1;
    else counts.modified += 1;
  }
  return {
    total: files.length,
    ...counts,
    paths: files.slice(0, 12).map((file) => formatChangedPath(file)),
  };
}

function formatChangedPath(file: LocalBranchChangedFile): string {
  const path = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
  return `${path} (${file.status ?? "modified"}${file.binary ? ", binary" : ""})`;
}

function nonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
