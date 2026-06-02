import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const FindingSchema = z
  .object({
    code: z.string(),
    title: z.string(),
    severity: z.enum(["info", "warning", "critical"]),
    detail: z.string(),
    action: z.string().optional(),
    publicText: z.string().optional(),
  })
  .openapi("Finding");

export const AdvisorySchema = z
  .object({
    id: z.string(),
    targetType: z.enum(["repository", "pull_request", "issue"]),
    targetKey: z.string(),
    repoFullName: z.string(),
    pullNumber: z.number().optional(),
    issueNumber: z.number().optional(),
    headSha: z.string().optional(),
    conclusion: z.enum(["success", "neutral", "action_required"]),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string(),
    summary: z.string(),
    findings: z.array(FindingSchema),
    generatedAt: z.string(),
  })
  .openapi("Advisory");

export const RegistryRepoSchema = z
  .object({
    repo: z.string(),
    emissionShare: z.number(),
    issueDiscoveryShare: z.number(),
    labelMultipliers: z.record(z.string(), z.number()),
    trustedLabelPipeline: z.boolean().nullable().optional(),
    maintainerCut: z.number(),
    defaultLabelMultiplier: z.number().nullable().optional(),
    fixedBaseScore: z.number().nullable().optional(),
    eligibilityMode: z.string().nullable().optional(),
    raw: z.record(z.string(), z.unknown()),
  })
  .openapi("RegistryRepo");

export const RegistrySnapshotSchema = z
  .object({
    id: z.string(),
    generatedAt: z.string(),
    fetchedAt: z.string(),
    source: z.object({
      kind: z.enum(["api", "raw-github"]),
      url: z.string(),
    }),
    repoCount: z.number(),
    totalEmissionShare: z.number(),
    warnings: z.array(z.string()),
    repositories: z.array(RegistryRepoSchema),
  })
  .openapi("RegistrySnapshot");

export const RepositorySchema = z
  .object({
    fullName: z.string(),
    owner: z.string(),
    name: z.string(),
    installationId: z.number().nullable().optional(),
    isInstalled: z.boolean(),
    isRegistered: z.boolean(),
    isPrivate: z.boolean(),
    htmlUrl: z.string().nullable().optional(),
    defaultBranch: z.string().nullable().optional(),
    registryConfig: RegistryRepoSchema.nullable().optional(),
  })
  .openapi("Repository");

export const WorkboardItemSchema = z
  .object({
    repoFullName: z.string(),
    issueNumber: z.number(),
    title: z.string(),
    state: z.string(),
    htmlUrl: z.string().nullable().optional(),
    fit: z.enum(["good", "caution", "hold"]),
    reasons: z.array(z.string()),
  })
  .openapi("WorkboardItem");

export const LaneAdviceSchema = z
  .object({
    lane: z.enum(["direct_pr", "issue_discovery", "split", "inactive", "unknown"]),
    repoFullName: z.string(),
    issueDiscoveryShare: z.number().optional(),
    directPrShare: z.number().optional(),
    summary: z.string(),
    contributorGuidance: z.string(),
    maintainerGuidance: z.string(),
  })
  .openapi("LaneAdvice");

export const CollisionItemSchema = z
  .object({
    type: z.enum(["issue", "pull_request"]),
    number: z.number(),
    title: z.string(),
    authorLogin: z.string().nullable().optional(),
    htmlUrl: z.string().nullable().optional(),
  })
  .openapi("CollisionItem");

export const CollisionClusterSchema = z
  .object({
    id: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    reason: z.string(),
    items: z.array(CollisionItemSchema),
  })
  .openapi("CollisionCluster");

export const CollisionReportSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    summary: z.object({
      clusterCount: z.number(),
      highRiskCount: z.number(),
      itemsReviewed: z.number(),
    }),
    clusters: z.array(CollisionClusterSchema),
  })
  .openapi("CollisionReport");

export const QueueHealthSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    burdenScore: z.number(),
    level: z.enum(["low", "medium", "high", "critical"]),
    summary: z.string(),
    signals: z.object({
      openIssues: z.number(),
      openPullRequests: z.number(),
      unlinkedPullRequests: z.number(),
      stalePullRequests: z.number(),
      maintainerAuthoredPullRequests: z.number(),
      collisionClusters: z.number(),
      ageBuckets: z.object({
        under7Days: z.number(),
        days7To30: z.number(),
        over30Days: z.number(),
      }),
      likelyReviewablePullRequests: z.number(),
    }),
    findings: z.array(FindingSchema),
  })
  .openapi("QueueHealth");

export const ConfigQualitySchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    score: z.number(),
    level: z.enum(["excellent", "good", "needs_attention", "fragile"]),
    lane: LaneAdviceSchema,
    configuredLabels: z.array(z.string()),
    observedLabels: z.array(z.string()),
    notObservedConfiguredLabels: z.array(z.string()),
    findings: z.array(FindingSchema),
  })
  .openapi("ConfigQuality");

export const LabelAuditSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    configuredLabels: z.array(z.string()),
    liveLabels: z.array(z.string()),
    observedLabels: z.array(
      z.object({
        name: z.string(),
        count: z.number(),
        configured: z.boolean(),
        existsOnGitHub: z.boolean(),
      }),
    ),
    missingConfiguredLabels: z.array(z.string()),
    suspiciousConfiguredLabels: z.array(z.string()),
    trustedPipelineReady: z.boolean(),
    findings: z.array(FindingSchema),
  })
  .openapi("LabelAudit");

export const ContributorProfileSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    github: z.object({
      login: z.string(),
      name: z.string().nullable().optional(),
      bio: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      publicRepos: z.number().optional(),
      followers: z.number().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      topLanguages: z.array(z.string()),
      source: z.enum(["github", "unavailable"]),
    }),
    source: z.enum(["gittensor_api", "github_cache"]),
    gittensor: z
      .object({
        githubId: z.string(),
        githubUsername: z.string(),
        uid: z.number().optional(),
        hotkey: z.string().optional(),
        evaluatedAt: z.string().optional(),
        updatedAt: z.string().optional(),
        isEligible: z.boolean(),
        credibility: z.number(),
        eligibleRepoCount: z.number(),
        issueDiscoveryScore: z.number(),
        issueTokenScore: z.number(),
        issueCredibility: z.number(),
        isIssueEligible: z.boolean(),
        issueEligibleRepoCount: z.number(),
        alphaPerDay: z.number(),
        taoPerDay: z.number(),
        usdPerDay: z.number(),
        totals: z.object({
          pullRequests: z.number(),
          mergedPullRequests: z.number(),
          openPullRequests: z.number(),
          closedPullRequests: z.number(),
          openIssues: z.number(),
          closedIssues: z.number(),
          solvedIssues: z.number(),
          validSolvedIssues: z.number(),
        }),
        repositories: z.array(
          z.object({
            repoFullName: z.string(),
            pullRequests: z.number(),
            mergedPullRequests: z.number(),
            openPullRequests: z.number(),
            closedPullRequests: z.number(),
            openIssues: z.number(),
            closedIssues: z.number(),
            solvedIssues: z.number(),
            validSolvedIssues: z.number(),
            isEligible: z.boolean(),
            isIssueEligible: z.boolean(),
            credibility: z.number(),
            issueCredibility: z.number(),
            totalScore: z.number(),
            baseTotalScore: z.number(),
          }),
        ),
      })
      .optional(),
    registeredRepoActivity: z.object({
      pullRequests: z.number(),
      mergedPullRequests: z.number(),
      issues: z.number(),
      reposTouched: z.array(z.string()),
      dominantLabels: z.array(z.string()),
    }),
    trustSignals: z.object({
      evidenceScore: z.number(),
      level: z.enum(["new", "emerging", "established"]),
      unlinkedOpenPullRequests: z.number(),
      maintainerAssociatedPullRequests: z.number(),
    }),
  })
  .openapi("ContributorProfile");

export const ContributorOpenPrNextStepPacketSchema = z
  .object({
    repoFullName: z.string(),
    number: z.number(),
    title: z.string(),
    classification: z.enum([
      "approved",
      "blocked",
      "stale",
      "needs_author",
      "failing_checks",
      "missing_tests",
      "duplicate_prone",
      "reviewable",
      "should_close_or_withdraw",
      "maintainer_lane",
      "draft",
    ]),
    summary: z.string(),
    reasons: z.array(z.string()),
    nextSteps: z.array(z.string()),
  })
  .openapi("ContributorOpenPrNextStepPacket");

export const ContributorOpenPrMonitorSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    openPrCount: z.number(),
    registeredRepoCount: z.number(),
    cleanupFirst: z.boolean(),
    summary: z.string(),
    guidance: z.array(z.string()),
    pendingScenarios: z.array(
      z.object({
        repoFullName: z.string(),
        detection: z.object({
          source: z.enum(["github_observed", "user_supplied"]),
          pendingMergedPrCount: z.number(),
          pendingClosedPrCount: z.number(),
          approvedPrCount: z.number(),
          expectedOpenPrCountAfterMerge: z.number().optional(),
          scenarioNotes: z.array(z.string()),
          classified: z.array(
            z.object({
              repoFullName: z.string(),
              number: z.number(),
              title: z.string(),
              classification: z.string(),
              reasons: z.array(z.string()),
            }),
          ),
        }),
      }),
    ),
    pullRequests: z.array(ContributorOpenPrNextStepPacketSchema),
  })
  .openapi("ContributorOpenPrMonitor");

export const ContributorOpportunitySchema = z
  .object({
    repoFullName: z.string(),
    issueNumber: z.number().optional(),
    title: z.string(),
    fit: z.enum(["good", "caution", "hold"]),
    score: z.number(),
    lane: z.enum(["direct_pr", "issue_discovery", "split", "inactive", "unknown"]),
    reasons: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .openapi("ContributorOpportunity");

export const ContributorOpportunitiesResponseSchema = z
  .object({
    profile: ContributorProfileSchema,
    opportunities: z.array(ContributorOpportunitySchema),
  })
  .openapi("ContributorOpportunitiesResponse");

export const ContributorFitSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    profile: ContributorProfileSchema,
    summary: z.string(),
    languageFit: z.array(
      z.object({
        repoFullName: z.string(),
        language: z.string().nullable().optional(),
        match: z.boolean(),
      }),
    ),
    repoStats: z.array(
      z.object({
        login: z.string(),
        repoFullName: z.string(),
        pullRequests: z.number(),
        mergedPullRequests: z.number(),
        openPullRequests: z.number(),
        issues: z.number(),
        stalePullRequests: z.number(),
        unlinkedPullRequests: z.number(),
        dominantLabels: z.array(z.string()),
        lastActivityAt: z.string().nullable().optional(),
      }),
    ),
    opportunities: z.array(ContributorOpportunitySchema),
    findings: z.array(FindingSchema),
  })
  .openapi("ContributorFit");

export const PreflightResultSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    status: z.enum(["ready", "needs_work", "hold"]),
    lane: LaneAdviceSchema,
    reviewBurden: z.enum(["low", "medium", "high"]),
    linkedIssues: z.array(z.number()),
    findings: z.array(FindingSchema),
    collisions: z.array(CollisionClusterSchema),
  })
  .openapi("PreflightResult");

export const LocalDiffPreflightResultSchema = PreflightResultSchema.extend({
  localDiff: z.object({
    changedFileCount: z.number(),
    changedLineCount: z.number(),
    testFileCount: z.number(),
    codeFileCount: z.number(),
    inferredLinkedIssues: z.array(z.number()),
    summary: z.string(),
  }),
}).openapi("LocalDiffPreflightResult");

export const MaintainerPacketSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    queueHealth: QueueHealthSchema,
    configQuality: ConfigQualitySchema,
    collisions: CollisionReportSchema,
    pullRequestPackets: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        authorLogin: z.string().nullable().optional(),
        reviewPriority: z.enum(["review", "needs_author", "watch"]),
        reasons: z.array(z.string()),
      }),
    ),
    suggestedActions: z.array(z.string()),
  })
  .openapi("MaintainerPacket");

export const PullRequestMaintainerPacketSchema = z
  .object({
    repoFullName: z.string(),
    pullNumber: z.number(),
    generatedAt: z.string(),
    reviewPriority: z.enum(["review", "needs_author", "watch"]),
    summary: z.string(),
    changeSummary: z.object({
      fileCount: z.number(),
      codeFileCount: z.number(),
      testFileCount: z.number(),
      additions: z.number(),
      deletions: z.number(),
      topPaths: z.array(z.string()),
    }),
    reviewSignals: z.object({
      reviewCount: z.number(),
      approvalCount: z.number(),
      changeRequestCount: z.number(),
      checkFailureCount: z.number(),
      linkedIssues: z.array(z.number()),
      collisionClusters: z.number(),
    }),
    findings: z.array(FindingSchema),
    contributorNextSteps: z.array(z.string()),
    maintainerNotes: z.array(z.string()),
  })
  .openapi("PullRequestMaintainerPacket");

