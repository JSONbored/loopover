import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const installations = sqliteTable("installations", {
  id: integer("id").primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountId: integer("account_id").notNull(),
  targetType: text("target_type").notNull(),
  repositorySelection: text("repository_selection"),
  permissionsJson: text("permissions_json").notNull().default("{}"),
  eventsJson: text("events_json").notNull().default("[]"),
  suspendedAt: text("suspended_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const repositories = sqliteTable("repositories", {
  fullName: text("full_name").primaryKey(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  installationId: integer("installation_id"),
  isInstalled: integer("is_installed", { mode: "boolean" }).notNull().default(false),
  isRegistered: integer("is_registered", { mode: "boolean" }).notNull().default(false),
  isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
  htmlUrl: text("html_url"),
  defaultBranch: text("default_branch"),
  registryConfigJson: text("registry_config_json"),
  emissionShare: real("emission_share"),
  issueDiscoveryShare: real("issue_discovery_share"),
  maintainerCut: real("maintainer_cut").notNull().default(0),
  labelMultipliersJson: text("label_multipliers_json").notNull().default("{}"),
  lastRegistrySnapshotId: text("last_registry_snapshot_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const repositorySettings = sqliteTable("repository_settings", {
  repoFullName: text("repo_full_name").primaryKey(),
  commentMode: text("comment_mode").notNull().default("detected_contributors_only"),
  publicAudienceMode: text("public_audience_mode").notNull().default("oss_maintainer"),
  publicSignalLevel: text("public_signal_level").notNull().default("standard"),
  checkRunMode: text("check_run_mode").notNull().default("off"),
  checkRunDetailLevel: text("check_run_detail_level").notNull().default("minimal"),
  gateCheckMode: text("gate_check_mode").notNull().default("off"),
  linkedIssueGateMode: text("linked_issue_gate_mode").notNull().default("advisory"),
  duplicatePrGateMode: text("duplicate_pr_gate_mode").notNull().default("advisory"),
  qualityGateMode: text("quality_gate_mode").notNull().default("advisory"),
  qualityGateMinScore: integer("quality_gate_min_score"),
  autoLabelEnabled: integer("auto_label_enabled", { mode: "boolean" }).notNull().default(true),
  gittensorLabel: text("gittensor_label").notNull().default("gittensor"),
  createMissingLabel: integer("create_missing_label", { mode: "boolean" }).notNull().default(true),
  publicSurface: text("public_surface").notNull().default("comment_and_label"),
  includeMaintainerAuthors: integer("include_maintainer_authors", { mode: "boolean" }).notNull().default(false),
  requireLinkedIssue: integer("require_linked_issue", { mode: "boolean" }).notNull().default(false),
  backfillEnabled: integer("backfill_enabled", { mode: "boolean" }).notNull().default(true),
  privateTrustEnabled: integer("private_trust_enabled", { mode: "boolean" }).notNull().default(true),
  commandAuthorizationJson: text("command_authorization_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const repoSyncState = sqliteTable("repo_sync_state", {
  repoFullName: text("repo_full_name").primaryKey(),
  status: text("status").notNull().default("never_synced"),
  sourceKind: text("source_kind").notNull().default("github"),
  primaryLanguage: text("primary_language"),
  defaultBranch: text("default_branch"),
  isPrivate: integer("is_private", { mode: "boolean" }),
  openIssuesCount: integer("open_issues_count").notNull().default(0),
  openPullRequestsCount: integer("open_pull_requests_count").notNull().default(0),
  recentMergedPullRequestsCount: integer("recent_merged_pull_requests_count").notNull().default(0),
  labelsSyncedAt: text("labels_synced_at"),
  issuesSyncedAt: text("issues_synced_at"),
  pullRequestsSyncedAt: text("pull_requests_synced_at"),
  mergedPullRequestsSyncedAt: text("merged_pull_requests_synced_at"),
  lastStartedAt: text("last_started_at"),
  lastCompletedAt: text("last_completed_at"),
  errorSummary: text("error_summary"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const repoSyncSegments = sqliteTable(
  "repo_sync_segments",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    segment: text("segment").notNull(),
    status: text("status").notNull().default("never_synced"),
    sourceKind: text("source_kind").notNull().default("github"),
    mode: text("mode").notNull().default("light"),
    lastCursor: text("last_cursor"),
    nextCursor: text("next_cursor"),
    fetchedCount: integer("fetched_count").notNull().default(0),
    expectedCount: integer("expected_count"),
    pageCount: integer("page_count").notNull().default(0),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    staleAt: text("stale_at"),
    rateLimitResetAt: text("rate_limit_reset_at"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    warningsJson: text("warnings_json").notNull().default("[]"),
    errorSummary: text("error_summary"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoSegment: uniqueIndex("repo_sync_segments_repo_segment_unique").on(table.repoFullName, table.segment),
    repoStatus: index("repo_sync_segments_repo_status_idx").on(table.repoFullName, table.status),
  }),
);

export const githubRateLimitObservations = sqliteTable(
  "github_rate_limit_observations",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name"),
    resource: text("resource").notNull().default("rest"),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    limitValue: integer("limit_value"),
    remaining: integer("remaining"),
    resetAt: text("reset_at"),
    observedAt: text("observed_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoObserved: index("github_rate_limit_observations_repo_observed_idx").on(table.repoFullName, table.observedAt),
    reset: index("github_rate_limit_observations_reset_idx").on(table.resetAt),
  }),
);

export const repoGithubTotalsSnapshots = sqliteTable(
  "repo_github_totals_snapshots",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    openIssuesTotal: integer("open_issues_total").notNull().default(0),
    openPullRequestsTotal: integer("open_pull_requests_total").notNull().default(0),
    mergedPullRequestsTotal: integer("merged_pull_requests_total").notNull().default(0),
    closedUnmergedPullRequestsTotal: integer("closed_unmerged_pull_requests_total").notNull().default(0),
    labelsTotal: integer("labels_total").notNull().default(0),
    sourceKind: text("source_kind").notNull().default("github"),
    fetchedAt: text("fetched_at").notNull(),
    rateLimitRemaining: integer("rate_limit_remaining"),
    rateLimitResetAt: text("rate_limit_reset_at"),
    payloadJson: text("payload_json").notNull().default("{}"),
  },
  (table) => ({
    repoFetched: index("repo_github_totals_repo_fetched_idx").on(table.repoFullName, table.fetchedAt),
  }),
);

export const pullRequestDetailSyncState = sqliteTable(
  "pull_request_detail_sync_state",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    pullNumber: integer("pull_number").notNull(),
    status: text("status").notNull().default("never_synced"),
    filesSyncedAt: text("files_synced_at"),
    reviewsSyncedAt: text("reviews_synced_at"),
    checksSyncedAt: text("checks_synced_at"),
    lastSyncedAt: text("last_synced_at"),
    errorSummary: text("error_summary"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoPull: uniqueIndex("pull_request_detail_sync_repo_pull_unique").on(table.repoFullName, table.pullNumber),
    repoStatus: index("pull_request_detail_sync_repo_status_idx").on(table.repoFullName, table.status),
  }),
);

export const repoLabels = sqliteTable(
  "repo_labels",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    description: text("description"),
    isConfigured: integer("is_configured", { mode: "boolean" }).notNull().default(false),
    observedCount: integer("observed_count").notNull().default(0),
    payloadJson: text("payload_json").notNull().default("{}"),
    lastSeenAt: text("last_seen_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoLabel: uniqueIndex("repo_labels_repo_name_unique").on(table.repoFullName, table.name),
  }),
);

export const repoSnapshots = sqliteTable("repo_snapshots", {
  id: text("id").primaryKey(),
  repoFullName: text("repo_full_name").notNull(),
  snapshotKind: text("snapshot_kind").notNull(),
  sourceKind: text("source_kind").notNull().default("github"),
  fetchedAt: text("fetched_at").notNull(),
  primaryLanguage: text("primary_language"),
  defaultBranch: text("default_branch"),
  openIssuesCount: integer("open_issues_count").notNull().default(0),
  openPullRequestsCount: integer("open_pull_requests_count").notNull().default(0),
  recentMergedPullRequestsCount: integer("recent_merged_pull_requests_count").notNull().default(0),
  payloadJson: text("payload_json").notNull().default("{}"),
});

export const registrySnapshots = sqliteTable("registry_snapshots", {
  id: text("id").primaryKey(),
  sourceKind: text("source_kind").notNull(),
  sourceUrl: text("source_url").notNull(),
  generatedAt: text("generated_at").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  repoCount: integer("repo_count").notNull(),
  totalEmissionShare: real("total_emission_share").notNull(),
  warningsJson: text("warnings_json").notNull().default("[]"),
  payloadJson: text("payload_json").notNull(),
});

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    authorLogin: text("author_login"),
    authorAssociation: text("author_association"),
    headSha: text("head_sha"),
    headRef: text("head_ref"),
    baseRef: text("base_ref"),
    mergedAt: text("merged_at"),
    htmlUrl: text("html_url"),
    labelsJson: text("labels_json").notNull().default("[]"),
    linkedIssuesJson: text("linked_issues_json").notNull().default("[]"),
    lastSeenOpenAt: text("last_seen_open_at"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoNumber: uniqueIndex("pull_requests_repo_number_unique").on(table.repoFullName, table.number),
  }),
);

export const pullRequestFiles = sqliteTable(
  "pull_request_files",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    pullNumber: integer("pull_number").notNull(),
    path: text("path").notNull(),
    status: text("status"),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changes: integer("changes").notNull().default(0),
    previousFilename: text("previous_filename"),
    payloadJson: text("payload_json").notNull().default("{}"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoPullPath: uniqueIndex("pull_request_files_repo_pull_path_unique").on(table.repoFullName, table.pullNumber, table.path),
  }),
);

