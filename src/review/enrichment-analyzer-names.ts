// Canonical REES enrichment-analyzer name registry (#2050). The single source of truth for the analyzer keys that
// both the operator `REES_ANALYZERS` env list and the per-repo `.gittensory.yml` `review.enrichment` toggles are
// validated against. A leaf module with no imports, so the review wiring and the signals-layer manifest parser can
// share it without a heavy or circular dependency.

export const REES_ANALYZER_NAMES = [
  "dependency",
  "lockfileDrift",
  "secret",
  "license",
  "installScript",
  "heavyDependency",
  "hardcodedUrl",
  "actionPin",
  "eol",
  "redos",
  "provenance",
  "codeowners",
  "secretLog",
  "assetWeight",
  "typosquat",
  "commitSignature",
  "iacMisconfig",
  "nativeBuild",
  "history",
  "docCommentDrift",
  "duplication",
  "errorSwallow",
  "churnHotspot",
  "blameLink",
  "approvalIntegrity",
  "ciCheckSignals",
  "undocumentedExport",
  "staleBranch",
  "commitHygiene",
  "pendingReviewRequests",
  "testRatio",
  "migrationSafety",
  "looseRange",
  "terminology",
  "todoMarker",
  "magicNumber",
  "conflictMarker",
  "debugLeftover",
  "commitLint",
] as const;

export type ReesAnalyzerName = (typeof REES_ANALYZER_NAMES)[number];

export const REES_ANALYZER_NAME_SET: ReadonlySet<string> = new Set<string>(REES_ANALYZER_NAMES);
