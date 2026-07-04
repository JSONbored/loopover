// Shared contract types for the review-enrichment service (REES). Kept separate from server.ts so analyzers and
// the orchestrator can import them without a circular dependency through the HTTP layer.

/** Engine → service request. The engine already has the diff + files, so the service needs NO repo checkout. */
export interface EnrichRequest {
  repoFullName: string;
  prNumber: number;
  headSha?: string;
  baseSha?: string;
  title?: string;
  body?: string;
  author?: string;
  files?: Array<{
    path: string;
    status?: string;
    previousPath?: string;
    patch?: string;
    additions?: number;
    deletions?: number;
  }>;
  diff?: string;
  /** Optional GitHub read token for GitHub-backed analyzers. Never logged. */
  githubToken?: string;
  /** The PR's linked issue, resolved engine-side and passed in the envelope so the history analyzer can judge
   *  whether the diff covers the issue's stated requirement without an extra fetch. Absent ⇒ alignment omitted. (#1478) */
  linkedIssue?: EnrichLinkedIssue;
  budget?: { timeoutMs?: number; maxBriefChars?: number };
  profile?: ReesProfileName;
  analyzers?: string[];
}

export type ReesProfileName = "fast" | "balanced" | "deep";

/** A PR's linked issue, as carried in the request envelope. `title`/`body` hold the stated requirement the history
 *  analyzer measures the diff against; only the number is mandatory. (#1478) */
export interface EnrichLinkedIssue {
  number: number;
  title?: string;
  body?: string;
}

/** A known vulnerability for a dependency version, sourced from OSV.dev. */
export interface Cve {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  summary: string;
  fixedIn: string | null;
}

/** One added/changed dependency that carries at least one known vulnerability. */
export interface DependencyFinding {
  ecosystem: string;
  package: string;
  from: string | null;
  to: string;
  direction: "add" | "change";
  cves: Cve[];
}

/** A vulnerable lockfile-only dependency resolution. The package was not changed in a top-level manifest diff,
 *  so it is treated as transitive lockfile drift and reported with the lockfile location that introduced it. */
export interface LockfileDriftFinding {
  file: string;
  line: number;
  ecosystem: "npm" | "PyPI";
  package: string;
  from: string | null;
  to: string;
  direction: "add" | "change";
  cves: Cve[];
}

/** A potential leaked credential. Value-redacted by construction — only the location + kind are ever reported. */
export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  confidence: "high" | "medium";
}

/** A newly-added/upgraded dependency whose license warrants a compatibility check. */
export interface LicenseFinding {
  ecosystem: string;
  package: string;
  version: string;
  licenses: string[];
  classification: "copyleft" | "unknown";
}

/** A newly-added/upgraded npm dependency version that runs install lifecycle scripts (supply-chain risk). */
export interface InstallScriptFinding {
  package: string;
  version: string;
  hooks: string[];
  publishedAt: string | null;
}

/** A newly-added/upgraded npm package that is materially heavy but only directly imported/required a few times
 *  in the changed lines. Size values are package-service bytes and are nullable when that service omits one. */
export interface HeavyDependencyFinding {
  ecosystem: "npm";
  package: string;
  version: string;
  from: string | null;
  direction: "add" | "change";
  usageCount: number;
  usageLocations: Array<{ file: string; line: number }>;
  installSizeBytes: number | null;
  bundleSizeBytes: number | null;
  gzipSizeBytes: number | null;
  dependencyCount: number | null;
}

/** A third-party GitHub Action referenced by a mutable tag/branch instead of a pinned commit SHA. */
export interface ActionPinFinding {
  file: string;
  line: number;
  action: string;
  ref: string;
}

/** A runtime/base-image/engine pinned to a release that is past end-of-support (or EOL within 90 days). */
export interface EolFinding {
  file: string;
  product: string;
  version: string;
  eol: string;
  status: "eol" | "soon";
}