export const BountySchema = z
  .object({
    id: z.string(),
    repoFullName: z.string(),
    issueNumber: z.number(),
    status: z.string(),
    amountText: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    payload: z.record(z.string(), z.unknown()),
    discoveredAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .openapi("Bounty");

export const BountyAdvisorySchema = z
  .object({
    id: z.string(),
    repoFullName: z.string(),
    issueNumber: z.number(),
    status: z.string(),
    lifecycle: z.enum(["active", "historical", "completed", "cancelled", "stale", "ambiguous", "unknown"]),
    isActiveOpportunity: z.boolean(),
    fundingStatus: z.enum(["funded", "target_only", "unknown"]),
    consensusRisk: z.enum(["low", "medium", "high"]),
    linkedPrs: z.array(
      z.object({
        number: z.number(),
        state: z.enum(["open", "closed", "merged", "unknown"]),
        isActive: z.boolean(),
      }),
    ),
    findings: z.array(FindingSchema),
  })
  .openapi("BountyAdvisory");

export const BountyLifecycleEventsSchema = z
  .object({
    bountyId: z.string(),
    events: z.array(
      z.object({
        id: z.string(),
        bountyId: z.string(),
        repoFullName: z.string(),
        issueNumber: z.number(),
        status: z.string(),
        payload: z.record(z.string(), z.unknown()),
        generatedAt: z.string(),
      }),
    ),
  })
  .openapi("BountyLifecycleEvents");

export const RepositorySettingsSchema = z
  .object({
    repoFullName: z.string(),
    commentMode: z.enum(["off", "detected_contributors_only", "all_prs"]),
    publicSignalLevel: z.enum(["minimal", "standard"]),
    checkRunMode: z.enum(["off", "enabled"]),
    checkRunDetailLevel: z.enum(["minimal", "standard", "deep"]),
    autoLabelEnabled: z.boolean(),
    gittensorLabel: z.string(),
    createMissingLabel: z.boolean(),
    publicSurface: z.enum(["off", "comment_and_label", "comment_only", "label_only"]),
    includeMaintainerAuthors: z.boolean(),
    requireLinkedIssue: z.boolean(),
    backfillEnabled: z.boolean(),
    privateTrustEnabled: z.boolean(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .openapi("RepositorySettings");

export const RepoSettingsPreviewSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    settings: z.object({
      publicSurface: z.enum(["off", "comment_and_label", "comment_only", "label_only"]),
      commentMode: z.enum(["off", "detected_contributors_only", "all_prs"]),
      publicSignalLevel: z.enum(["minimal", "standard"]),
      checkRunMode: z.enum(["off", "enabled"]),
      checkRunDetailLevel: z.enum(["minimal", "standard", "deep"]),
      autoLabelEnabled: z.boolean(),
      gittensorLabel: z.string(),
      createMissingLabel: z.boolean(),
      includeMaintainerAuthors: z.boolean(),
      requireLinkedIssue: z.boolean(),
    }),
    installation: z
      .object({
        installationId: z.number(),
        status: z.enum(["healthy", "needs_attention", "broken"]),
        missingPermissions: z.array(z.string()),
        missingEvents: z.array(z.string()),
        permissionRemediation: z.array(
          z.object({
            permission: z.string(),
            requiredAccess: z.string(),
            currentAccess: z.string(),
            ok: z.boolean(),
            action: z.string(),
          }),
        ),
      })
      .nullable(),
    sample: z.object({
      authorLogin: z.string(),
      authorType: z.string(),
      authorAssociation: z.string(),
      minerStatus: z.enum(["confirmed", "not_found", "unavailable"]),
      title: z.string(),
      labels: z.array(z.string()),
      linkedIssues: z.array(z.number()),
    }),
    decision: z.object({
      willComment: z.boolean(),
      willLabel: z.boolean(),
      willCheckRun: z.boolean(),
      skipped: z.boolean(),
      skipReason: z.enum(["surface_off", "missing_author", "bot_author", "maintainer_author", "miner_detection_unavailable", "not_official_gittensor_miner"]).nullable(),
      actions: z.array(z.enum(["skip", "comment", "label", "check_run", "none"])),
      summary: z.string(),
    }),
    previewComment: z.string().nullable(),
    appliedLabel: z.string().nullable(),
    checkRun: z
      .object({
        willCreate: z.boolean(),
        title: z.string(),
        detailLevel: z.enum(["minimal", "standard", "deep"]),
      })
      .nullable(),
    warnings: z.array(z.string()),
    summary: z.string(),
  })
  .openapi("RepoSettingsPreview");

export const RepoSyncStateSchema = z
  .object({
    repoFullName: z.string(),
    status: z.enum(["never_synced", "running", "success", "partial", "error", "skipped", "capped", "rate_limited", "stale"]),
    sourceKind: z.enum(["github", "installation", "test"]),
    primaryLanguage: z.string().nullable().optional(),
    defaultBranch: z.string().nullable().optional(),
    isPrivate: z.boolean().nullable().optional(),
    openIssuesCount: z.number(),
    openPullRequestsCount: z.number(),
    recentMergedPullRequestsCount: z.number(),
    labelsSyncedAt: z.string().nullable().optional(),
    issuesSyncedAt: z.string().nullable().optional(),
    pullRequestsSyncedAt: z.string().nullable().optional(),
    mergedPullRequestsSyncedAt: z.string().nullable().optional(),
    lastStartedAt: z.string().nullable().optional(),
    lastCompletedAt: z.string().nullable().optional(),
    errorSummary: z.string().nullable().optional(),
    warnings: z.array(z.string()),
    updatedAt: z.string().nullable().optional(),
  })
  .openapi("RepoSyncState");

export const RepoSyncSegmentSchema = z
  .object({
    repoFullName: z.string(),
    segment: z.enum(["metadata", "labels", "open_issues", "open_pull_requests", "recent_merged_pull_requests", "pull_request_files", "pull_request_reviews", "check_summaries"]),
    status: z.enum([
      "never_synced",
      "running",
      "refreshing",
      "complete",
      "partial",
      "capped",
      "sampled",
      "stale",
      "rate_limited",
      "waiting_rate_limit",
      "error",
      "skipped",
      "not_modified",
    ]),
    sourceKind: z.enum(["github", "installation", "test"]),
    mode: z.enum(["light", "full", "resume"]),
    lastCursor: z.string().nullable().optional(),
    nextCursor: z.string().nullable().optional(),
    fetchedCount: z.number(),
    expectedCount: z.number().nullable().optional(),
    pageCount: z.number(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    staleAt: z.string().nullable().optional(),
    rateLimitResetAt: z.string().nullable().optional(),
    warnings: z.array(z.string()),
    errorSummary: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    cursor: z.string().nullable().optional(),
    coveragePercent: z.number().nullable().optional(),
    isRequired: z.boolean().optional(),
  })
  .openapi("RepoSyncSegment");

export const GitHubRateLimitObservationSchema = z
  .object({
    id: z.string().optional(),
    repoFullName: z.string().nullable().optional(),
    resource: z.enum(["rest", "graphql"]),
    path: z.string(),
    statusCode: z.number(),
    limitValue: z.number().nullable().optional(),
    remaining: z.number().nullable().optional(),
    resetAt: z.string().nullable().optional(),
    observedAt: z.string().nullable().optional(),
  })
  .openapi("GitHubRateLimitObservation");

export const SignalFidelitySchema = z
  .object({
    status: z.enum(["complete", "degraded", "blocked", "unknown"]),
    repoCount: z.number(),
    completeRepos: z.number(),
    degradedRepos: z.number(),
    blockedRepos: z.number(),
    partialRepos: z.array(z.string()),
    cappedRepos: z.array(z.string()),
    staleRepos: z.array(z.string()),
    rateLimitedRepos: z.array(z.string()),
    nextRecoverableAt: z.string().nullable().optional(),
  })
  .openapi("SignalFidelity");

export const CoreSignalFidelitySchema = z
  .object({
    status: z.enum(["complete", "degraded", "blocked", "unknown"]),
    repoCount: z.number(),
    completeRepos: z.number(),
    degradedRepos: z.number(),
    blockedRepos: z.number(),
    incompleteRepos: z.array(z.string()),
    refreshingRepos: z.array(z.string()),
    waitingForRateLimitRepos: z.array(z.string()),
    historyCoverage: z.enum(["sampled", "counts_only", "full"]),
  })
  .openapi("CoreSignalFidelity");

export const RepoGithubTotalsSnapshotSchema = z
  .object({
    id: z.string(),
    repoFullName: z.string(),
    openIssuesTotal: z.number(),
    openPullRequestsTotal: z.number(),
    mergedPullRequestsTotal: z.number(),
    closedUnmergedPullRequestsTotal: z.number(),
    labelsTotal: z.number(),
    sourceKind: z.enum(["github", "installation", "test"]),
    fetchedAt: z.string(),
    rateLimitRemaining: z.number().nullable().optional(),
    rateLimitResetAt: z.string().nullable().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("RepoGithubTotalsSnapshot");

export const InstallationHealthSchema = z
  .object({
    installationId: z.number(),
    accountLogin: z.string(),
    repositorySelection: z.string().nullable().optional(),
    installedReposCount: z.number(),
    registeredInstalledCount: z.number(),
    status: z.enum(["healthy", "needs_attention", "broken"]),
    missingPermissions: z.array(z.string()),
    missingEvents: z.array(z.string()),
    permissions: z.record(z.string(), z.string()),
    events: z.array(z.string()),
    checkedAt: z.string(),
    errorSummary: z.string().nullable().optional(),
    requiredPermissions: z.record(z.string(), z.string()).optional(),
    requiredEvents: z.array(z.string()).optional(),
    optionalVisibleEvents: z.array(z.string()).optional(),
    permissionRemediation: z
      .array(z.object({ permission: z.string(), requiredAccess: z.string(), currentAccess: z.string(), ok: z.boolean(), action: z.string() }))
      .optional(),
    eventRemediation: z.array(z.object({ event: z.string(), ok: z.boolean(), action: z.string() })).optional(),
    repairSteps: z.array(z.string()).optional(),
  })
  .openapi("InstallationHealth");

export const UpstreamDriftReportSchema = z
  .object({
    id: z.string(),
    fingerprint: z.string(),
    severity: z.enum(["low", "medium", "high", "blocking"]),
    status: z.enum(["open", "acknowledged", "resolved", "ignored"]),
    summary: z.string(),
    affectedAreas: z.array(z.enum(["registry", "scoring_model", "issue_discovery", "mirror_linkage", "language_weights", "source"])),
    previousRulesetId: z.string().nullable().optional(),
    currentRulesetId: z.string().nullable().optional(),
    issueNumber: z.number().nullable().optional(),
    issueUrl: z.string().nullable().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    generatedAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("UpstreamDriftReport");

const RegistryHyperparameterDriftFieldSchema = z.enum([
  "repo",
  "emissionShare",
  "issueDiscoveryShare",
  "maintainerCut",
  "labelMultipliers",
  "trustedLabelPipeline",
  "defaultLabelMultiplier",
  "fixedBaseScore",
  "eligibilityMode",
]);

const RegistryDriftSurfaceSchema = z.enum(["allocation", "lane_fit", "scoreability_assumptions", "maintainer_economics", "issue_discovery_behavior", "label_policy"]);

export const RegistryHyperparameterDriftSummarySchema = z
  .object({
    totalEvents: z.number(),
    omittedEvents: z.number(),
    highImpactCount: z.number(),
    affectedRepoCount: z.number(),
    affectedFields: z.array(RegistryHyperparameterDriftFieldSchema),
    affectedSurfaces: z.array(RegistryDriftSurfaceSchema),
  })
  .openapi("RegistryHyperparameterDriftSummary");

export const UpstreamRulesetSnapshotSchema = z
  .object({
    id: z.string(),
    sourceRepo: z.string(),
    sourceRef: z.string(),
    commitSha: z.string().nullable().optional(),
    sourceSnapshotIds: z.array(z.string()),
    activeModel: z.enum(["current_density_model", "pending_saturation_model", "exponential_saturation_model", "unknown"]),
    registryRepoCount: z.number(),
    totalEmissionShare: z.number(),
    semanticHash: z.string(),
    payload: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    generatedAt: z.string(),
  })
  .openapi("UpstreamRulesetSnapshot");

export const UpstreamStatusSchema = z
  .object({
    generatedAt: z.string(),
    status: z.enum(["current", "drift_detected", "stale", "unavailable"]),
    latestCommitSha: z.string().nullable().optional(),
    latestRulesetId: z.string().nullable().optional(),
    latestRulesetGeneratedAt: z.string().nullable().optional(),
    activeModel: z.enum(["current_density_model", "pending_saturation_model", "exponential_saturation_model", "unknown"]).nullable().optional(),
    highestSeverity: z.enum(["low", "medium", "high", "blocking"]).nullable().optional(),
    affectedAreas: z.array(z.enum(["registry", "scoring_model", "issue_discovery", "mirror_linkage", "language_weights", "source"])),
    registryHyperparameterDrift: RegistryHyperparameterDriftSummarySchema,
    openReportCount: z.number(),
    reports: z.array(UpstreamDriftReportSchema),
  })
  .openapi("UpstreamStatus");

export const SyncStatusSchema = z
  .object({
    generatedAt: z.string(),
    signalFidelity: SignalFidelitySchema,
    freshnessSlo: z.object({
      status: z.enum(["fresh", "degraded", "blocked"]),
      generatedAt: z.string(),
      staleCount: z.number(),
      degradedCount: z.number(),
      blockedCount: z.number(),
      missingCount: z.number(),
      launchBlockingCount: z.number(),
      repairRecommended: z.boolean(),
      items: z.array(z.object({ area: z.string(), targetKey: z.string(), status: z.string(), launchBlocking: z.boolean(), ageSeconds: z.number().optional(), sloSeconds: z.number(), breachSeconds: z.number().optional(), observedAt: z.string().nullable().optional(), summary: z.string() })),
      warnings: z.array(z.string()),
    }),
    coreSignalFidelity: CoreSignalFidelitySchema,
    upstreamDrift: UpstreamStatusSchema,
    historyCoverage: z.enum(["sampled", "counts_only", "full"]),
    refreshingRepos: z.array(z.string()),
    waitingForRateLimitRepos: z.array(z.string()),
    repositories: z.array(RepoSyncStateSchema),
    segments: z.array(RepoSyncSegmentSchema),
    githubTotals: z.array(RepoGithubTotalsSnapshotSchema),
    pullRequestDetailSync: z.array(z.record(z.string(), z.unknown())),
    installations: z.array(InstallationHealthSchema),
    rateLimits: z.array(GitHubRateLimitObservationSchema),
  })
  .openapi("SyncStatus");

export const ReadinessSchema = z
  .object({
    status: z.enum(["ready", "needs_attention"]),
    generatedAt: z.string(),
    ready: z.boolean(),
    readyForPublicReview: z.boolean(),
    signalFidelity: SignalFidelitySchema,
    freshnessSlo: z.object({
      status: z.enum(["fresh", "degraded", "blocked"]),
      generatedAt: z.string(),
      staleCount: z.number(),
      degradedCount: z.number(),
      blockedCount: z.number(),
      missingCount: z.number(),
      launchBlockingCount: z.number(),
      repairRecommended: z.boolean(),
      items: z.array(z.object({ area: z.string(), targetKey: z.string(), status: z.string(), launchBlocking: z.boolean(), ageSeconds: z.number().optional(), sloSeconds: z.number(), breachSeconds: z.number().optional(), observedAt: z.string().nullable().optional(), summary: z.string() })),
      warnings: z.array(z.string()),
    }),
    coreSignalFidelity: CoreSignalFidelitySchema,
    upstreamDrift: UpstreamStatusSchema,
    historyCoverage: z.enum(["sampled", "counts_only", "full"]),
    partialRepos: z.array(z.string()),
    cappedRepos: z.array(z.string()),
    staleRepos: z.array(z.string()),
    rateLimitedRepos: z.array(z.string()),
    refreshingRepos: z.array(z.string()),
    waitingForRateLimitRepos: z.array(z.string()),
    nextRecoverableAt: z.string().nullable().optional(),
    registry: z
      .object({
        snapshotId: z.string(),
        repoCount: z.number(),
        totalEmissionShare: z.number(),
        source: z.object({ kind: z.string(), url: z.string() }),
        warningCount: z.number(),
      })
      .nullable(),
    scoringModel: z
      .object({
        snapshotId: z.string(),
        activeModel: z.enum(["current_density_model", "pending_saturation_model", "exponential_saturation_model", "unknown"]),
        sourceKind: z.string(),
        fetchedAt: z.string(),
        warningCount: z.number(),
      })
      .nullable(),
    githubBackfill: z.object({
      repoSyncCount: z.number(),
      statusCounts: z.record(z.string(), z.number()),
      failingSyncs: z.array(
        z.object({
          repoFullName: z.string(),
          errorSummary: z.string().nullable().optional(),
          lastCompletedAt: z.string().nullable().optional(),
        }),
      ),
      incompleteSyncs: z.array(
        z.object({
          repoFullName: z.string(),
          status: z.enum(["never_synced", "running", "skipped"]),
          lastCompletedAt: z.string().nullable().optional(),
        }),
      ),
      segmentCount: z.number(),
      segments: z.array(RepoSyncSegmentSchema),
      githubTotals: z.array(RepoGithubTotalsSnapshotSchema),
      pullRequestDetailSyncCount: z.number(),
      cappedSegments: z.array(z.object({ repoFullName: z.string(), segment: z.string(), nextCursor: z.string().nullable().optional() })),
      rateLimitedSegments: z.array(z.object({ repoFullName: z.string(), segment: z.string(), rateLimitResetAt: z.string().nullable().optional() })),
      latestRateLimits: z.array(GitHubRateLimitObservationSchema),
    }),
    installations: z.object({
      count: z.number(),
      healthCount: z.number(),
      unhealthyCount: z.number(),
    }),
    secrets: z.object({
      githubAppPrivateKey: z.boolean(),
      githubWebhookSecret: z.boolean(),
      githubPublicToken: z.boolean(),
      apiToken: z.boolean(),
      mcpToken: z.boolean(),
      internalJobToken: z.boolean(),
    }),
    warnings: z.array(z.string()),
  })
  .openapi("Readiness");

export const ScoringModelSnapshotSchema = z
  .object({
    id: z.string(),
    sourceKind: z.enum(["raw-github", "api", "fallback", "test"]),
    sourceUrl: z.string(),
    fetchedAt: z.string(),
    activeModel: z.enum(["current_density_model", "pending_saturation_model", "exponential_saturation_model", "unknown"]),
    constants: z.record(z.string(), z.number()),
    programmingLanguages: z.record(z.string(), z.unknown()),
    registrySnapshotId: z.string().nullable().optional(),
    warnings: z.array(z.string()),
    payload: z.record(z.string(), z.unknown()),
  })
  .openapi("ScoringModelSnapshot");

const ScoreEstimateSchema = z.object({
  baseScore: z.number(),
  densityMultiplier: z.number(),
  contributionBonus: z.number(),
  labelMultiplier: z.number(),
  issueMultiplier: z.number(),
  credibilityMultiplier: z.number(),
  reviewPenaltyMultiplier: z.number(),
  openPrMultiplier: z.number(),
  estimatedMergedScore: z.number(),
  pendingSaturationScore: z.number(),
});

const ScoreGatesSchema = z.object({
  baseTokenGatePassed: z.boolean(),
  openPrThreshold: z.number(),
  openPrCount: z.number(),
  collateralFraction: z.number(),
  credibilityFloor: z.number(),
  credibilityObserved: z.number(),
});

const BranchEligibilitySchema = z.object({
  required: z.boolean(),
  status: z.enum(["eligible", "ineligible", "unknown", "not_required"]),
  evidence: z.enum(["provided", "missing"]),
  source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied", "missing"]),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  stale: z.boolean(),
  warnings: z.array(z.string()),
});

const ScoreGateBlockerSchema = z.object({
  code: z.enum([
    "repo_not_registered",
    "inactive_allocation",
    "base_token_gate",
    "open_pr_threshold",
    "credibility_floor",
    "review_penalty",
    "metadata_only",
    "linked_issue_invalid",
    "linked_issue_unvalidated",
    "branch_ineligible",
    "branch_eligibility_missing",
  ]),
  severity: z.enum(["blocker", "reducer", "context"]),
  detail: z.string(),
});

const ScoreGateDeltaSchema = z.object({
  gate: z.enum(["open_pr_threshold", "credibility_floor", "linked_issue_multiplier"]),
  current: z.string(),
  projected: z.string(),
  explanation: z.string(),
});

const LinkedIssueMultiplierDecisionSchema = z.object({
  mode: z.enum(["none", "standard", "maintainer"]),
  status: z.enum(["not_required", "raw", "plausible", "validated", "invalid", "unavailable"]),
  source: z.enum(["none", "user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]),
  eligible: z.boolean(),
  issueNumbers: z.array(z.number()),
  solvedByPullRequests: z.array(z.number()),
  baseMultiplier: z.number(),
  appliedMultiplier: z.number(),
  reason: z.string(),
  warnings: z.array(z.string()),
});

const ScoreScenarioPreviewSchema = z.object({
  name: z.enum(["current", "cleanGates", "afterPendingMerges", "afterApprovedPrsMerge", "afterStalePrsClose", "linkedIssueFixed", "bestReasonableCase"]),
  source: z.enum(["current_data", "user_supplied", "github_observed", "gittensory_projection"]),
  assumptions: z.array(z.string()),
  scoreEstimate: ScoreEstimateSchema,
  gates: ScoreGatesSchema,
  effectiveEstimatedScore: z.number(),
  underlyingPotentialScore: z.number(),
  blockedBy: z.array(ScoreGateBlockerSchema),
  linkedIssueMultiplier: LinkedIssueMultiplierDecisionSchema,
  deltaExplanation: z.string(),
});

export const ScorePreviewResultSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    scoringModelSnapshotId: z.string(),
    activeModel: z.enum(["current_density_model", "pending_saturation_model", "exponential_saturation_model", "unknown"]),
    privateOnly: z.literal(true),
    laneMath: z.record(z.string(), z.number()),
    scoreEstimate: ScoreEstimateSchema,
    linkedIssueMultiplier: LinkedIssueMultiplierDecisionSchema,
    gates: ScoreGatesSchema,
    branchEligibility: BranchEligibilitySchema,
    effectiveEstimatedScore: z.number(),
    underlyingPotentialScore: z.number(),
    blockedBy: z.array(ScoreGateBlockerSchema),
    gateDeltas: z.array(ScoreGateDeltaSchema),
    scenarioPreviews: z.array(ScoreScenarioPreviewSchema),
    scoreabilityStatus: z.enum(["blocked", "conditionally_scoreable", "scoreable", "hold"]),
    warnings: z.array(z.string()),
    assumptions: z.array(z.string()),
    recommendation: z.object({
      level: z.enum(["strong_fit", "reasonable_fit", "needs_work", "hold"]),
      actions: z.array(z.string()),
    }),
  })
  .openapi("ScorePreviewResult");

export const ScorePreviewSchema = z
  .object({
    id: z.string(),
    scoringModelSnapshotId: z.string(),
    repoFullName: z.string(),
    targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]),
    targetKey: z.string(),
    contributorLogin: z.string().nullable().optional(),
    input: z.record(z.string(), z.unknown()),
    result: ScorePreviewResultSchema,
    generatedAt: z.string(),
  })
  .openapi("ScorePreview");

export const IssueQualityReportSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    lane: LaneAdviceSchema,
    issues: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        lifecycle: z.enum(["open", "closed_not_solved", "solved", "valid_solved", "stale", "duplicate", "invalid"]).optional(),
        linkage: z
          .object({
            status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]),
            source: z.enum(["official_mirror", "github_cache", "missing"]),
            solvedByPullRequests: z.array(z.number()),
            reason: z.string(),
            warnings: z.array(z.string()),
          })
          .optional(),
        status: z.enum(["ready", "needs_proof", "hold", "do_not_use"]),
        score: z.number(),
        reasons: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    ),
    summary: z.string(),
  })
  .openapi("IssueQualityReport");

export const IssueQualityResponseSchema = z
  .object({
    status: z.enum(["ready"]),
    source: z.enum(["snapshot", "computed"]),
    repoFullName: z.string(),
    generatedAt: z.string(),
    report: IssueQualityReportSchema,
  })
  .openapi("IssueQualityResponse");

export const BurdenForecastSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    horizonDays: z.union([z.literal(7), z.literal(30)]),
    level: z.enum(["low", "medium", "high", "critical"]),
    forecast: z.record(z.string(), z.number()),
    findings: z.array(FindingSchema),
    summary: z.string(),
  })
  .openapi("BurdenForecast");

