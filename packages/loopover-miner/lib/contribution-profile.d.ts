// ContributionProfile schema (#6795) — the shape AMS uses to represent what it has learned about a repo's
// contribution-eligibility rules, before any extraction (#6796) or `discover` wiring (#6798) is built against
// it. Grounded in the real-repo signal inventory (#6794, packages/loopover-miner/docs/ams-contribution-signal-
// inventory.md), whose findings drove three schema decisions the abstract shape would have gotten wrong:
//   1. Eligibility labels are matchers over name AND description, not a fixed name list — rust/deno/kubernetes
//      use their own taxonomies and encode the meaning in the description.
//   2. Every rule is INDEPENDENTLY absent: "absent" is a first-class confidence, distinct from "not yet
//      extracted", because signal quality varies widely WITHIN a single repo.
//   3. The linked-issue requirement is NOT a core field — it is loopover-local, absent from the rest of the
//      sample — so it lives in an optional `prBody` slot rather than the profile's spine.

/** How trustworthy a single extracted rule is. `explicit`: derived from an unambiguous, machine-readable
 *  signal (a label whose name/description states eligibility, a CONTRIBUTING line that names a required label).
 *  `inferred`: derived from a conventional-but-unstated signal (a `blocked` status label read as exclusionary).
 *  `absent`: the repo exposes no signal of this kind at all — a real, common answer (3/10 of the #6794 sample
 *  had no eligibility label), and deliberately distinct from `unknown`. */
export type ContributionSignalConfidence =
  "explicit" | "inferred" | "absent" | "unknown";

/** Where a rule was derived from, for debuggability (#6794 found the primary source differs per repo — some
 *  state rules only in agent docs, some only in labels). */
export type ContributionSignalSource =
  "labels" | "contributing_md" | "pr_template" | "agent_docs";

export interface ContributionSignalProvenance {
  source: ContributionSignalSource;
  /** Human-readable pointer to the exact signal, e.g. a label name or a doc path. Never secrets. */
  detail: string;
}

/** A matcher for an eligibility/exclusion label. Matches over the label's NAME or DESCRIPTION — #6794 found
 *  rust encodes "good first issue" semantics only in `E-easy`'s description, which a name-only match misses. */
export interface ContributionLabelMatcher {
  /** Which field the pattern tests. */
  field: "name" | "description";
  /** Case-insensitive substring the field must contain (not a regex — kept simple and auditable). */
  contains: string;
}

/** One extracted rule: its value, how confident the extractor was, and what it was derived from. `value` is
 *  `null` when `confidence` is `absent`/`unknown`, so a consumer never mistakes "no rule" for "empty rule". */
export interface ContributionSignalRule<T> {
  value: T | null;
  confidence: ContributionSignalConfidence;
  provenance: ContributionSignalProvenance[];
}

/** Optional PR-body requirements. Modelled as an optional slot rather than a spine field precisely because
 *  #6794 found the linked-issue requirement is loopover-local, not an ecosystem norm. */
export interface ContributionPrBodyRequirements {
  /** Does a PR need to reference an issue with a closing keyword (Closes/Fixes #N)? */
  requiresLinkedIssue: boolean;
}

/** The learned contribution-eligibility profile for one repo. */
export interface ContributionProfile {
  repoFullName: string;
  /** Bumped when the field set/semantics change, so a cached profile from an older extractor is detectable. */
  schemaVersion: number;
  /** ISO timestamp the profile was built. */
  generatedAt: string;
  /** Which label(s) mark an issue contributor-workable. `value` is an OR-list of matchers; `absent` when the
   *  repo exposes no eligibility label (a real outcome for 3/10 of the #6794 sample). */
  eligibilityLabels: ContributionSignalRule<ContributionLabelMatcher[]>;
  /** Which label(s) mark an issue maintainer-only / off-limits. Weaker/more inferential than eligibility per
   *  #6794 (nothing in the sample named exclusion in a label NAME), hence usually `inferred` or `absent`. */
  exclusionLabels: ContributionSignalRule<ContributionLabelMatcher[]>;
  /** Optional PR-body requirements (see the type). Absent for most repos. */
  prBody: ContributionSignalRule<ContributionPrBodyRequirements>;
  /** Overall completeness: the least-confident spine signal, so `discover` can treat a partial profile
   *  conservatively. NOT an average — one strong signal must not mask an absent one. */
  completeness: ContributionSignalConfidence;
}

/** Assignee-exclusion (e.g. "not assigned to the repo owner") is deliberately NOT a profile field: #6794 found
 *  it is not documented for most repos and is derivable from the issue's own `assignees` at query time. This
 *  type names that runtime check so the implementation issues (#6796/#6798) treat it as a live filter, not a
 *  cached rule. */
export interface ContributionAssigneeRuntimeCheck {
  /** Exclude issues assigned to any of these logins (typically the repo owner). Applied at discover time. */
  excludeAssignedLogins: string[];
}

/** A cached profile plus the metadata that governs when it is refreshed. Mirrors the miner's other local
 *  SQLite stores (policy-doc-cache.js): keyed by repo, with a TTL, because labels and docs both change. */
export interface CachedContributionProfile {
  profile: ContributionProfile;
  /** ISO timestamp the profile was written to the cache. */
  fetchedAt: string;
  /** True once `fetchedAt` is older than the store's TTL — the caller should re-extract. */
  stale: boolean;
}

export const CONTRIBUTION_PROFILE_SCHEMA_VERSION: 1;
export const CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS: readonly [
  "explicit",
  "inferred",
  "absent",
  "unknown",
];
export const CONTRIBUTION_SIGNAL_SOURCES: readonly [
  "labels",
  "contributing_md",
  "pr_template",
  "agent_docs",
];
/** Default cache TTL: 7 days. Labels/docs change slowly; a week bounds staleness without re-fetching per run. */
export const CONTRIBUTION_PROFILE_CACHE_TTL_MS: number;
/** The local SQLite store table the cache (#6797) will use, named here so the schema owns it. */
export const CONTRIBUTION_PROFILE_STORE_TABLE: "miner_contribution_profile";

/** Build an empty, fully-`absent`/`unknown` profile for a repo — the safe default before extraction has run,
 *  so `discover` treats an unprofiled repo conservatively rather than as "no restrictions". */
export function emptyContributionProfile(
  repoFullName: string,
  generatedAt: string,
): ContributionProfile;

/** The least-confident of a set of signal confidences, per the `completeness` rule (weakest wins). */
export function weakestConfidence(
  confidences: readonly ContributionSignalConfidence[],
): ContributionSignalConfidence;