/** A regex literal introduced by the PR that is vulnerable to catastrophic backtracking (ReDoS). Reports the
 *  location + the (truncated) vulnerable pattern only — never any matched value. */
export interface RedosFinding {
  file: string;
  line: number;
  kind: "nested-quantifier";
  pattern: string;
}

/** A newly-added dependency (npm/PyPI) lacking a published provenance attestation, or a binary/vendored file
 *  committed without auditable source — supply-chain integrity risks the no-checkout reviewer cannot verify. */
export interface ProvenanceFinding {
  kind: "no-attestation" | "binary" | "vendored";
  /** Ecosystem — set for no-attestation findings. */
  ecosystem?: string;
  /** Package name — set for no-attestation findings. */
  package?: string;
  /** Resolved version — set for no-attestation findings. */
  version?: string;
  /** File path — set for binary and vendored findings. */
  file?: string;
}

/** A changed file governed by a CODEOWNERS rule where the PR author is not listed as an owner (#1515).
 *  The blast radius (distinct ownership domains crossed) is derived at render time from the full findings set. */
export interface CodeownersFinding {
  file: string;
  owners: string[]; // sorted owners from the last-matching CODEOWNERS rule; always non-empty
}

/** An added line that passes sensitive data into a logging/stdout sink (a secret, PII, or a dumped request
 *  object). Reports the location + sink + category only — never the logged value. */
export interface SecretLogFinding {
  file: string;
  line: number;
  sink: string;
  category: "secret" | "pii" | "request-object";
}

/** A heavy binary asset the PR adds or grows. `bytes` is the size at headSha; `deltaBytes` is the growth vs base
 *  (equal to `bytes` for a newly-added file). */
export interface AssetWeightFinding {
  path: string;
  bytes: number;
  deltaBytes: number;
  status: "added" | "grown";
}

/** A newly-added dependency whose name is a near-miss of a popular package (typosquat) or an unscoped name that
 *  is not published on the public registry and is therefore publicly claimable (dependency-confusion). Reports
 *  the package name + the reason only — never the manifest contents. (#1501) */
export interface TyposquatFinding {
  ecosystem: string;
  package: string;
  version: string;
  kind: "typosquat" | "confusion";
  /** The popular package the name is a near-miss of — set for `typosquat` findings. */
  similarTo?: string;
  /** Damerau-Levenshtein distance to `similarTo` — set for edit-distance `typosquat` findings (0 = homoglyph/separator). */
  distance?: number;
  /** Short, public-safe explanation of why the name was flagged. */
  reason: string;
}

/** A head commit whose signature/author provenance warrants scrutiny: an unsigned/unverified-signature head, an
 *  author/committer login mismatch, or a never-before-seen committer in a repo that otherwise has verified history
 *  — supply-chain/impersonation signals the no-checkout reviewer cannot derive. Surfaces ONLY the public GitHub
 *  verification verdict (`verified` + `reason`) and boolean provenance flags — never tokens, emails, or identities
 *  beyond the public commit author login GitHub already exposes. (#1517) */
export interface CommitSignatureFinding {
  /** GitHub's signature verification verdict for the head commit. */
  verified: boolean;
  /** GitHub's machine-readable verification reason (e.g. `unsigned`, `valid`, `unknown_key`). Public-safe string. */
  reason: string;
  /** The head commit author's GitHub login, when GitHub resolves one — public, already shown on the PR. */
  authorLogin?: string;
  /** True when the commit author login differs from the committer login (a potential authorship mismatch). */
  authorMismatch: boolean;
  /** True when the author login has no prior verified commit in a repo that otherwise carries verified history. */
  newCommitter: boolean;
}