export const ContributorScoringProfileSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    scoringModelSnapshotId: z.string(),
    evidence: z.record(z.string(), z.number()),
    privateSignals: z.array(z.string()),
  })
  .openapi("ContributorScoringProfile");

export const RoleContextSchema = z
  .object({
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    role: z.enum(["outside_contributor", "repo_maintainer", "org_member", "collaborator", "owner", "unknown"]),
    maintainerLane: z.boolean(),
    normalContributorEvidenceAllowed: z.boolean(),
    source: z.enum(["github_association", "repo_owner_match", "gittensor_api", "cache", "unknown"]),
    association: z.string().nullable().optional(),
    reasons: z.array(z.string()),
    guidance: z.string(),
  })
  .openapi("RoleContext");

const ContributorOutcomeCountsSchema = z.object({
  pullRequests: z.number(),
  mergedPullRequests: z.number(),
  openPullRequests: z.number(),
  closedPullRequests: z.number(),
  issues: z.number(),
  openIssues: z.number(),
  closedIssues: z.number(),
  solvedIssues: z.number(),
  validSolvedIssues: z.number(),
});

const ContributorOutcomeTotalsSchema = ContributorOutcomeCountsSchema.extend({
  closedPullRequestRate: z.number(),
  credibility: z.number(),
  issueCredibility: z.number(),
});

