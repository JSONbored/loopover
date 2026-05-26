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
    labelMultipliers: z.record(z.number()),
    trustedLabelPipeline: z.boolean().nullable().optional(),
    maintainerCut: z.number(),
    defaultLabelMultiplier: z.number().nullable().optional(),
    fixedBaseScore: z.number().nullable().optional(),
    eligibilityMode: z.string().nullable().optional(),
    raw: z.record(z.unknown()),
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
    payload: z.record(z.unknown()),
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
    lifecycle: z.enum(["active", "historical", "unknown"]),
    fundingStatus: z.enum(["funded", "target_only", "unknown"]),
    consensusRisk: z.enum(["low", "medium", "high"]),
    findings: z.array(FindingSchema),
  })
  .openapi("BountyAdvisory");

export const RepositorySettingsSchema = z
  .object({
    repoFullName: z.string(),
    commentMode: z.enum(["off", "detected_contributors_only", "all_prs"]),
    publicSignalLevel: z.enum(["minimal", "standard"]),
    checkRunMode: z.enum(["enabled"]),
    checkRunDetailLevel: z.enum(["minimal", "standard", "deep"]),
    backfillEnabled: z.boolean(),
    privateTrustEnabled: z.boolean(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .openapi("RepositorySettings");

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
    payload: z.record(z.unknown()).optional(),
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
    permissions: z.record(z.string()),
    events: z.array(z.string()),
    checkedAt: z.string(),
    errorSummary: z.string().nullable().optional(),
    requiredPermissions: z.record(z.string()).optional(),
    requiredEvents: z.array(z.string()).optional(),
    optionalVisibleEvents: z.array(z.string()).optional(),
    permissionRemediation: z
      .array(z.object({ permission: z.string(), requiredAccess: z.string(), currentAccess: z.string(), ok: z.boolean(), action: z.string() }))
      .optional(),
    eventRemediation: z.array(z.object({ event: z.string(), ok: z.boolean(), action: z.string() })).optional(),
    repairSteps: z.array(z.string()).optional(),
  })
  .openapi("InstallationHealth");

export const SyncStatusSchema = z
  .object({
    generatedAt: z.string(),
    signalFidelity: SignalFidelitySchema,
    coreSignalFidelity: CoreSignalFidelitySchema,
    historyCoverage: z.enum(["sampled", "counts_only", "full"]),
    refreshingRepos: z.array(z.string()),
    waitingForRateLimitRepos: z.array(z.string()),
    repositories: z.array(RepoSyncStateSchema),
    segments: z.array(RepoSyncSegmentSchema),
    githubTotals: z.array(RepoGithubTotalsSnapshotSchema),
    pullRequestDetailSync: z.array(z.record(z.unknown())),
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
    coreSignalFidelity: CoreSignalFidelitySchema,
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
        activeModel: z.enum(["current_density_model", "pending_saturation_model", "unknown"]),
        sourceKind: z.string(),
        fetchedAt: z.string(),
        warningCount: z.number(),
      })
      .nullable(),
    githubBackfill: z.object({
      repoSyncCount: z.number(),
      statusCounts: z.record(z.number()),
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
    activeModel: z.enum(["current_density_model", "pending_saturation_model", "unknown"]),
    constants: z.record(z.number()),
    programmingLanguages: z.record(z.unknown()),
    registrySnapshotId: z.string().nullable().optional(),
    warnings: z.array(z.string()),
    payload: z.record(z.unknown()),
  })
  .openapi("ScoringModelSnapshot");

export const ScorePreviewSchema = z
  .object({
    id: z.string(),
    scoringModelSnapshotId: z.string(),
    repoFullName: z.string(),
    targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]),
    targetKey: z.string(),
    contributorLogin: z.string().nullable().optional(),
    input: z.record(z.unknown()),
    result: z.record(z.unknown()),
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
        status: z.enum(["ready", "needs_proof", "hold", "do_not_use"]),
        score: z.number(),
        reasons: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    ),
    summary: z.string(),
  })
  .openapi("IssueQualityReport");

export const BurdenForecastSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    horizonDays: z.union([z.literal(7), z.literal(30)]),
    level: z.enum(["low", "medium", "high", "critical"]),
    forecast: z.record(z.number()),
    findings: z.array(FindingSchema),
    summary: z.string(),
  })
  .openapi("BurdenForecast");

export const ContributorScoringProfileSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    scoringModelSnapshotId: z.string(),
    evidence: z.record(z.number()),
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

export const ContributorOutcomeHistorySchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    source: z.enum(["gittensor_api", "github_cache"]),
    totals: z.record(z.number()),
    repoOutcomes: z.array(z.record(z.unknown())),
    successPatterns: z.array(z.record(z.unknown())),
    failurePatterns: z.array(z.record(z.unknown())),
    summary: z.string(),
  })
  .openapi("ContributorOutcomeHistory");

export const ContributorPatternReportSchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    patternType: z.enum(["success", "failure"]),
    patterns: z.array(z.record(z.unknown())),
    summary: z.string(),
  })
  .openapi("ContributorPatternReport");

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
    rewardRisk: z.record(z.unknown()).optional(),
    reasoning: z.array(z.string()).optional(),
    actionImpact: z.record(z.unknown()).optional(),
  })
  .openapi("RepoFitRecommendation");

export const ContributorIntakeHealthSchema = z
  .object({
    repoFullName: z.string(),
    generatedAt: z.string(),
    level: z.enum(["healthy", "watch", "strained", "blocked"]),
    score: z.number(),
    queueHealth: z.record(z.unknown()),
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
  outcomeContext: z.record(z.unknown()).optional(),
  recommendation: z.enum(["review", "needs_author", "watch", "likely_duplicate", "maintainer_lane"]),
  privateSummary: z.string(),
  reviewability: z.record(z.unknown()).optional(),
}).openapi("PullRequestReviewIntelligence");

