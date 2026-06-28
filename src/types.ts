export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JobMessage =
  | {
      type: "github-webhook";
      deliveryId: string;
      eventName: string;
      payload: GitHubWebhookPayload;
      // Set when the DLQ consumer re-drives a dead-lettered webhook back onto the lane (#1276). Bounds the
      // self-heal to a single re-drive so a genuinely-poison payload cannot loop the webhook DLQ forever.
      redriven?: boolean;
    }
  | {
      // Delayed self-poll to re-capture a PR's before/after preview once its preview deploy is live — the first
      // review captures a "loading" placeholder when the deploy isn't ready yet (capture.previewPending). Each
      // recapture re-reviews the PR; bounded by `attempt` so a never-resolving preview can't loop forever.
      type: "recapture-preview";
      deliveryId: string;
      repoFullName: string;
      prNumber: number;
      installationId: number;
      attempt: number;
    }
  | {
      // One bounded re-gate unit fanned out by the scheduled sweep (#audit-sweep-fanout): re-review + stamp a
      // single PR. Each candidate becomes its own individually-retryable, rate-limited queue message so the heavy
      // re-review work interleaves with other jobs instead of monopolizing the consumer for all 25 at once.
      type: "agent-regate-pr";
      deliveryId: string;
      repoFullName: string;
      prNumber: number;
      installationId: number;
    }
  | {
      type: "refresh-registry";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "backfill-registered-repos";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
      force?: boolean;
      mode?: "light" | "full" | "resume";
    }
  | {
      type: "backfill-repo-segment";
      requestedBy: "schedule" | "api" | "test";
      repoFullName: string;
      segment: "labels" | "open_issues" | "open_pull_requests" | "recent_merged_pull_requests";
      mode?: "light" | "full" | "resume";
      force?: boolean;
      cursor?: string;
    }
  | {
      type: "backfill-pr-details";
      requestedBy: "schedule" | "api" | "test";
      repoFullName: string;
      mode?: "light" | "full" | "resume";
      cursor?: number;
    }
  | {
      type: "refresh-installation-health";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "generate-signal-snapshots";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
    }
  | {
      type: "refresh-scoring-model";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "refresh-upstream-sources";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "build-upstream-ruleset";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "detect-upstream-drift";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "refresh-upstream-drift";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "file-upstream-drift-issues";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "build-contributor-evidence";
      requestedBy: "schedule" | "api" | "test";
      login?: string;
    }
  | {
      type: "build-contributor-decision-packs";
      requestedBy: "schedule" | "api" | "test";
      login?: string;
    }
  | {
      type: "refresh-contributor-activity";
      requestedBy: "schedule" | "api" | "test";
      login: string;
      repoFullName?: string;
    }
  | {
      type: "build-burden-forecasts";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
    }
  | {
      type: "repair-data-fidelity";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "rollup-product-usage";
      requestedBy: "schedule" | "api" | "test";
      day?: string;
      days?: number;
    }
  | {
      type: "prune-retention";
      requestedBy: "schedule" | "api" | "test";
      dryRun?: boolean;
    }
  | {
      type: "generate-weekly-value-report";
      requestedBy: "schedule" | "api" | "test";
      variant?: WeeklyValueReportVariant;
      days?: number;
    }
  | {
      // Scheduled re-gate sweep (#777). No `repoFullName` = fan-out: enqueue one per agent-configured repo.
      // With `repoFullName` = recompute the gate verdict for that repo's stale open PRs (advisory/audit only).
      type: "agent-regate-sweep";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
    }
  | {
      type: "run-agent";
      requestedBy: "api" | "mcp" | "github_comment" | "test";
      runId: string;
    }
  | {
      type: "notify-evaluate";
      requestedBy: "webhook" | "test";
      event: DetectedNotificationEvent;
    }
  | {
      type: "notify-deliver";
      requestedBy: "notify-evaluate" | "test";
      deliveryId: string;
    }
  | {
      // Convergence (ops / observability, flag-gated by GITTENSORY_REVIEW_OPS). Scan gittensory's review-outcome data
      // (gate-block ledger + recommendation/slop calibration) and emit a structured `ops_anomaly` log on drift.
      // Enqueued hourly by the cron ONLY when the flag is ON (index.ts), so flag-OFF this job never exists.
      type: "ops-alerts";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      // Convergence (self-improve / auto-tune, flag-gated by GITTENSORY_REVIEW_SELFTUNE). Run the ported
      // self-improvement loop over gittensory's review-outcome data — compute tuning recommendations,
      // SHADOW-SOAK any strictly-tightening one, and AUTO-PROMOTE it to live only after the soak window passes
      // the gate; every action is audited. TIGHTENING-ONLY. Enqueued hourly by the cron ONLY when the flag is
      // ON (index.ts), so flag-OFF this job never exists.
      type: "selftune";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      // Convergence (RAG / codebase index — Layer C, flag-gated by GITTENSORY_REVIEW_RAG). Populate + maintain the
      // vector index that retrieval reads.
      //   - No `repoFullName` (the cron fan-out) → enqueue one per-repo FULL re-index job for every
      //     registered + cutover-allowlisted repo (mirrors the agent-regate / signal-snapshot fan-out).
      //   - `repoFullName` + no `paths` → FULL re-index of that repo's code (indexRepo).
      //   - `repoFullName` + `paths` → INCREMENTAL re-index of only those changed paths (reindexChangedPaths),
      //     enqueued from a push / merged-PR webhook.
      // Enqueued + dispatched ONLY when the flag is ON; flag-OFF (default) this job is never created and the
      // processor no-ops, so the deploy is byte-identical to today.
      type: "rag-index-repo";
      requestedBy: "schedule" | "api" | "webhook" | "test";
      repoFullName?: string;
      paths?: string[];
    }
  | {
      // Public OAuth draft-submission flow (GITTENSORY_REVIEW_DRAFT): fork the content repo with the
      // contributor's token + open the PR. Enqueued by the draft OAuth callback.
      type: "submit-draft";
      requestedBy: "api" | "test";
      draftId: string;
    }
  | {
      // Orb relay retry (#relay-retry): re-attempt previously-failed forwardOrbEvent calls (container was down).
      // Enqueued by the cron every sweep cycle (≈2 min) ONLY when ORB_BROKER_ENABLED is set.
      type: "retry-orb-relay";
      requestedBy: "schedule" | "test";
    };

export type GitHubWebhookPayload = {
  action?: string;
  installation?: {
    id: number;
    app_id?: number;
    account?: {
      login?: string;
      id?: number;
      type?: string;
    };
    target_type?: string;
    repository_selection?: string;
    permissions?: Record<string, string>;
    events?: string[];
    suspended_at?: string | null;
  };
  repository?: GitHubRepositoryPayload;
  repositories?: GitHubRepositoryPayload[];
  repositories_added?: GitHubRepositoryPayload[];
  repositories_removed?: GitHubRepositoryPayload[];
  pull_request?: GitHubPullRequestPayload;
  issue?: GitHubIssuePayload;
  comment?: GitHubIssueCommentPayload;
  review?: GitHubReviewPayload;
  reaction?: GitHubReactionPayload;
  sender?: GitHubWebhookUserPayload;
  label?: {
    name?: string;
  };
};

