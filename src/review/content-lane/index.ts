// Content-lane public surface (reviewbot→gittensory convergence).
//
// The native, flag-gated content-review primitives for the two CONTENT repos — awesome-claude (a
// curated list) and metagraphed (a registry) — a different domain from gittensory's code-gate. The
// lane only runs when GITTENSORY_REVIEW_CONTENT_LANE is truthy (see ./flag); flag-off the host never reaches
// these modules.
//
// PORTED so far (the deterministic core — pure or fetch-only, no engine):
//  - flag                 : GITTENSORY_REVIEW_CONTENT_LANE gate
//  - safe-url             : SSRF-safe URL guard (shared)
//  - scope (awesome)      : content-PR scope classification (ignore / close / deletion / review)
//  - duplicates (awesome) : duplicate-detection + protected-edit gate
//  - source-evidence (a.) : source-URL reachability gate (injectable fetch)
//  - security-scan (a.)   : embedded-secret + pipe-to-shell scan
//  - registry-logic (meta): candidate/provider gates, netuid GROUNDING, dedup keys, freshness, scope
//  - netuid-verification  : taostats + public-registry netuid identity (fail-open; taostats key optional)
//
// DEFERRED / engine-entangled (NOT ported here — see the port report): the dual-AI review
// orchestration (needs the inference adapter + the gate engine), content-RAG (Vectorize/D1/Queue),
// and the GitHub/D1 I/O orchestrators that wire these primitives into a live review.

export { isContentLaneEnabled, type ContentLaneEnv } from "./flag";
export { isSafeHttpUrl, isSafeEndpointUrl } from "./safe-url";

// awesome-claude (curated list) primitives
export {
  classifyContentFiles,
  importContentPathParts,
  touchesContentEntry,
  SUPPORTED_CONTENT_CATEGORIES,
  type ContentClassification,
  type ContentFile,
  type ContentScope,
} from "./scope";
export { AWESOME_CLAUDE_CONTENT_SPEC, type ContentRepoSpec } from "./content-repo-spec";
export {
  buildContentDuplicateReview,
  directoryIndexToSignals,
  extractContentDuplicateSignals,
  findContentDuplicateMatch,
  findStrictContentDuplicateMatch,
  findRelatedContentMatches,
  findDuplicateFrontmatterKeys,
  parseSimpleFrontmatter,
  protectedFrontmatterChanges,
  type ContentDuplicateMatch,
  type ContentDuplicateReview,
  type ContentDuplicateSignals,
  type DirectoryIndexEntry,
} from "./duplicates";
export {
  checkSubmittedSourceEvidence,
  extractSubmittedSourceUrls,
  shouldHardCloseSourceEvidence,
  sourceEvidenceCloseDecision,
  sourceEvidenceSummary,
  sourceEvidenceToDecisionEvidence,
  type SourceEvidenceDecision,
  type SourceEvidenceItem,
  type SourceEvidenceReport,
  type SubmittedSourceUrl,
} from "./source-evidence";
export {
  scanForSecrets,
  scanSubmissionContent,
  scanLinkedBodiesForSecrets,
  EXECUTABLE_CATEGORIES,
  type SecurityFinding,
  type SecretScanResult,
} from "./security-scan";

// metagraphed (registry) primitives
export {
  assessProviderDocument,
  assessSurfaceEntry,
  assessSubnetDocument,
  assessFreshness,
  classifyRegistryPrScope,
  isRegistrySubmissionScope,
  METAGRAPHED_LANE_SPEC,
  SUBNET_ENTRY_PATTERN,
  FLAT_PROVIDER_PATTERN,
  type RegistryLaneSpec,
  type RegistryPrScope,
  type RegistryScopeResult,
  computeGrounding,
  containsSecretLikeText,
  deriveRegistryIdentityTokens,
  functionalRequired,
  isAllowedChain,
  isBaseLayerKind,
  isInternalAutomationBranch,
  isNonEmptyStructuredBody,
  netuidGroundingRegex,
  normalizePublicUrl,
  probeFunctionalSurface,
  registrableDomain,
  surfaceMatchesRegistryIdentity,
  toCoreVerdict,
  ARTIFACT_PATTERN,
  DEFAULT_PUBLIC_API_BASE,
  STALE_REPO_DAYS,
  type Assessment,
  type CandidateLike,
  type FreshnessSignals,
  type GroundingSignals,
  type MetaVerdict,
  type ProviderAssessment,
  type ProviderLike,
  type Verdict,
} from "./registry-logic";
export { runSurfaceReview, diffAppendedSurfaceEntries, type SurfaceReviewInput, type SurfaceReviewResult } from "./orchestrator";
export {
  checkNetuidExists,
  fetchSubnetRecord,
  fetchTaostatsSubnetIdentity,
  type NetuidVerificationEnv,
  type SubnetRecord,
  type TaostatsIdentity,
} from "./netuid-verification";