export const pullRequestReviews = sqliteTable("pull_request_reviews", {
  id: text("id").primaryKey(),
  repoFullName: text("repo_full_name").notNull(),
  pullNumber: integer("pull_number").notNull(),
  reviewerLogin: text("reviewer_login"),
  state: text("state").notNull(),
  authorAssociation: text("author_association"),
  submittedAt: text("submitted_at"),
  payloadJson: text("payload_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const checkSummaries = sqliteTable(
  "check_summaries",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    pullNumber: integer("pull_number"),
    headSha: text("head_sha"),
    name: text("name").notNull(),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    detailsUrl: text("details_url"),
    payloadJson: text("payload_json").notNull().default("{}"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoShaName: uniqueIndex("check_summaries_repo_sha_name_unique").on(table.repoFullName, table.headSha, table.name),
  }),
);

export const recentMergedPullRequests = sqliteTable(
  "recent_merged_pull_requests",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    authorLogin: text("author_login"),
    htmlUrl: text("html_url"),
    mergedAt: text("merged_at"),
    labelsJson: text("labels_json").notNull().default("[]"),
    linkedIssuesJson: text("linked_issues_json").notNull().default("[]"),
    changedFilesJson: text("changed_files_json").notNull().default("[]"),
    payloadJson: text("payload_json").notNull().default("{}"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoNumber: uniqueIndex("recent_merged_pull_requests_repo_number_unique").on(table.repoFullName, table.number),
  }),
);

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    authorLogin: text("author_login"),
    authorAssociation: text("author_association"),
    htmlUrl: text("html_url"),
    labelsJson: text("labels_json").notNull().default("[]"),
    linkedPrsJson: text("linked_prs_json").notNull().default("[]"),
    lastSeenOpenAt: text("last_seen_open_at"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoNumber: uniqueIndex("issues_repo_number_unique").on(table.repoFullName, table.number),
  }),
);

