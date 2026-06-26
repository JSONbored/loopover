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

/** Structured analyzer output. Each analyzer fills its own key; more land as analyzers ship (#1477/#1478). */
export interface BriefFindings {
  dependency?: DependencyFinding[];
  secret?: SecretFinding[];
  license?: LicenseFinding[];
  actionPin?: ActionPinFinding[];
  installScript?: InstallScriptFinding[];
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
