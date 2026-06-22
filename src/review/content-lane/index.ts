// Content-lane public surface (reviewbot→gittensory convergence).
//
// The native, flag-gated content-review primitives for the two CONTENT repos — awesome-claude (a
// curated list) and metagraphed (a registry) — a different domain from gittensory's code-gate. The
// lane only runs when REVIEWBOT_CONTENT_LANE is truthy (see ./flag); flag-off the host never reaches
// these modules.
//
// PORTED so far (the deterministic core — pure or fetch-only, no engine):
//  - flag                 : REVIEWBOT_CONTENT_LANE gate
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
  DISTRIBUTION_SOURCE_HOSTS,
  TRUSTED_SOURCE_HOSTS,
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
  assessCandidateDocument,
  assessProviderDocument,
  assessFreshness,
  classifyPrScope,
  computeGrounding,
  containsSecretLikeText,
  candidateRegistryKey,
  deriveRegistryIdentityTokens,
  functionalRequired,
  isAllowedChain,
  isBaseLayerKind,
  isDirectSubmissionScope,
  isInternalAutomationBranch,
  isNonEmptyStructuredBody,
  netuidGroundingRegex,
  normalizePublicUrl,
  probeFunctionalSurface,
  registrableDomain,
  registryDedupKeys,
  registryUrls,
  surfaceMatchesRegistryIdentity,
  toCoreVerdict,
  CANDIDATE_PATTERN,
  PROVIDER_PATTERN,
  PROVIDER_ANY_PATTERN,
  ARTIFACT_PATTERN,
  DEFAULT_PUBLIC_API_BASE,
  STALE_REPO_DAYS,
  type Assessment,
  type CandidateLike,
  type FreshnessSignals,
  type GroundingSignals,
  type MetaVerdict,
  type PrScope,
  type ProviderAssessment,
  type ProviderLike,
  type ScopeResult,
  type Verdict,
} from "./registry-logic";
export {
  checkNetuidExists,
  fetchSubnetRecord,
  fetchTaostatsSubnetIdentity,
  type NetuidVerificationEnv,
  type SubnetRecord,
  type TaostatsIdentity,
} from "./netuid-verification";
