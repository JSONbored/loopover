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
      /** Self-host OTEL trace context for connecting ingress → queued review work. */
      traceParent?: string;
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
      // One bounded re-gate unit: re-review + stamp a single PR. Each candidate becomes its own individually-
      // retryable, rate-limited queue message so the heavy re-review work interleaves with other jobs instead
      // of monopolizing the consumer. Producers: the scheduled sweep's stale-candidate fan-out
      // (#audit-sweep-fanout, deliveryId prefixed "regate-sweep:" — genuinely deferrable maintenance) and the
      // sweep's own outage-repair fan-out (deliveryId prefixed "regate-repair:" — a PR missing a current-head
      // Gate check or public-surface publish); a trailing coalesced re-review after a webhook burst; an
      // over-cap sibling wake; a linked-issue-change re-review. EXCEPT for the "regate-sweep:" prefix, every
      // producer carries the real webhook/event deliveryId that caused it — current-HEAD contributor-PR-review
      // work, never background maintenance (isScheduledRegateSweepJob / githubRateLimitAdmissionTargetForJob in
      // ../selfhost/queue-common.ts, #selfhost-queue-liveness).
      type: "agent-regate-pr";
      deliveryId: string;
      repoFullName: string;
      prNumber: number;
      installationId: number;
      /** Original GitHub PR creation time. Durable self-host queues use this to drain contributor PR work oldest-first. */
      prCreatedAt?: string | null | undefined;
      // #regate-churn (req 8): an explicit manual re-gate request — bypasses the AI review cache and the
      // bounded non-cacheable-reuse cooldown so it always pays for a fresh opinion. No current scheduled or
      // webhook-driven caller sets this; it exists so a manual trigger has a supported way to force a fresh
      // pass instead of reusing a recent (possibly disputed) result.
      force?: boolean | undefined;
      /** The head SHA this job was dispatched to repair; present only on priority-repair dispatches.
       *  Used by regatePullRequest to record the repair attempt at execution time (not dispatch time)
       *  so the cap in surfaceRepairPriorityPullNumbers counts actual runs, not queued jobs. */
      repairHeadSha?: string | undefined;
    }
  | {
      type: "refresh-registry";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      type: "sync-brokered-installed-repos";
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
      installationId?: number;
      mode?: "light" | "full" | "resume";
      force?: boolean;
      cursor?: string;
    }
  | {
      type: "backfill-pr-details";
      requestedBy: "schedule" | "api" | "test";
      repoFullName: string;
      installationId?: number;
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
      // A batch of logins to process in ONE job. Set by the cron fan-out (when the derived login set exceeds
      // CONTRIBUTOR_EVIDENCE_BATCH_SIZE) so the per-login GitHub reads spread across the queue instead of bursting.
      logins?: string[];
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
      // Maintainer review recap digest (#1963): build the recap for one repo and post it to that repo's
      // configured Discord webhook. Manually-triggerable only in this PR (`requestedBy: "api"`) -- the
      // scheduled cron trigger ("schedule") is a scoped follow-up, listed here now so the union already
      // documents the intended source without a later breaking change.
      type: "generate-review-recap";
      requestedBy: "schedule" | "api" | "test";
      repoFullName: string;
      windowDays?: number;
    }
  | {
      // Cross-repo maintainer recap digest (#1963, #2248): folds gate-precision + outcome-calibration across
      // every scanned repo into ONE RecapReport (buildMaintainerRecap, #2239) and delivers it to Discord --
      // distinct from "generate-review-recap" above, which is single-repo. No `repoFullName`: this is always
      // a global job, enqueued by the cron on a configurable daily/weekly cadence (GITTENSORY_RECAP_CADENCE).
      type: "generate-maintainer-recap";
      requestedBy: "schedule" | "api" | "test";
      windowDays?: number;
    }
  | {
      // Scheduled re-gate sweep (#777). No `repoFullName` = fan-out: enqueue one per agent-configured repo.
      // With `repoFullName` = recompute the gate verdict for that repo's stale open PRs (advisory/audit only).
      type: "agent-regate-sweep";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
      installationId?: number;
    }
  | {
      type: "run-agent";
      requestedBy: "api" | "mcp" | "github_comment" | "test";
      runId: string;
    }
  | {
      // Batched (#selfhost-maintenance-self-pin): every notification event detected from ONE webhook delivery
      // (a review event plus any issue-watch matches) rides in a single job, instead of one job per event --
      // that was flooding the maintenance lane with a job per watcher on a popular newly-opened issue. Always
      // non-empty at enqueue time (see processors.ts); the processor evaluates every event in the batch.
      type: "notify-evaluate";
      requestedBy: "webhook" | "test";
      events: DetectedNotificationEvent[];
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
      // Self-heal (flag-gated by GITTENSORY_SWEEP_WATCHDOG). Scan the SAME acting-autonomy repo set the
      // scheduled regate sweep covers for a stalled per-repo sweep (open PRs present, but none regated within
      // the staleness window) — emit a structured `sweep_liveness_stale` log AND re-enqueue a targeted
      // `agent-regate-sweep` for just that repo. Enqueued hourly by the cron ONLY when the flag is ON
      // (index.ts), so flag-OFF this job never exists.
      type: "sweep-liveness-watchdog";
      requestedBy: "schedule" | "api" | "test";
    }
  | {
      // Self-heal (flag-gated by GITTENSORY_PR_RECONCILIATION). List-diff GitHub's open PR numbers against the
      // local table for every acting-autonomy repo — a much tighter cadence than backfillRegisteredRepositories's
      // 6-hour freshness window — and catch up (fetch + upsert + regate) any PR number GitHub has that the local
      // table doesn't (a silently-lost "opened" webhook). Enqueued on a short interval ONLY when the flag is ON
      // (index.ts), so flag-OFF this job never exists.
      type: "reconcile-open-prs";
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
      installationId?: number;
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
    }
  | {
      // Self-host backlog-convergence sweep (#selfhost-backlog-convergence): finds open PRs whose public review
      // surface was never published for their current head (a blind spot the periodic re-gate sweep's dispatch-
      // time stamping can miss — see selfhost/backlog-convergence.ts) and fans out one `agent-regate-pr` job per
      // candidate. No `repoFullName` = fan-out: enqueue one per convergence-eligible repo, mirroring
      // "agent-regate-sweep". With `repoFullName` = sweep that one repo's stale-surface open PRs.
      type: "backlog-convergence-sweep";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
      installationId?: number;
    }
  | {
      // Scheduled repo-doc refresh (#3003, part of #2993). No `repoFullName` = fan-out: enumerate every repo
      // with `.gittensory.yml repoDocGeneration.enabled: true` whose refresh interval has elapsed and enqueue
      // one per-repo job each, mirroring "agent-regate-sweep"/"backlog-convergence-sweep". With `repoFullName` =
      // refresh that one repo via openRepoDocPullRequest (the SAME function the on-demand MCP trigger calls) --
      // no separate eligibility/diffing logic lives in the queue processor itself.
      type: "repo-doc-refresh-sweep";
      requestedBy: "schedule" | "api" | "test";
      repoFullName?: string;
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
    sha?: string;
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
   *  floor and `aiReviewLowConfidenceDisposition` (#4603) use it: a sub-floor finding still blocks the gate when
   *  `aiReviewMode` is `block`, but its DISPOSITION varies — `hold_for_review` (default) routes the PR to a manual
   *  hold instead of a one-shot close, `advisory_only` drops it to a non-blocking finding entirely, and `one_shot`
   *  ignores the floor (today's unconditional-close behavior). See `isConfiguredGateBlocker` and
   *  `resolveAiReviewLowConfidenceHold` in `src/rules/advisory.ts`. Absent for deterministic findings (they carry
   *  no model confidence); an absent/unparseable reviewer confidence degrades to 1.0 upstream, so omitting it here
   *  behaves exactly like an at-or-above-floor confidence. */
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
  /** GitHub's own PR creation time (`pull_request.created_at`) — the ground-truth order contributors actually
   *  opened their PRs in, independent of when gittensory's own webhook/sweep pipeline happened to observe or
   *  process this PR. NOT the same as {@link linkedIssueClaimedAt} (gittensory's own sync-time). Preferred for
   *  duplicate-cluster winner election when present on both sides being compared (#dup-winner). */
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  /** First time Gittensory observed this PR claiming one or more linked issues. Used to elect same-issue
   * duplicate winners by claim order instead of PR number ONLY when {@link createdAt} is unavailable on either
   * side of a comparison. */
  linkedIssueClaimedAt?: string | null | undefined;
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
  /** Linked-issue hard-rule violation memory (#linked-issue-hard-rule-persistence): the FIRST time this PR NUMBER
   *  was confirmed to violate a hard rule. Set once, NEVER cleared, NOT scoped to head SHA (mirrors
   *  draftConversionCount) — checked ADDITIONALLY alongside resolveLinkedIssueHardRule's own live re-parse so an
   *  edited body or a changed linked-issue live state can't erase an already-confirmed violation. Planner-written;
   *  read straight from the row. */
  linkedIssueHardRuleViolatedAt?: string | null | undefined;
  /** The specific rule reason text captured at the moment of the first violation (mirrors mergeBlockedReason's
   *  pairing with mergeBlockedSha) — so a later close can still cite the concrete rule even when the live re-parse
   *  can no longer reproduce it. */
  linkedIssueHardRuleViolationReason?: string | null | undefined;
  /** Visual-capture gate satisfaction (#4110): the head SHA at which the bot's before/after capture pipeline
   *  last produced a REAL before+after render pair (not a placeholder/failed/pending shot) for this PR. The
   *  screenshotTableGate treats visualCaptureSatisfiedSha === headSha as evidence equivalent to a hand-authored
   *  before/after table. Publish-written; read straight from the row. */
  visualCaptureSatisfiedSha?: string | null | undefined;
  /** File paths changed by this open PR, when the caller has already resolved them (e.g. from the
   *  `pull_request_files` cache). Absent/undefined when not resolved — callers must not assume an empty array
   *  means "no files changed". Mirrors {@link RecentMergedPullRequestRecord.changedFiles} so the same
   *  collision/preflight path-overlap scoring works for open PRs, not just merged history. */
  changedFiles?: string[] | undefined;
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

/** `gate.copycat.mode` (#1969) -- a dedicated 4-value enum rather than the shared {@link GateRuleMode}
 *  tri-state, since the issue's tiered response is warn -> label -> block -> strikes (where "strikes" is a
 *  separate escalation action reusing the existing cross-repo banned-contributors ledger, not a 5th mode
 *  value). See {@link RepositorySettings.copycatGateMode}'s doc comment for the currently-inert status. */
export type CopycatGateMode = "off" | "warn" | "label" | "block";

/** Review-check publish surface (#2852). Controls ONLY whether/how the "Gittensory Orb Review Agent" check-run
 *  is created/updated -- never the underlying gate evaluation, disposition, comments, labels, audit, or
 *  autonomous merge/close, all of which run identically in every mode (the autonomous decision engine already
 *  excludes the bot's own check-runs from the live CI aggregate it merges/closes against, see
 *  `BOT_OWNED_CHECK_NAMES` in `github/backfill.ts`, specifically to avoid a self-deadlock).
 *   • `required` — legacy/current behavior: publish/update the check exactly as before. For operators who
 *                  intentionally keep it as a required branch-protection status check.
 *   • `visible`  — publish/update the SAME check-run for UI visibility only. Never intended to be added as a
 *                  required branch-protection check; behaves identically to `required` on the publish side
 *                  (same API calls), the distinction is purely about how the operator should configure GitHub.
 *   • `disabled` — never create/update the check-run at all. Recommended for high-volume autonomous self-hosting
 *                  to avoid GitHub showing "Expected — Waiting for status to be reported" under queue pressure;
 *                  requires removing the check from branch-protection required-status-checks first (Gittensory
 *                  cannot do this on the operator's behalf -- it is a GitHub branch-protection setting). */
export type ReviewCheckMode = "required" | "visible" | "disabled";

/** Auto-project/milestone matching (#3183): detects when a PR is likely part of an open GitHub Milestone even
 *  with no closing-keyword issue link, and posts a bot-comment suggestion. `"off"` (default) runs no matching
 *  at all; `"suggest"` matches and posts a single advisory comment, never mutating the PR; `"auto"` (#3185,
 *  shipped) actually calls `attachToMilestone`/`attachToProject` for a high-confidence match instead of only
 *  commenting -- see `maybeSuggestMilestoneMatchForPr` in `integrations/project-tracker-adapter.ts`. */
export type ProjectMilestoneMatchMode = "off" | "suggest" | "auto";

/** Which backend {@link ProjectMilestoneMatchMode} matches against (#3186). `"github"` (default) uses the
 *  installed App's own GitHub Milestones/Projects v2 access; `"linear"` matches against a Linear workspace
 *  instead, using a per-repo encrypted API key (see `getDecryptedRepositoryLinearKey` in db/repositories.ts) --
 *  the key itself is never set here or via `.gittensory.yml`, only this backend CHOICE is config-as-code. */
export type ProjectMilestoneMatchBackend = "github" | "linear";

/** Which policy pack the gate runs under (#692). `gittensor` = the full Gittensor policy: registry/emissions-
 *  aware, and it threads the author's confirmed status for on-chain scoring (the gate verdict itself blocks
 *  every author the same — confirmed status no longer changes it, #gate-nonconfirmed). `oss-anti-slop` = a
 *  general, repo-agnostic pack: the same deterministic rules (slop/duplicate/linked-issue/readiness/AI-
 *  consensus) block ANY author, with no emissions/registry/Gittensor coupling — so the gate runs on any repo. */
export type GatePolicyPack = "gittensor" | "oss-anti-slop";

/**
 * How the independent AI-reviewer opinions are combined into ONE gate decision (#dual-ai-combiner). Canonical
 * definition lives here (not in `services/ai-review.ts`, which re-exports it) because both `RepositorySettings`
 * below and `signals/focus-manifest.ts` need it, and BOTH are imported by the UI workspace — `services/ai-review.ts`
 * pulls in ambient Cloudflare Workers types (`Env`, `D1Database`, …) the UI's tsconfig `lib` doesn't declare, so a
 * `import("../services/ai-review").CombineStrategy` type-only reference from either file would still drag that
 * whole module graph into the UI's typecheck and break it (#2567 follow-up fix).
 *   • `single`     — one reviewer; its verdict IS the decision (a named blocker blocks).
 *   • `consensus`  — two reviewers; block ONLY when BOTH name a blocker; lone blocker → split (hold). The
 *                    historical cloud behavior — the default, so an unset `combine` is byte-identical.
 *   • `synthesis`  — two reviewers run separately, then merge into ONE decision (no split/hold-on-disagree):
 *                    `onMerge: either` blocks if EITHER flags a blocker; `both` only if all do.
 */
export type CombineStrategy = "single" | "consensus" | "synthesis";
/** Synthesis merge rule — block if `either` reviewer flags a blocker, or only when `both` agree. See
 *  {@link CombineStrategy} for why the canonical definition lives here rather than `services/ai-review.ts`. */
export type OnMerge = "either" | "both";

/**
 * Disposition for an `ai_consensus_defect` / `ai_review_split` finding whose confidence is BELOW the
 * configured `aiReviewCloseConfidence` floor (#4603, resolving the dead-floor audit finding from commit
 * `311b7613d` / #1781). Only matters under `aiReviewMode: block` — a sub-floor finding is otherwise-identical
 * across all three values once confidence clears the floor.
 *   • `one_shot`        — today's live (pre-#4603) behavior: confidence is ignored, the defect always
 *                          one-shot-closes. Opt-in only, for maintainers who want max automation and accept
 *                          the false-positive risk.
 *   • `hold_for_review`  — the SHIPPED DEFAULT. The defect still blocks the merge (the gate check still fails,
 *                          a contributor still cannot merge as-is), but does NOT one-shot-close — it is routed
 *                          through the same held-for-manual-review mechanism the disposition planner already
 *                          uses for `migrationCollisionHold`/`unlinkedIssueMatchHold`
 *                          (`src/settings/agent-actions.ts`), not a second hold mechanism.
 *   • `advisory_only`    — a sub-floor finding drops to a fully non-blocking advisory (never a gate blocker).
 *                          For maintainers who would rather lean on other deterministic gates and never see a
 *                          review-hold queue.
 */
export type AiReviewLowConfidenceDisposition = "one_shot" | "hold_for_review" | "advisory_only";

/**
 * A multimodal content block for an AI provider message (#4111 — advisory-only AI-vision analysis of
 * before/after visual captures). Canonical definition lives here for the same UI-safety reason as
 * {@link CombineStrategy} above: this type carries no ambient Workers/Node types, so any file that needs it
 * (including the UI workspace) can import it without dragging in `Env`/`D1Database`.
 *   • `text`  — plain prompt text. The only content kind any message ever carried before this issue, so a
 *     message whose content is a plain `string` (never an array) is byte-identical to today.
 *   • `image` — a base64-encoded screenshot (`data`, no `data:` URI prefix) + its MIME type. Attached ONLY for
 *     a route the EXISTING pixel-diff threshold already confirmed changed (see
 *     `review/visual/visual-findings.ts`'s gating) — an unchanged route never costs a vision token. A
 *     provider that cannot consume images (the self-host subscription CLIs — see `selfhost/ai.ts`'s
 *     `contentText`) drops image blocks and sends the text blocks alone rather than failing the call.
 */
export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export const MAX_CONTRIBUTOR_OPEN_ITEM_CAP = 100;

export type RepositorySettings = {
  repoFullName: string;
  commentMode: "off" | "detected_contributors_only" | "all_prs";
  publicAudienceMode: "oss_maintainer" | "gittensor_only";
  publicSignalLevel: "minimal" | "standard";
  checkRunMode: "off" | "enabled";
  // #4620: "deep" removed -- it was never wired to any different behavior than "standard" (formatCheckRunOutput
  // and buildCheckRunAnnotations in rules/advisory.ts both branch only on `=== "minimal"` vs not).
  checkRunDetailLevel: "minimal" | "standard";
  /** Legacy shadow of {@link reviewCheckMode} (#2852), deprecated (#4618): a computed read-back value only,
   *  for API/dashboard back-compat display. `"enabled"` when `reviewCheckMode !== "disabled"`, else `"off"`
   *  -- see getRepositorySettings/upsertRepositorySettings in db/repositories.ts. No write path accepts this
   *  field anymore; set {@link reviewCheckMode} directly instead. */
  gateCheckMode: "off" | "enabled";
  /** Scheduled re-gate sweep candidate ordering (#3815). `staleness` (default) picks whichever open PR the
   *  sweep has gone longest WITHOUT re-gating (see selectRegateCandidates), which is what gives the sweep its
   *  documented full-coverage-in-ceil(open/max)-ticks convergence guarantee even under dry-run/pause (when
   *  GitHub's own `updatedAt` writes are suppressed). `oldest-first` instead always picks the oldest-created
   *  open PRs first, for an operator who wants deterministic creation-order draining over that guarantee.
   *  Selection-time only — real-time webhook-driven review is not gated by this and can process any PR at
   *  any time regardless of the chosen order. */
  regateSweepOrderMode: "staleness" | "oldest-first";
  /** The actual runtime authority for whether the "Gittensory Orb Review Agent" check-run publishes (#2852).
   *  See {@link ReviewCheckMode}. */
  reviewCheckMode: ReviewCheckMode;
  /** Auto-project/milestone matching (#3183). See {@link ProjectMilestoneMatchMode}. Always populated by the DB
   *  layer (default `"off"`); optional so existing settings fixtures/callers need not be touched. */
  autoProjectMilestoneMatch?: ProjectMilestoneMatchMode | undefined;
  /** Which backend {@link ProjectMilestoneMatchMode} matches against (#3186). See {@link ProjectMilestoneMatchBackend}.
   *  Always populated by the DB layer (default `"github"`); optional so existing settings fixtures/callers need
   *  not be touched. */
  autoProjectMilestoneMatchBackend?: ProjectMilestoneMatchBackend | undefined;
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
   *  >= 10 changed files OR >= 1000 changed (added+deleted) lines that would otherwise pass is HELD for manual review
   *  (neutral gate → "manual" verdict), never auto-merged and never a hard failure. Opt-in via `gate.size.mode`. */
  sizeGateMode?: GateRuleMode | undefined;
  /** Lockfile-tamper-risk gate (#2563). `off` (default/absent) = no scan; `advisory`/`block` = a changed
   *  `package-lock.json` whose diff changes a `resolved`/`integrity` value WITHOUT the same package's version
   *  changing in a changed `package.json`, or whose `resolved` URL points outside `registry.npmjs.org`, produces
   *  a `lockfile_tamper_risk` finding (`block` additionally hard-blocks). Distinct from the OSV.dev CVE analyzer
   *  in review-enrichment — this is a tamper/integrity-substitution check, not a known-CVE check. Config-as-code
   *  only — no DB column or dashboard toggle; set via `.gittensory.yml gate.lockfileIntegrity`. */
  lockfileIntegrityGateMode?: GateRuleMode | undefined;
  /** CLA / license-compatibility gate (#2564). `off` (default/absent) = no CLA check at all; `advisory`/`block` =
   *  evaluate the configured detection method(s) (`claConsentPhrase` and/or `claCheckRunName` + `claCheckRunAppSlug`) and raise a
   *  `cla_consent_missing` finding when neither confirms consent — `block` also hard-blocks the gate. Config-as-code
   *  only (no DB column, mirrors sizeGateMode) — set via `.gittensory.yml gate.claMode`. */
  claGateMode?: GateRuleMode | undefined;
  /** `gate.cla.consentPhrase`: a public-safe-filtered phrase a maintainer requires somewhere in the PR body (e.g.
   *  "I have read and agree to the CLA"), matched case-insensitively. `null`/absent ⇒ phrase-match detection is not
   *  configured. Config-as-code only, alongside {@link claGateMode}. */
  claConsentPhrase?: string | null | undefined;
  /** `gate.cla.checkRunName`: the name of a separate CLA-bot check-run this repo also runs (e.g. "CLA Assistant
   *  Lite"). A `success`/`neutral` conclusion for a check-run with this exact name (case-insensitive), produced
   *  by `claCheckRunAppSlug`, also satisfies consent. `null`/absent ⇒ check-run detection is not configured.
   *  Config-as-code only, alongside {@link claGateMode}. */
  claCheckRunName?: string | null | undefined;
  /** `gate.cla.checkRunAppSlug`: the trusted GitHub App slug that must have produced `claCheckRunName`. Required
   *  for check-run detection so contributor-controlled same-name runs cannot satisfy a blocking CLA gate. */
  claCheckRunAppSlug?: string | null | undefined;
  /** Copycat/plagiarism detection (#1969). `off` (default/absent) = no check; `warn`/`label`/`block` are
   *  escalating tiers a future containment/similarity engine would act on (`block` additionally hard-blocks;
   *  a further "strikes" escalation reuses the existing cross-repo banned-contributors ledger once wired).
   *  Config-as-code only — no DB column or dashboard toggle; set via `.gittensory.yml gate.copycat.mode`.
   *  CURRENTLY INERT: this field is parsed and threaded end-to-end, but no detection engine reads it yet —
   *  see {@link CopycatGateMode}'s doc comment in packages/gittensory-engine for the tracked follow-up plan. */
  copycatGateMode?: CopycatGateMode | undefined;
  /** `gate.copycat.minScore`: containment/similarity score (0-100) at/above which `copycatGateMode` would act,
   *  once the detection engine exists. `null`/absent ⇒ the engine's own default threshold. Config-as-code
   *  only, alongside {@link copycatGateMode}. */
  copycatGateMinScore?: number | null | undefined;
  /** `gate.expectedCiContexts` (#selfhost-ci-verification): maintainer-declared CI check/status context names to
   *  treat as required when GitHub branch protection returns no readable required-status-checks (unconfigured,
   *  or a 403 from a token lacking `administration:read` — common for GitHub App installations). Merged with any
   *  branch-protection required contexts when both exist; used ALONE when branch protection is null/empty; a
   *  repo with neither configured keeps the existing fold-all fail-closed behavior. A context missing from the
   *  commit ⇒ pending; a completed red check for a listed context ⇒ failed; every listed context settled clean
   *  ⇒ verified passed (no `ciCompletenessWarning`). Config-as-code only — no DB column; set via
   *  `.gittensory.yml gate.expectedCiContexts`. */
  expectedCiContexts?: ReadonlyArray<string> | null | undefined;
  /** Dry-run disposition (#gate-dryrun). When true, the gate renders the would-be merge/close/manual verdict (every
   *  advisory sub-gate promoted to block) WITHOUT enforcing — the posted check stays non-blocking. Lets advisory mode
   *  preview exactly what it would do before the maintainer flips to real enforcement. Default off. */
  gateDryRun?: boolean | undefined;
  /** Live premerge migrations/** collision recheck (#2550). When true, an agent-driven merge of a PR that
   *  touches migrations/** is preceded by a fresh GitHub Trees-API read of the base branch's CURRENT migration
   *  filenames — unioned with this PR's own new migration filenames — checked for a live numeric collision.
   *  A collision suppresses the merge and holds the PR with a rebase-needed label + comment instead of merging
   *  blind. Config-as-code only (no DB column, mirrors gateDryRun) — set via `.gittensory.yml`
   *  `gate.premergeContentRecheck`. Default off/undefined — opt-in, since it costs one extra, uncached
   *  GitHub API call for any PR that touches migrations/**. */
  premergeContentRecheck?: boolean | undefined;
  /** Merge-readiness gate (#merge-readiness). `off`/`advisory`/`block`. No min-score. Default `off`. */
  mergeReadinessGateMode: GateRuleMode;
  /** Focus-manifest policy gate (#555). When `block`, the focus manifest's declared policy (required-linked
   *  issue and test expectations) becomes an enforceable review-agent blocker. Path-based manual-review holds
   *  are configured separately through `settings.hardGuardrailGlobs`. An
   *  INDEPENDENT dimension, deliberately not folded into the merge-readiness composite. Default `off` — opt-in. */
  manifestPolicyGateMode: GateRuleMode;
  /** Self-authored linked-issue gate. When `block`, the gate closes a PR where the contributor also
   *  opened the linked issue (`pr.authorLogin === issue.authorLogin`). Defaults to `advisory` — the finding
   *  is surfaced in the review panel but never blocks unless the maintainer opts in. */
  selfAuthoredLinkedIssueGateMode: GateRuleMode;
  /** Linked-issue satisfaction gate (#1961/#3906). `off` = the AI assessment of whether the PR's diff
   *  satisfies its primary linked issue's intent never runs (byte-identical to today). `advisory` = it runs
   *  and renders as a collapsible section in the review comment, but never blocks. `block` = ALSO let a
   *  confidence-floor-passing "unaddressed" verdict become a gate blocker (`linked_issue_scope_mismatch`,
   *  confirmed-contributors only, like every other blocker). This is the DB-backed, dashboard-settable
   *  counterpart; `.gittensory.yml gate.linkedIssueSatisfaction` overrides it exactly like every other
   *  `gate:` field overrides its `RepositorySettings` counterpart. The near-identically-named, config-as-
   *  code-only `review.linkedIssueSatisfaction` manifest field (#2173) is folded in as a fallback alias
   *  (#4149) when `gate.linkedIssueSatisfaction` is unset — see `resolveEffectiveSettings` in
   *  `signals/focus-manifest.ts` — so setting either spelling has the same real effect. Default `off` —
   *  opt-in. */
  linkedIssueSatisfactionGateMode: GateRuleMode;
  /** First-time-contributor grace (#552). RESERVED / currently INERT (#2266): parsed, clamped, and threaded
   *  end-to-end, but the gate evaluator never reads it — a genuine newcomer with a real blocker is still
   *  one-shot closed exactly like a repeat contributor (blocker findings must remain closure outcomes).
   *  Setting this true has no runtime effect today; kept for potential future use. Default false. */
  firstTimeContributorGrace: boolean;
  /** Slop-risk threshold (0-100) at/above which `slopGateMode: block` blocks. Default 60 (the `high` band). */
  slopGateMinScore?: number | null | undefined;
  /** AI-assisted slop advisory (the `slopAiAdvisory` capability). When true AND `slopGateMode != off`, a
   *  free/default-reviewer pass (the configured self-host provider, or the legacy Workers-AI pair when
   *  none is configured) adds an ADVISORY-only `ai_slop_advisory` finding for semantic slop the
   *  deterministic detector cannot quantify. It NEVER feeds slopRisk or the gate (only the deterministic
   *  core blocks). Default false — opt-in via `.gittensory.yml gate.slop.aiAdvisory`. */
  slopAiAdvisory: boolean;
  /** AI maintainer review. `off` = no AI; `advisory` = post AI review notes only; `block` = ALSO let a
   *  dual-model high-confidence consensus defect become a gate blocker (confirmed-contributors only,
   *  like every other blocker). Default `off` — AI is opt-in. */
  aiReviewMode: GateRuleMode;
  /** Bring-your-own-key: when true and a provider key is configured for the repo, the advisory AI review
   *  is generated by the maintainer's frontier model (Anthropic/OpenAI) instead of the free/default
   *  reviewer. The consensus blocker always uses the free/default reviewer pair regardless (the configured
   *  self-host provider, or the legacy Workers-AI pair when none is configured), so BYOK never changes who
   *  can be blocked. Default false. */
  aiReviewByok: boolean;
  /** Config-as-code BYOK provider for the advisory write-up. `null` = use the configured key's own
   *  provider. When set, it must match the stored key's provider or BYOK is skipped (falls back to the
   *  free/default reviewer). The secret key itself is never here — only via the encrypted key store. */
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
  /** Configured AI-reviewer confidence floor (0-1) for close calibration (#7). Under `aiReviewMode: block`, AI
   *  defect findings remain BLOCKERS even when their confidence is below this floor — the floor never turns a
   *  real defect into a non-blocker on its own. What DOES vary below the floor is governed by the separate
   *  {@link aiReviewLowConfidenceDisposition} field (#4603): `hold_for_review` (default) routes a sub-floor
   *  blocker to manual review instead of one-shot-closing; `advisory_only` drops it to non-blocking; `one_shot`
   *  ignores the floor entirely. Config-as-code only — set via `.gittensory.yml gate.aiReview.closeConfidence`
   *  (no dashboard/DB column); unset ⇒ the gate uses the 0.93 default. Clamped to [0,1] at parse time. */
  aiReviewCloseConfidence?: number | null | undefined;
  /** Disposition for a sub-floor `ai_consensus_defect`/`ai_review_split` finding (#4603) — see
   *  {@link AiReviewLowConfidenceDisposition} for the full semantics of each value. Default `"hold_for_review"`.
   *  Unlike {@link aiReviewCloseConfidence}, this IS DB-backed/dashboard-settable (via the `/ai-review` route,
   *  alongside `aiReviewMode`) and also overridable via `.gittensory.yml gate.aiReview.lowConfidenceDisposition`
   *  — yml > DB > this default, resolved through the normal `resolveEffectiveSettings` chain like every other
   *  gate-setting field. */
  aiReviewLowConfidenceDisposition?: AiReviewLowConfidenceDisposition | null | undefined;
  /** Per-repo dual-AI combine-strategy override (#2567). Config-as-code only — set via `.gittensory.yml
   *  gate.aiReview.combine` (no dashboard/DB column); unset ⇒ the self-host operator's `AI_REVIEW_PLAN.combine`
   *  boot config (or `consensus` if the operator set nothing). A REFINEMENT of the operator's plan, not a
   *  bypass — `runGittensoryAiReview` clamps the resolved `onMerge` to the operator's floor (see
   *  {@link aiReviewOnMerge}); `combine` itself carries no floor semantics (single/consensus/synthesis are not
   *  ordered by strictness). */
  aiReviewCombine?: CombineStrategy | null | undefined;
  /** Per-repo `synthesis` merge-rule override (#2567): `either` blocks on ANY one reviewer's blocker (the
   *  STRICTER rule); `both` blocks only when every reviewer agrees (the more PERMISSIVE rule). Config-as-code
   *  only — set via `.gittensory.yml gate.aiReview.onMerge` (no dashboard/DB column). A repo override can only
   *  TIGHTEN the operator's `AI_REVIEW_PLAN.onMerge` floor (e.g. `either` → `either` is a no-op; `both` → an
   *  attempted loosening is clamped back to `either`). When the operator has not set an `onMerge` floor, any
   *  per-repo value is honored unclamped. See `resolveEffectiveAiReviewOnMerge` in `services/ai-review.ts`. */
  aiReviewOnMerge?: OnMerge | null | undefined;
  /** Per-repo reviewer-pair override (#2567): named self-host providers (e.g. `{ model: "claude-code" }`,
   *  `{ model: "codex" }`) to run instead of the operator's `AI_REVIEW_PLAN.reviewers` (or the free Workers-AI
   *  pair when the operator configured none). Config-as-code only — set via `.gittensory.yml
   *  gate.aiReview.reviewers` (no dashboard/DB column). Unlike {@link aiReviewOnMerge}, WHICH reviewers run
   *  carries no operator floor to violate (the floor is what triggers a hold/block, not who evaluates it), so a
   *  repo override always wins unclamped when set. */
  aiReviewReviewers?: ReadonlyArray<{ model: string; fallback?: string | null | undefined }> | null | undefined;
  /** When TRUE, the repo OWNER's (and maintainer's) own PRs are eligible for auto-CLOSE like a contributor's
   *  (still subject to the `close` autonomy class + the same adverse-signal conditions). Default FALSE — owner
   *  PRs are exempt from auto-close (merge or manual-hold only). Per-repo configurable so maintainers choose
   *  rather than inheriting a hardwired opinion. */
  closeOwnerAuthors: boolean;
  autoLabelEnabled: boolean;
  gittensorLabel: string;
  createMissingLabel: boolean;
  /** #label-decoupling: independently gates the per-PR TYPE/taxonomy label (bug/feature by the PR
   *  title, or priority via linked-issue label propagation — see `resolvePrTypeLabel` in
   *  `settings/pr-type-label.ts`). Distinct from {@link autoLabelEnabled} (which governs only the
   *  base {@link gittensorLabel} context label) and from `decidePublicSurface`'s public-surface gate
   *  (miner detection / `publicAudienceMode` / `includeMaintainerAuthors` / bot-author exclusion) —
   *  type labels are internal triage metadata applied unconditionally to every PR, not a
   *  contributor-facing signal, so neither of those public-surface conditions should suppress them.
   *  Default TRUE (matches the prior de-facto behavior before this field existed, when type labels
   *  were gated by `autoLabelEnabled` nested inside the public-surface check). Always populated by
   *  the DB layer; optional so existing settings fixtures/callers need not be touched. */
  typeLabelsEnabled?: boolean | undefined;
  /** Per-repo override of the TYPE/taxonomy label NAMES, keyed by category (#priority-linked-issue-gate,
   *  #label-modularity). Defaults to `DEFAULT_TYPE_LABELS` (`gittensor:bug`/`gittensor:feature`/
   *  `gittensor:priority`) in `settings/pr-type-label.ts` — a repo can override just one name (e.g. only
   *  `priority`) and keep the others default, AND/OR add arbitrary additional categories beyond the
   *  built-in three (e.g. `security: "area:security"`) for its own taxonomy. Always populated by the DB
   *  layer; optional so existing settings fixtures/callers need not be touched. */
  typeLabels?: PrTypeLabelSet | undefined;
  /** Linked-issue label propagation (#priority-linked-issue-gate): the ONLY mechanism that can ever
   *  select the configured priority label (or any other configured mapping's PR label) — never
   *  inferred from a PR's title, changed files, AI output, or existing PR labels. Default disabled
   *  (`enabled: false`, no mappings) — a self-hoster opts in per repo. Always populated by the DB
   *  layer; optional so existing settings fixtures/callers need not be touched. */
  linkedIssueLabelPropagation?: LinkedIssueLabelPropagationConfig | undefined;
  /** Deterministic linked-issue hard rules. Config-as-code only; set with
   *  `.gittensory.yml settings.linkedIssueHardRules` in private/global or per-repo config. These rules close
   *  contributor PRs that link ineligible issues before spending AI review budget: owner/other-assigned,
   *  maintainer-only, or missing point-label issues. Defaults all-off so self-hosters opt into their own policy. */
  linkedIssueHardRules?: LinkedIssueHardRulesConfig | undefined;
  /** Same-account issue-avoidance guardrail (#unlinked-issue-guardrail). Config-as-code only; set with
   *  `.gittensory.yml settings.unlinkedIssueGuardrail` in private/global or per-repo config. Defaults
   *  all-off so a self-hoster opts into their own credibility-gate-farming defense. */
  unlinkedIssueGuardrail?: UnlinkedIssueGuardrailConfig | undefined;
  /** Per-capability local-inference routing (#4364). Config-as-code only; set with `.gittensory.yml
   *  settings.advisoryAiRouting` in shared/global or per-repo config. Defaults all-false so every advisory
   *  capability stays on the shared frontier env.AI chain until an operator opts each one in. */
  advisoryAiRouting?: AdvisoryAiRoutingConfig | undefined;
  /** Governs ONLY the PR comment and label -- never the "Gittensory Context" check ({@link checkRunMode})
   *  or the "Gittensory Orb Review Agent" gate check ({@link reviewCheckMode}), which are independent axes
   *  by design (#2852: the check-run must keep posting for branch-protection/auto-merge to keep working
   *  even when a maintainer wants full public silence). Setting this to `"off"` does NOT silence either
   *  check-run -- see README's "Check-run and comment surfaces, disambiguated" section. */
  publicSurface: "off" | "comment_and_label" | "comment_only" | "label_only";
  includeMaintainerAuthors: boolean;
  /** Surfaces the `missing_linked_issue` advisory finding in the review comment -- does NOT block a PR on
   *  its own. The real blocking authority is {@link RepositorySettings.linkedIssueGateMode} `=== "block"`
   *  (default `"advisory"`); the one place this flag alone promotes to a real block
   *  (`resolveEffectiveSettings` in `src/signals/focus-manifest.ts`) only fires when `linkedIssueGateMode`
   *  is explicitly `"off"`, so at the default it never does. A maintainer wanting a real linked-issue
   *  requirement must set `linkedIssueGateMode: "block"`, not just this toggle. */
  requireLinkedIssue: boolean;
  backfillEnabled: boolean;
  /** Opt-in for the public, unauthenticated README status badge (#541). Always populated by the DB layer
   *  (default false); optional so existing settings fixtures/callers need not be touched. */
  badgeEnabled?: boolean | undefined;
  /** Opt-in for the public per-repo review-quality page (#2568). Always populated by the DB layer
   *  (default false); optional so existing settings fixtures/callers need not be touched. */
  publicQualityMetrics?: boolean | undefined;
  commandAuthorization?: RepositoryCommandAuthorizationPolicy | undefined;
  /** Per-repo contributor blacklist (#1425, anti-abuse): banned GitHub logins whose PRs/issues the engine
   *  deterministically closes ahead of merit review. Layered the same as other settings (`.gittensory.yml` >
   *  DB) and unioned with the shared/global list at the point of use. Always populated by the DB layer
   *  (default `[]`); optional so existing settings fixtures/callers need not be touched. */
  contributorBlacklist?: ContributorBlacklistEntry[] | undefined;
  /** The label applied to a blacklisted contributor's PR (#1425). Configurable per-repo (dashboard/DB +
   *  `.gittensory.yml` `settings.blacklistLabel`); defaults to `"slop"` so the disposition works regardless of
   *  the label a repo sets. Explicit `null` closes WITHOUT applying any label (the same load-bearing-null idiom
   *  as {@link contributorOpenPrCap}) -- distinct from omitted/undefined, which uses the default. Always
   *  populated by the DB layer (default `"slop"`); optional so existing settings fixtures/callers need not be
   *  touched (mirrors the sibling `contributorBlacklist`). */
  blacklistLabel?: string | null | undefined;
  /** Per-contributor open-PR cap (#2270, anti-abuse): the max PRs a single non-owner/admin/bot contributor may
   *  have open on this repo at once. `null`/absent (default) = no cap, byte-identical to today. Layered like
   *  every other settings field (`.gittensory.yml` `settings.contributorOpenPrCap` > DB > `null`). Capped at
   *  {@link MAX_CONTRIBUTOR_OPEN_ITEM_CAP} so the fixed live-verification sample can enforce the threshold. */
  contributorOpenPrCap?: number | null | undefined;
  /** Per-contributor open-issue cap (#2270, anti-abuse): same shape and precedence as {@link contributorOpenPrCap},
   *  applied to open issues instead of open PRs. `null`/absent (default) = no cap. Also capped at
   *  {@link MAX_CONTRIBUTOR_OPEN_ITEM_CAP}. */
  contributorOpenIssueCap?: number | null | undefined;
  /** The label applied to a PR/issue closed for exceeding a per-contributor open-item cap (#2270). Same
   *  configurable-with-fallback shape as {@link blacklistLabel} (including the explicit-`null`-closes-without-a-
   *  label idiom); defaults to `"over-contributor-limit"` so the disposition works regardless of the label a
   *  repo sets. Always populated by the DB layer; optional so existing settings fixtures/callers need not be
   *  touched. */
  contributorCapLabel?: string | null | undefined;
  /** Cancel in-flight CI runs on a contributor_cap close (#2462, anti-abuse): when true, after a PR is
   *  auto-closed for exceeding {@link contributorOpenPrCap}, gittensory lists and cancels that PR's
   *  in-progress/queued Actions runs at its head SHA. Requires the App installation to have granted
   *  `actions: write` -- degrades gracefully (skipped + logged, never blocks the close) when it hasn't.
   *  `null`/undefined (the DB-layer default) means "unset" and falls back to the
   *  `CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT` env var -- unlike most boolean toggles, this one is nullable so an
   *  explicit `false` (opt back out) is distinguishable from "not configured" for that fallback. */
  contributorCapCancelCi?: boolean | null | undefined;
  /** Review-request nagging cooldown (#2463, anti-abuse): throttle a contributor repeatedly pinging
   *  `@gittensory` (any command) on this repo. `"off"` (default) is a no-op; `"hold"` posts a deterministic
   *  cooldown reply and takes no further action; `"close"` additionally closes the thread (PR threads only in
   *  v1 — a plain issue thread degrades to `"hold"` behavior until #2493's `closeIssue` primitive lands).
   *  Always populated by the DB layer (default `"off"`); optional so existing settings fixtures/callers need
   *  not be touched. */
  reviewNagPolicy?: "off" | "hold" | "close" | undefined;
  /** Review-nag cooldown (#2463): how many `@gittensory` pings a contributor may make on this repo within
   *  {@link reviewNagCooldownDays} before the (N+1)th is throttled. Always populated by the DB layer (default
   *  `3`); optional so existing settings fixtures/callers need not be touched. Only meaningful when
   *  {@link reviewNagPolicy} is not `"off"`. */
  reviewNagMaxPings?: number | undefined;
  /** Review-nag cooldown (#2463): the rolling window (in days) {@link reviewNagMaxPings} counts against. Always
   *  populated by the DB layer (default `5`); optional so existing settings fixtures/callers need not be
   *  touched. */
  reviewNagCooldownDays?: number | undefined;
  /** The label applied to a thread closed for review-nag cooldown (#2463), mirroring {@link blacklistLabel}'s
   *  configurable-with-fallback shape (including the explicit-`null`-closes-without-a-label idiom). Always
   *  populated by the DB layer (default `"review-nag-cooldown"`); optional so existing settings
   *  fixtures/callers need not be touched. */
  reviewNagLabel?: string | null | undefined;
  /** Maintainer-mention nag moderation: GitHub logins to ALSO throttle under the review-nag cooldown when the
   *  thread author repeatedly @-mentions them (on top of the bot's own `@gittensory` handle) -- e.g. a
   *  maintainer login instead of the bot, for a contributor who keeps tagging a specific person for review.
   *  Counted independently per mentioned login and independently of the `@gittensory` counter, but reuses the
   *  SAME {@link reviewNagPolicy}/{@link reviewNagMaxPings}/{@link reviewNagCooldownDays}/{@link reviewNagLabel}
   *  thresholds/action/label -- one cooldown policy, multiple watched mention targets. `[]`/undefined (default)
   *  = no logins watched, zero behavior change. Never fires for the repo owner, admin logins, automation bots,
   *  or a login on {@link autoCloseExemptLogins}. */
  reviewNagMonitoredMentions?: string[] | undefined;
  /** Shared repo-scoped exemption list (#2463, anti-abuse): GitHub logins that are NEVER throttled or closed by
   *  gittensory's deterministic anti-abuse mechanisms (review-nag and the per-contributor open-item cap above),
   *  on top of the standing owner/admin/automation-bot exemption. Always populated by the DB layer (default
   *  `[]`); optional so existing settings fixtures/callers need not be touched. */
  autoCloseExemptLogins?: string[] | undefined;
  /** Hard manual-review guardrail globs. Config-as-code only: set in private/global or per-repo
   *  `.gittensory.yml` under `settings.hardGuardrailGlobs`. Absent means no path guardrails. Arrays are
   *  replacement overlays, so a repo can clear a global default with `[]`. */
  hardGuardrailGlobs?: string[] | null | undefined;
  /** Label applied when an otherwise-ready PR is held for manual review by a guardrail. Config-as-code only;
   *  `null` disables the label while keeping the hold. Distinct from `review_state_label`, so operators can
   *  apply one manual-review label without enabling ready/changes-requested disposition labels. */
  manualReviewLabel?: string | null | undefined;
  /** Optional review-state label names. Config-as-code only; each `null` disables that specific label. These are
   *  deliberately generic defaults rather than `gittensory:*` names so self-hosters can opt into their own
   *  taxonomy without inheriting project-specific labels. */
  readyToMergeLabel?: string | null | undefined;
  changesRequestedLabel?: string | null | undefined;
  migrationCollisionLabel?: string | null | undefined;
  pendingClosureLabel?: string | null | undefined;
  /** Force-rebase-before-merge window in minutes (#2552, anti-race). When a base branch has advanced within
   *  this many minutes of the actual merge-decision moment, an agent-driven merge forces an `update_branch` +
   *  fresh CI recheck cycle first, rather than trusting a `mergeableState: clean` read that may already be
   *  stale relative to a sibling commit that just landed on the base. `null`/undefined (default) = never
   *  force -- a `mergeable_state: clean` read is trusted exactly as it is today. Layered like every other
   *  settings field (`.gittensory.yml` `gate.requireFreshRebaseWindow` > DB > `null`). */
  requireFreshRebaseWindowMinutes?: number | null | undefined;
  /** Account-age throttle (#2561, anti-abuse): an account younger than this many days gets the
   *  {@link newAccountLabel} and a tighter effective contributor cap — friction/visibility, NEVER an
   *  automatic close on account age alone. `null`/undefined (default) = off. Never fires for the repo
   *  owner, admin logins, or automation bots. Applies on both PR and issue contributor-cap paths. */
  accountAgeThresholdDays?: number | null | undefined;
  /** The label applied to a below-threshold-age account's PR (#2561), mirroring {@link blacklistLabel}'s
   *  configurable-with-fallback shape. Always populated by the DB layer (default `"new-account"`); optional so
   *  existing settings fixtures/callers need not be touched. */
  newAccountLabel?: string | undefined;
  /** Per-command @gittensory rate limit (#2560, anti-abuse): generalizes the review-nag cooldown's counting
   *  pattern (the audit-events ledger) to EVERY `@gittensory` command, keyed by `(actor, command, targetKey)` --
   *  independent of, and complementary to, review-nag's own narrower thread-author-only scope. `"off"` (default)
   *  is a no-op; `"hold"` posts a deterministic cooldown reply and skips the command's own dispatch. Always
   *  populated by the DB layer (default `"off"`); optional so existing settings fixtures/callers need not be
   *  touched. */
  commandRateLimitPolicy?: "off" | "hold" | undefined;
  /** Per-command rate limit (#2560): how many invocations of a single command an actor may make within
   *  {@link commandRateLimitWindowHours} before the (N+1)th is throttled -- for a CHEAP command (cache-only,
   *  no AI orchestrator call). Always populated by the DB layer (default `20`); optional so existing settings
   *  fixtures/callers need not be touched. Only meaningful when {@link commandRateLimitPolicy} is not `"off"`. */
  commandRateLimitMaxPerWindow?: number | undefined;
  /** Per-command rate limit (#2560): the same threshold as {@link commandRateLimitMaxPerWindow}, but for an
   *  AI-cost-bearing command (dispatches to a real orchestrator call: `ask`, `blockers`, `preflight`,
   *  `reviewability`, `packet`, `duplicate-check`, `next-action`, `repo-fit`). Deliberately tighter than the
   *  cheap-command default. Always populated by the DB layer (default `5`); optional so existing settings
   *  fixtures/callers need not be touched. */
  commandRateLimitAiMaxPerWindow?: number | undefined;
  /** Per-command rate limit (#2560): the rolling window (in hours) both {@link commandRateLimitMaxPerWindow}
   *  and {@link commandRateLimitAiMaxPerWindow} count against. Always populated by the DB layer (default `24`);
   *  optional so existing settings fixtures/callers need not be touched. */
  commandRateLimitWindowHours?: number | undefined;
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
   *  performing any GitHub mutation -- but this is NOT a cost-free preview: AI/LLM review calls still
   *  execute and still incur their normal provider cost (deliberate design tagged `#token-bleed-spend-gate`
   *  in `ai-review-orchestration.ts`/`agent-orchestrator.ts`/`processors.ts`; every spend gate checks only
   *  `agentPaused`, never this field). Default false. */
  agentDryRun?: boolean | undefined;
  /** Per-repo override of the global DB-backed agent freeze (#4372): when true, this repo's actions execute
   *  even while `global_agent_controls.frozen` is set, so an operator can re-activate one repo at a time
   *  without lifting the fleet-wide brake. Never overrides the `AGENT_ACTIONS_PAUSED` env var, and
   *  {@link agentPaused} on this same repo still wins over it. Default false. */
  agentGlobalFreezeOverride?: boolean | undefined;
  /** Moderation-rules engine (#selfhost-mod-engine): whether the whole layer runs on THIS repo. `"inherit"`
   *  (the DB default) defers to `global_moderation_config.enabled`; `"off"`/`"enabled"` force this repo
   *  regardless of the global default. Always populated by the DB layer; optional so existing settings
   *  fixtures/callers need not be touched. */
  moderationGateMode?: "inherit" | "off" | "enabled" | undefined;
  /** Moderation-rules engine: a per-repo override of WHICH of the anti-abuse mechanisms (contributor cap,
   *  blacklist, review-nag, review-evasion) feed a contributor's shared, cross-repo violation tally.
   *  `undefined`/absent ⇒ inherit the global rule set (`resolveEffectiveModerationRules`'s default shape). */
  moderationRules?: ("contributor_cap" | "blacklist" | "review_nag" | "review_evasion")[] | undefined;
  /** Moderation-rules engine: per-repo override of the label applied at >=1 lifetime violation. `undefined` ⇒
   *  the global config's `warningLabel` (itself defaulting to `"mod:warning"`). */
  moderationWarningLabel?: string | undefined;
  /** Moderation-rules engine: per-repo override of the label applied at >= the ban threshold. `undefined` ⇒
   *  the global config's `bannedLabel` (itself defaulting to `"mod:banned"`). */
  moderationBannedLabel?: string | undefined;
  /** Waste elimination for known automation authors (release-please's github-actions[bot], Renovate,
   *  Dependabot -- settings/agent-actions.ts's PROTECTED_AUTOCLOSE_AUTHORS): skip AI review, gate evaluation,
   *  and public-surface publish entirely for a PR/event genuinely triggered by one of these -- not just
   *  suppress output like {@link "./review-eligibility".ignoreAuthors}. `"inherit"` (the DB default) defers
   *  to the `GITTENSORY_SKIP_AUTOMATION_BOT_PRS` global default (itself default-ON, unlike most feature
   *  flags -- see settings/automation-bot-skip.ts's own doc comment for why); `"off"`/`"enabled"` fully
   *  override the global default in either direction for this repo. Always populated by the DB layer;
   *  optional so existing settings fixtures/callers need not be touched. */
  skipAutomationBotAuthors?: "inherit" | "off" | "enabled" | undefined;
  /** Review-evasion protection (#review-evasion-protection): a contributor closing or converting their OWN
   *  PR to draft while gittensory has an ACTIVE review pass running against it is dodging the one-shot
   *  review process. `"off"` (the default) disables detection entirely; `"close"` reopens (if needed) and
   *  re-closes as the App -- a close the contributor cannot themselves reopen (#one-shot-reopen) -- applies
   *  the configured label/comment, and records a `review_evasion` moderation strike. */
  reviewEvasionProtection?: "off" | "close" | undefined;
  /** Merge-train FIFO gate (#selfhost-merge-train): without this, a PR merges the instant its OWN gate
   *  clears, with zero awareness of an older sibling PR still open in the same repo -- proven live to cause
   *  out-of-order merges and the conflicts that follow. `"off"` (the default) is unchanged behavior.
   *  `"audit"` logs what the gate WOULD hold, without actually holding anything -- the safe way to validate
   *  the fix before enabling it for real. `"enforce"` actually defers a merge behind a still-viable older
   *  sibling, bounded by a staleness cap (see {@link "../review/merge-train"}) so one stuck old PR can never
   *  block newer ones forever. */
  mergeTrainMode?: "off" | "audit" | "enforce" | undefined;
  /** Review-evasion protection: label applied alongside the enforcement close, gated on `close` autonomy
   *  like every other anti-abuse label (#label-scoping), mirroring {@link blacklistLabel}'s shape. `undefined`
   *  ⇒ the `"review-evasion"` default; explicit `null` ⇒ close without any label. */
  reviewEvasionLabel?: string | null | undefined;
  /** Review-evasion protection: whether to post the public explanation comment before the enforcement close.
   *  Default true. */
  reviewEvasionComment?: boolean | undefined;
  /** Config-driven before/after screenshot-table gate (#2006): a DETERMINISTIC check (no AI, zero hallucination
   *  risk) that a contributor visual/frontend PR's body contains a markdown table with before/after image
   *  markup, scoped to the repo's configured labels/paths (`whenLabels`/`whenPaths`, OR-matched). Off by
   *  default (`enabled: false`) -- opt in per repo, mirroring every other anti-abuse mechanism's shape. See
   *  `review/screenshot-table-gate.ts` for the normalizer and the pure evaluator. */
  screenshotTableGate?: ScreenshotTableGateConfig | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

/** #4110: `request_changes`/`comment` were REMOVED (not just left unused) -- they were fully typed/validated
 *  but `src/queue/processors.ts` only ever branched on `=== "close"`, so setting either in `.gittensory.yml`
 *  silently did nothing. A legacy config with either removed value normalizes to the default ("close") with a
 *  warning, exactly like any other invalid value.
 *  `"advisory"` (#4535) is a NEW, actually-wired value, not a resurrection of either removed one: the gate
 *  still computes the violation and its reason, but `src/queue/processors.ts` only ever folds the result into
 *  the close-triggering `screenshotTableMatch` when `action === "close"` -- so `"advisory"` is a real no-op on
 *  merge/close by construction, with visibility left to the AI reviewer's own commentary (its context is
 *  expected to mention the same completeness requirement -- see the review-context sync in the #4540 PR). */
export type ScreenshotTableGateAction = "close" | "advisory";

/** Per-repo config for the before/after screenshot-table gate (#2006). See {@link RepositorySettings.screenshotTableGate}
 *  and `review/screenshot-table-gate.ts` for the normalizer + pure evaluator. */
export type ScreenshotTableGateConfig = {
  enabled: boolean;
  whenLabels: string[];
  whenPaths: string[];
  action: ScreenshotTableGateAction;
  /** Full replacement for the rejection reason -- when set, this is used verbatim and NEITHER the
   *  auto-generated matrix "still missing: ..." list NOR `skillFileUrl` appear (a maintainer who sets
   *  this owns the entire message). Leave unset to get the auto-generated, always-accurate message
   *  (naming the exact missing pairs in matrix mode) with `skillFileUrl` appended when configured --
   *  that combination is usually what you want; only set `message` for total control over the wording. */
  message?: string | undefined;
  /** Viewport x theme completeness matrix (#4535). Both empty (the default) ⇒ byte-identical to the original
   *  presence-only check (some image-bearing table, anywhere). A non-empty `requireViewports` switches the
   *  evaluator into matrix mode: every configured viewport (crossed with every configured theme, when
   *  `requireThemes` is also non-empty) must have its own labeled before/after row in the PR body's table --
   *  see `review/screenshot-table-gate.ts` for the row-matching heuristic. `requireThemes` alone (viewports
   *  empty) has no effect -- the viewport dimension is what turns matrix mode on. */
  requireViewports: string[];
  requireThemes: string[];
  /** A link to this repo's contributor skill file, appended to the AUTO-GENERATED rejection message
   *  (#4540 follow-up) so a closed contributor always gets pointed at the exact format/contract instead
   *  of just being told evidence is missing. Ignored when `message` is set (a full override already
   *  owns the entire text -- append the link into that string yourself if you want it there too). */
  skillFileUrl?: string | undefined;
};

export type CommandAuthorizationRole = "maintainer" | "collaborator" | "pr_author" | "confirmed_miner";

export type RepositoryCommandAuthorizationPolicy = {
  default: CommandAuthorizationRole[];
  commands: Record<string, CommandAuthorizationRole[]>;
};

/** Per-repo-configurable TYPE/taxonomy label NAMES, keyed by an arbitrary category name
 *  (#label-modularity). `bug`/`feature`/`priority` are the built-in categories `deriveKindFromTitle`
 *  and the priority-linked-issue-gate know how to CLASSIFY, but the map itself is an open
 *  `category -> label name` record -- a self-hoster can add any number of additional categories (e.g.
 *  `security: "area:security"`) that never get chosen by title-classification, only ever by a
 *  configured `linkedIssueLabelPropagation` mapping (any `prLabel`, not just a `typeLabels` value, can
 *  be propagated -- registering a category here just makes it participate in the mutual-exclusivity
 *  cleanup `resolvePrTypeLabel` computes, i.e. it becomes eligible for automatic removal when a PR's
 *  classification moves away from it). See `resolvePrTypeLabel` in `settings/pr-type-label.ts`. */
export type PrTypeLabelSet = Record<string, string>;

/** One linked-issue → PR label mapping (#priority-linked-issue-gate). See
 *  `LinkedIssueLabelPropagationConfig` below and `review/linked-issue-label-propagation.ts`. */
export type LinkedIssueLabelPropagationMapping = {
  issueLabel: string;
  prLabel: string;
  removeOtherTypeLabels: boolean;
  /** Allow this mapping to fire off a linked issue authored by the repo's owner/admin/write-collaborator
   *  even when the PR author neither opened nor is assigned to that issue (#priority-linked-issue-gate-
   *  ownership). Defaults to `false`/unset (today's strict author-or-assignee-only behavior) -- a
   *  maintainer-reward mapping like `gittensor:priority` should never set this, since it is exactly the
   *  scarce, hand-picked label a contributor could otherwise farm by citing an unrelated issue they had no
   *  part in. See `review/linked-issue-label-propagation-fetch.ts`'s `isRepoMaintainerLogin`. */
  trustMaintainerAuthoredIssue?: boolean | undefined;
  /** Like `trustMaintainerAuthoredIssue`, but for a mapping that DOES carry real reward weight (#priority-
   *  linked-issue-gate-ownership, #priority-reward-maintainer-trust) -- e.g. `gittensor:priority`. Deliberately
   *  a SEPARATE, distinctly-named flag rather than reusing `trustMaintainerAuthoredIssue`, so a repo that wants
   *  the strict author-or-assignee bar preserved for its reward label keeps that behavior by default; this must
   *  be explicitly opted into. GitHub silently refuses to assign a contributor lacking push/triage access to the
   *  repo (`ensurePullRequestAssignee`'s own doc comment) -- so for a repo whose issues are opened for open
   *  pickup and rarely formally assigned, requiring a literal GitHub assignee relationship means the reward
   *  label can structurally never propagate to most real external contributors, no matter how the assign action
   *  is timed. This flag accepts the SAME evidence bug/feature already trust (a maintainer authored the linked
   *  issue) as sufficient for the reward label too, when a repo's operator has decided that's the intended
   *  workflow (e.g. a maintainer hand-labels an issue `gittensor:priority` specifically to attract ANY
   *  contributor to pick it up, per the label's own "reserved for outstanding work" framing -- the hand-picking
   *  already happened at issue-labeling time, not gated on which contributor later closes it). */
  trustMaintainerAuthoredIssueForReward?: boolean | undefined;
};

export type LinkedIssueLabelPropagationMode = "exclusive_type_label";

/** Config-driven propagation of a linked/closing issue's GitHub label onto the PR
 *  (#priority-linked-issue-gate). Built so a maintainer-reward/bonus label (e.g. `gittensor:priority`)
 *  can never be inferred from a PR's title, changed files, AI output, or existing PR labels -- only
 *  ever copied from a linked issue that already carries it. See
 *  `review/linked-issue-label-propagation.ts` for the normalizer and the fetch orchestrator. */
export type LinkedIssueLabelPropagationConfig = {
  enabled: boolean;
  mode: LinkedIssueLabelPropagationMode;
  mappings: LinkedIssueLabelPropagationMapping[];
};

export type LinkedIssueHardRulesMode = "block" | "off";

export type LinkedIssueHardRulesConfig = {
  ownerAssignedClose: LinkedIssueHardRulesMode;
  /** Close when an open linked issue is assigned to someone other than the PR author. */
  assignedIssueClose: LinkedIssueHardRulesMode;
  missingPointLabelClose: LinkedIssueHardRulesMode;
  maintainerOnlyLabelClose: LinkedIssueHardRulesMode;
  pointBearingLabels: string[];
  maintainerOnlyLabels: string[];
  defaultLabelRepo: boolean;
  verifyBeforeClose: boolean;
  closeDelaySeconds: number;
};

/** "hold" evaluates a linkless PR against the repo's open issues and HOLDS it for manual review on a
 *  verified direct match (never auto-closes); "off" (default) never runs the check. */
export type UnlinkedIssueGuardrailMode = "hold" | "off";

/** Same-account issue-avoidance guardrail (#unlinked-issue-guardrail, credibility-gate-farming defense):
 *  when a PR links NO issue, check whether it directly, unambiguously solves an EXISTING open issue that
 *  was never linked. Config-as-code only, `.gittensory.yml settings.unlinkedIssueGuardrail`; defaults
 *  all-off so a self-hoster opts in per repo. `minConfidence` bounds false positives — the AI verifier
 *  must clear this bar (0-1) before a match holds anything. */
export type UnlinkedIssueGuardrailConfig = {
  mode: UnlinkedIssueGuardrailMode;
  minConfidence: number;
};

/** Per-capability opt-in to the local-inference AI_ADVISORY binding (#4364): each of these ADVISORY-ONLY
 *  (never gate-blocking) capabilities independently decides whether it routes through env.AI_ADVISORY (when
 *  configured) instead of the shared frontier env.AI chain. Config-as-code only, `.gittensory.yml
 *  settings.advisoryAiRouting` (global default in shared/root config, per-repo override); defaults all-false
 *  so an operator must deliberately opt each capability in.
 *
 *  `chatQa` (#4595) is the ONE capability that does NOT share the others' silent-frontier fallback BY DEFAULT:
 *  the four cost-optimizing capabilities above quietly fall back to the shared frontier env.AI when their flag
 *  is off, but the `@gittensory chat` grounded Q&A surface declines/skips whenever `chatQa !== true` or
 *  `env.AI_ADVISORY` is unconfigured, rather than ever spending a frontier token -- UNLESS `chatQaFrontierFallback`
 *  is also explicitly enabled (a self-hoster without a local GPU may prefer their own frontier subscription
 *  over an outright decline). */
export type AdvisoryAiRoutingConfig = {
  slop: boolean;
  e2eTestGen: boolean;
  planner: boolean;
  summaries: boolean;
  /** Grounded `@gittensory chat <question>` LLM Q&A (#4595). Ollama-first: declines when off or when
   *  env.AI_ADVISORY is unconfigured and {@link chatQaFrontierFallback} is not also enabled. Default false. */
  chatQa: boolean;
  /** Opt-in ONLY (#4595 follow-up): when true, chat falls back to the shared frontier env.AI chain if
   *  env.AI_ADVISORY is unconfigured, instead of declining. Meaningless unless {@link chatQa} is also true.
   *  Default false -- preserves the original Ollama-only behavior for every existing deployment; a self-hoster
   *  without a local GPU may enable this to use their own frontier subscription/tokens for chat instead. */
  chatQaFrontierFallback: boolean;
  /** Closed-set intent-classification router for unrecognized `@gittensory` mentions (#4596): maps free-text
   *  questions to the closest existing Q&A command (never an action command) rather than the plain
   *  did-you-mean hint. Ollama-only, same as chatQa -- never falls back to the frontier env.AI. Default false. */
  intentRouting: boolean;
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
 *  gittensory watches but never acts. `auto_with_approval` executes behind a human approval gate (#779);
 *  `auto` executes directly. (#4620: `suggest`/`propose` were removed here -- the doc comment promised
 *  distinct "surface guidance/concrete proposals without executing" behavior, but every read site
 *  (`isActingAutonomyLevel`/`autonomyRequiresApproval`) only ever distinguished acting from non-acting, so
 *  both were 100% behaviorally identical to `observe` from day one. No stored config used either value.) */
export type AutonomyLevel = "observe" | "auto_with_approval" | "auto";

/** The write-action classes the maintainer auto-maintain layer (#778) can take on a PR. `label` gates the
 *  anti-abuse enforcement labels tied 1:1 to a `close` in the same disposition (blacklist/contributor-cap/
 *  review-nag) -- those additionally require `close` to be acting, so `label` alone can't apply them without a
 *  close. `review_state_label` is a SEPARATE, independent gate for the planner's own disposition-communication
 *  labels (ready-to-merge / changes-requested / manual-review / migration-collision / the linked-issue
 *  pending-closure flag / the account-age new-account label) -- these are advisory signals about the bot's own
 *  verdict, not enforcement actions, and default OFF (`observe`) like every other class so a one-shot-mode repo
 *  never sees them without an explicit opt-in. `assign` (#3182) sets the PR's opening contributor as the GitHub
 *  assignee -- an independent, always-safe triage action with no bearing on merge/close/approve, gated purely
 *  on its own dial like `review_state_label`. */
export type AgentActionClass = "review" | "request_changes" | "approve" | "merge" | "close" | "label" | "review_state_label" | "update_branch" | "assign";

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
  // #label-scoping: a staged `label` action can be governed by a narrower purpose class (for example `close`
  // for enforcement metadata, or `review_state_label` for disposition labels). Persist it so accept-time replay
  // re-checks the same autonomy class that authorized staging, not the generic label dial.
  autonomyClass?: AgentActionClass;
  label?: string;
  // Flag-then-close double-check: whether a `label` action ADDs (default/absent) or REMOVEs its label, plus an
  // optional comment posted alongside the label mutation. Persisted so a staged label action replays faithfully.
  labelOp?: "add" | "remove";
  comment?: string;
  reviewBody?: string;
  mergeMethod?: AutoMergeMethod;
  // For an `assign` action (#3182): the GitHub login to assign when a staged action is accepted.
  assignee?: string;
  // Legacy approval-queue rows may contain this field from the reverted linked-issue assignment fan-out. New
  // plans do not set it, actionParams does not persist it, and the executor ignores it because linked issue
  // assignment is an authorization signal granted by maintainers, not by PR-body closing references.
  assignLinkedIssues?: number[];
  closeComment?: string;
  // Individual close reasons, persisted for approval-queue replay so the eventual audit row keeps the structured
  // reason list rather than only the flattened `reason` field.
  closeReasons?: string[];
  // Which kind of close this is (see PlannedAgentAction.closeKind), persisted so it round-trips through staging:
  // the close-precision circuit-breaker still scopes itself correctly when a staged close is later accepted
  // (#2127), and the actuation-time live-CI re-check (#2364) — which only applies to a heuristic close — still
  // fires correctly once the row is replayed through pendingActionToPlanned, rather than silently skipping for
  // a lost discriminator.
  closeKind?: "linked-issue-hard-rule" | "blacklist" | "contributor_cap" | "review_nag" | "screenshot_table" | "heuristic";
  // For a CI-driven heuristic close, persist the CI state that must still hold when the staged action replays
  // (#2364). This is separate from closeKind because heuristic closes also cover non-CI adverse signals.
  // ALWAYS set (to "failed" or "not_required") for a freshly planned heuristic close (#2478) -- never omitted --
  // so `undefined` unambiguously means a LEGACY row staged before this field existed, not "not CI-driven".
  closeRequiresCiState?: "failed" | "not_required";
  // True when a base conflict (mergeable_state: "dirty") was part of this heuristic close's justification --
  // one of three non-CI close reasons (alongside closeRequiresThreadResolved and closeRequiresDuplicateStillOpen
  // below) the approval queue's accept-time live recheck has a cheap, reliable live signal for. Slop score and a
  // gate-verdict blocker not backed by one of the above have no equivalently cheap live re-derivation, so
  // decidePendingAgentAction only reruns its mergeable-state/review-decision staleness check when this is true --
  // gating it on closeRequiresCiState === "not_required" alone (any non-CI reason) instead would supersede EVERY
  // duplicate/slop/blocker-only close whose mergeability simply happens to read "clean" (which most
  // never-conflicted PRs already are), even though their actual justification never depended on mergeability and
  // may still be live (gate review finding).
  // ALWAYS set (never omitted) for a freshly planned heuristic close, mirroring closeRequiresCiState's own
  // discipline -- so `undefined` unambiguously means a legacy row staged before this field existed.
  closeRequiresMergeableState?: boolean;
  // True when an unresolved GitHub review thread (REVIEW_THREAD_BLOCKER_CODE) was part of this heuristic
  // close's justification -- the SAME staleness class as closeRequiresMergeableState (#3863) but for a
  // contributor RESOLVING the thread on GitHub instead of the base branch becoming mergeable again. ALWAYS set
  // (never omitted) for a freshly planned heuristic close, mirroring closeRequiresMergeableState's own
  // discipline. Unlike closeRequiresMergeableState, this field has NO pre-existing legacy rows -- it is
  // introduced alongside its only producer, so `undefined` here unambiguously means "not thread-justified",
  // not an ambiguous legacy row; the accept-time/actuation-time rechecks below scope on it with a strict
  // `=== true`, not the broader `!== false` closeRequiresMergeableState needs for its own legacy-row case.
  closeRequiresThreadResolved?: boolean;
  // True when a duplicate-PR justification (linkedDuplicateCount > 0) was part of this heuristic close's
  // reasons -- see PlannedAgentAction.closeRequiresDuplicateStillOpen in agent-actions.ts for the full
  // rationale (#dup-winner-staleness). ALWAYS set (never omitted) for a freshly planned heuristic close,
  // mirroring closeRequiresMergeableState's own discipline.
  closeRequiresDuplicateStillOpen?: boolean;
  // The specific sibling PR number named as the duplicate-cluster winner, persisted so the recheck can
  // re-verify THAT PR specifically instead of re-deriving the whole cluster. See
  // PlannedAgentAction.duplicateWinnerPrNumber in agent-actions.ts. Absent when the election named no
  // specific winner even though closeRequiresDuplicateStillOpen is true.
  duplicateWinnerPrNumber?: number;
  // Persisted so the close-precision breaker's concrete-evidence exemption (see
  // PlannedAgentAction.closeConcreteEvidence) still applies correctly when a staged heuristic close is later
  // accepted -- without this, EVERY staged close would silently fall back to "not concrete" at accept-time and
  // stay wrongly subject to the breaker even when it was planned from red CI, a conflict, a committed secret,
  // or another concrete signal.
  closeConcreteEvidence?: boolean;
  expectedHeadSha?: string;
  // For an `approve` action: retract the bot's own stale approval instead of posting a new one (see
  // PlannedAgentAction.dismissStaleApproval). Must round-trip through staging like every other action-specific
  // field. (#2254)
  dismissStaleApproval?: boolean;
};

// "errored" is distinct from "accepted": the maintainer's accept decision ran the staged action through the
// executor, but the mutation itself threw (a real GitHub-call failure), as opposed to a clean "accepted" outcome
// where the executor's own gates (autonomy/dry-run/freshness) declined to act -- that's an intentional policy
// result, not a failure, and stays "accepted" (#2423).
export type AgentPendingActionStatus = "pending" | "accepted" | "rejected" | "errored";

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
  headSha?: string | null | undefined;
  filesSyncedAt?: string | null | undefined;
  reviewsSyncedAt?: string | null | undefined;
  reviewsInvalidatedAt?: string | null | undefined;
  checksSyncedAt?: string | null | undefined;
  lastSyncedAt?: string | null | undefined;
  errorSummary?: string | null | undefined;
  // #2537: durable bare-PR-state cache fields (mergeable_state/state from GET /pulls/{n}).
  prMergeableState?: string | null | undefined;
  prState?: string | null | undefined;
  prStateFetchedAt?: string | null | undefined;
  // #selfhost-ci-verification (CI-state snapshot cache sibling to the #2537 PR-state trio above): a durable
  // mirror of the LiveCiAggregate the gate's own live-CI fetch already produces (src/github/backfill.ts),
  // keyed fresh only when BOTH ciHeadSha matches the head_sha being queried AND ciRequiredContextsKey matches
  // the current settings.expectedCiContexts. NEVER read by the act-boundary merge/close decision (see the
  // schema.ts comment) -- those paths always force a live fetch.
  ciHeadSha?: string | null | undefined;
  ciState?: "passed" | "failed" | "pending" | "unverified" | null | undefined;
  ciHasPending?: boolean | null | undefined;
  ciHasVisiblePending?: boolean | null | undefined;
  ciHasMissingRequiredContext?: boolean | null | undefined;
  ciFailingDetailsJson?: string | null | undefined;
  ciNonRequiredFailingDetailsJson?: string | null | undefined;
  ciCompletenessWarning?: string | null | undefined;
  ciRequiredContextsKey?: string | null | undefined;
  ciStateFetchedAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type GitHubRateLimitObservationRecord = {
  id?: string | undefined;
  repoFullName?: string | null | undefined;
  admissionKey?: string | null | undefined;
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

// Review memory (#2178, data-model slice of #1964). One row per (repoFullName, category, pathGlob,
// patternHash) — a maintainer-dismissed finding shape gittensory should suppress/demote if it recurs.
// Privacy: repo + category (the finding's own deterministic `code`) + a path glob + a message HASH ONLY —
// never the raw finding message/title, never an actor's trust/reward fields.
export type ReviewSuppressionRecord = {
  id: string;
  repoFullName: string;
  category: string;
  pathGlob: string;
  patternHash: string;
  createdAt: string;
  createdBy?: string | null | undefined;
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
  // "broker" = a brokered self-host (ORB_ENROLLMENT_SECRET set, no local GitHub App private key by design).
  // Permission snapshots are available only after the broker returns token permissions; event subscriptions are
  // not introspectable through the broker. Consumers must branch on authMode, not infer certainty from empty
  // arrays alone.
  authMode: "local" | "broker";
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

export type BurdenForecastRecord = {
  repoFullName: string;
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

/** One repo's periodic maintainer review-activity digest (#1963). Pure aggregate over already-computed
 *  stats (pull-request outcomes + gate precision) — no new ledger, no raw trust/reward values. */
export type ReviewRecap = {
  repoFullName: string;
  generatedAt: string;
  windowDays: number;
  /** Realized PR outcomes in the window, from the PR row's own state/mergedAt (ground truth, not a prediction). */
  merged: number;
  closed: number;
  stillOpen: number;
  /** Gate merge-precision for this repo over the SAME window, from {@link GateEvalRow.mergePrecision}.
   *  null = no would-merge predictions with a known outcome yet (nothing to divide by). */
  gatePrecision: number | null;
  /** Total gate_decision predictions this report's precision rate was computed from (0 = no signal). */
  gateDecided: number;
  summary: string[];
};

/** #4521: one cohort's blocked/false-positive counts within a maintainer recap window — the SAME shape for
 *  both the per-repo and aggregate-totals cohort splits. Mirrors GatePrecisionCohortReport's overall shape,
 *  renamed to match this file's own gateFalsePositives/gateFalsePositiveRate naming convention. */
export type MaintainerRecapCohortCounts = {
  blocked: number;
  gateFalsePositives: number;
  gateFalsePositiveRate: number | null;
};

/** One repo's realized review-outcome roll-up inside a maintainer recap window (#2239, foundation for #1963).
 *  Counts are ground-truth PR outcomes + gate/recommendation calibration totals — never predictions. */
export type MaintainerRecapRepo = {
  repoFullName: string;
  /** PRs with a terminal outcome (merged or closed) over the window — the outcome-calibration sample size. */
  reviewed: number;
  merged: number;
  closed: number;
  /** Gate blocks that later MERGED anyway over the window (a gate FALSE POSITIVE), from GatePrecisionReport. */
  gateFalsePositives: number;
  /** Blocks a maintainer explicitly OVERRODE (the strongest false-positive signal), summed across gate types. */
  gateOverrides: number;
  /** Recommendations that resolved NEGATIVELY (a reversal) over the window, from the outcome calibration. */
  reversals: number;
  /** #4521: miner-vs-human split of this repo's gate-block outcomes, present only when the caller's
   *  GatePrecisionReport carried a `cohorts` field (loadGatePrecisionReport's `includeCohorts` option).
   *  Absent means the split wasn't requested for this recap run — never a signal that it doesn't apply. */
  cohorts?: { miner: MaintainerRecapCohortCounts; human: MaintainerRecapCohortCounts } | undefined;
};

/** A serializable maintainer recap: a window of gittensory's OWN review-outcome data folded across repos.
 *  Foundation for the #1963 recap digest — the pure data-shaping seam only (no delivery, no scheduling).
 *  Distinct from {@link ReviewRecap} (single-repo, sourced from gate merge-precision predictions); this is
 *  multi-repo and sourced from the gate-precision + outcome-calibration aggregators. (#2239) */
export type RecapReport = {
  generatedAt: string;
  windowDays: number;
  repos: MaintainerRecapRepo[];
  totals: {
    reviewed: number;
    merged: number;
    closed: number;
    /** Total gate blocks over the window (the denominator of {@link gateFalsePositiveRate}). */
    blocked: number;
    gateFalsePositives: number;
    gateOverrides: number;
    reversals: number;
    /** Aggregate false-positive rate (gateFalsePositives / blocked), null when nothing was blocked. */
    gateFalsePositiveRate: number | null;
    /** #4521: aggregate miner-vs-human split across every repo that carried one — present only when at
     *  least one repo's GatePrecisionReport included `cohorts`. A repo without one simply doesn't
     *  contribute to these sums, so a partial-adoption window still degrades gracefully. */
    cohorts?: { miner: MaintainerRecapCohortCounts; human: MaintainerRecapCohortCounts } | undefined;
  };
  summary: string[];
};