/** A static IaC / config misconfiguration introduced by the PR. Reports the location + rule only. */
export interface IacMisconfigFinding {
  file: string;
  line: number;
  kind:
    | "wildcard-cors-credentials"
    | "open-ingress"
    | "public-bucket"
    | "insecure-cookie"
    | "tls-verification-disabled"
    | "prod-debug"
    | "hardcoded-service-url"
    | "privileged-container"
    | "privilege-escalation"
    | "host-pid-namespace"
    | "host-ipc-namespace"
    | "run-as-root"
    | "run-as-root-uid"
    | "writable-root-filesystem"
    | "unmasked-proc-mount"
    | "unencrypted-storage"
    | "publicly-accessible-database"
    | "imdsv1-allowed"
    | "world-writable-permissions";
}

/** A newly-added dependency whose install compiles native code (npm node-gyp addon) or has no prebuilt wheel
 *  (PyPI sdist-only) — a hidden CI cold-start/install cost and a frequent cross-platform breakage source. Reports
 *  package@version + the factual build property only. (#1512) */
export interface NativeBuildFinding {
  ecosystem: string;
  package: string;
  version: string;
  kind: "native-addon" | "sdist-only";
  /** npm only: a prebuilt-binary path exists (node-pre-gyp/prebuild or a `binary` field), so a compile is the
   *  fallback when no prebuilt matches the platform/ABI rather than guaranteed. */
  prebuiltFallback?: boolean;
  /** Short, public-safe explanation of the build cost. */
  reason: string;
}

/** Public-safe historical context the no-checkout reviewer is blind to and the engine deliberately does NOT compute:
 *  the author's track record IN THIS repo, past PRs that already changed the same files (with their outcome), and
 *  whether the diff covers the linked issue's stated requirement. Surfaced as a single block (0-or-1 element array).
 *  Carries ONLY public GitHub facts — never the engine's internal submitter reputation, trust, reward, or score. (#1478) */
export interface HistoryFinding {
  /** Author track record in THIS repo. `null` when no token/author was available to query the GitHub API. */
  author: {
    /** Prior PRs by this author in this repo; `null` when the GitHub Search lookup failed / was unavailable. */
    priorMergedInRepo: number | null;
    priorClosedInRepo: number | null;
    accountAgeDays: number | null;
    /** `true`/`false` ONLY when both PR-count lookups succeeded; `null` when a count was unavailable (never guessed). */
    firstTimeContributor: boolean | null;
  } | null;
  /** Past PRs that already changed the same files, with the outcome of each and the overlapping paths. */
  similarPastPrs: Array<{
    number: number;
    title: string;
    outcome: "merged" | "reverted";
    overlapPaths: string[];
  }>;
  /** Whether the diff covers the linked issue's stated requirement. `null` when the PR has no linked issue. */
  linkedIssueAlignment: {
    issue: number;
    statedRequirement: string;
    diffCovers: "full" | "partial" | "none";
  } | null;
  /** True when a GitHub sub-query was skipped (no token) or degraded (rate-limit/error), so the block is incomplete. */
  partial: boolean;
}

/** A changed file that is a statistical churn hotspot: many recent commits AND a high fraction of fix/revert
 *  commits, so defects historically cluster there. Counts come from the repository's public commit history within
 *  a fixed window — never file contents. (#1513) */
export interface ChurnHotspotFinding {
  file: string;
  /** Commits touching this file in the window (capped at one page; `capped` marks the cap was hit). */
  commitCount: number;
  /** Of those, how many were fix/revert/hotfix/regression commits. */
  fixCount: number;
  /** The lookback window in days. */
  windowDays: number;
  /** True when `commitCount` reached the per-page cap, so the real count is at least that. */
  capped: boolean;
}

/** For a changed file that MODIFIES or DELETES existing lines, the prior PR (or commit) that most recently touched
 *  that FILE — resolved from the path's latest base-branch commit + the commit→PR association API. This is
 *  FILE-LEVEL context (the last change to land on the file before this PR), not per-line blame: it does not claim
 *  the surfaced PR introduced any specific line. Surfaces only a PR number and a short SHA prefix, never file
 *  contents. (#2034, part of #1499) */
