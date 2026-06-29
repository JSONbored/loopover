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
  /** Short-lived broker token for OSV/license/history fetches. Never logged. */
  githubToken?: string;
  budget?: { timeoutMs?: number; maxBriefChars?: number };
  analyzers?: string[];
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

/** Structured analyzer output. Each analyzer fills its own key; more land as analyzers ship (#1477/#1478). */
export interface BriefFindings {
  dependency?: DependencyFinding[];
  lockfileDrift?: LockfileDriftFinding[];
  secret?: SecretFinding[];
  license?: LicenseFinding[];
  actionPin?: ActionPinFinding[];
  installScript?: InstallScriptFinding[];
  eol?: EolFinding[];
  redos?: RedosFinding[];
  provenance?: ProvenanceFinding[];
  codeowners?: CodeownersFinding[];
  secretLog?: SecretLogFinding[];
  assetWeight?: AssetWeightFinding[];
  typosquat?: TyposquatFinding[];
  nativeBuild?: NativeBuildFinding[];
}

export type AnalyzerStatus = "ok" | "degraded" | "skipped";

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
  findings: BriefFindings;
  promptSection: string;
  systemSuffix: string;
}
