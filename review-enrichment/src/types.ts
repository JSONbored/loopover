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

/** Neutral direct-dependency inventory delta from manifest patches (#2020, part of #1499).
 *  Reports add/remove/version-change only — no CVE or registry data. */
export interface DependencyDiffFinding {
  ecosystem: string;
  package: string;
  from: string | null;
  to: string | null;
  direction: "add" | "remove" | "change";
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
  metadataCapped?: true;
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
    | "world-writable-permissions"
    | "docker-add-remote-url"
    | "docker-image-latest-tag"
    | "docker-root-user"
    | "remote-shell-pipe"
    | "insecure-download-flag"
    | "ssh-port-exposed"
    | "npm-unsafe-perm"
    | "sudo-in-build"
    | "hardcoded-build-secret"
    | "insecure-pip-index"
    | "db-ssl-disabled"
    | "git-ssl-no-verify"
    | "ssh-host-key-check-off"
    | "verify-ssl-off"
    | "validate-certs-off"
    | "tls-skip-verify"
    | "trust-all-server-certs"
    | "seccomp-unconfined-runtime"
    | "apparmor-unconfined"
    | "userns-host"
    | "ipc-host"
    | "cap-add-all"
    | "no-new-privileges-off"
    | "docker-socket-mount"
    | "hsts-disabled"
    | "referrer-policy-leak"
    | "cookie-not-httponly"
    | "coop-unsafe-none"
    | "coep-unsafe-none";
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

/** An export newly ADDED by the PR with zero non-declaration references anywhere in the repo (dead-on-arrival).
 *  Reports the symbol + its line only, never file contents. (#2025) */
export interface UnusedExportFinding {
  file: string;
  line: number;
  symbol: string;
}

/** A TS enum member or string-literal union variant newly ADDED by the PR that a previously exhaustive switch still
 *  omits. Reports the type name, added member, and optional consumer file — never full file contents. (#2028) */
export interface ExhaustivenessFinding {
  file: string;
  line: number;
  unionName: string;
  addedMember: string;
  consumerFile?: string;
}

/** A changed test file that appears in recent default-branch CI test-check failure history. Counts only — never
 *  logs or output text. (#2033) */
export interface FlakyTestFinding {
  file: string;
  recentFailures: number;
  window: string;
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

/** A commit-history hygiene signal, read from structured GitHub PR-commits API fields only (`commit.message`,
 *  `parents`) — never diff/file content beyond the already-public commit list. `merge-commit-in-history`: a
 *  commit in the PR has more than one parent (usually the base branch merged into a feature branch instead of a
 *  rebase). `fixup-commit-present`: a commit subject starts with git's own `fixup!`/`squash!` autosquash marker,
 *  meant to be squashed before merge. `unattributed-co-author`: a commit message carries a `Co-authored-by:`
 *  trailer, surfacing multi-author attribution. */
export type CommitHygieneFinding =
  | { shaPrefix: string; kind: "merge-commit-in-history" }
  | { shaPrefix: string; kind: "fixup-commit-present"; subject: string }
  | { shaPrefix: string; kind: "unattributed-co-author"; coAuthor: string };

/** A reviewer or team (`team:slug`) whose most recent `review_requested` event is still pending (no review
 *  submitted) 48+ hours later, read from structured GitHub fields only (the requested-reviewers list and the
 *  issue-timeline's `review_requested` events) — never diff/file content. */
export interface PendingReviewRequestFinding {
  reviewer: string;
  hoursPending: number;
}

/** How much test change accompanies a PR's source change, computed from `req.files` alone (path + additions) —
 *  no network, no diff/patch parsing. Emitted only when the source change is material (>= a minimum added-line
 *  floor) and the test-to-source line ratio is under a configurable threshold (#2024, part of #1499). */
export interface TestRatioFinding {
  sourceAdded: number;
  testAdded: number;
  sourceFiles: number;
  testFiles: number;
  ratio: number;
  belowThreshold: boolean;
}

/** A risky schema operation on an added migration-SQL line — a change that can break running deployments
 *  mid-rollout (#2022, part of #1499). Reports the location + rule kind only, never SQL content. */
export interface MigrationSafetyFinding {
  file: string;
  line: number;
  kind: "drop" | "rename" | "not-null-no-default" | "blocking-rewrite";
}

/** A newly-added/changed npm dependency whose version specifier is dangerously loose — a wildcard, the
 *  `latest` dist-tag, an unbounded `>=` range, or a bare major — letting any future publish flow into the
 *  next install (#2036, part of #1499). Reports the manifest location, package, raw specifier, and kind. */
export interface LooseRangeFinding {
  file: string;
  line: number;
  package: string;
  range: string;
  kind: "wildcard" | "latest" | "unbounded-gte" | "bare";
}

/** A non-inclusive term a PR added in an identifier or comment, with the suggested neutral replacement
 *  (#2031, part of #1499). Reports the location, the matched term, and the suggestion only. */
export interface TerminologyFinding {
  file: string;
  line: number;
  term: string;
  suggestion: string;
}

/** A TODO/FIXME/HACK/XXX marker a PR added in a comment — known-incomplete work shipping in the change
 *  (#2016, part of #1499). Reports the location, the tag, and an optional truncated note. */
export interface TodoMarkerFinding {
  file: string;
  line: number;
  tag: "TODO" | "FIXME" | "HACK" | "XXX";
  note?: string;
}

/** An unexplained numeric literal newly added in non-test source where a named constant would usually make intent
 *  clearer (#2018, part of #1499). Precision-first: common sentinels/scales, named constants, array indexes, and
 *  enum/member initializers are suppressed. Reports only the location and literal text. */
export interface MagicNumberFinding {
  file: string;
  line: number;
  value: string;
}

/** A leftover VCS conflict marker a PR committed in an added line — an unresolved merge/rebase artifact that
 *  must be removed (#2032, part of #1499). Reports the location + the marker shape only. */
export interface ConflictMarkerFinding {
  file: string;
  line: number;
  marker: "<<<<<<<" | "|||||||" | "=======" | ">>>>>>>";
}

/** A debugging leftover a PR added in non-test source — `debugger;`, a bare console sink, or a `print()` call
 *  (#2015, part of #1499). Distinct from secret-log (sensitive payloads); reports location + kind only. */
export interface DebugLeftoverFinding {
  file: string;
  line: number;
  kind: "debugger" | "console" | "print";
}

/** Maintainability size smell from patch structure (#2019, part of #1499).
 *  Reports estimated file length or added function body span — never source content. */
export interface SizeSmellFinding {
  file: string;
  line?: number;
  kind: "long-file" | "big-function";
  measure: number;
  threshold: number;
  name?: string;
}

/** A user-facing string literal added without the repo's i18n convention (#2029, part of #1499).
 *  Reports file and line only — never string content. */
export interface I18nFinding {
  file: string;
  line: number;
}

/** A swallowed or mishandled error/exception newly added in the diff (#2014, extended for Go + Python
 *  bare-except by #1477). Reports file, line, and kind only — never catch/handler body content. `empty-catch`:
 *  an empty JS/TS `catch`, Go `if err != nil {}`, or Python `except: pass` body. `unused-binding`: the bound
 *  exception/checked error variable is never referenced, logged, or re-thrown. `return-null`: the handler
 *  returns a bare `null`/`nil` instead of propagating the error. `bare-except`: a Python `except:` naming no
 *  exception type, which catches everything (including `SystemExit`/`KeyboardInterrupt`) regardless of body. */
export interface ErrorSwallowFinding {
  file: string;
  line: number;
  kind: "empty-catch" | "unused-binding" | "return-null" | "bare-except";
}

/** An approximate cyclomatic complexity for a newly-added function, computed from diff-visible added lines only
 *  (#1477) — `1 + a count of if/for/while/case/catch/&&/||/?? tokens` within the function's added body lines,
 *  not a whole-function true McCabe count (REES has no full-file content to walk). Distinct from deep-nesting
 *  (#2030), which measures brace NESTING depth, a readability smell, not decision-point density. Reports file,
 *  line, the detected function name, the measured complexity, and the configured threshold — never source
 *  content. */
export interface ComplexityFinding {
  file: string;
  line: number;
  name: string;
  complexity: number;
  threshold: number;
}

/** A real before/after cyclomatic-complexity delta for a function that existed BEFORE this PR too and whose body
 *  changed (#4740, part of epic #4737) -- the true-delta counterpart complexity.ts's own header comment
 *  explicitly disclaims being (that analyzer only scores NEWLY-added functions against a fixed threshold, since
 *  it normally has no full-file content). Using the shared reconstructOldContent primitive (#4739) to recover the
 *  pre-PR file text, both the reconstructed OLD and current HEAD versions are scanned with complexity.ts's OWN
 *  decision-point counting logic (unchanged, just run twice) and matched by function name. A negative `delta` is
 *  an IMPROVEMENT (the function got simpler); a positive `delta` is a regression. Reports file, the function's
 *  CURRENT (head) line, name, and both raw scores -- never source content. */
export interface ComplexityDeltaFinding {
  file: string;
  line: number;
  name: string;
  before: number;
  after: number;
  delta: number;
}

/** Deep control-flow nesting newly added in the diff (#2030, part of #1499).
 *  Reports file, line, measured depth, and threshold — never source content. */
export interface DeepNestingFinding {
  file: string;
  line: number;
  depth: number;
  threshold: number;
}

/** A promise-shaped call added without await/return/void or a same-line .then/.catch chain (#2023, part of #1499).
 *  Reports location and a truncated callee name — never full expressions. */
export interface FloatingPromiseFinding {
  file: string;
  line: number;
  call: string;
}

/** An explicit `any` annotation, `<any>` assertion, or `as any` cast newly added in a TS diff (#2017, part of #1499).
 *  Reports file, line, and kind only — never surrounding code. */
export interface UnsafeAnyFinding {
  file: string;
  line: number;
  kind: "annotation" | "cast" | "assertion";
}

/** A common accessibility regression in newly added markup (#2026, part of #1499).
 *  Reports file, line, and rule only — never string content. */
export interface A11yFinding {
  file: string;
  line: number;
  rule:
    | "img-alt"
    | "click-events-have-key-events"
    | "label-control"
    | "positive-tabindex";
}

/** An absolute HTTP(S) URL or raw IP:port endpoint hardcoded in non-test, non-config source (#2027, part of #1499).
 *  Reports location, kind, and a redacted/truncated host — never full paths or query strings. */
export interface HardcodedUrlFinding {
  file: string;
  line: number;
  kind: "http-url" | "ip-endpoint";
  host: string;
}

/** A PR commit subject that does not conform to the Conventional Commits spec (#2021, part of #1499). Reports a
 *  short SHA prefix, the subject, and the failing reason — never author/email. */
export interface CommitLintFinding {
  sha: string;
  subject: string;
  reason: "bad-type" | "missing-colon" | "too-long" | "empty";
}

/** A newly-added or upgraded direct dependency the curated list marks deprecated/unmaintained, with a maintained
 *  successor where one exists — adoption risk + future supply-chain liability (#1511, part of #1499). Reports the
 *  ecosystem, package, added version, direction, reason, and replacement only — never manifest contents. */
export interface DeprecatedDependencyFinding {
  ecosystem: string;
  package: string;
  version: string;
  direction: "add" | "change";
  replacement: string | null;
  reason: string;
}

/** Structured analyzer output. Each analyzer fills its own key; more land as analyzers ship (#1477/#1478). */
/** An exported symbol a PR removes or renames in a package public entrypoint — a semver-major break for
 *  downstream consumers shipped without a major version bump (#1510, part of #1499). Reports file, old-file line,
 *  and the removed/renamed symbol name only — never code. */
export interface ApiBreakFinding {
  file: string;
  line: number;
  symbol: string;
}

/** A changed file where the PR re-introduces added lines in a region a PRIOR revert commit removed — a signal the
 *  change may be re-treading a known-bad path that was already reverted/hot-fixed out (#1514, part of #1499).
 *  Derived from the public commit history and the revert commit's own patch: the PR's added new-file line ranges
 *  are intersected with the old-file line ranges the revert deleted in the same file. Reports the file, a
 *  re-introduced line, and a short revert commit-SHA prefix (with the reverted PR number when the revert message
 *  names one) — never file contents. */
export interface RevertRecurrenceFinding {
  file: string;
  /** New-file line where the PR's re-introduced range that overlaps the reverted region begins. */
  line: number;
  /** Short prefix of the prior revert commit's SHA (prefix only — never the full SHA). */
  revertShaPrefix: string;
  /** The PR the revert undid, when the revert message names it (`Revert "<title> (#N)"`). */
  revertedPr?: number;
}

/** Added new-file lines in a changed file that the project's OWN latest successful CI coverage report marks as
 *  executed zero times — real measured test gaps on exactly the lines this PR introduces, not a heuristic about
 *  whether tests "look" present (#1516, part of #1499). Derived from the GitHub Actions coverage artifact of the
 *  PR head commit (lcov / Istanbul `coverage-final.json` / Cobertura XML), intersected with the patch's added
 *  line numbers. Reports the file and the uncovered line numbers only — never file contents. */
export interface CoverageDeltaFinding {
  file: string;
  /** 1-based new-file line numbers among the PR's added lines the coverage report records as never executed. */
  uncoveredLines: number[];
}

/** An exported symbol the PR REMOVES (or renames away) from an INTERNAL source file that UNCHANGED in-repo files
 *  still import — a hidden cross-file compile/runtime break the no-checkout reviewer cannot see (#1509, part of
 *  #1499). Callers are resolved on the default branch via repo-scoped GitHub Code Search, filtered to files the PR
 *  did not touch, and each is CONFIRMED to genuinely import the symbol from an internal module (never a text/
 *  comment/property hit). Distinct from api-break (#1510, entrypoint→downstream) and unused-export (#2025, added→
 *  dead). Reports the removed symbol, its old-file line, and the unchanged caller file paths only — never code. */
export interface CallerImpactFinding {
  file: string;
  /** Old-file line of the removed export declaration in the changed file. */
  line: number;
  symbol: string;
  /** Unchanged in-repo files confirmed to still import the removed symbol (capped). */
  callers: string[];
}

export interface BriefFindings {
  dependency?: DependencyFinding[];
  dependencyDiff?: DependencyDiffFinding[];
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
  duplicationDelta?: DuplicationDeltaFinding[];
  churnHotspot?: ChurnHotspotFinding[];
  blameLink?: BlameLinkFinding[];
  approvalIntegrity?: ApprovalIntegrityFinding[];
  ciCheckSignals?: CiCheckSignalFinding[];
  undocumentedExport?: UndocumentedExportFinding[];
  staleBranch?: StaleBranchFinding[];
  commitHygiene?: CommitHygieneFinding[];
  pendingReviewRequests?: PendingReviewRequestFinding[];
  testRatio?: TestRatioFinding[];
  migrationSafety?: MigrationSafetyFinding[];
  looseRange?: LooseRangeFinding[];
  terminology?: TerminologyFinding[];
  todoMarker?: TodoMarkerFinding[];
  magicNumber?: MagicNumberFinding[];
  conflictMarker?: ConflictMarkerFinding[];
  debugLeftover?: DebugLeftoverFinding[];
  sizeSmell?: SizeSmellFinding[];
  floatingPromise?: FloatingPromiseFinding[];
  deepNesting?: DeepNestingFinding[];
  errorSwallow?: ErrorSwallowFinding[];
  complexity?: ComplexityFinding[];
  complexityDelta?: ComplexityDeltaFinding[];
  unsafeAny?: UnsafeAnyFinding[];
  a11y?: A11yFinding[];
  i18n?: I18nFinding[];
  unusedExport?: UnusedExportFinding[];
  exhaustiveness?: ExhaustivenessFinding[];
  flakyTest?: FlakyTestFinding[];
  hardcodedUrl?: HardcodedUrlFinding[];
  commitLint?: CommitLintFinding[];
  apiBreak?: ApiBreakFinding[];
  deprecatedDep?: DeprecatedDependencyFinding[];
  revertRecurrence?: RevertRecurrenceFinding[];
  coverageDelta?: CoverageDeltaFinding[];
  callerImpact?: CallerImpactFinding[];
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

/** The reverse of `DuplicationFinding`: a duplicate block PAIR that existed within a changed file's PRE-PR content
 *  and is no longer both present after — a consolidation/removal the no-checkout reviewer cannot see (it has no
 *  visibility into the file's past). Uses the shared `reconstructOldContent` primitive (#4739) to recover the
 *  pre-PR text, then the same chunk-normalization + suffix-automaton matcher `duplication-scan.ts` uses, so "what
 *  counts as a duplicate" stays identical between the add- and remove-detectors. Scope: per-file only — a pair
 *  split across two different files is not detected. Reports pre-PR locations + the matched line count only,
 *  never code content. (#4741) */
export interface DuplicationDeltaFinding {
  /** Path of the changed file whose pre-PR content held the now-resolved duplicate pair. */
  file: string;
  /** Pre-PR (old-content) line where the duplicate copy that is NO LONGER present in the new content began. */
  line: number;
  /** Pre-PR (old-content) line of the pair's other half. */
  duplicateOfLine: number;
  /** Number of contiguous significant lines that matched verbatim pre-PR (after whitespace normalization). */
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