export type GitHubWebhookUserPayload = {
  login?: string;
  type?: string;
  id?: number;
};

export type GitHubRepositoryPayload = {
  id?: number;
  name: string;
  full_name: string;
  private?: boolean;
  html_url?: string;
  default_branch?: string;
  owner?: {
    login?: string;
  };
};

export type GitHubPullRequestPayload = {
  number: number;
  title: string;
  state: string;
  html_url?: string;
  merged_at?: string | null;
  draft?: boolean | null;
  isDraft?: boolean | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  mergeableState?: string | null;
  reviewDecision?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  user?: {
    login?: string;
    type?: string;
  };
  author_association?: string;
  head?: {
    sha?: string;
    ref?: string;
  };
  base?: {
    ref?: string;
  };
  labels?: Array<{ name?: string }>;
  body?: string | null;
};

export type GitHubReviewPayload = {
  state?: string;
  user?: GitHubWebhookUserPayload;
  submitted_at?: string | null;
  html_url?: string;
};

export type GitHubIssuePayload = {
  number: number;
  title: string;
  state: string;
  html_url?: string;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  user?: {
    login?: string;
  };
  author_association?: string;
  labels?: Array<{ name?: string }>;
  body?: string | null;
  pull_request?: unknown;
};

export type GitHubReactionPayload = {
  id?: number;
  content?: string;
  user?: GitHubWebhookUserPayload;
  created_at?: string | null;
};

export type GitHubIssueCommentPayload = {
  id: number;
  body?: string | null;
  html_url?: string | null;
  user?: {
    login?: string;
    type?: string;
  };
  author_association?: string;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Per-repo time-decay overrides (#703), parsed from the registry's nested `scoring.time_decay`. Mirrors
 * upstream's RepoTimeDecayConfig: every field optional; a missing/invalid field resolves to the global
 * default constant (see resolveTimeDecay). The repo maintainer sets these in master_repositories.json.
 */
export type RepoTimeDecayOverrides = {
  gracePeriodHours?: number | null | undefined;
  sigmoidMidpointDays?: number | null | undefined;
  sigmoidSteepness?: number | null | undefined;
  minMultiplier?: number | null | undefined;
};

export type RegistryRepoConfig = {
  repo: string;
  emissionShare: number;
  issueDiscoveryShare: number;
  labelMultipliers: Record<string, number>;
  trustedLabelPipeline?: boolean | null;
  maintainerCut: number;
  defaultLabelMultiplier?: number | null;
  fixedBaseScore?: number | null;
  eligibilityMode?: string | null;
  /** Per-repo time-decay curve overrides (#703); null/absent = use the global defaults for every field. */
  timeDecay?: RepoTimeDecayOverrides | null;
  raw: Record<string, JsonValue>;
};

export type RegistrySnapshot = {
  id: string;
  generatedAt: string;
  fetchedAt: string;
  source: {
    kind: "api" | "raw-github";
    url: string;
  };
  repoCount: number;
  totalEmissionShare: number;
  warnings: string[];
  repositories: RegistryRepoConfig[];
};

export type AdvisoryConclusion = "success" | "neutral" | "action_required";
export type AdvisorySeverity = "info" | "warning" | "critical";

export type AdvisoryFinding = {
  code: string;
  title: string;
  severity: AdvisorySeverity;
  detail: string;
  action?: string;
  publicText?: string;
  /** Calibrated confidence in [0,1] for an AI-judgment finding (`ai_consensus_defect` / `ai_review_split`) — the
   *  reviewer's own probability that the flagged blocker is a real defect (#8). The gate's `aiReviewCloseConfidence`
   *  threshold uses it: an AI defect blocks ONLY when this clears the floor. Absent for deterministic findings (they
   *  carry no model confidence); an absent/unparseable reviewer confidence degrades to 1.0 upstream, so omitting it
   *  here behaves exactly like today. */
  confidence?: number;
};

export type Advisory = {
  id: string;
  targetType: "repository" | "pull_request" | "issue";
  targetKey: string;
  repoFullName: string;
  pullNumber?: number;
  issueNumber?: number;
  headSha?: string;
  conclusion: AdvisoryConclusion;
  severity: AdvisorySeverity;
  title: string;
  summary: string;
  findings: AdvisoryFinding[];
  generatedAt: string;
};

export type RepositoryRecord = {
  fullName: string;
  owner: string;
  name: string;
  installationId?: number | null | undefined;
  isInstalled: boolean;
  isRegistered: boolean;
  isPrivate: boolean;
  htmlUrl?: string | null | undefined;
  defaultBranch?: string | null | undefined;
  registryConfig?: RegistryRepoConfig | null | undefined;
};

export type PullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  headSha?: string | null | undefined;
  headRef?: string | null | undefined;
  baseRef?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  mergedAt?: string | null | undefined;
  isDraft?: boolean | null | undefined;
  mergeableState?: string | null | undefined;
  reviewDecision?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  /** Latest deterministic slop assessment (0-100) and band, persisted by the public-surface processor when
   *  the repo opted into slop. `null`/absent = not assessed (slop off, or PR not yet processed). */
  slopRisk?: number | null | undefined;
  slopBand?: string | null | undefined;
  /** RC3 terminal-fail merges: failed auto-merge attempt count, and the head SHA at which the merge is
   *  terminally blocked (with a human-readable reason). When mergeBlockedSha === headSha the planner suppresses
   *  the `merge` disposition (held for a human); a new commit clears the block. */
  mergeAttemptCount?: number | null | undefined;
  mergeBlockedSha?: string | null | undefined;
  mergeBlockedReason?: string | null | undefined;
  /** Re-approval idempotency: the head SHA the bot last auto-approved. The planner skips the `approve`
   *  disposition while approvedHeadSha === headSha (this commit is already approved by the bot); a new commit
   *  clears the match so the bot may re-approve the new code. Mirrors mergeBlockedSha. */
  approvedHeadSha?: string | null | undefined;
  /** Sweep convergence: the timestamp the scheduled re-gate sweep last recomputed this PR. selectRegateCandidates
   *  orders by this marker (not GitHub's updatedAt) so the sweep advances through all open PRs even when the
   *  review write that would bump updatedAt is suppressed (dry-run / paused). Sweep-written; read straight from
   *  the row (never the GitHub payload). */
  lastRegatedAt?: string | null | undefined;
  /** Public-surface marker: the head SHA at which the public surface was last published. Used for reporting and
   *  stale-surface diagnostics, not as a hard re-review skip: GitHub comments/checks can still be stale or partial
   *  while this marker matches headSha. Publish-written; read straight from the row. */
  lastPublishedSurfaceSha?: string | null | undefined;
};

export type IssueRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  labels: string[];
  linkedPrs: number[];
};