const ContributorReconciliationReportSchema = z.object({
  login: z.string(),
  generatedAt: z.string(),
  source: z.enum(["gittensor_api", "github_cache"]),
  officialAuthoritative: z.boolean(),
  totals: z.object({
    official: ContributorOutcomeTotalsSchema.optional(),
    cached: ContributorOutcomeTotalsSchema,
    effective: ContributorOutcomeTotalsSchema,
  }),
  repos: z.array(
    z.object({
      repoFullName: z.string(),
      maintainerLane: z.boolean(),
      official: ContributorOutcomeCountsSchema.optional(),
      cached: ContributorOutcomeCountsSchema,
      effective: ContributorOutcomeCountsSchema,
      discrepancyReasons: z.array(z.string()),
      freshness: z.object({
        officialUpdatedAt: z.string().optional(),
        cachedLastActivityAt: z.string().optional(),
      }),
    }),
  ),
  findings: z.array(FindingSchema),
  summary: z.string(),
});

export const ContributorOutcomeHistorySchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    source: z.enum(["gittensor_api", "github_cache"]),
    reconciliation: ContributorReconciliationReportSchema.optional(),
    totals: z.record(z.string(), z.number()),
    repoOutcomes: z.array(z.record(z.string(), z.unknown())),
    successPatterns: z.array(z.record(z.string(), z.unknown())),
    failurePatterns: z.array(z.record(z.string(), z.unknown())),
    summary: z.string(),
  })
  .openapi("ContributorOutcomeHistory");

export const ContributorPatternReportSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    patternType: z.enum(["success", "failure"]),
    patterns: z.array(z.record(z.string(), z.unknown())),
    summary: z.string(),
  })
  .openapi("ContributorPatternReport");

export const RepoOutcomeEvidenceCompletenessSchema = z
  .object({
    pullRequestsAnalyzed: z.number(),
    withFileDetail: z.number(),
    withReviewDetail: z.number(),
    withCheckDetail: z.number(),
    filesCompletenessRatio: z.number(),
    reviewsCompletenessRatio: z.number(),
    checksCompletenessRatio: z.number(),
    fullyDecidedWithDetail: z.number(),
    status: z.enum(["complete", "partial", "missing"]),
  })
  .openapi("RepoOutcomeEvidenceCompleteness");

export const RepoOutcomePatternsSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    lane: z.enum(["direct_pr", "issue_discovery", "split", "inactive", "unknown"]),
    primaryLanguage: z.string().nullable(),
    sampleSize: z.number(),
    totals: z.record(z.string(), z.number()),
    outsideContributorMergeRate: z.number(),
    maintainerLaneMergeRate: z.number(),
    dimensions: z.array(z.record(z.string(), z.unknown())),
    successPatterns: z.array(z.record(z.string(), z.unknown())),
    riskPatterns: z.array(z.record(z.string(), z.unknown())),
    evidenceCompleteness: RepoOutcomeEvidenceCompletenessSchema,
    findings: z.array(FindingSchema),
    summary: z.string(),
  })
  .openapi("RepoOutcomePatterns");