export const bounties = sqliteTable(
  "bounties",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    status: text("status").notNull(),
    amountText: text("amount_text"),
    sourceUrl: text("source_url"),
    payloadJson: text("payload_json").notNull().default("{}"),
    discoveredAt: text("discovered_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoIssue: uniqueIndex("bounties_repo_issue_unique").on(table.repoFullName, table.issueNumber),
  }),
);

export const contributors = sqliteTable("contributors", {
  login: text("login").primaryKey(),
  githubProfileJson: text("github_profile_json").notNull().default("{}"),
  topLanguagesJson: text("top_languages_json").notNull().default("[]"),
  publicRepos: integer("public_repos"),
  followers: integer("followers"),
  source: text("source").notNull().default("github"),
  firstSeenAt: text("first_seen_at").notNull().default("CURRENT_TIMESTAMP"),
  lastSeenAt: text("last_seen_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const contributorRepoStats = sqliteTable(
  "contributor_repo_stats",
  {
    id: text("id").primaryKey(),
    login: text("login").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    pullRequests: integer("pull_requests").notNull().default(0),
    mergedPullRequests: integer("merged_pull_requests").notNull().default(0),
    openPullRequests: integer("open_pull_requests").notNull().default(0),
    issues: integer("issues").notNull().default(0),
    stalePullRequests: integer("stale_pull_requests").notNull().default(0),
    unlinkedPullRequests: integer("unlinked_pull_requests").notNull().default(0),
    dominantLabelsJson: text("dominant_labels_json").notNull().default("[]"),
    lastActivityAt: text("last_activity_at"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    loginRepo: uniqueIndex("contributor_repo_stats_login_repo_unique").on(table.login, table.repoFullName),
  }),
);

export const collisionEdges = sqliteTable("collision_edges", {
  id: text("id").primaryKey(),
  repoFullName: text("repo_full_name").notNull(),
  leftType: text("left_type").notNull(),
  leftNumber: integer("left_number").notNull(),
  leftTitle: text("left_title").notNull(),
  rightType: text("right_type").notNull(),
  rightNumber: integer("right_number").notNull(),
  rightTitle: text("right_title").notNull(),
  risk: text("risk").notNull(),
  reason: text("reason").notNull(),
  sharedTermsJson: text("shared_terms_json").notNull().default("[]"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const signalSnapshots = sqliteTable("signal_snapshots", {
  id: text("id").primaryKey(),
  signalType: text("signal_type").notNull(),
  targetKey: text("target_key").notNull(),
  repoFullName: text("repo_full_name"),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    objective: text("objective").notNull(),
    actorLogin: text("actor_login").notNull(),
    surface: text("surface").notNull(),
    mode: text("mode").notNull().default("copilot"),
    status: text("status").notNull().default("queued"),
    dataQualityStatus: text("data_quality_status").notNull().default("unknown"),
    errorSummary: text("error_summary"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    actorUpdated: index("agent_runs_actor_updated_idx").on(table.actorLogin, table.updatedAt),
    statusUpdated: index("agent_runs_status_updated_idx").on(table.status, table.updatedAt),
    surfaceUpdated: index("agent_runs_surface_updated_idx").on(table.surface, table.updatedAt),
  }),
);

export const agentActions = sqliteTable(
  "agent_actions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    actionType: text("action_type").notNull(),
    targetRepoFullName: text("target_repo_full_name"),
    targetPullNumber: integer("target_pull_number"),
    targetIssueNumber: integer("target_issue_number"),
    status: text("status").notNull(),
    recommendation: text("recommendation").notNull(),
    whyJson: text("why_json").notNull().default("[]"),
    scoreabilityImpact: text("scoreability_impact"),
    riskImpact: text("risk_impact"),
    maintainerImpact: text("maintainer_impact"),
    blockedByJson: text("blocked_by_json").notNull().default("[]"),
    rerunWhen: text("rerun_when"),
    publicSafeSummary: text("public_safe_summary").notNull(),
    approvalRequired: integer("approval_required", { mode: "boolean" }).notNull().default(true),
    safetyClass: text("safety_class").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    runAction: index("agent_actions_run_action_idx").on(table.runId, table.actionType),
    targetRepo: index("agent_actions_target_repo_idx").on(table.targetRepoFullName, table.createdAt),
  }),
);

export const agentContextSnapshots = sqliteTable(
  "agent_context_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    decisionPackVersion: text("decision_pack_version"),
    repoSignalSnapshotIdsJson: text("repo_signal_snapshot_ids_json").notNull().default("[]"),
    scoringModelId: text("scoring_model_id"),
    freshnessWarningsJson: text("freshness_warnings_json").notNull().default("[]"),
    provenanceJson: text("provenance_json"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    runCreated: index("agent_context_snapshots_run_created_idx").on(table.runId, table.createdAt),
  }),
);

export const agentRecommendationOutcomes = sqliteTable(
  "agent_recommendation_outcomes",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    runId: text("run_id").notNull(),
    actorLogin: text("actor_login").notNull(),
    actionType: text("action_type").notNull(),
    targetRepoFullName: text("target_repo_full_name"),
    targetPullNumber: integer("target_pull_number"),
    targetIssueNumber: integer("target_issue_number"),
    surface: text("surface"),
    snapshotId: text("snapshot_id"),
    outcomeState: text("outcome_state").notNull(),
    outcomeTargetType: text("outcome_target_type").notNull(),
    outcomeRepoFullName: text("outcome_repo_full_name"),
    outcomePullNumber: integer("outcome_pull_number"),
    outcomeIssueNumber: integer("outcome_issue_number"),
    maintainerLane: integer("maintainer_lane", { mode: "boolean" }).notNull().default(false),
    confidence: text("confidence").notNull(),
    reason: text("reason").notNull(),
    sourceUpdatedAt: text("source_updated_at"),
    detectedAt: text("detected_at").notNull().default("CURRENT_TIMESTAMP"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    action: uniqueIndex("agent_recommendation_outcomes_action_unique").on(table.actionId),
    actorState: index("agent_recommendation_outcomes_actor_state_idx").on(table.actorLogin, table.outcomeState, table.updatedAt),
    target: index("agent_recommendation_outcomes_target_idx").on(table.targetRepoFullName, table.targetPullNumber, table.targetIssueNumber),
    maintainer: index("agent_recommendation_outcomes_maintainer_idx").on(table.actorLogin, table.maintainerLane, table.updatedAt),
  }),
);

export const installationHealth = sqliteTable("installation_health", {
  installationId: integer("installation_id").primaryKey(),
  accountLogin: text("account_login").notNull(),
  repositorySelection: text("repository_selection"),
  installedReposCount: integer("installed_repos_count").notNull().default(0),
  registeredInstalledCount: integer("registered_installed_count").notNull().default(0),
  status: text("status").notNull(),
  missingPermissionsJson: text("missing_permissions_json").notNull().default("[]"),
  missingEventsJson: text("missing_events_json").notNull().default("[]"),
  permissionsJson: text("permissions_json").notNull().default("{}"),
  eventsJson: text("events_json").notNull().default("[]"),
  checkedAt: text("checked_at").notNull(),
  errorSummary: text("error_summary"),
});

export const advisories = sqliteTable("advisories", {
  id: text("id").primaryKey(),
  targetType: text("target_type").notNull(),
  targetKey: text("target_key").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  pullNumber: integer("pull_number"),
  issueNumber: integer("issue_number"),
  headSha: text("head_sha"),
  conclusion: text("conclusion").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  findingsJson: text("findings_json").notNull().default("[]"),
  checkRunId: integer("check_run_id"),
  checkRunUrl: text("check_run_url"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const webhookEvents = sqliteTable("webhook_events", {
  deliveryId: text("delivery_id").primaryKey(),
  eventName: text("event_name").notNull(),
  action: text("action"),
  installationId: integer("installation_id"),
  repositoryFullName: text("repository_full_name"),
  payloadHash: text("payload_hash").notNull(),
  status: text("status").notNull(),
  errorSummary: text("error_summary"),
  receivedAt: text("received_at").notNull().default("CURRENT_TIMESTAMP"),
  processedAt: text("processed_at"),
});

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  jobType: text("job_type").notNull(),
  status: text("status").notNull(),
  sourceKind: text("source_kind"),
  sourceUrl: text("source_url"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  errorSummary: text("error_summary"),
  startedAt: text("started_at").notNull().default("CURRENT_TIMESTAMP"),
  completedAt: text("completed_at"),
});

export const scoringModelSnapshots = sqliteTable("scoring_model_snapshots", {
  id: text("id").primaryKey(),
  sourceKind: text("source_kind").notNull(),
  sourceUrl: text("source_url").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  activeModel: text("active_model").notNull(),
  constantsJson: text("constants_json").notNull().default("{}"),
  programmingLanguagesJson: text("programming_languages_json").notNull().default("{}"),
  registrySnapshotId: text("registry_snapshot_id"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  payloadJson: text("payload_json").notNull().default("{}"),
});

export const scorePreviews = sqliteTable("score_previews", {
  id: text("id").primaryKey(),
  scoringModelSnapshotId: text("scoring_model_snapshot_id").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  targetType: text("target_type").notNull(),
  targetKey: text("target_key").notNull(),
  contributorLogin: text("contributor_login"),
  inputJson: text("input_json").notNull().default("{}"),
  resultJson: text("result_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const contributorEvidence = sqliteTable("contributor_evidence", {
  login: text("login").primaryKey(),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const contributorScoringProfiles = sqliteTable("contributor_scoring_profiles", {
  login: text("login").primaryKey(),
  scoringModelSnapshotId: text("scoring_model_snapshot_id").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const officialMinerDetections = sqliteTable("official_miner_detections", {
  login: text("login").primaryKey(), status: text("status").notNull(),
  snapshotJson: text("snapshot_json").notNull().default("{}"), error: text("error"),
  fetchedAt: text("fetched_at").notNull(), expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const issueQualityReports = sqliteTable(
  "issue_quality_reports",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    repoIssue: uniqueIndex("issue_quality_reports_repo_issue_unique").on(table.repoFullName, table.issueNumber),
  }),
);

export const burdenForecasts = sqliteTable("burden_forecasts", {
  repoFullName: text("repo_full_name").primaryKey(),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const repoQueueTrendSnapshots = sqliteTable("repo_queue_trend_snapshots", {
  repoFullName: text("repo_full_name").primaryKey(),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const registryDriftEvents = sqliteTable("registry_drift_events", {
  id: text("id").primaryKey(),
  repoFullName: text("repo_full_name").notNull(),
  driftType: text("drift_type").notNull(),
  detail: text("detail").notNull(),
  previousSnapshotId: text("previous_snapshot_id"),
  currentSnapshotId: text("current_snapshot_id"),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const upstreamSourceSnapshots = sqliteTable(
  "upstream_source_snapshots",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    sourceRepo: text("source_repo").notNull(),
    sourceRef: text("source_ref").notNull(),
    path: text("path").notNull(),
    sourceUrl: text("source_url").notNull(),
    commitSha: text("commit_sha"),
    blobSha: text("blob_sha"),
    contentSha256: text("content_sha256"),
    etag: text("etag"),
    status: text("status").notNull().default("fetched"),
    parsedJson: text("parsed_json").notNull().default("{}"),
    warningsJson: text("warnings_json").notNull().default("[]"),
    payloadJson: text("payload_json").notNull().default("{}"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => ({
    keyFetched: index("upstream_source_snapshots_key_fetched_idx").on(table.sourceKey, table.fetchedAt),
    commit: index("upstream_source_snapshots_commit_idx").on(table.commitSha),
  }),
);

export const upstreamRulesetSnapshots = sqliteTable(
  "upstream_ruleset_snapshots",
  {
    id: text("id").primaryKey(),
    sourceRepo: text("source_repo").notNull(),
    sourceRef: text("source_ref").notNull(),
    commitSha: text("commit_sha"),
    sourceSnapshotIdsJson: text("source_snapshot_ids_json").notNull().default("[]"),
    activeModel: text("active_model").notNull(),
    registryRepoCount: integer("registry_repo_count").notNull().default(0),
    totalEmissionShare: real("total_emission_share").notNull().default(0),
    semanticHash: text("semantic_hash").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    warningsJson: text("warnings_json").notNull().default("[]"),
    generatedAt: text("generated_at").notNull(),
  },
  (table) => ({
    generated: index("upstream_ruleset_snapshots_generated_idx").on(table.generatedAt),
    semantic: index("upstream_ruleset_snapshots_semantic_idx").on(table.semanticHash),
  }),
);

export const upstreamDriftReports = sqliteTable(
  "upstream_drift_reports",
  {
    id: text("id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    summary: text("summary").notNull(),
    affectedAreasJson: text("affected_areas_json").notNull().default("[]"),
    previousRulesetId: text("previous_ruleset_id"),
    currentRulesetId: text("current_ruleset_id"),
    issueNumber: integer("issue_number"),
    issueUrl: text("issue_url"),
    payloadJson: text("payload_json").notNull().default("{}"),
    generatedAt: text("generated_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    fingerprint: uniqueIndex("upstream_drift_reports_fingerprint_unique").on(table.fingerprint),
    severityStatus: index("upstream_drift_reports_severity_status_idx").on(table.severity, table.status),
    updated: index("upstream_drift_reports_updated_idx").on(table.updatedAt),
  }),
);

export const bountyLifecycleEvents = sqliteTable("bounty_lifecycle_events", {
  id: text("id").primaryKey(),
  bountyId: text("bounty_id").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  issueNumber: integer("issue_number").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    login: text("login").notNull(),
    githubUserId: integer("github_user_id"),
    scopesJson: text("scopes_json").notNull().default("[]"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    lastSeenAt: text("last_seen_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (table) => ({
    tokenHash: uniqueIndex("auth_sessions_token_hash_unique").on(table.tokenHash),
    login: index("auth_sessions_login_idx").on(table.login),
    expires: index("auth_sessions_expires_idx").on(table.expiresAt),
    revoked: index("auth_sessions_revoked_idx").on(table.revokedAt),
  }),
);

export const digestSubscriptions = sqliteTable(
  "digest_subscriptions",
  {
    id: text("id").primaryKey(),
    login: text("login").notNull(),
    email: text("email").notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("app"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    loginEmail: uniqueIndex("digest_subscriptions_login_email_unique").on(table.login, table.email),
    login: index("digest_subscriptions_login_idx").on(table.login),
    status: index("digest_subscriptions_status_idx").on(table.status),
  }),
);

export const githubAgentCommandAnswers = sqliteTable(
  "github_agent_command_answers",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    command: text("command").notNull(),
    requestCommentId: integer("request_comment_id"),
    responseCommentId: integer("response_comment_id"),
    responseUrl: text("response_url"),
    actorKind: text("actor_kind").notNull(),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (table) => ({
    repoIssue: index("github_agent_command_answers_repo_issue_idx").on(table.repoFullName, table.issueNumber),
    commandUpdated: index("github_agent_command_answers_command_updated_idx").on(table.command, table.updatedAt),
  }),
);

export const githubAgentCommandFeedback = sqliteTable(
  "github_agent_command_feedback",
  {
    id: text("id").primaryKey(),
    answerId: text("answer_id")
      .notNull()
      .references(() => githubAgentCommandAnswers.id),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    command: text("command").notNull(),
    actorHash: text("actor_hash").notNull(),
    vote: text("vote").notNull(),
    source: text("source").notNull(),
    actorKind: text("actor_kind").notNull(),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (table) => ({
    actorAnswer: uniqueIndex("github_agent_command_feedback_actor_answer_unique").on(table.answerId, table.actorHash),
    commandUpdated: index("github_agent_command_feedback_command_updated_idx").on(table.command, table.updatedAt),
    repoIssue: index("github_agent_command_feedback_repo_issue_idx").on(table.repoFullName, table.issueNumber),
  }),
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    actor: text("actor"),
    route: text("route"),
    targetKey: text("target_key"),
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    typeCreated: index("audit_events_type_created_idx").on(table.eventType, table.createdAt),
    actorCreated: index("audit_events_actor_created_idx").on(table.actor, table.createdAt),
    routeCreated: index("audit_events_route_created_idx").on(table.route, table.createdAt),
  }),
);

export const productUsageEvents = sqliteTable(
  "product_usage_events",
  {
    id: text("id").primaryKey(),
    surface: text("surface").notNull(),
    role: text("role").notNull().default("unknown"),
    eventName: text("event_name").notNull(),
    route: text("route"),
    actorHash: text("actor_hash"),
    sessionHash: text("session_hash"),
    repoFullName: text("repo_full_name"),
    targetKey: text("target_key"),
    outcome: text("outcome").notNull(),
    latencyMs: integer("latency_ms"),
    clientName: text("client_name"),
    clientVersion: text("client_version"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    occurredAt: text("occurred_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    surfaceOccurred: index("product_usage_events_surface_occurred_idx").on(table.surface, table.occurredAt),
    roleOccurred: index("product_usage_events_role_occurred_idx").on(table.role, table.occurredAt),
    eventOccurred: index("product_usage_events_event_occurred_idx").on(table.eventName, table.occurredAt),
    actorOccurred: index("product_usage_events_actor_occurred_idx").on(table.actorHash, table.occurredAt),
    repoOccurred: index("product_usage_events_repo_occurred_idx").on(table.repoFullName, table.occurredAt),
  }),
);

export const productUsageDailyRollups = sqliteTable(
  "product_usage_daily_rollups",
  {
    day: text("day").primaryKey(),
    status: text("status").notNull(),
    totalEvents: integer("total_events").notNull().default(0),
    activeActors: integer("active_actors").notNull().default(0),
    activeSessions: integer("active_sessions").notNull().default(0),
    activeRepos: integer("active_repos").notNull().default(0),
    sourceEventCount: integer("source_event_count").notNull().default(0),
    maxEventCapacity: integer("max_event_capacity").notNull().default(0),
    firstEventAt: text("first_event_at"),
    lastEventAt: text("last_event_at"),
    surfacesJson: text("surfaces_json").notNull().default("[]"),
    outcomesJson: text("outcomes_json").notNull().default("[]"),
    eventsJson: text("events_json").notNull().default("[]"),
    reposJson: text("repos_json").notNull().default("[]"),
    commandsJson: text("commands_json").notNull().default("[]"),
    toolsJson: text("tools_json").notNull().default("[]"),
    routeClassesJson: text("route_classes_json").notNull().default("[]"),
    activationJson: text("activation_json").notNull().default("{}"),
    rolesJson: text("roles_json").notNull().default("[]"),
    activationByRoleJson: text("activation_by_role_json").notNull().default("[]"),
    activationBySurfaceJson: text("activation_by_surface_json").notNull().default("[]"),
    retentionJson: text("retention_json").notNull().default("[]"),
    generatedAt: text("generated_at").notNull().default("CURRENT_TIMESTAMP"),
    updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    statusUpdated: index("product_usage_daily_rollups_status_idx").on(table.status, table.updatedAt),
  }),
);

export const aiUsageEvents = sqliteTable(
  "ai_usage_events",
  {
    id: text("id").primaryKey(),
    feature: text("feature").notNull(),
    actor: text("actor"),
    route: text("route"),
    model: text("model").notNull(),
    status: text("status").notNull(),
    estimatedNeurons: integer("estimated_neurons").notNull().default(0),
    detail: text("detail"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    featureCreated: index("ai_usage_events_feature_created_idx").on(table.feature, table.createdAt),
    actorCreated: index("ai_usage_events_actor_created_idx").on(table.actor, table.createdAt),
  }),
);