export const ContributorStrategySchema = z
  .object({
    login: z.string(),
    generatedAt: z.string(),
    scoringModelSnapshotId: z.string(),
    summary: z.string(),
    bestFitRepos: z.array(z.record(z.unknown())),
    avoidRepos: z.array(z.record(z.unknown())),
    cleanupFirst: z.array(z.record(z.unknown())),
    maintainerLaneRepos: z.array(z.record(z.unknown())),
    successPatterns: z.array(z.record(z.unknown())),
    failurePatterns: z.array(z.record(z.unknown())),
    laneWarnings: z.array(z.string()),
    nextActions: z.array(z.string()),
    rewardRisk: z.record(z.unknown()).optional(),
    reasoning: z.array(z.string()).optional(),
    actionImpact: z.array(z.string()).optional(),
  })
  .openapi("ContributorStrategy");

export const ContributorDecisionPackSchema = z
  .object({
    status: z.enum(["ready"]),
    source: z.enum(["computed", "snapshot"]),
    login: z.string(),
    generatedAt: z.string(),
    snapshotAgeSeconds: z.number().optional(),
    stale: z.boolean(),
    scoringModelSnapshotId: z.string(),
    profile: z.record(z.unknown()),
    outcomeHistory: ContributorOutcomeHistorySchema,
    roleContexts: z.array(RoleContextSchema),
    repoDecisions: z.array(z.record(z.unknown())),
    topActions: z.array(z.record(z.unknown())),
    cleanupFirst: z.array(z.record(z.unknown())),
    pursueRepos: z.array(z.record(z.unknown())),
    avoidRepos: z.array(z.record(z.unknown())),
    maintainerLaneRepos: z.array(z.record(z.unknown())),
    scoreBlockers: z.array(z.record(z.unknown())),
    dataQuality: z.record(z.unknown()),
    summary: z.string(),
    nextActions: z.array(z.string()),
  })
  .openapi("ContributorDecisionPack");

export const DecisionPackRefreshNeededSchema = z
  .object({
    status: z.enum(["needs_snapshot_refresh"]),
    login: z.string(),
    repoFullName: z.string().optional(),
    generatedAt: z.string(),
    reason: z.enum(["missing_snapshot", "stale_snapshot"]),
    enqueued: z.boolean(),
    staleSnapshot: z.object({ generatedAt: z.string(), ageSeconds: z.number() }).optional(),
    dataQuality: z.record(z.unknown()).optional(),
  })
  .openapi("DecisionPackRefreshNeeded");

export const RepoDecisionResponseSchema = z
  .object({
    status: z.enum(["ready"]),
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    source: z.enum(["computed", "snapshot"]),
    decision: z.record(z.unknown()),
    dataQuality: z.record(z.unknown()),
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
    queueHealth: z.record(z.unknown()).nullable().optional(),
    collisions: z.record(z.unknown()).optional(),
    configQuality: z.record(z.unknown()).nullable().optional(),
    labelAudit: z.record(z.unknown()).nullable().optional(),
    maintainerLane: z.record(z.unknown()).nullable().optional(),
    maintainerCutReadiness: z.record(z.unknown()).nullable().optional(),
    contributorIntakeHealth: z.record(z.unknown()).nullable().optional(),
    dataQuality: z.record(z.unknown()),
  })
  .openapi("RepoIntelligence");

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
    actionImpact: z.record(z.unknown()),
    currentPreview: z.record(z.unknown()),
    afterCleanupPreview: z.record(z.unknown()),
    actions: z.array(RewardRiskActionSchema),
    whyThisHelps: z.array(z.string()),
    nextActions: z.array(z.string()),
    summary: z.string(),
  })
  .openapi("RepoRewardRisk");

export const LocalBranchAnalysisSchema = z
  .object({
    login: z.string(),
    repoFullName: z.string(),
    generatedAt: z.string(),
    baseRef: z.string().optional(),
    headRef: z.string().optional(),
    branchName: z.string().optional(),
    lane: LaneAdviceSchema,
    roleContext: RoleContextSchema,
    preflight: LocalDiffPreflightResultSchema,
    scorePreview: ScorePreviewSchema,
    rewardRisk: RepoRewardRiskSchema,
    scoreBlockers: z.array(z.string()),
    localFindings: z.array(FindingSchema),
    maintainerFit: z.object({
      recommendation: z.enum(["pursue", "cleanup_first", "maintainer_lane", "avoid_for_now", "unknown"]),
      reviewBurden: z.enum(["low", "medium", "high"]),
      role: z.enum(["outside_contributor", "repo_maintainer", "org_member", "collaborator", "owner", "unknown"]),
      maintainerLane: z.boolean(),
      reasons: z.array(z.string()),
      risks: z.array(z.string()),
    }),
    prPacket: z.object({
      titleSuggestion: z.string(),
      bodySections: z.array(z.object({ heading: z.string(), lines: z.array(z.string()) })),
      reviewerNotes: z.array(z.string()),
      validationSummary: z.object({
        passed: z.number(),
        failed: z.number(),
        notRun: z.number(),
        commands: z.array(z.object({ command: z.string(), status: z.enum(["passed", "failed", "not_run"]), summary: z.string().optional() })),
      }),
      publicSafeWarnings: z.array(z.string()),
    }),
    nextActions: z.array(RewardRiskActionSchema),
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

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("gittensory-api"),
    time: z.string(),
  })
  .openapi("Health");