export const RepoOutcomePatternsResponseSchema = z
  .object({
    status: z.enum(["ready"]),
    source: z.enum(["snapshot", "computed"]),
    repoFullName: z.string(),
    generatedAt: z.string(),
    ageSeconds: z.number(),
    freshness: z.enum(["fresh", "stale"]),
    patterns: RepoOutcomePatternsSchema,
    dataQuality: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("RepoOutcomePatternsResponse");

export const RepoFitRecommendationSchema = z
  .object({
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    roleContext: RoleContextSchema,
    lane: LaneAdviceSchema,
    recommendation: z.enum(["pursue", "cleanup_first", "maintainer_lane", "avoid_for_now", "unknown"]),
    confidence: z.enum(["high", "medium", "low"]),
    reasons: z.array(z.string()),
    risks: z.array(z.string()),
    nextActions: z.array(z.string()),
    rewardRisk: z.record(z.string(), z.unknown()).optional(),
    reasoning: z.array(z.string()).optional(),
    actionImpact: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("RepoFitRecommendation");

export const ContributorIntakeHealthSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    level: z.enum(["healthy", "watch", "strained", "blocked"]),
    score: z.number(),
    queueHealth: z.record(z.string(), z.unknown()),
    configLevel: z.enum(["excellent", "good", "needs_attention", "fragile"]),
    duplicateClusters: z.number(),
    reviewablePullRequests: z.number(),
    summary: z.string(),
    findings: z.array(FindingSchema),
  })
  .openapi("ContributorIntakeHealth");

export const MaintainerCutReadinessSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    ready: z.boolean(),
    maintainerCut: z.number(),
    recommendedAction: z.enum(["leave_disabled", "consider_small_cut", "review_existing_cut", "fix_config_first"]),
    reasons: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .openapi("MaintainerCutReadiness");

export const MaintainerLaneReportSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    lane: LaneAdviceSchema,
    maintainerCut: z.number(),
    maintainerCutConfigured: z.boolean(),
    queueHealth: QueueHealthSchema,
    configQuality: ConfigQualitySchema,
    contributorIntakeHealth: ContributorIntakeHealthSchema,
    summary: z.string(),
    findings: z.array(FindingSchema),
  })
  .openapi("MaintainerLaneReport");

export const PullRequestReviewIntelligenceSchema = PullRequestMaintainerPacketSchema.extend({
  roleContext: RoleContextSchema,
  outcomeContext: z.record(z.string(), z.unknown()).optional(),
  recommendation: z.enum(["review", "needs_author", "watch", "likely_duplicate", "maintainer_lane"]),
  privateSummary: z.string(),
  reviewability: z.record(z.string(), z.unknown()).optional(),
}).openapi("PullRequestReviewIntelligence");

export const ContributorStrategySchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    scoringModelSnapshotId: z.string(),
    summary: z.string(),
    bestFitRepos: z.array(z.record(z.string(), z.unknown())),
    avoidRepos: z.array(z.record(z.string(), z.unknown())),
    cleanupFirst: z.array(z.record(z.string(), z.unknown())),
    maintainerLaneRepos: z.array(z.record(z.string(), z.unknown())),
    successPatterns: z.array(z.record(z.string(), z.unknown())),
    failurePatterns: z.array(z.record(z.string(), z.unknown())),
    laneWarnings: z.array(z.string()),
    nextActions: z.array(z.string()),
    rewardRisk: z.record(z.string(), z.unknown()).optional(),
    reasoning: z.array(z.string()).optional(),
    actionImpact: z.array(z.string()).optional(),
  })
  .openapi("ContributorStrategy");

export const DecisionPackFreshnessSchema = z.enum(["fresh", "stale", "rebuilding", "missing"]).openapi("DecisionPackFreshness");

export const DecisionRecommendationSchema = z.enum(["pursue", "cleanup_first", "maintainer_lane", "avoid_for_now", "watch"]).openapi("DecisionRecommendation");

export const DecisionActionKindSchema = z
  .enum(["cleanup_existing_prs", "land_existing_prs", "open_new_direct_pr", "file_issue_discovery", "maintainer_lane_improve_repo", "maintainer_cut_readiness"])
  .openapi("DecisionActionKind");

export const ActionPortfolioBucketNameSchema = z.enum(["cleanup", "wait", "direct_pr", "issue_discovery", "avoid", "maintainer_lane"]).openapi("ActionPortfolioBucketName");

export const ActionPortfolioItemSchema = z
  .object({
    bucket: ActionPortfolioBucketNameSchema,
    repoFullName: z.string(),
    actionKind: DecisionActionKindSchema.optional(),
    priorityScore: z.number(),
    recommendation: DecisionRecommendationSchema,
    status: z.enum(["recommended", "blocked", "watch"]),
    whyNow: z.array(z.string()),
    scoreabilityImpact: z.string(),
    riskImpact: z.string(),
    maintainerImpact: z.string(),
    blockedBy: z.array(z.string()),
    rerunWhen: z.string(),
    publicSafeSummary: z.string(),
    nextActions: z.array(z.string()),
    publicNextActions: z.array(z.string()),
    source: z.enum(["decision_pack"]),
    scenarioProjection: z
      .object({
        source: z.enum(["github_observed", "user_supplied"]),
        pendingMergedPrCount: z.number(),
        pendingClosedPrCount: z.number(),
        approvedPrCount: z.number(),
        expectedOpenPrCountAfterMerge: z.number().optional(),
        notes: z.array(z.string()),
      })
      .optional(),
  })
  .openapi("ActionPortfolioItem");

export const ActionPortfolioSchema = z
  .object({
    generatedAt: z.string(),
    bucketOrder: z.array(ActionPortfolioBucketNameSchema),
    buckets: z.array(
      z.object({
        bucket: ActionPortfolioBucketNameSchema,
        label: z.string(),
        summary: z.string(),
        actions: z.array(ActionPortfolioItemSchema),
      }),
    ),
    topActions: z.array(ActionPortfolioItemSchema),
    counts: z.record(z.string(), z.number()),
    summary: z.string(),
  })
  .openapi("ActionPortfolio");

export const ContributorDecisionPackSchema = z
  .object({
    status: z.enum(["ready"]),
    source: z.enum(["computed", "snapshot"]),
    login: z.string(),
    generatedAt: z.string(),
    snapshotAgeSeconds: z.number().optional(),
    stale: z.boolean(),
    freshness: DecisionPackFreshnessSchema,
    rebuildEnqueued: z.boolean(),
    scoringModelSnapshotId: z.string(),
    profile: z.record(z.string(), z.unknown()),
    outcomeHistory: ContributorOutcomeHistorySchema,
    roleContexts: z.array(RoleContextSchema),
    opportunities: z.array(ContributorOpportunitySchema),
    repoDecisions: z.array(z.record(z.string(), z.unknown())),
    topActions: z.array(z.record(z.string(), z.unknown())),
    actionPortfolio: ActionPortfolioSchema,
    cleanupFirst: z.array(z.record(z.string(), z.unknown())),
    pursueRepos: z.array(z.record(z.string(), z.unknown())),
    avoidRepos: z.array(z.record(z.string(), z.unknown())),
    maintainerLaneRepos: z.array(z.record(z.string(), z.unknown())),
    scoreBlockers: z.array(z.record(z.string(), z.unknown())),
    evidenceGraph: z.record(z.string(), z.unknown()).optional(),
    dataQuality: z.record(z.string(), z.unknown()),
    summary: z.string(),
    nextActions: z.array(z.string()),
    openPrMonitor: ContributorOpenPrMonitorSchema.optional(),
  })
  .openapi("ContributorDecisionPack");

export const DecisionPackRefreshNeededSchema = z
  .object({
    status: z.enum(["needs_snapshot_refresh"]),
    login: z.string(),
    repoFullName: z.string().optional(),
    generatedAt: z.string(),
    reason: z.enum(["missing_snapshot"]),
    freshness: z.enum(["missing"]),
    rebuildEnqueued: z.boolean(),
  })
  .openapi("DecisionPackRefreshNeeded");

export const RepoDecisionResponseSchema = z
  .object({
    status: z.enum(["ready"]),
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    source: z.enum(["computed", "snapshot"]),
    freshness: DecisionPackFreshnessSchema,
    rebuildEnqueued: z.boolean(),
    decision: z.record(z.string(), z.unknown()),
    dataQuality: z.record(z.string(), z.unknown()),
  })
  .openapi("RepoDecisionResponse");