export type BountyRecord = {
  id: string;
  repoFullName: string;
  issueNumber: number;
  status: string;
  amountText?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  payload: Record<string, JsonValue>;
  discoveredAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type GateRuleMode = "off" | "advisory" | "block";

/** Which policy pack the gate runs under (#692). `gittensor` = the full Gittensor policy: registry/emissions-
 *  aware, and it threads the author's confirmed status for on-chain scoring (the gate verdict itself blocks
 *  every author the same — confirmed status no longer changes it, #gate-nonconfirmed). `oss-anti-slop` = a
 *  general, repo-agnostic pack: the same deterministic rules (slop/duplicate/linked-issue/readiness/AI-
 *  consensus) block ANY author, with no emissions/registry/Gittensor coupling — so the gate runs on any repo. */
export type GatePolicyPack = "gittensor" | "oss-anti-slop";

export type RepositorySettings = {
  repoFullName: string;
  commentMode: "off" | "detected_contributors_only" | "all_prs";
  publicAudienceMode: "oss_maintainer" | "gittensor_only";
  publicSignalLevel: "minimal" | "standard";
  checkRunMode: "off" | "enabled";
  checkRunDetailLevel: "minimal" | "standard" | "deep";
  gateCheckMode: "off" | "enabled";
  /** Policy pack the gate evaluates under (#692). Default `gittensor` (registry-aware; threads confirmed
   *  status for scoring only). `oss-anti-slop` runs the deterministic rules against any author on any repo. */
  gatePack: GatePolicyPack;
  linkedIssueGateMode: GateRuleMode;
  duplicatePrGateMode: GateRuleMode;
  qualityGateMode: GateRuleMode;
  qualityGateMinScore?: number | null | undefined;
  /** Deterministic anti-slop signal (#530/#532). `off` = no slop score; `advisory` = surface the slop
   *  score + warnings in context; `block` = ALSO hard-block when slopRisk >= slopGateMinScore (deterministic
   *  only, applies to every author like every blocker). Default `off` — opt-in via .gittensory.yml. */
  slopGateMode: GateRuleMode;
  /** PR-size manual-review HOLD (#gate-size). `off` (default/absent) = no size hold; `advisory`/`block` = a PR with
   *  >= 10 changed files OR >= 500 changed (added+deleted) lines that would otherwise pass is HELD for manual review
   *  (neutral gate → "manual" verdict), never auto-merged and never a hard failure. Opt-in via `gate.size.mode`. */
  sizeGateMode?: GateRuleMode | undefined;
  /** Dry-run disposition (#gate-dryrun). When true, the gate renders the would-be merge/close/manual verdict (every
   *  advisory sub-gate promoted to block) WITHOUT enforcing — the posted check stays non-blocking. Lets advisory mode
   *  preview exactly what it would do before the maintainer flips to real enforcement. Default off. */
  gateDryRun?: boolean | undefined;
  /** Merge-readiness gate (#merge-readiness). `off`/`advisory`/`block`. No min-score. Default `off`. */
  mergeReadinessGateMode: GateRuleMode;
  /** Focus-manifest policy gate (#555). When `block`, the focus manifest's declared policy (blocked paths,
   *  required-linked-issue, test expectations) becomes an enforceable `Gittensory Gate` blocker. An
   *  INDEPENDENT dimension, deliberately not folded into the merge-readiness composite. Default `off` — opt-in. */
  manifestPolicyGateMode: GateRuleMode;
  /** Self-authored linked-issue gate. When `block`, the gate closes a PR where the contributor also
   *  opened the linked issue (`pr.authorLogin === issue.authorLogin`). Defaults to `advisory` — the finding
   *  is surfaced in the review panel but never blocks unless the maintainer opts in. */
  selfAuthoredLinkedIssueGateMode: GateRuleMode;
  /** First-time-contributor grace (#552). When true, a would-be BLOCK is softened to a neutral/advisory gate
   *  for a genuine newcomer (0 merged PRs in this repo) who is NOT a repeat offender (< 3 closed-unmerged PRs).
   *  Repeat offenders and authors with merge history are gated normally. Default false — opt-in. */
  firstTimeContributorGrace: boolean;
  /** Slop-risk threshold (0-100) at/above which `slopGateMode: block` blocks. Default 60 (the `high` band). */
  slopGateMinScore?: number | null | undefined;
  /** AI-assisted slop advisory (the `slopAiAdvisory` capability). When true AND `slopGateMode != off`, a
   *  free Workers-AI pass adds an ADVISORY-only `ai_slop_advisory` finding for semantic slop the
   *  deterministic detector cannot quantify. It NEVER feeds slopRisk or the gate (only the deterministic
   *  core blocks). Default false — opt-in via `.gittensory.yml gate.slop.aiAdvisory`. */
  slopAiAdvisory: boolean;
  /** AI maintainer review. `off` = no AI; `advisory` = post AI review notes only; `block` = ALSO let a
   *  dual-model high-confidence consensus defect become a gate blocker (confirmed-contributors only,
   *  like every other blocker). Default `off` — AI is opt-in. */
  aiReviewMode: GateRuleMode;
  /** Bring-your-own-key: when true and a provider key is configured for the repo, the advisory AI review
   *  is generated by the maintainer's frontier model (Anthropic/OpenAI) instead of free Workers AI. The
   *  consensus blocker always uses the free Workers-AI model pair regardless, so BYOK never changes who
   *  can be blocked. Default false. */
  aiReviewByok: boolean;
  /** Config-as-code BYOK provider for the advisory write-up. `null` = use the configured key's own
   *  provider. When set, it must match the stored key's provider or BYOK is skipped (Workers-AI fallback).
   *  The secret key itself is never here — only via the encrypted key store. */
  aiReviewProvider?: "anthropic" | "openai" | null | undefined;
  /** Config-as-code model override for the BYOK advisory write-up (e.g. "claude-3-5-sonnet-latest").
   *  `null` = use the key record's model, else a conservative per-provider default. */
  aiReviewModel?: string | null | undefined;
  /** Review EVERY PR's author, not only confirmed Gittensor contributors. The AI maintainer review is
   *  confirmed-contributor-gated by default (an AI-spend guard). When true the review runs for any author —
   *  intended for a self-host operator who wants real reviews on all PRs (incl. their own) and pays for the
   *  AI themselves. Default false — opt-in via `.gittensory.yml gate.aiReview.allAuthors`. Independent of
   *  `aiReviewMode`: `off` still means no AI; this only widens WHO an enabled review covers. */
  aiReviewAllAuthors: boolean;
  /** Minimum calibrated AI-reviewer confidence (0-1) for an AI defect to BLOCK under `aiReviewMode: block` (#7).
   *  A dual-model consensus defect / split blocks only when its finding `confidence >= aiReviewCloseConfidence`;
   *  below-threshold AI defects hold for human review rather than passing. Config-as-code only — set via
   *  `.gittensory.yml gate.aiReview.closeConfidence` (no dashboard/DB column); unset ⇒ the gate uses the 0.9
   *  default. Clamped to [0,1] at parse time. */
  aiReviewCloseConfidence?: number | null | undefined;
  /** When TRUE, the repo OWNER's (and maintainer's) own PRs are eligible for auto-CLOSE like a contributor's
   *  (still subject to the `close` autonomy class + the same adverse-signal conditions). Default FALSE — owner
   *  PRs are exempt from auto-close (merge or manual-hold only). Per-repo configurable so maintainers choose
   *  rather than inheriting a hardwired opinion. */
  closeOwnerAuthors: boolean;
  autoLabelEnabled: boolean;
  gittensorLabel: string;
  createMissingLabel: boolean;
  publicSurface: "off" | "comment_and_label" | "comment_only" | "label_only";
  includeMaintainerAuthors: boolean;
  requireLinkedIssue: boolean;
  backfillEnabled: boolean;
  privateTrustEnabled: boolean;
  /** Opt-in for the public, unauthenticated README status badge (#541). Always populated by the DB layer
   *  (default false); optional so existing settings fixtures/callers need not be touched. */
  badgeEnabled?: boolean | undefined;
  commandAuthorization?: RepositoryCommandAuthorizationPolicy | undefined;
  /** Per-repo contributor blacklist (#1425, anti-abuse): banned GitHub logins whose PRs/issues the engine
   *  deterministically closes ahead of merit review. Layered the same as other settings (`.gittensory.yml` >
   *  DB) and unioned with the shared/global list at the point of use. Always populated by the DB layer
   *  (default `[]`); optional so existing settings fixtures/callers need not be touched. */
  contributorBlacklist?: ContributorBlacklistEntry[] | undefined;
  /** The label applied to a blacklisted contributor's PR (#1425). Configurable per-repo (dashboard/DB +
   *  `.gittensory.yml` `settings.blacklistLabel`); defaults to `"slop"` so the disposition works regardless of
   *  the label a repo sets. Always populated by the DB layer (default `"slop"`); optional so existing settings
   *  fixtures/callers need not be touched (mirrors the sibling `contributorBlacklist`). */
  blacklistLabel?: string | undefined;
  /** Agent-layer autonomy dial (#773): per-action-class level. Always populated by the DB layer (default
   *  `{}` = deny-by-default = "observe" for every class); optional so existing settings fixtures/callers
   *  need not be touched. The single source the action layer (#778) reads via `resolveAutonomy`. */
  autonomy?: AutonomyPolicy | undefined;
  /** Auto-maintain policy (#774): merge method + approval count. Always populated by the DB layer with
   *  defaults (squash / 1 approval); optional so existing settings fixtures/callers need not be touched. */
  autoMaintain?: AutoMaintainPolicy | undefined;
  /** Per-repo agent kill-switch (#776): when true, the action layer takes NO action on this repo (the
   *  global env switch overrides this too). Default false. */
  agentPaused?: boolean | undefined;
  /** Per-repo dry-run/shadow mode (#776): when true, the action layer records what it WOULD do without
   *  performing any GitHub mutation. Default false. */
  agentDryRun?: boolean | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type CommandAuthorizationRole = "maintainer" | "collaborator" | "pr_author" | "confirmed_miner";

export type RepositoryCommandAuthorizationPolicy = {
  default: CommandAuthorizationRole[];
  commands: Record<string, CommandAuthorizationRole[]>;
};

/** A blocked contributor (#1425, anti-abuse): a GitHub `login` plus optional maintainer metadata. The converged
 *  engine short-circuits a blacklisted author's PR/issue to a deterministic close ahead of any merit/CI/AI
 *  analysis. Metadata can come from private configuration and must not be echoed to public surfaces. */
export type ContributorBlacklistEntry = {
  login: string;
  /** Why the account is blocked. Free-text maintainer metadata; not published in automated close comments. */
  reason?: string | undefined;
  /** PR/issue URLs (or other maintainer refs) evidencing the block. */
  evidence?: string[] | undefined;
  /** ISO-8601 date the entry was added. */
  addedAt?: string | undefined;
};

/** Agent-layer graduated autonomy (#773), least → most autonomous. `observe` is the deny-by-default floor:
 *  gittensory watches but never acts. `suggest`/`propose` surface guidance/concrete proposals without
 *  executing; `auto_with_approval` executes behind a human approval gate (#779); `auto` executes directly. */
export type AutonomyLevel = "observe" | "suggest" | "propose" | "auto_with_approval" | "auto";

/** The write-action classes the maintainer auto-maintain layer (#778) can take on a PR. */
export type AgentActionClass = "review" | "request_changes" | "approve" | "merge" | "close" | "label" | "update_branch";

/** Per-action-class autonomy. An unset class resolves to `observe` (deny-by-default). */
export type AutonomyPolicy = Partial<Record<AgentActionClass, AutonomyLevel>>;

/** How the agent merges when it auto-merges (#774). */
export type AutoMergeMethod = "merge" | "squash" | "rebase";

/** Auto-maintain policy (#774): the "how" once an action is at an acting autonomy level. `requireApprovals`
 *  is the human approval count an `auto_with_approval` action waits for (#779); `mergeMethod` is how an
 *  auto-merge merges. Always populated by the DB layer with defaults. */
export type AutoMaintainPolicy = {
  requireApprovals: number;
  mergeMethod: AutoMergeMethod;
};

/** The payload needed to execute a staged action when a maintainer accepts it (#779). Only the field for the
 *  action's class is set, mirroring PlannedAgentAction. */
export type AgentPendingActionParams = {
  label?: string;
  // Flag-then-close double-check: whether a `label` action ADDs (default/absent) or REMOVEs its label, plus an
  // optional comment posted alongside the label mutation. Persisted so a staged label action replays faithfully.
  labelOp?: "add" | "remove";
  comment?: string;
  reviewBody?: string;
  mergeMethod?: AutoMergeMethod;
  closeComment?: string;
  expectedHeadSha?: string;
};

export type AgentPendingActionStatus = "pending" | "accepted" | "rejected";

/** Approval-queue row (#779): an `auto_with_approval` action the write-actions layer staged for a one-tap
 *  maintainer accept (→ execute) or reject (→ cancel). */
export type AgentPendingActionRecord = {
  id: string;
  repoFullName: string;
  pullNumber: number;
  installationId: number;
  actionClass: AgentActionClass;
  autonomyLevel: AutonomyLevel;
  params: AgentPendingActionParams;
  reason: string | null;
  status: AgentPendingActionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RepoSyncStateRecord = {
  repoFullName: string;
  status: "never_synced" | "running" | "success" | "partial" | "error" | "skipped" | "capped" | "rate_limited" | "stale";
  sourceKind: "github" | "installation" | "test";
  primaryLanguage?: string | null | undefined;
  defaultBranch?: string | null | undefined;
  isPrivate?: boolean | null | undefined;
  openIssuesCount: number;
  openPullRequestsCount: number;
  recentMergedPullRequestsCount: number;
  labelsSyncedAt?: string | null | undefined;
  issuesSyncedAt?: string | null | undefined;
  pullRequestsSyncedAt?: string | null | undefined;
  mergedPullRequestsSyncedAt?: string | null | undefined;
  lastStartedAt?: string | null | undefined;
  lastCompletedAt?: string | null | undefined;
  errorSummary?: string | null | undefined;
  warnings: string[];
  updatedAt?: string | null | undefined;
};

export type RepoSyncSegmentRecord = {
  repoFullName: string;
  segment:
    | "metadata"
    | "labels"
    | "open_issues"
    | "open_pull_requests"
    | "recent_merged_pull_requests"
    | "pull_request_files"
    | "pull_request_reviews"
    | "check_summaries";
  status:
    | "never_synced"
    | "running"
    | "refreshing"
    | "complete"
    | "partial"
    | "capped"
    | "sampled"
    | "stale"
    | "rate_limited"
    | "waiting_rate_limit"
    | "error"
    | "skipped"
    | "not_modified";
  sourceKind: "github" | "installation" | "test";
  mode: "light" | "full" | "resume";
  lastCursor?: string | null | undefined;
  nextCursor?: string | null | undefined;
  fetchedCount: number;
  expectedCount?: number | null | undefined;
  pageCount: number;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  staleAt?: string | null | undefined;
  rateLimitResetAt?: string | null | undefined;
  etag?: string | null | undefined;
  lastModified?: string | null | undefined;
  warnings: string[];
  errorSummary?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type RepoGithubTotalsSnapshotRecord = {
  id: string;
  repoFullName: string;
  openIssuesTotal: number;
  openPullRequestsTotal: number;
  mergedPullRequestsTotal: number;
  closedUnmergedPullRequestsTotal: number;
  labelsTotal: number;
  sourceKind: "github" | "installation" | "test";
  fetchedAt: string;
  rateLimitRemaining?: number | null | undefined;
  rateLimitResetAt?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type RepoQueueTrendSnapshotRecord = {
  repoFullName: string;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type PullRequestDetailSyncStateRecord = {
  repoFullName: string;
  pullNumber: number;
  status: "never_synced" | "running" | "complete" | "partial" | "waiting_rate_limit" | "error";
  filesSyncedAt?: string | null | undefined;
  reviewsSyncedAt?: string | null | undefined;
  checksSyncedAt?: string | null | undefined;
  lastSyncedAt?: string | null | undefined;
  errorSummary?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type GitHubRateLimitObservationRecord = {
  id?: string | undefined;
  repoFullName?: string | null | undefined;
  resource: "rest" | "graphql";
  path: string;
  statusCode: number;
  limitValue?: number | null | undefined;
  remaining?: number | null | undefined;
  resetAt?: string | null | undefined;
  observedAt?: string | null | undefined;
};

export type DataQuality = {
  status: "complete" | "degraded" | "blocked" | "unknown";
  generatedAt: string;
  repoFullName?: string | null | undefined;
  stale: boolean;
  partial: boolean;
  capped: boolean;
  rateLimited: boolean;
  segmentCount: number;
  incompleteSegments: string[];
  cappedSegments: string[];
  staleSegments: string[];
  rateLimitedSegments: string[];
  warnings: string[];
  syncState?: Pick<RepoSyncStateRecord, "status" | "lastCompletedAt" | "updatedAt" | "warnings"> | undefined;
};

export type RepoLabelRecord = {
  repoFullName: string;
  name: string;
  color?: string | null | undefined;
  description?: string | null | undefined;
  isConfigured: boolean;
  observedCount: number;
  payload: Record<string, JsonValue>;
  lastSeenAt?: string | null | undefined;
};

export type RepoSnapshotRecord = {
  id: string;
  repoFullName: string;
  snapshotKind: string;
  sourceKind: string;
  fetchedAt: string;
  primaryLanguage?: string | null | undefined;
  defaultBranch?: string | null | undefined;
  openIssuesCount: number;
  openPullRequestsCount: number;
  recentMergedPullRequestsCount: number;
  payload: Record<string, JsonValue>;
};

export type PullRequestFileRecord = {
  repoFullName: string;
  pullNumber: number;
  path: string;
  status?: string | null | undefined;
  additions: number;
  deletions: number;
  changes: number;
  previousFilename?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type PullRequestFilePathRecord = Pick<PullRequestFileRecord, "repoFullName" | "pullNumber" | "path">;

export type PullRequestReviewRecord = {
  id: string;
  repoFullName: string;
  pullNumber: number;
  reviewerLogin?: string | null | undefined;
  state: string;
  authorAssociation?: string | null | undefined;
  submittedAt?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type CheckSummaryRecord = {
  id: string;
  repoFullName: string;
  pullNumber?: number | null | undefined;
  headSha?: string | null | undefined;
  name: string;
  status: string;
  conclusion?: string | null | undefined;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  detailsUrl?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type RecentMergedPullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  authorLogin?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  mergedAt?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  changedFiles: string[];
  payload: Record<string, JsonValue>;
};

export type ContributorRecord = {
  login: string;
  githubProfile: Record<string, JsonValue>;
  topLanguages: string[];
  publicRepos?: number | null | undefined;
  followers?: number | null | undefined;
  source: "github" | "unavailable";
  firstSeenAt?: string | null | undefined;
  lastSeenAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type ContributorRepoStatRecord = {
  login: string;
  repoFullName: string;
  pullRequests: number;
  mergedPullRequests: number;
  openPullRequests: number;
  issues: number;
  stalePullRequests: number;
  unlinkedPullRequests: number;
  dominantLabels: string[];
  lastActivityAt?: string | null | undefined;
};

export type CollisionEdgeRecord = {
  id: string;
  repoFullName: string;
  leftType: "issue" | "pull_request" | "recent_merged_pull_request";
  leftNumber: number;
  leftTitle: string;
  rightType: "issue" | "pull_request" | "recent_merged_pull_request";
  rightNumber: number;
  rightTitle: string;
  risk: "low" | "medium" | "high";
  reason: string;
  sharedTerms: string[];
  generatedAt?: string | null | undefined;
};

export type SignalSnapshotRecord = {
  id: string;
  signalType: string;
  targetKey: string;
  repoFullName?: string | null | undefined;
  payload: Record<string, JsonValue>;
  generatedAt?: string | null | undefined;
};

export type AgentSurface = "mcp" | "github_comment" | "api";
export type AgentMode = "copilot";
export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "needs_snapshot_refresh";
export type AgentActionType =
  | "choose_next_work"
  | "cleanup_existing_prs"
  | "preflight_branch"
  | "explain_score_blockers"
  | "prepare_pr_packet"
  | "check_duplicate_risk"
  | "monitor_existing_pr"
  | "explain_repo_fit";
export type AgentActionStatus = "recommended" | "ready" | "blocked" | "watch" | "needs_input";
export type AgentSafetyClass = "private" | "public_safe" | "approval_required";
export type AgentActionBlockerCategory = "branch" | "account" | "queue" | "scoreability" | "risk" | "maintainer" | "unknown";

export type AgentActionExplanationCard = {
  summary: string;
  whyNow: string;
  scoreabilityBlocker: string;
  risk: string;
  maintainerFriction: string;
  expectedImpact: string;
  blockerGroups: Array<{
    category: AgentActionBlockerCategory;
    items: string[];
  }>;
  rerunWhen: string;
  publicSafe: {
    summary: string;
    whyNow: string;
    rerunWhen: string;
  };
};

export type AgentRunRecord = {
  id: string;
  objective: string;
  actorLogin: string;
  surface: AgentSurface;
  mode: AgentMode;
  status: AgentRunStatus;
  dataQualityStatus: "complete" | "degraded" | "blocked" | "unknown";
  errorSummary?: string | null | undefined;
  payload: Record<string, JsonValue>;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type AgentActionRecord = {
  id: string;
  runId: string;
  actionType: AgentActionType;
  targetRepoFullName?: string | null | undefined;
  targetPullNumber?: number | null | undefined;
  targetIssueNumber?: number | null | undefined;
  status: AgentActionStatus;
  recommendation: string;
  why: string[];
  scoreabilityImpact?: string | null | undefined;
  riskImpact?: string | null | undefined;
  maintainerImpact?: string | null | undefined;
  blockedBy: string[];
  rerunWhen?: string | null | undefined;
  publicSafeSummary: string;
  explanationCard?: AgentActionExplanationCard | undefined;
  approvalRequired: boolean;
  safetyClass: AgentSafetyClass;
  payload: Record<string, JsonValue>;
  createdAt?: string | null | undefined;
};

export type AgentContextSnapshotRecord = {
  id: string;
  runId: string;
  decisionPackVersion?: string | null | undefined;
  repoSignalSnapshotIds: string[];
  scoringModelId?: string | null | undefined;
  freshnessWarnings: string[];
  payload: Record<string, JsonValue>;
  createdAt?: string | null | undefined;
};

export type AgentRecommendationOutcomeState = "accepted" | "rejected" | "ignored" | "stale" | "merged" | "closed" | "improved";
export type AgentRecommendationOutcomeTargetType = "pull_request" | "issue" | "repository" | "none";
export type AgentRecommendationOutcomeConfidence = "high" | "medium" | "low";
export type AgentRecommendationOutcomeSource = "explicit" | "inferred";

export type AgentRecommendationOutcomeRecord = {
  id?: string | undefined;
  actionId: string;
  runId: string;
  actorLogin: string;
  actionType: AgentActionType;
  surface?: AgentSurface | null | undefined;
  snapshotId?: string | null | undefined;
  targetRepoFullName?: string | null | undefined;
  targetPullNumber?: number | null | undefined;
  targetIssueNumber?: number | null | undefined;
  source: AgentRecommendationOutcomeSource;
  outcomeState: AgentRecommendationOutcomeState;
  outcomeTargetType: AgentRecommendationOutcomeTargetType;
  outcomeRepoFullName?: string | null | undefined;
  outcomePullNumber?: number | null | undefined;
  outcomeIssueNumber?: number | null | undefined;
  maintainerLane: boolean;
  confidence: AgentRecommendationOutcomeConfidence;
  reason: string;
  sourceUpdatedAt?: string | null | undefined;
  detectedAt?: string | null | undefined;
  metadata: Record<string, JsonValue>;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type AgentRecommendationOutcomeStateBucket = {
  state: AgentRecommendationOutcomeState;
  count: number;
};

export type AgentRecommendationOutcomeRepoSummary = {
  repoFullName: string;
  total: number;
  accepted: number;
  rejected: number;
  ignored: number;
  stale: number;
  merged: number;
  closed: number;
  improved: number;
  positive: number;
  negative: number;
  maintainerLaneTotal: number;
  latestOutcomeAt?: string | null | undefined;
  signal: "positive" | "negative" | "mixed" | "neutral";
};

// #554 gate false-positive telemetry. One latest gate-block row per (repo, PR). Privacy: repo + PR number +
// blocker codes + timestamps ONLY — deliberately no actor login, no trust/reward fields.
export type GateOutcomeRecord = {
  id?: string | undefined;
  repoFullName: string;
  pullNumber: number;
  headSha?: string | null | undefined;
  blockerCodes: string[];
  overridden: boolean;
  blockedAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type AgentRecommendationOutcomeSummary = {
  login: string;
  generatedAt: string;
  windowDays: number;
  totals: {
    total: number;
    accepted: number;
    rejected: number;
    ignored: number;
    stale: number;
    merged: number;
    closed: number;
    improved: number;
    positive: number;
    negative: number;
    maintainerLaneTotal: number;
  };
  sources: {
    explicit: number;
    inferred: number;
  };
  states: AgentRecommendationOutcomeStateBucket[];
  repos: AgentRecommendationOutcomeRepoSummary[];
  maintainerLane: {
    total: number;
    states: AgentRecommendationOutcomeStateBucket[];
  };
  privateSummary: string;
};

export type InstallationRecord = {
  id: number;
  accountLogin: string;
  accountId: number;
  /** The GitHub App this installation belongs to (#selfhost-app-id); null until an `installation` event or the
   *  App-installation API refresh populates it. */
  appId?: number | null | undefined;
  targetType: string;
  repositorySelection?: string | null | undefined;
  permissions: Record<string, string>;
  events: string[];
  suspendedAt?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type InstallationHealthRecord = {
  installationId: number;
  accountLogin: string;
  repositorySelection?: string | null | undefined;
  installedReposCount: number;
  registeredInstalledCount: number;
  status: "healthy" | "needs_attention" | "broken";
  missingPermissions: string[];
  missingEvents: string[];
  permissions: Record<string, string>;
  events: string[];
  checkedAt: string;
  errorSummary?: string | null | undefined;
};

export type ScoringModelSnapshotRecord = {
  id: string;
  sourceKind: "raw-github" | "api" | "fallback" | "test";
  sourceUrl: string;
  fetchedAt: string;
  activeModel: "current_density_model" | "pending_saturation_model" | "exponential_saturation_model" | "unknown";
  constants: Record<string, number>;
  programmingLanguages: Record<string, JsonValue>;
  registrySnapshotId?: string | null | undefined;
  warnings: string[];
  payload: Record<string, JsonValue>;
};

export type UpstreamSourceStatus = "fetched" | "not_modified" | "fallback" | "error";

export type UpstreamSourceSnapshotRecord = {
  id: string;
  sourceKey: string;
  sourceRepo: string;
  sourceRef: string;
  path: string;
  sourceUrl: string;
  commitSha?: string | null | undefined;
  blobSha?: string | null | undefined;
  contentSha256?: string | null | undefined;
  etag?: string | null | undefined;
  status: UpstreamSourceStatus;
  parsed: Record<string, JsonValue>;
  warnings: string[];
  payload: Record<string, JsonValue>;
  fetchedAt: string;
};

export type UpstreamDriftSeverity = "low" | "medium" | "high" | "blocking";
export type UpstreamDriftStatus = "open" | "acknowledged" | "resolved" | "ignored";
export type UpstreamDriftArea = "registry" | "scoring_model" | "issue_discovery" | "mirror_linkage" | "language_weights" | "source";
export type RegistryHyperparameterDriftField =
  | "repo"
  | "emissionShare"
  | "issueDiscoveryShare"
  | "maintainerCut"
  | "labelMultipliers"
  | "trustedLabelPipeline"
  | "defaultLabelMultiplier"
  | "fixedBaseScore"
  | "eligibilityMode"
  | "timeDecay";
export type RegistryDriftSurface = "allocation" | "lane_fit" | "scoreability_assumptions" | "maintainer_economics" | "issue_discovery_behavior" | "label_policy";
export type RegistryHyperparameterDriftEvent = {
  repoFullName: string;
  field: RegistryHyperparameterDriftField;
  previous: JsonValue;
  current: JsonValue;
  severity: UpstreamDriftSeverity;
  affectedSurfaces: RegistryDriftSurface[];
  summary: string;
};
export type RegistryHyperparameterDriftSummary = {
  totalEvents: number;
  omittedEvents: number;
  highImpactCount: number;
  affectedRepoCount: number;
  affectedFields: RegistryHyperparameterDriftField[];
  affectedSurfaces: RegistryDriftSurface[];
};

export type UpstreamRulesetSnapshotRecord = {
  id: string;
  sourceRepo: string;
  sourceRef: string;
  commitSha?: string | null | undefined;
  sourceSnapshotIds: string[];
  activeModel: ScoringModelSnapshotRecord["activeModel"];
  registryRepoCount: number;
  totalEmissionShare: number;
  semanticHash: string;
  payload: Record<string, JsonValue>;
  warnings: string[];
  generatedAt: string;
};

export type UpstreamDriftReportRecord = {
  id: string;
  fingerprint: string;
  severity: UpstreamDriftSeverity;
  status: UpstreamDriftStatus;
  summary: string;
  affectedAreas: UpstreamDriftArea[];
  previousRulesetId?: string | null | undefined;
  currentRulesetId?: string | null | undefined;
  issueNumber?: number | null | undefined;
  issueUrl?: string | null | undefined;
  payload: Record<string, JsonValue>;
  generatedAt: string;
  updatedAt: string;
};

export type ScorePreviewRecord = {
  id: string;
  scoringModelSnapshotId: string;
  repoFullName: string;
  targetType: "planned_pr" | "pull_request" | "local_diff" | "variant";
  targetKey: string;
  contributorLogin?: string | null | undefined;
  input: Record<string, JsonValue>;
  result: Record<string, JsonValue>;
  generatedAt: string;
};

export type ContributorEvidenceRecord = {
  login: string;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type ContributorScoringProfileRecord = {
  login: string;
  scoringModelSnapshotId: string;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type IssueQualityReportRecord = {
  id: string;
  repoFullName: string;
  issueNumber: number;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type BurdenForecastRecord = {
  repoFullName: string;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type RegistryDriftEventRecord = {
  id: string;
  repoFullName: string;
  driftType: string;
  detail: string;
  previousSnapshotId?: string | null | undefined;
  currentSnapshotId?: string | null | undefined;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type BountyLifecycleEventRecord = {
  id: string;
  bountyId: string;
  repoFullName: string;
  issueNumber: number;
  status: string;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type AuthSessionRecord = {
  id: string;
  tokenHash: string;
  login: string;
  githubUserId?: number | null | undefined;
  scopes: string[];
  expiresAt: string;
  revokedAt?: string | null | undefined;
  createdAt: string;
  lastSeenAt?: string | null | undefined;
  metadata: Record<string, JsonValue>;
};

export type ControlPanelRoleName = "miner" | "maintainer" | "owner" | "operator";

export type ControlPanelRoleStatus = "active" | "available" | "needs_setup";

export type ControlPanelRoleCard = {
  role: ControlPanelRoleName;
  status: ControlPanelRoleStatus;
  title: string;
  detail: string;
  href: string;
  evidenceCount: number;
  sampleRepos: string[];
  nextActions: string[];
};

export type ControlPanelRoleSummary = {
  login: string;
  generatedAt: string;
  roles: ControlPanelRoleName[];
  confirmedMiner: boolean;
  roleCards: ControlPanelRoleCard[];
  onboarding: {
    status: "ready" | "needs_setup";
    primaryRole?: ControlPanelRoleName | undefined;
    nextActions: string[];
  };
  evidence: {
    ownedInstalledRepos: number;
    maintainerRepos: number;
    accountInstallations: number;
    operator: boolean;
  };
  publicSafe: true;
};

export type DigestSubscriptionRecord = {
  id: string;
  login: string;
  email: string;
  status: "active" | "paused";
  source: string;
  createdAt: string;
  updatedAt: string;
};

// Notifications (#535). `badge` is the pull-based extension/harness channel shipped first; `email`
// (#570) is a later opt-in channel. Subscriptions store per-channel opt-out (badge is on by default
// unless a row is `paused`).
export type NotificationChannel = "badge" | "email";
export type NotificationDeliveryStatus = "pending" | "delivered" | "read" | "suppressed";
export type NotificationEventType = "pull_request_changes_requested" | "pull_request_merged" | "issue_watch_match";

/** #699 path B: a miner's standing watch on a repo for new grabbable issues. `labels` ([]=any) filters
 *  which issues notify. The `pullNumber` field of the resulting notification event carries the ISSUE number. */
export type IssueWatchSubscription = {
  login: string;
  repoFullName: string;
  labels: string[];
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

// A notification-worthy event extracted from a webhook payload (src/notifications/events.ts).
export type DetectedNotificationEvent = {
  eventType: NotificationEventType;
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  dedupKey: string;
  deeplink: string;
  actorLogin: string;
  detectedAt: string;
};

export type NotificationSubscriptionRecord = {
  id: string;
  login: string;
  channel: NotificationChannel;
  status: "active" | "paused";
  destination: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type NotificationDeliveryRecord = {
  id: string;
  dedupKey: string;
  channel: NotificationChannel;
  recipientLogin: string;
  eventType: string;
  repoFullName: string;
  pullNumber: number | null;
  title: string;
  body: string;
  deeplink: string;
  actorLogin: string | null;
  status: NotificationDeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
};

export type CommandFeedbackVote = "useful" | "not_useful";
export type CommandFeedbackSource = "github_reaction" | "app";

export type AgentCommandAnswerRecord = {
  id: string;
  repoFullName: string;
  issueNumber: number;
  command: string;
  requestCommentId?: number | null | undefined;
  responseCommentId?: number | null | undefined;
  responseUrl?: string | null | undefined;
  actorKind: "maintainer" | "author";
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  metadata: Record<string, JsonValue>;
};

export type AgentCommandFeedbackRecord = {
  id?: string | undefined;
  answerId: string;
  repoFullName: string;
  issueNumber: number;
  command: string;
  actorLogin: string;
  vote: CommandFeedbackVote;
  source: CommandFeedbackSource;
  actorKind: "maintainer" | "author";
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  metadata?: Record<string, JsonValue> | undefined;
};

export type CommandUsefulnessBucket = {
  command: string;
  feedbackCount: number;
  usefulCount: number;
  notUsefulCount: number;
  answerCount: number;
  usefulnessRate: number | null;
  latestFeedbackAt?: string | null | undefined;
};

export type CommandUsefulnessSummary = {
  windowDays: number;
  generatedAt: string;
  totals: Omit<CommandUsefulnessBucket, "command">;
  commands: CommandUsefulnessBucket[];
};

export type AuditEventRecord = {
  id?: string | undefined;
  eventType: string;
  actor?: string | null | undefined;
  route?: string | null | undefined;
  targetKey?: string | null | undefined;
  outcome: "success" | "denied" | "error" | "queued" | "completed";
  detail?: string | null | undefined;
  metadata?: Record<string, JsonValue> | undefined;
  createdAt?: string | null | undefined;
};

export type ProductUsageSurface = "api" | "mcp" | "github_app" | "control_panel" | "browser_extension" | "internal";

export type ProductUsageOutcome = "success" | "denied" | "error" | "queued" | "completed" | "skipped";

export type ProductUsageRole = "miner" | "maintainer" | "owner" | "operator" | "contributor" | "unknown";

export type ProductUsageEventRecord = {
  id: string;
  surface: ProductUsageSurface;
  role: ProductUsageRole;
  eventName: string;
  route?: string | null | undefined;
  actorHash?: string | null | undefined;
  sessionHash?: string | null | undefined;
  repoFullName?: string | null | undefined;
  targetKey?: string | null | undefined;
  outcome: ProductUsageOutcome;
  latencyMs?: number | null | undefined;
  clientName?: string | null | undefined;
  clientVersion?: string | null | undefined;
  metadata: Record<string, JsonValue>;
  occurredAt: string;
};

export type ProductUsageSummary = {
  since?: string | null | undefined;
  totalEvents: number;
  activeActors: number;
  bySurface: Array<{ surface: ProductUsageSurface; count: number }>;
  byOutcome: Array<{ outcome: ProductUsageOutcome; count: number }>;
  byEvent: Array<{ eventName: string; count: number }>;
};

export type McpCompatibilityAdoptionSummary = {
  since?: string | null | undefined;
  totalEvents: number;
  activeActors: number;
  activeSessions: number;
  scannedEvents: number;
  scanLimit: number;
  truncated: boolean;
  minimumSupportedVersion: string;
  latestRecommendedVersion: string;
  staleEvents: number;
  incompatibleEvents: number;
  byClientVersion: ProductUsageDimensionCount[];
  byProtocolVersion: ProductUsageDimensionCount[];
  byCompatibilityStatus: Array<{ status: "current" | "stale" | "incompatible" | "unknown"; count: number }>;
};

export type ProductUsageDailyRollupStatus = "complete" | "partial" | "incomplete";

export type ProductUsageDimensionCount = {
  key: string;
  count: number;
};

export type ProductUsageRoleDimensionCount = {
  role: ProductUsageRole;
  count: number;
  activeActors: number;
  activeRepos: number;
};

export type ProductUsageActivationFunnel = {
  loginActors: number;
  doctorPassActors: number;
  firstUsefulActionActors: number;
  fullyActivatedActors: number;
  githubInstalledRepos: number;
  githubFirstCommandRepos: number;
  githubUsefulMaintainerRepos: number;
  githubActivatedRepos: number;
};

export type ProductUsageRoleActivationFunnel = ProductUsageActivationFunnel & {
  role: ProductUsageRole;
};

export type ProductUsageSurfaceActivationFunnel = ProductUsageActivationFunnel & {
  surface: ProductUsageSurface;
};

export type ProductUsageRetentionWindow = "previous_7_days" | "previous_30_days";

export type ProductUsageRetentionDimension = {
  activeActors: number;
  retainedActors: number;
  retentionRate: number;
};

export type ProductUsageRoleRetention = ProductUsageRetentionDimension & {
  role: ProductUsageRole;
};

export type ProductUsageSurfaceRetention = ProductUsageRetentionDimension & {
  surface: ProductUsageSurface;
};

export type ProductUsageRetentionRollup = ProductUsageRetentionDimension & {
  window: ProductUsageRetentionWindow;
  capped: boolean;
  byRole: ProductUsageRoleRetention[];
  bySurface: ProductUsageSurfaceRetention[];
};

export type ProductUsageDailyRollupRecord = {
  day: string;
  status: ProductUsageDailyRollupStatus;
  totalEvents: number;
  activeActors: number;
  activeSessions: number;
  activeRepos: number;
  sourceEventCount: number;
  maxEventCapacity: number;
  firstEventAt?: string | null | undefined;
  lastEventAt?: string | null | undefined;
  bySurface: Array<{ surface: ProductUsageSurface; count: number }>;
  byOutcome: Array<{ outcome: ProductUsageOutcome; count: number }>;
  byEvent: Array<{ eventName: string; count: number }>;
  byRepo: ProductUsageDimensionCount[];
  byCommand: ProductUsageDimensionCount[];
  byTool: ProductUsageDimensionCount[];
  byRouteClass: ProductUsageDimensionCount[];
  activation: ProductUsageActivationFunnel;
  byRole: ProductUsageRoleDimensionCount[];
  activationByRole: ProductUsageRoleActivationFunnel[];
  activationBySurface: ProductUsageSurfaceActivationFunnel[];
  retention: ProductUsageRetentionRollup[];
  generatedAt: string;
  updatedAt: string;
};

export type ProductUsageRollupRunResult = {
  generatedAt: string;
  requestedDays: string[];
  rollups: ProductUsageDailyRollupRecord[];
  status: ProductUsageRollupStatus;
};

export type ProductUsageRollupStatus = {
  status: "empty" | "ready" | "partial" | "stale" | "incomplete";
  generatedAt: string;
  latestEventAt?: string | null | undefined;
  latestRollupDay?: string | null | undefined;
  latestRollupGeneratedAt?: string | null | undefined;
  missingDays: string[];
  staleDays: string[];
  incompleteDays: string[];
  warnings: string[];
};

export type WeeklyValueReportVariant = "public" | "operator";

export type WeeklyValueReportMetric = {
  id: string;
  label: string;
  value: number;
  detail: string;
  visibility: "public" | "operator";
};

export type WeeklyValueReport = {
  generatedAt: string;
  variant: WeeklyValueReportVariant;
  publicSafe: boolean;
  period: {
    days: number;
    startDay?: string | null | undefined;
    endDay?: string | null | undefined;
    rollupDays: string[];
  };
  summary: string[];
  metrics: WeeklyValueReportMetric[];
  warnings: string[];
  freshness: {
    status: ProductUsageRollupStatus["status"];
    latestEventAt?: string | null | undefined;
    latestRollupDay?: string | null | undefined;
    latestRollupGeneratedAt?: string | null | undefined;
    warnings: string[];
  };
  dataQuality: {
    status: "ready" | "warn";
    warnings: string[];
  };
  operatorDetails?: {
    topRepos: ProductUsageDimensionCount[];
    topCommands: ProductUsageDimensionCount[];
    topTools: ProductUsageDimensionCount[];
    topRouteClasses: ProductUsageDimensionCount[];
    daily: Array<{
      day: string;
      status: ProductUsageDailyRollupStatus;
      totalEvents: number;
      activeActors: number;
      activeRepos: number;
    }>;
    activation: ProductUsageActivationFunnel;
  };
};