export interface BlameLinkFinding {
  file: string;
  /** A representative old-file line from THIS PR's change (its first modified/deleted line) — a pointer to where
   *  the change lands, NOT a line attributed to `lastTouchedByPr`. */
  line: number;
  /** The last PR to touch this file before the change, when its commit maps to one via the commit/PR-association API. */
  lastTouchedByPr?: number;
  /** Short prefix of that most-recent commit's SHA (prefix only — never the full SHA). */
  lastTouchedByShaPrefix?: string;
}

/** An export newly ADDED to a package's public entrypoint (an `index.*` barrel) that ships with no adjacent doc
 *  comment — undocumented public surface. Reports the symbol + its line only, never file contents. (#2035) */
export interface UndocumentedExportFinding {
  file: string;
  line: number;
  symbol: string;
}

/** A review/approval integrity signal, read from structured PR-reviews API fields only (state, commit_id,
 *  user.login, submitted_at) — never diff/file content. `stale-approval`: the reviewer's latest APPROVED review
 *  predates the PR's current head commit. `self-approval`: the PR author approved their own PR.
 *  `outstanding-changes-requested`: the reviewer's CURRENT (most recent) review is still CHANGES_REQUESTED, not
 *  yet superseded by a later review from the same person. */
export type ApprovalIntegrityFinding =
  | {
      reviewer: string;
      kind: "stale-approval";
      /** Short prefix of the stale review's commit SHA (prefix only — never the full SHA). */
      reviewedShaPrefix: string;
    }
  | { reviewer: string; kind: "self-approval" }
  | { reviewer: string; kind: "outstanding-changes-requested" };

/** A CI check-run signal, read from structured GitHub check-run API fields only (name, status, conclusion,
 *  started_at, completed_at) — never logs or repo content. `retried-after-failure`: the named check's latest
 *  completed run at the head commit is a success, but one or more earlier completed runs of the SAME name were
 *  not (failure/timed_out/cancelled/action_required) — it did not go green on the first try.
 *  `long-running-check`: a single completed run whose wall-clock duration crossed a fixed threshold. */
export type CiCheckSignalFinding =
  | { checkName: string; kind: "retried-after-failure"; failedAttempts: number }
  | { checkName: string; kind: "long-running-check"; durationMinutes: number };

/** A PR whose head is significantly behind the repo's CURRENT default branch, read from structured GitHub repo
 *  (`default_branch`) and compare (`behind_by`) API fields only — never diff/file content. A branch far behind
 *  is more likely to hide a subtle semantic conflict a clean `mergeable` check alone would miss. */
export interface StaleBranchFinding {
  defaultBranch: string;
  behindBy: number;
}

/** Structured analyzer output. Each analyzer fills its own key; more land as analyzers ship (#1477/#1478). */
export interface BriefFindings {
  dependency?: DependencyFinding[];
  lockfileDrift?: LockfileDriftFinding[];
  secret?: SecretFinding[];
  license?: LicenseFinding[];
  actionPin?: ActionPinFinding[];
  installScript?: InstallScriptFinding[];
  heavyDependency?: HeavyDependencyFinding[];
  eol?: EolFinding[];
  redos?: RedosFinding[];
  provenance?: ProvenanceFinding[];
  codeowners?: CodeownersFinding[];
  secretLog?: SecretLogFinding[];
  assetWeight?: AssetWeightFinding[];
  typosquat?: TyposquatFinding[];
  commitSignature?: CommitSignatureFinding[];
  iacMisconfig?: IacMisconfigFinding[];
  nativeBuild?: NativeBuildFinding[];
  history?: HistoryFinding[];
  docCommentDrift?: DocCommentDriftFinding[];
  duplication?: DuplicationFinding[];
  churnHotspot?: ChurnHotspotFinding[];
  blameLink?: BlameLinkFinding[];
  approvalIntegrity?: ApprovalIntegrityFinding[];
  ciCheckSignals?: CiCheckSignalFinding[];
  undocumentedExport?: UndocumentedExportFinding[];
  staleBranch?: StaleBranchFinding[];
}