export const RepoIntelligenceSchema = z
  .object({
    status: z.enum(["ready"]),
    source: z.enum(["computed", "snapshot"]),
    repoFullName: z.string(),
    generatedAt: z.string(),
    repo: RepositorySchema.nullable(),
    lane: LaneAdviceSchema,
    queueHealth: z.record(z.string(), z.unknown()).nullable().optional(),
    collisions: z.record(z.string(), z.unknown()).optional(),
    configQuality: z.record(z.string(), z.unknown()).nullable().optional(),
    labelAudit: z.record(z.string(), z.unknown()).nullable().optional(),
    maintainerLane: z.record(z.string(), z.unknown()).nullable().optional(),
    maintainerCutReadiness: z.record(z.string(), z.unknown()).nullable().optional(),
    contributorIntakeHealth: z.record(z.string(), z.unknown()).nullable().optional(),
    dataQuality: z.record(z.string(), z.unknown()),
    burdenForecast: BurdenForecastSchema.optional(),
    burdenForecastFreshness: z
      .object({
        source: z.enum(["snapshot", "computed"]),
        generatedAt: z.string(),
        ageSeconds: z.number(),
        freshness: z.enum(["fresh", "stale"]),
      })
      .optional(),
  })
  .openapi("RepoIntelligence");

export const RegistrationReadinessSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    ready: z.boolean(),
    recommendedRegistrationMode: z.enum(["direct_pr", "issue_discovery", "split"]),
    issuePolicy: z.enum(["issue_discovery_enabled", "split_pr_and_issue_discovery_enabled", "direct_pr_requires_linked_issue", "direct_pr_no_issue_required"]),
    directPrReadiness: z.object({ ready: z.boolean(), reasons: z.array(z.string()) }),
    issueDiscoveryReadiness: z.object({ ready: z.boolean(), recommendation: z.enum(["enabled", "recommended", "not_recommended"]), reasons: z.array(z.string()) }),
    labelPolicy: z.record(z.string(), z.unknown()),
    maintainerCutReadiness: z.record(z.string(), z.unknown()),
    testCoverageHealth: z.object({
      status: z.enum(["gate_ready", "gate_unknown"]),
      trustedLabelPipelineReady: z.boolean(),
      checkRunMode: z.enum(["off", "enabled"]),
      requiredGate: z.array(z.string()),
      note: z.string(),
      warnings: z.array(z.string()),
    }),
    queueHealth: z.object({ level: z.enum(["low", "medium", "high", "critical"]), burdenScore: z.number(), reviewablePullRequests: z.number(), summary: z.string() }),
    contributorIntakeHealth: z.record(z.string(), z.unknown()),
    docsCompleteness: z.record(z.string(), z.unknown()),
    githubApp: z.object({
      installed: z.boolean(),
      publicSurface: z.enum(["off", "comment_and_label", "comment_only", "label_only"]),
      commentMode: z.enum(["off", "detected_contributors_only", "all_prs"]),
      checkRunMode: z.enum(["off", "enabled"]),
      quietByDefault: z.boolean(),
      behavior: z.string(),
      warnings: z.array(z.string()),
    }),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
    dataQuality: z.record(z.string(), z.unknown()),
  })
  .openapi("RegistrationReadiness");

export const GittensorConfigRecommendationSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    privateOnly: z.boolean(),
    current: z.record(z.string(), z.unknown()).nullable(),
    recommended: z.record(z.string(), z.unknown()),
    tradeoffs: z.array(z.string()),
    reasons: z.array(z.string()),
    warnings: z.array(z.string()),
    dataQuality: z.record(z.string(), z.unknown()),
  })
  .openapi("GittensorConfigRecommendation");

export const RewardRiskActionSchema = z
  .object({
    actionKind: z.enum([
      "cleanup_existing_prs",
      "land_existing_prs",
      "close_or_withdraw_low_fit_prs",
      "open_new_direct_pr",
      "file_issue_discovery",
      "maintainer_lane_improve_repo",
      "maintainer_cut_readiness",
    ]),
    repoFullName: z.string(),
    priorityScore: z.number(),
    laneValueScore: z.number(),
    scoreabilityScore: z.number(),
    personalFitScore: z.number(),
    riskPenalty: z.number(),
    maintainerFrictionPenalty: z.number(),
    actionLeverageScore: z.number(),
    whyThisHelps: z.array(z.string()),
    nextActions: z.array(z.string()),
  })
  .openapi("RewardRiskAction");

export const RepoRewardRiskSchema = z
  .object({
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    roleContext: RoleContextSchema,
    lane: LaneAdviceSchema,
    recommendation: z.enum(["pursue", "cleanup_first", "maintainer_lane", "avoid_for_now", "unknown"]),
    rewardUpside: z.object({
      relevantLane: z.enum(["direct_pr", "issue_discovery", "maintainer_lane", "none"]),
      repoSlice: z.number(),
      directPrSlice: z.number(),
      issueDiscoverySlice: z.number(),
      maintainerCutSlice: z.number(),
      labelMultiplier: z.number(),
      issueMultiplier: z.number(),
      estimatedScoreIfClean: z.number(),
      currentEstimatedScore: z.number(),
    }),
    scoreBlockers: z.array(z.string()),
    riskBreakdown: z.object({
      queueBurden: z.enum(["low", "medium", "high", "critical"]),
      queueBurdenScore: z.number(),
      duplicateClusters: z.number(),
      highRiskDuplicateClusters: z.number(),
      closedPullRequestRate: z.number(),
      openPullRequests: z.number(),
      credibility: z.number(),
      reviewChurnRisk: z.enum(["low", "medium", "high"]),
    }),
    actionImpact: z.record(z.string(), z.unknown()),
    currentPreview: z.record(z.string(), z.unknown()),
    afterCleanupPreview: z.record(z.string(), z.unknown()),
    actions: z.array(RewardRiskActionSchema),
    whyThisHelps: z.array(z.string()),
    nextActions: z.array(z.string()),
    summary: z.string(),
  })
  .openapi("RepoRewardRisk");

export const LocalWorkspaceIntelligenceSchema = z
  .object({
    version: z.literal(2),
    sourceUpload: z.object({
      enabled: z.literal(false),
      detail: z.string(),
    }),
    branch: z.object({
      name: z.string().optional(),
      baseRef: z.string().optional(),
      headSha: z.string().optional(),
      pendingCommitCount: z.number(),
    }),
    changedFiles: z.object({
      total: z.number(),
      added: z.number(),
      modified: z.number(),
      deleted: z.number(),
      renamed: z.number(),
      binary: z.number(),
      paths: z.array(z.string()),
    }),
    testEvidence: z.object({
      level: z.enum(["test_files", "validation_commands", "both", "none"]),
      testFileCount: z.number(),
      passedValidationCount: z.number(),
      commands: z.array(
        z.object({
          command: z.string(),
          status: z.enum(["passed", "failed", "not_run"]),
          summary: z.string().optional(),
        }),
      ),
    }),
    linkedIssues: z.array(z.number()),
    baseFreshness: z.object({
      status: z.enum(["fresh", "stale", "possibly_stale", "unknown"]),
      baseRef: z.string().optional(),
      baseSha: z.string().optional(),
      headSha: z.string().optional(),
      mergeBaseSha: z.string().optional(),
      remoteTrackingSha: z.string().optional(),
      changedFileCount: z.number(),
      testFileCount: z.number(),
      passedValidationCount: z.number(),
      warnings: z.array(z.string()),
      recommendation: z.string().optional(),
    }),
    ciStatusHints: z.array(z.string()),
    localScorerDiagnostics: z
      .object({
        mode: z.string(),
        activeModel: z.string().optional(),
        warnings: z.array(z.string()),
        metadataOnly: z.boolean(),
      })
      .optional(),
    blockers: z.object({
      branchQuality: z.array(z.string()),
      accountState: z.array(z.string()),
    }),
    rerunWhen: z.string(),
  })
  .openapi("LocalWorkspaceIntelligence");