/** A JSDoc/TSDoc block whose `@param` tags name parameters the adjacent function no longer declares — a
 *  verifiable doc-vs-signature drift the PR introduced by changing the signature. Reports the function name +
 *  the stale parameter names + location only. Functions with destructured/ambiguous params are skipped (so the
 *  param set is always confidently enumerable). (#1519) */
export interface DocCommentDriftFinding {
  file: string;
  line: number;
  symbol: string;
  /** `@param` names documented but absent from the function's actual parameter list. */
  staleParams: string[];
}

/** Added code that is a near-verbatim duplicate of a contiguous block already present elsewhere in the repo — a
 *  copy-paste the no-checkout reviewer cannot see, where importing the existing implementation is usually better.
 *  Reports the head location, the matching source location, and the matched line count only — never the code. (#1520) */
export interface DuplicationFinding {
  /** Path of the changed file that ADDED the duplicated block. */
  file: string;
  /** New-file line where the duplicated run begins in the changed file. */
  line: number;
  /** Path of the existing repo file that already contains the same block. */
  sourceFile: string;
  /** 1-based line where the run begins in the existing source file. */
  sourceLine: number;
  /** Number of contiguous significant lines that matched verbatim (after whitespace normalization). */
  lines: number;
}

export type AnalyzerStatus = "ok" | "degraded" | "skipped" | "capped" | "timeout";

/** Internal, public-safe analyzer diagnostics for Sentry. Never attach request bodies, diffs, tokens, or raw prompts. */
export interface AnalyzerDiagnostics {
  phase?: string;
  subcall?: string;
  partialStatus?: "complete" | "partial";
  partialReason?: string;
  githubEndpointCategory?: string;
  endpointCategory?: string;
  externalFailureReason?: string;
  externalElapsedMs?: number;
  fileLookupCount?: number;
  commitLookupCount?: number;
  prLookupCount?: number;
  skippedFileCount?: number;
  capped?: boolean;
  cacheHits?: number;
  cacheMisses?: number;
  externalCallsByCategory?: Record<string, number>;
  skippedWorkByCategory?: Record<string, number>;
  cappedWorkByCategory?: Record<string, number>;
  analysisElapsedMs?: number;
  captureDegradation?: boolean;
}

export interface AnalyzerMetricsDiagnostics {
  cacheHits: number;
  cacheMisses: number;
  externalCallsByCategory: Record<string, number>;
  skippedWorkByCategory: Record<string, number>;
  cappedWorkByCategory: Record<string, number>;
  analysisElapsedMs: number;
}

/** Service → engine response. `promptSection` is spliced verbatim; `findings` is the structured backing data. */
export interface ReviewBrief {
  schemaVersion: 1;
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  generatedAtIso: string;
  elapsedMs: number;
  partial: boolean;
  analyzerStatus: Record<string, AnalyzerStatus>;
  telemetry: ReviewBriefTelemetry;
  findings: BriefFindings;
  promptSection: string;
  systemSuffix: string;
}

export interface ReviewBriefTelemetry {
  profile: ReesProfileName;
  responseReserveMs: number;
  requestedAnalyzers: string[];
  analyzerCount: {
    requested: number;
    runnable: number;
    skipped: number;
  };
  analyzers: Record<string, AnalyzerTelemetry>;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  externalCallsByCategory: Record<string, number>;
  skippedWorkByCategory: Record<string, number>;
  cappedWorkByCategory: Record<string, number>;
  elapsedMs: number;
}

export interface AnalyzerTelemetry {
  status: AnalyzerStatus;
  elapsedMs: number;
  timeoutMs?: number;
  costClass?: string;
  partialStatus?: "complete" | "partial";
  partialReason?: string;
  skipReason?: string;
  capped?: boolean;
}