export const LocalBranchAnalysisSchema = z
  .object({
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    baseRef: z.string().optional(),
    headRef: z.string().optional(),
    branchName: z.string().optional(),
    baseFreshness: z.object({
      status: z.enum(["fresh", "stale", "possibly_stale", "unknown"]),
      baseRef: z.string().optional(),
      baseSha: z.string().optional(),
      headSha: z.string().optional(),
      mergeBaseSha: z.string().optional(),
      remoteTrackingSha: z.string().optional(),
      changedFileCount: z.number(),
      testFileCount: z.number(),
      passedValidationCount: z.number(),
      warnings: z.array(z.string()),
      recommendation: z.string().optional(),
    }),
    lane: LaneAdviceSchema,
    roleContext: RoleContextSchema,
    preflight: LocalDiffPreflightResultSchema,
    scorePreview: ScorePreviewResultSchema,
    scenarioScorePreview: z.object({
      current: ScoreScenarioPreviewSchema,
      bestReasonableCase: ScoreScenarioPreviewSchema,
      afterPendingMerges: ScoreScenarioPreviewSchema.optional(),
      afterApprovedPrsMerge: ScoreScenarioPreviewSchema.optional(),
      afterStalePrsClose: ScoreScenarioPreviewSchema.optional(),
      gateDeltas: z.array(ScoreGateDeltaSchema),
      blockedBy: z.array(ScoreGateBlockerSchema),
    }),
    observedPullRequestScenarios: z.object({
      approvedOrMergeable: z.number(),
      stale: z.number(),
      closed: z.number(),
      draft: z.number(),
      blocked: z.number(),
      maintainerLane: z.number(),
      notes: z.array(z.string()),
    }),
    githubBranchStatus: z.object({
      source: z.literal("cached_github_data"),
      status: z.enum(["approved", "failing_checks", "needs_author", "blocked", "pending_review", "no_pr", "unknown"]),
      pullNumber: z.number().optional(),
      title: z.string().optional(),
      reviewDecision: z.string().nullable().optional(),
      mergeableState: z.string().nullable().optional(),
      notes: z.array(z.string()),
    }),
    branchEligibility: BranchEligibilitySchema,
    rewardRisk: RepoRewardRiskSchema,
    scoreBlockers: z.array(z.string()),
    branchQualityBlockers: z.array(z.string()),
    accountStateBlockers: z.array(z.string()),
    recommendedRerunCondition: z.string(),
    localFindings: z.array(FindingSchema),
    maintainerFit: z.object({
      recommendation: z.enum(["pursue", "cleanup_first", "maintainer_lane", "avoid_for_now", "unknown"]),
      reviewBurden: z.enum(["low", "medium", "high"]),
      role: z.enum(["outside_contributor", "repo_maintainer", "org_member", "collaborator", "owner", "unknown"]),
      maintainerLane: z.boolean(),
      reasons: z.array(z.string()),
      risks: z.array(z.string()),
    }),
    manifestGuidance: z.object({
      present: z.boolean(),
      source: z.enum(["repo_file", "api_record", "none"]),
      linkedIssuePolicy: z.enum(["required", "preferred", "optional"]),
      issueDiscoveryPolicy: z.enum(["encouraged", "neutral", "discouraged"]),
      matchedWantedPaths: z.array(z.string()),
      matchedBlockedPaths: z.array(z.string()),
      preferredLabelHits: z.array(z.string()),
      findings: z.array(z.object({ code: z.string(), severity: z.enum(["info", "warning", "critical"]), title: z.string(), detail: z.string(), action: z.string().optional() })),
      publicNextSteps: z.array(z.string()),
      warnings: z.array(z.string()),
      summary: z.string(),
    }),
    prPacket: z.object({
      titleSuggestion: z.string(),
      markdown: z.string(),
      bodySections: z.array(z.object({ heading: z.string(), lines: z.array(z.string()) })),
      reviewerNotes: z.array(z.string()),
      validationSummary: z.object({
        passed: z.number(),
        failed: z.number(),
        notRun: z.number(),
        commands: z.array(
          z.object({
            command: z.string(),
            status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
            summary: z.string().optional(),
            durationMs: z.number().optional(),
            exitCode: z.number().optional(),
          }),
        ),
      }),
      publicSafeWarnings: z.array(z.string()),
    }),
    nextActions: z.array(RewardRiskActionSchema),
    workspaceIntelligence: LocalWorkspaceIntelligenceSchema,
    summary: z.string(),
  })
  .openapi("LocalBranchAnalysis");

export const ContributorRewardRiskStrategySchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    scoringModelSnapshotId: z.string(),
    summary: z.string(),
    topActions: z.array(RewardRiskActionSchema),
    repoAnalyses: z.array(RepoRewardRiskSchema),
    reasoning: z.array(z.string()),
    actionImpact: z.array(z.string()),
    nextActions: z.array(z.string()),
  })
  .openapi("ContributorRewardRiskStrategy");

export const MaintainerNoiseReportSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    score: z.number(),
    level: z.enum(["low", "medium", "high", "critical"]),
    noiseSources: z.array(z.string()),
    maintainerActions: z.array(z.enum(["review_now", "needs_author", "likely_duplicate", "close_or_redirect", "watch", "maintainer_lane"])),
    queueHealth: QueueHealthSchema,
    summary: z.string(),
  })
  .openapi("MaintainerNoiseReport");

export const PullRequestReviewabilitySchema = z
  .object({
    repoFullName: z.string(),
    pullNumber: z.number(),
    generatedAt: z.string(),
    score: z.number(),
    action: z.enum(["review_now", "needs_author", "likely_duplicate", "close_or_redirect", "watch", "maintainer_lane"]),
    noiseSources: z.array(z.string()),
    whyThisHelps: z.array(z.string()),
    maintainerNextSteps: z.array(z.string()),
    privateSummary: z.string(),
  })
  .openapi("PullRequestReviewability");

export const RegistryChangeReportSchema = z
  .object({
    generatedAt: z.string(),
    currentSnapshotId: z.string().optional(),
    previousSnapshotId: z.string().optional(),
    addedRepos: z.array(z.string()),
    removedRepos: z.array(z.string()),
    changedRepos: z.array(
      z.object({
        repoFullName: z.string(),
        changes: z.array(z.string()),
      }),
    ),
    summary: z.string(),
  })
  .openapi("RegistryChangeReport");

export const AgentActionSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    actionType: z.enum([
      "choose_next_work",
      "cleanup_existing_prs",
      "preflight_branch",
      "explain_score_blockers",
      "prepare_pr_packet",
      "check_duplicate_risk",
      "monitor_existing_pr",
      "explain_repo_fit",
    ]),
    targetRepoFullName: z.string().nullable().optional(),
    targetPullNumber: z.number().nullable().optional(),
    targetIssueNumber: z.number().nullable().optional(),
    status: z.enum(["recommended", "ready", "blocked", "watch", "needs_input"]),
    recommendation: z.string(),
    why: z.array(z.string()),
    scoreabilityImpact: z.string().nullable().optional(),
    riskImpact: z.string().nullable().optional(),
    maintainerImpact: z.string().nullable().optional(),
    blockedBy: z.array(z.string()),
    rerunWhen: z.string().nullable().optional(),
    publicSafeSummary: z.string(),
    approvalRequired: z.boolean(),
    safetyClass: z.enum(["private", "public_safe", "approval_required"]),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().nullable().optional(),
  })
  .openapi("AgentAction");

export const AgentRunSchema = z
  .object({
    id: z.string(),
    objective: z.string(),
    actorLogin: z.string(),
    surface: z.enum(["mcp", "github_comment", "api"]),
    mode: z.literal("copilot"),
    status: z.enum(["queued", "running", "completed", "failed", "needs_snapshot_refresh"]),
    dataQualityStatus: z.enum(["complete", "degraded", "blocked", "unknown"]),
    errorSummary: z.string().nullable().optional(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .openapi("AgentRun");

export const AgentContextSnapshotSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    decisionPackVersion: z.string().nullable().optional(),
    repoSignalSnapshotIds: z.array(z.string()),
    scoringModelId: z.string().nullable().optional(),
    freshnessWarnings: z.array(z.string()),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().nullable().optional(),
  })
  .openapi("AgentContextSnapshot");

export const AgentRunBundleSchema = z
  .object({
    run: AgentRunSchema,
    actions: z.array(AgentActionSchema),
    contextSnapshots: z.array(AgentContextSnapshotSchema),
    summary: z.string(),
  })
  .openapi("AgentRunBundle");

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("gittensory-api"),
    time: z.string(),
    minMcpVersion: z.string(),
    latestRecommendedMcpVersion: z.string(),
  })
  .openapi("Health");

export const McpCompatibilitySchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("gittensory-api"),
    apiVersion: z.string(),
    mcp: z.object({
      packageName: z.string(),
      minimumSupportedVersion: z.string(),
      latestRecommendedVersion: z.string(),
      latestPackageVersion: z.string(),
      supportedVersionRange: z.string(),
      upgradeCommand: z.string(),
      npxFallbackCommand: z.string(),
    }),
    compatibilityWarnings: z.array(
      z.object({
        code: z.string(),
        message: z.string(),
      }),
    ),
    breakingChanges: z.array(
      z.object({
        version: z.string(),
        summary: z.string(),
        mitigation: z.string().optional(),
      }),
    ),
    generatedAt: z.string(),
  })
  .openapi("McpCompatibility");
