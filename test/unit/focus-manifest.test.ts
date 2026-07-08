import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAgentConfigured } from "../../src/settings/autonomy";
import {
  buildFocusManifestGuidance,
  compileFocusManifestPolicy,
  contentLaneConfigToJson,
  deriveContributionLanes,
  featuresConfigToJson,
  gateConfigToJson,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  parseFocusManifest,
  parseFocusManifestContent,
  formatManifestValidationNotice,
  resolveEffectiveSettings,
  excludeReviewPaths,
  applyReviewPathFilters,
  filterReviewFilesForAi,
  resolveReviewPathInstructions,
  resolveReviewAutoReviewConfig,
  resolveReviewPreMergeChecks,
  composeRepoReviewContext,
  evaluateAutoReviewSkipReason,
  resolveAutoReviewSkipSummary,
  AUTO_REVIEW_SKIP_SUMMARY,
  isContributorControlledAutoReviewSkipReason,
  resolveAutoReviewConfig,
  resolveReviewPromptOverrides,
  composeManifestReviewInstructions,
  EMPTY_AUTO_REVIEW_CONFIG,
  EMPTY_SELF_HOST_AI_MODEL_CONFIG,
  EMPTY_VISUAL_CONFIG,
  resolveReviewSelfHostAiModel,
  resolveReviewVisualConfig,
  repoDocGenerationConfigToJson,
  resolveTestGenerationManifestToggle,
  resolveReviewMemoryManifestToggle,
  reviewConfigToJson,
  overlayReviewConfig,
  parseReviewConfigMapping,
  reviewRecapConfigToJson,
  settingsOverrideToJson,
  type FocusManifest,
  type FocusManifestContentLaneConfig,
  type FocusManifestFeaturesConfig,
  type FocusManifestGateConfig,
  type FocusManifestRepoDocGenerationConfig,
  type FocusManifestReviewConfig,
  type FocusManifestReviewRecapConfig,
  type FocusManifestSettings,
  type SelfHostAiModelConfig,
} from "../../src/signals/focus-manifest";
import { DEFAULT_COMMAND_AUTHORIZATION_POLICY } from "../../src/settings/command-authorization";
import { MAX_TYPE_LABEL_CATEGORIES, MAX_TYPE_LABEL_NAME_LENGTH } from "../../src/settings/pr-type-label";
import type { RepositorySettings } from "../../src/types";

const FULL_MANIFEST = {
  source: "repo_file",
  wantedPaths: ["src/", "packages/*/lib"],
  blockedPaths: ["migrations/", "infra/secrets.tf"],
  preferredLabels: ["bug", "good first issue"],
  linkedIssuePolicy: "required",
  testExpectations: ["unit tests for new branches"],
  issueDiscoveryPolicy: "discouraged",
  maintainerNotes: ["Internal: ping @owner before touching the queue processor."],
  publicNotes: ["Prefer small, focused PRs."],
};

describe("parseFocusManifest", () => {
  it("normalizes a fully specified manifest", () => {
    const manifest = parseFocusManifest(FULL_MANIFEST);
    expect(manifest).toMatchObject({
      present: true,
      source: "repo_file",
      wantedPaths: ["src/", "packages/*/lib"],
      preferredLabels: ["bug", "good first issue"],
      linkedIssuePolicy: "required",
      issueDiscoveryPolicy: "discouraged",
      publicNotes: ["Prefer small, focused PRs."],
    });
    expect(manifest.warnings).toEqual([]);
  });

  it("treats null/undefined as an absent manifest", () => {
    for (const value of [null, undefined]) {
      const manifest = parseFocusManifest(value);
      expect(manifest.present).toBe(false);
      expect(manifest.source).toBe("none");
    }
  });

  it("falls back safely when the manifest is not an object", () => {
    for (const value of [["a", "b"], "string", 42, true]) {
      const manifest = parseFocusManifest(value);
      expect(manifest.present).toBe(false);
      expect(manifest.warnings.join(" ")).toMatch(/must be a mapping/i);
    }
  });

  it("warns and skips malformed field shapes without throwing", () => {
    const manifest = parseFocusManifest({
      wantedPaths: "src/",
      blockedPaths: [123, "ok", "", "  "],
      preferredLabels: ["a".repeat(400)],
      linkedIssuePolicy: "sometimes",
      issueDiscoveryPolicy: 7,
    });
    expect(manifest.wantedPaths).toEqual([]);
    expect(manifest.preferredLabels[0]).toHaveLength(300);
    expect(manifest.linkedIssuePolicy).toBe("optional");
    expect(manifest.issueDiscoveryPolicy).toBe("neutral");
    expect(manifest.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("caps over-long lists and de-duplicates entries", () => {
    const many = Array.from({ length: 250 }, (_, index) => `path-${index}`);
    const manifest = parseFocusManifest({ wantedPaths: [...many, "path-0"] });
    expect(manifest.wantedPaths.length).toBe(200);
    expect(manifest.warnings.join(" ")).toMatch(/exceeded 200 entries/);
  });

  it("de-duplicates repeated entries within the list cap", () => {
    const manifest = parseFocusManifest({ wantedPaths: ["src/", "src/", "lib/"] });
    expect(manifest.wantedPaths).toEqual(["src/", "lib/"]);
  });

  it("de-duplicates over-long entries after truncation", () => {
    const prefix = "a".repeat(300);
    const manifest = parseFocusManifest({ wantedPaths: [`${prefix}X`, `${prefix}Y`] });
    expect(manifest.wantedPaths).toEqual([prefix]);
    expect(manifest.warnings.join(" ")).toMatch(/truncated an over-long entry/);
  });

  it("applies the list cap to over-long entries", () => {
    const overLong = Array.from({ length: 250 }, (_, index) => `path-${index}-${"x".repeat(300)}`);
    const manifest = parseFocusManifest({ wantedPaths: overLong });
    expect(manifest.wantedPaths.length).toBe(200);
    expect(manifest.warnings.join(" ")).toMatch(/exceeded 200 entries/);
  });

  it("marks a manifest with no recognized fields as absent", () => {
    const manifest = parseFocusManifest({ unrelated: "value" });
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/no recognized focus fields/i);
  });

  it("redacts public notes that contain forbidden language", () => {
    const manifest = parseFocusManifest({ publicNotes: ["Maximize your reward payout", "Keep PRs small"] });
    expect(manifest.publicNotes).toEqual(["Keep PRs small"]);
  });

  it("respects an explicit source override and defaults to api_record otherwise", () => {
    expect(parseFocusManifest({ wantedPaths: ["src/"] }, "api_record").source).toBe("api_record");
    expect(parseFocusManifest({ wantedPaths: ["src/"] }).source).toBe("api_record");
    expect(parseFocusManifest({ source: "repo_file", wantedPaths: ["src/"] }).source).toBe("repo_file");
    expect(parseFocusManifest({ source: "bogus", wantedPaths: ["src/"] }).source).toBe("api_record");
  });
});

describe("parseFocusManifestContent", () => {
  it("returns an absent manifest for empty content", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(parseFocusManifestContent(value).present).toBe(false);
    }
  });

  it("parses valid JSON content", () => {
    const manifest = parseFocusManifestContent(JSON.stringify(FULL_MANIFEST));
    expect(manifest.present).toBe(true);
    expect(manifest.source).toBe("repo_file");
  });

  it("warns instead of throwing on malformed JSON", () => {
    const manifest = parseFocusManifestContent("{ not: valid json");
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/not valid JSON/i);
  });

  it("warns when JSON content is not a mapping", () => {
    for (const content of ['["a","b"]', "null", '"string"']) {
      const manifest = parseFocusManifestContent(content);
      expect(manifest.present).toBe(false);
      expect(manifest.warnings.join(" ")).toMatch(/must be a mapping/i);
    }
  });

  it("parses valid YAML content", () => {
    const manifest = parseFocusManifestContent("wantedPaths:\n  - src/\nblockedPaths:\n  - dist/\n", "repo_file");
    expect(manifest.present).toBe(true);
    expect(manifest.wantedPaths).toEqual(["src/"]);
  });

  it("warns instead of throwing on malformed YAML", () => {
    const manifest = parseFocusManifestContent("wantedPaths: [unterminated", "repo_file");
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/not valid YAML/i);
  });

  it("parses .gittensory.yml.example with zero warnings (#2554: doc must match parser exactly)", () => {
    const content = readFileSync(".gittensory.yml.example", "utf8");
    const manifest = parseFocusManifestContent(content, "repo_file");
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    // Spot-check the 4 knobs #2554 added docs for actually round-trip through the real parser.
    expect(manifest.gate.sizeMode).toBe("off");
    expect(manifest.gate.dryRun).toBe(false);
    expect(manifest.gate.selfAuthoredLinkedIssue).toBe("advisory");
    expect(manifest.gate.aiReviewCloseConfidence).toBeNull();
    // #2552: requireFreshRebaseWindow also round-trips through the real parser.
    expect(manifest.gate.requireFreshRebaseWindowMinutes).toBe(10);
    // #2563: gate.lockfileIntegrity also round-trips through the real parser.
    expect(manifest.gate.lockfileIntegrityMode).toBe("off");
  });

  it("parses .gittensory.minimal.yml with zero warnings and enables no agent actions (#2054)", () => {
    const content = readFileSync(".gittensory.minimal.yml", "utf8");
    const manifest = parseFocusManifestContent(content, "repo_file");
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    expect(manifest.gate.enabled).toBe(false);
    expect(isAgentConfigured(manifest.settings.autonomy)).toBe(false);
    const round = parseFocusManifest({ gate: gateConfigToJson(manifest.gate), settings: { autonomy: manifest.settings.autonomy } });
    expect(round.warnings).toEqual([]);
    expect(round.gate.enabled).toBe(false);
    expect(isAgentConfigured(round.settings.autonomy)).toBe(false);
  });
});

// #1670: `.gittensory.yml.example` is meant to be THE exhaustive reference -- every field a maintainer
// can configure, with a comment, default, and allowed values. The "parses with zero warnings" test above
// only proves whatever IS in the file is valid; it can never catch a field that's simply missing from the
// doc entirely. Each map below uses `satisfies Record<keyof T, string>` so adding a field to a config type
// without also adding it here is a TypeScript compile error -- the doc can never silently drift behind the
// parser again. A few `FocusManifestSettings` fields are deliberately excluded (see below) because they're
// raw settings-layer aliases of a `gate:` field that already documents the same knob under its friendlier
// name (`resolveEffectiveSettings` maps `gate.linkedIssue` -> `settings.linkedIssueGateMode`, etc.) --
// documenting both would just be confusing about which one to actually use.
describe(".gittensory.yml.example field-exhaustiveness (#1670)", () => {
  const exampleContent = readFileSync(".gittensory.yml.example", "utf8");

  const GATE_FIELD_TOKENS = {
    enabled: "enabled:",
    checkMode: "checkMode:",
    pack: "pack:",
    linkedIssue: "linkedIssue:",
    duplicates: "duplicates:",
    readinessMode: "readiness:",
    readinessMinScore: "readiness:",
    slopMode: "slop:",
    slopMinScore: "slop:",
    slopAiAdvisory: "aiAdvisory:",
    sizeMode: "size:",
    lockfileIntegrityMode: "lockfileIntegrity:",
    aiReviewMode: "aiReview:",
    aiReviewByok: "byok:",
    aiReviewProvider: "provider:",
    aiReviewModel: "model:",
    aiReviewAllAuthors: "allAuthors:",
    aiReviewCloseConfidence: "closeConfidence:",
    aiReviewCombine: "combine:",
    aiReviewOnMerge: "onMerge:",
    aiReviewReviewers: "reviewers:",
    mergeReadiness: "mergeReadiness:",
    manifestPolicy: "manifestPolicy:",
    selfAuthoredLinkedIssue: "selfAuthoredLinkedIssue:",
    linkedIssueSatisfaction: "linkedIssueSatisfaction:",
    dryRun: "dryRun:",
    firstTimeContributorGrace: "firstTimeContributorGrace:",
    premergeContentRecheck: "premergeContentRecheck:",
    requireFreshRebaseWindowMinutes: "requireFreshRebaseWindow:",
    claMode: "claMode:",
    claConsentPhrase: "consentPhrase:",
    claCheckRunName: "checkRunName:",
    claCheckRunAppSlug: "checkRunAppSlug:",
    expectedCiContexts: "expectedCiContexts:",
  } satisfies Record<Exclude<keyof FocusManifestGateConfig, "present">, string>;

  it.each(Object.entries(GATE_FIELD_TOKENS))("documents gate.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });

  // Settings fields that are raw aliases of an already-documented `gate:` field (see the describe-block
  // comment above) -- intentionally NOT in SETTINGS_FIELD_TOKENS, so they must be listed here instead of
  // silently vanishing from the exhaustiveness check.
  const SETTINGS_GATE_ALIASED_FIELDS = ["gateCheckMode", "linkedIssueGateMode", "duplicatePrGateMode", "selfAuthoredLinkedIssueGateMode", "qualityGateMode", "qualityGateMinScore", "aiReviewMode", "aiReviewByok", "aiReviewProvider", "aiReviewModel", "aiReviewAllAuthors"] as const;

  const SETTINGS_FIELD_TOKENS = {
    commentMode: "commentMode:",
    publicAudienceMode: "publicAudienceMode:",
    publicSignalLevel: "publicSignalLevel:",
    checkRunMode: "checkRunMode:",
    checkRunDetailLevel: "checkRunDetailLevel:",
    regateSweepOrderMode: "regateSweepOrderMode:",
    reviewCheckMode: "checkMode:", // `gate.checkMode` above documents the same underlying knob.
    autoProjectMilestoneMatch: "autoProjectMilestoneMatch:",
    autoProjectMilestoneMatchBackend: "autoProjectMilestoneMatchBackend:",
    closeOwnerAuthors: "closeOwnerAuthors:",
    autoLabelEnabled: "autoLabelEnabled:",
    typeLabelsEnabled: "typeLabelsEnabled:",
    badgeEnabled: "badgeEnabled:",
    publicQualityMetrics: "publicQualityMetrics:",
    gittensorLabel: "gittensorLabel:",
    createMissingLabel: "createMissingLabel:",
    publicSurface: "publicSurface:",
    includeMaintainerAuthors: "includeMaintainerAuthors:",
    requireLinkedIssue: "requireLinkedIssue:",
    backfillEnabled: "backfillEnabled:",
    autonomy: "autonomy:",
    autoMaintain: "autoMaintain:",
    agentPaused: "agentPaused:",
    agentDryRun: "agentDryRun:",
    commandAuthorization: "commandAuthorization:",
    contributorBlacklist: "contributorBlacklist:",
    blacklistLabel: "blacklistLabel:",
    contributorOpenPrCap: "contributorOpenPrCap:",
    contributorOpenIssueCap: "contributorOpenIssueCap:",
    contributorCapLabel: "contributorCapLabel:",
    contributorCapCancelCi: "contributorCapCancelCi:",
    reviewNagPolicy: "reviewNagPolicy:",
    reviewNagMaxPings: "reviewNagMaxPings:",
    reviewNagCooldownDays: "reviewNagCooldownDays:",
    reviewNagLabel: "reviewNagLabel:",
    reviewNagMonitoredMentions: "reviewNagMonitoredMentions:",
    autoCloseExemptLogins: "autoCloseExemptLogins:",
    hardGuardrailGlobs: "hardGuardrailGlobs:",
    manualReviewLabel: "manualReviewLabel:",
    readyToMergeLabel: "readyToMergeLabel:",
    changesRequestedLabel: "changesRequestedLabel:",
    migrationCollisionLabel: "migrationCollisionLabel:",
    pendingClosureLabel: "pendingClosureLabel:",
    accountAgeThresholdDays: "accountAgeThresholdDays:",
    newAccountLabel: "newAccountLabel:",
    commandRateLimitPolicy: "commandRateLimitPolicy:",
    commandRateLimitMaxPerWindow: "commandRateLimitMaxPerWindow:",
    commandRateLimitAiMaxPerWindow: "commandRateLimitAiMaxPerWindow:",
    commandRateLimitWindowHours: "commandRateLimitWindowHours:",
    moderationGateMode: "moderationGateMode:",
    moderationRules: "moderationRules:",
    moderationWarningLabel: "moderationWarningLabel:",
    moderationBannedLabel: "moderationBannedLabel:",
    reviewEvasionProtection: "reviewEvasionProtection:",
    reviewEvasionLabel: "reviewEvasionLabel:",
    reviewEvasionComment: "reviewEvasionComment:",
    mergeTrainMode: "mergeTrainMode:",
    typeLabels: "typeLabels:",
    linkedIssueLabelPropagation: "linkedIssueLabelPropagation:",
    linkedIssueHardRules: "linkedIssueHardRules:",
    unlinkedIssueGuardrail: "unlinkedIssueGuardrail:",
    screenshotTableGate: "screenshotTableGate:",
  } satisfies Record<Exclude<keyof FocusManifestSettings, (typeof SETTINGS_GATE_ALIASED_FIELDS)[number]>, string>;

  it.each(Object.entries(SETTINGS_FIELD_TOKENS))("documents settings.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });

  const REVIEW_FIELD_TOKENS = {
    footerText: "footer:",
    note: "note:",
    fields: "fields:",
    enrichmentAnalyzers: "enrichment:",
    profile: "profile:",
    tone: "tone:",
    securityFocus: "security_focus:",
    inlineComments: "inline_comments:",
    fixHandoff: "fixHandoff:",
    autoMergeSummary: "auto_merge_summary:",
    suggestions: "suggestions:",
    changedFilesSummary: "changed_files_summary:",
    effortScore: "effort_score:",
    testGeneration: "test_generation:",
    impactMap: "impact_map:",
    cultureProfile: "culture_profile:",
    reviewMemory: "memory:",
    findingCategories: "finding_categories:",
    inlineCommentsPerCategory: "inline_comments_per_category:",
    minFindingSeverity: "min_finding_severity:",
    maxFindings: "max_findings:",
    commentVerbosity: "comment_verbosity:",
    pathInstructions: "path_instructions:",
    instructions: "instructions:",
    excludePaths: "exclude_paths:",
    pathFilters: "path_filters:",
    preMergeChecks: "pre_merge_checks:",
    autoReview: "auto_review:",
    labelingRules: "labeling_rules:",
    aiModel: "ai_model:",
    visual: "visual:",
    linkedIssueSatisfaction: "linkedIssueSatisfaction:",
  } satisfies Record<Exclude<keyof FocusManifestReviewConfig, "present" | "sharedConfigSource">, string>;

  it.each(Object.entries(REVIEW_FIELD_TOKENS))("documents review.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });

  const FEATURES_FIELD_TOKENS = {
    rag: "rag:",
    reputation: "reputation:",
    unifiedComment: "unifiedComment:",
    safety: "safety:",
  } satisfies Record<Exclude<keyof FocusManifestFeaturesConfig, "present">, string>;

  it.each(Object.entries(FEATURES_FIELD_TOKENS))("documents features.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });

  const CONTENT_LANE_FIELD_TOKENS = {
    entryFileGlob: "entryFileGlob:",
    providerFileGlob: "providerFileGlob:",
    artifactGlob: "artifactGlob:",
    collectionField: "collectionField:",
    maxAppendedEntries: "maxAppendedEntries:",
    duplicateKeyFields: "duplicateKeyFields:",
    validatorId: "validatorId:",
  } satisfies Record<Exclude<keyof FocusManifestContentLaneConfig, "present">, string>;

  it.each(Object.entries(CONTENT_LANE_FIELD_TOKENS))("documents contentLane.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });

  const REPO_DOC_GENERATION_FIELD_TOKENS = {
    enabled: "enabled:",
    scope: "scope:",
    allowOverwriteExisting: "allowOverwriteExisting:",
    refreshIntervalDays: "refreshIntervalDays:",
  } satisfies Record<Exclude<keyof FocusManifestRepoDocGenerationConfig, "present">, string>;

  it.each(Object.entries(REPO_DOC_GENERATION_FIELD_TOKENS))("documents repoDocGeneration.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });

  const REVIEW_RECAP_FIELD_TOKENS = {
    enabled: "enabled:",
    cadenceDays: "cadenceDays:",
  } satisfies Record<Exclude<keyof FocusManifestReviewRecapConfig, "present">, string>;

  it.each(Object.entries(REVIEW_RECAP_FIELD_TOKENS))("documents reviewRecap.%s", (_field, token) => {
    expect(exampleContent).toContain(token);
  });
});

describe("matchesManifestPath", () => {
  it("matches exact paths and directory prefixes", () => {
    expect(matchesManifestPath("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchesManifestPath("src/nested/file.ts", "src/")).toBe(true);
    expect(matchesManifestPath("src/nested/file.ts", "src")).toBe(true);
    expect(matchesManifestPath("docs/readme.md", "src/")).toBe(false);
  });

  it("matches wildcard patterns and normalizes separators", () => {
    expect(matchesManifestPath("packages/mcp/lib/x.ts", "packages/*/lib/*.ts")).toBe(true);
    expect(matchesManifestPath("packages\\mcp\\lib\\x.ts", "packages/*/lib/*.ts")).toBe(true);
    expect(matchesManifestPath("./src/Index.ts", "src/index.ts")).toBe(true);
    expect(matchesManifestPath("src/a.ts", "**/*.go")).toBe(false);
  });

  it("returns false for empty path or pattern", () => {
    expect(matchesManifestPath("", "src/")).toBe(false);
    expect(matchesManifestPath("src/x.ts", "")).toBe(false);
  });

  it("**/ matches at the repo ROOT too (zero-depth), not only nested files (#review-audit)", () => {
    expect(matchesManifestPath("app.test.ts", "**/*.test.ts")).toBe(true); // root-level (was a bug: required a slash)
    expect(matchesManifestPath("dir/app.test.ts", "**/*.test.ts")).toBe(true); // nested still matches
    expect(matchesManifestPath("foo", "**/foo")).toBe(true);
    expect(matchesManifestPath("a/b/foo", "**/foo")).toBe(true);
    expect(matchesManifestPath("a/b/c.ts", "**/*.ts")).toBe(true);
  });

  it("keeps **/ on path-segment boundaries instead of broad suffix matching (#review-audit)", () => {
    expect(matchesManifestPath("safe.ts", "**/safe.ts")).toBe(true);
    expect(matchesManifestPath("dir/safe.ts", "**/safe.ts")).toBe(true);
    expect(matchesManifestPath("unsafe.ts", "**/safe.ts")).toBe(false);
    expect(matchesManifestPath("src/safe.ts", "src/**/safe.ts")).toBe(true);
    expect(matchesManifestPath("src/dir/safe.ts", "src/**/safe.ts")).toBe(true);
    expect(matchesManifestPath("src/unsafe.ts", "src/**/safe.ts")).toBe(false);
  });

  it("multi-wildcard matching is correct (ordered substrings, suffix cannot overlap)", () => {
    expect(matchesManifestPath("xayybzzc", "*a*b*c")).toBe(true);
    expect(matchesManifestPath("aXbXc", "a*b*c")).toBe(true);
    expect(matchesManifestPath("ab", "a*b")).toBe(true); // * matches empty
    expect(matchesManifestPath("ba", "a*b")).toBe(false); // wrong order
    expect(matchesManifestPath("ac", "a*b*c")).toBe(false); // 'b' missing between a and c
    expect(matchesManifestPath("ab", "a*b*c")).toBe(false); // missing trailing c
  });

  it("is LINEAR on a hostile multi-star glob — no catastrophic backtracking (ReDoS, #review-audit)", () => {
    const evilGlob = "*a".repeat(20); // 20 non-adjacent stars; the old code compiled this to a backtracking regex
    const nearMiss = "a".repeat(300) + "b"; // long run then a non-a tail the glob cannot satisfy
    const start = performance.now();
    const result = matchesManifestPath(nearMiss, evilGlob);
    const elapsed = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100); // the old per-star regex did not return within 30s on this input
  });

  it("bounds repeated **/ expansion while retaining linear matching (#review-audit)", () => {
    const globstarRun = "**/".repeat(20) + "safe.ts";
    const start = performance.now();
    const result = matchesManifestPath("a/b/c/safe.ts", globstarRun);
    const elapsed = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});

// Regression tests for the three compileManifestPathMatcher branches: exact,
// directory-prefix, and wildcard. Each test exercises one branch in isolation.
describe("matchesManifestPath — compileManifestPathMatcher branches", () => {
  it("exact branch: returns true only when normalised path equals normalised pattern", () => {
    expect(matchesManifestPath("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchesManifestPath("./src/Index.ts", "src/index.ts")).toBe(true); // normalisation
    expect(matchesManifestPath("src/other.ts", "src/index.ts")).toBe(false);
  });

  it("directory-prefix branch: matches descendants but not siblings with shared prefix", () => {
    expect(matchesManifestPath("src/utils/foo.ts", "src/utils")).toBe(true);
    expect(matchesManifestPath("src/utils/foo.ts", "src/utils/")).toBe(true);
    // "src/utilsX" shares the prefix string but must not match "src/utils"
    expect(matchesManifestPath("src/utilsX/foo.ts", "src/utils")).toBe(false);
    expect(matchesManifestPath("docs/readme.md", "src/")).toBe(false);
  });

  it("wildcard branch: * and ** expand to any characters in regex", () => {
    expect(matchesManifestPath("packages/mcp/lib/x.ts", "packages/*/lib/*.ts")).toBe(true);
    expect(matchesManifestPath("src/foo.ts", "src/*.ts")).toBe(true);
    expect(matchesManifestPath("src/foo.go", "src/*.ts")).toBe(false);
    expect(matchesManifestPath("a/b/c.ts", "**/*.ts")).toBe(true);
    expect(matchesManifestPath("src/a.ts", "**/*.go")).toBe(false);
  });
});

describe("buildFocusManifestGuidance", () => {
  const wanted = parseFocusManifest(FULL_MANIFEST);

  it("emits a malformed info finding when an absent manifest carries warnings", () => {
    const manifest = parseFocusManifestContent("{ broken");
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["src/x.ts"] });
    expect(guidance.present).toBe(false);
    expect(guidance.findings.some((finding) => finding.code === "manifest_malformed")).toBe(true);
    expect(guidance.summary).toMatch(/deterministic signals only/i);
  });

  it("returns a no-op guidance for an absent manifest with no warnings", () => {
    const guidance = buildFocusManifestGuidance({ manifest: parseFocusManifest(null), changedPaths: ["src/x.ts"] });
    expect(guidance.present).toBe(false);
    expect(guidance.findings).toEqual([]);
    expect(guidance.publicNextSteps).toEqual([]);
  });

  it("ignores legacy blockedPaths for review guidance and manual holds", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["migrations/0099_x.sql"] });
    // FULL_MANIFEST.blockedPaths includes "migrations/", which would have matched this changed path and
    // produced a manifest_blocked_path finding before blockedPaths was retired -- proving that code is gone
    // is the whole point of this test, not the unrelated manifest_malformed code from the test above.
    expect(guidance.findings.map((finding) => finding.code)).not.toContain("manifest_blocked_path");
    expect(guidance.publicNextSteps.join(" ")).not.toMatch(/blocked|guarded/i);
    expect(guidance.summary).toMatch(/outside the wanted areas/i);
  });

  it("recommends preferred paths when the change is in a wanted area", () => {
    const guidance = buildFocusManifestGuidance({
      manifest: wanted,
      changedPaths: ["src/feature.ts"],
      labels: ["bug"],
      linkedIssueCount: 1,
      testFileCount: 1,
    });
    expect(guidance.matchedWantedPaths).toContain("src/");
    expect(guidance.findings.some((finding) => finding.code === "manifest_preferred_path")).toBe(true);
    expect(guidance.preferredLabelHits).toContain("bug");
    expect(guidance.summary).toMatch(/aligns with a wanted area/i);
  });

  it("warns when a change is outside the wanted areas", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["docs/readme.md"], linkedIssueCount: 1, testFileCount: 1 });
    const offFocus = guidance.findings.find((finding) => finding.code === "manifest_off_focus");
    expect(offFocus?.severity).toBe("warning");
    expect(guidance.summary).toMatch(/outside the wanted areas/i);
  });

  it("requires a linked issue when the policy demands it", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["src/x.ts"], linkedIssueCount: 0, testFileCount: 1 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_linked_issue_required")).toBe(true);
  });

  it("REGRESSION (#no-issue-rationale-exemption): does not require a linked issue when the caller reports a clear no-issue rationale", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["src/x.ts"], linkedIssueCount: 0, testFileCount: 1, hasNoIssueRationale: true });
    expect(guidance.findings.some((finding) => finding.code === "manifest_linked_issue_required")).toBe(false);
  });

  it("prefers a linked issue under the preferred policy", () => {
    const manifest = parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" });
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["src/x.ts"], linkedIssueCount: 0, testFileCount: 1 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_linked_issue_preferred")).toBe(true);
  });

  it("surfaces missing preferred labels and test expectations", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["src/x.ts"], labels: [], linkedIssueCount: 1, testFileCount: 0, passedValidationCount: 0 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_missing_preferred_label")).toBe(true);
    const missingTests = guidance.findings.find((finding) => finding.code === "manifest_missing_tests");
    expect(missingTests).toMatchObject({
      title: "Configured validation evidence missing",
      detail: expect.stringContaining("No changed test files or passing validation evidence were detected"),
      action: "Add regression/invariant coverage, update relevant tests, or attach passing validation output that satisfies the repo's configured expectations.",
    });
    expect(missingTests?.detail).toContain("unit tests for new branches.");
  });

  it("omits the 'Expected evidence' detail when every test expectation is public-unsafe (#3304)", () => {
    // testExpectations.length > 0 still trips the finding, but the public-safe filter drops the only entry,
    // so the detail must fall back to the base sentence with no "Expected evidence: ..." suffix appended.
    const unsafeManifest = parseFocusManifest({ testExpectations: ["Submit your wallet seed phrase"] });
    const guidance = buildFocusManifestGuidance({ manifest: unsafeManifest, changedPaths: ["src/x.ts"], linkedIssueCount: 1, testFileCount: 0, passedValidationCount: 0 });
    const missingTests = guidance.findings.find((finding) => finding.code === "manifest_missing_tests");
    expect(missingTests?.detail).toBe("No changed test files or passing validation evidence were detected for this PR.");
    expect(missingTests?.detail).not.toContain("Expected evidence");
    expect(missingTests?.detail).not.toContain("wallet");
  });

  it("treats passing validation as satisfying test expectations", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["src/x.ts"], linkedIssueCount: 1, testFileCount: 0, passedValidationCount: 2 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_missing_tests")).toBe(false);
  });

  it("notes when issue-discovery is discouraged", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["src/x.ts"], labels: ["bug"], linkedIssueCount: 1, testFileCount: 1 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_issue_discovery_discouraged")).toBe(true);
  });

  it("never exposes maintainer-private notes in contributor guidance", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["migrations/x.sql"] });
    expect(guidance).not.toHaveProperty("maintainerNotes");
    expect(JSON.stringify(guidance)).not.toMatch(/ping @owner/);
    expect(guidance.publicNextSteps.every(isFocusManifestPublicSafe)).toBe(true);
  });

  it("produces a neutral summary when no wanted paths are configured", () => {
    const manifest = parseFocusManifest({ preferredLabels: ["bug"] });
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["src/x.ts"], labels: ["bug"] });
    expect(guidance.summary).toMatch(/no path-specific verdict/i);
  });
});

describe("compileFocusManifestPolicy", () => {
  const REPO = "JSONbored/gittensory";
  const GENERATED_AT = "2026-06-03T00:00:00.000Z";
  const opts = { generatedAt: GENERATED_AT };

  // ── Minimal: absent manifest ───────────────────────────────────────────
  it("returns an absent policy with empty contribution lanes for a null manifest", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest(null), opts);
    expect(policy.present).toBe(false);
    expect(policy.repoFullName).toBe(REPO);
    expect(policy.generatedAt).toBe(GENERATED_AT);
    expect(policy.source).toBe("none");
    expect(policy.publicSafe.contributionLanes).toEqual([]);
    expect(policy.publicSafe.readinessWarnings).toEqual([]);
    expect(policy.authenticated.parseWarnings).toEqual([]);
    expect(policy.authenticated.privateNoteCount).toBe(0);
  });

  it("does not mark the direct-PR lane 'preferred' from a redacted (public-unsafe) test expectation", () => {
    // The only test expectation is public-unsafe (wallet/seed) and there are no wanted paths, so nothing
    // public-safe signals that direct PRs are preferred. The lane preference must derive from the same
    // public-safe-filtered list it displays, not the raw testExpectations count.
    const manifest = parseFocusManifest({ testExpectations: ["Submit your wallet seed phrase"] });
    const policy = compileFocusManifestPolicy(REPO, manifest, opts);
    const directPr = policy.publicSafe.contributionLanes.find((lane) => lane.id === "direct-pr");
    expect(directPr).toBeDefined();
    expect(directPr!.validationExpectations).toEqual([]); // the unsafe expectation is redacted from the lane
    expect(directPr!.preferredPaths).toEqual([]);
    expect(directPr!.preference).toBe("neutral"); // was wrongly "preferred", driven by the raw (unfiltered) count
    expect(directPr!.summary).not.toMatch(/required validation evidence/i);

    // A PUBLIC-SAFE test expectation (no wanted paths) still drives the lane to "preferred" — the signal is real.
    const safeManifest = parseFocusManifest({ testExpectations: ["unit tests for new branches"] });
    const safeDirectPr = compileFocusManifestPolicy(REPO, safeManifest, opts).publicSafe.contributionLanes.find((lane) => lane.id === "direct-pr");
    expect(safeDirectPr!.preference).toBe("preferred");
    expect(safeDirectPr!.validationExpectations).toEqual(["unit tests for new branches"]);
  });

  it("forwards parse warnings into authenticated.parseWarnings for a malformed manifest", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifestContent("{ broken json"), opts);
    expect(policy.present).toBe(false);
    expect(policy.authenticated.parseWarnings.join(" ")).toMatch(/not valid JSON/i);
    expect(policy.authenticated.manifestWarningCount).toBeGreaterThan(0);
  });

  // ── Typical: fully specified manifest ─────────────────────────────────
  it("compiles a typical manifest into a complete policy schema", () => {
    const manifest = parseFocusManifest({
      source: "repo_file",
      wantedPaths: ["src/", "packages/*/lib"],
      blockedPaths: ["migrations/", "infra/secrets.tf"],
      preferredLabels: ["bug", "good first issue"],
      linkedIssuePolicy: "required",
      testExpectations: ["unit tests for new branches"],
      issueDiscoveryPolicy: "discouraged",
      maintainerNotes: ["Internal: ping @owner before the queue processor."],
      publicNotes: ["Prefer small, focused PRs."],
    });
    const policy = compileFocusManifestPolicy(REPO, manifest, opts);

    expect(policy.present).toBe(true);
    expect(policy.source).toBe("repo_file");

    // label policy
    expect(policy.publicSafe.labelPolicy.preferredLabels).toContain("bug");

    // validation
    expect(policy.publicSafe.validation.linkedIssuePolicy).toBe("required");
    expect(policy.publicSafe.validation.expectations).toContain("unit tests for new branches");

    // public notes — safe note included, private note excluded
    expect(policy.publicSafe.publicNotes).toContain("Prefer small, focused PRs.");
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(/ping @owner/);

    // authenticated: private note count, no maintainer text in publicSafe
    expect(policy.authenticated.privateNoteCount).toBe(1);
    expect(policy.authenticated.parseWarnings).toEqual([]);
  });

  // ── Missing-field: partial manifest ───────────────────────────────────
  it("handles a partial manifest with only linkedIssuePolicy set", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" }), opts);
    expect(policy.present).toBe(true);
    expect(policy.publicSafe.validation.linkedIssuePolicy).toBe("preferred");
    expect(policy.authenticated.privateNoteCount).toBe(0);
  });

  it("handles a manifest with only issueDiscoveryPolicy:encouraged", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ issueDiscoveryPolicy: "encouraged" }), opts);
    expect(policy.present).toBe(true);
    expect(policy.publicSafe.issueDiscoveryPolicy).toBe("encouraged");
  });

  it("keeps the focus-areas guidance for the public-safe wanted paths when one wanted path is a reserved word", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ wantedPaths: ["src/api/", "src/ranking/"] }), opts);
    const guidance = policy.publicSafe.entryGuidance.join(" ");
    // The safe path still surfaces; only the reserved-word path is dropped — the entire guidance line is no
    // longer discarded just because one wanted path is public-unsafe (consistent with contributionLanes).
    expect(guidance).toContain("Focus changes on maintainer-wanted areas: src/api/.");
    expect(guidance).not.toMatch(/ranking/i);
  });

  it("treats legacy blockedPaths-only manifests as absent", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ blockedPaths: ["infra/"] }), opts);
    expect(policy.present).toBe(false);
    expect(policy.publicSafe.readinessWarnings).toEqual([]);
  });

  it("emits a readiness warning when no wanted paths or preferred labels are declared", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ issueDiscoveryPolicy: "discouraged" }), opts);
    expect(policy.publicSafe.readinessWarnings.join(" ")).toMatch(/does not define wanted paths|contribution scope may be unclear/i);
  });

  it("emits a readiness warning when linked issue policy exists but no wanted paths are declared", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ linkedIssuePolicy: "required" }), opts);
    expect(policy.publicSafe.readinessWarnings.join(" ")).toMatch(/does not define wanted paths|contribution scope/i);
  });

  // ── Public/private separation ──────────────────────────────────────────
  it("keeps maintainer notes out of publicSafe entirely", () => {
    const policy = compileFocusManifestPolicy(
      REPO,
      parseFocusManifest({ wantedPaths: ["src/"], maintainerNotes: ["Private queue note.", "Ping @owner privately."] }),
      opts,
    );
    expect(policy.authenticated.privateNoteCount).toBe(2);
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(/Private queue note|Ping @owner/);
  });

  it("excludes forbidden language from all publicSafe fields even when injected via publicNotes or testExpectations", () => {
    const policy = compileFocusManifestPolicy(
      REPO,
      parseFocusManifest({
        wantedPaths: ["src/"],
        publicNotes: ["Maximize your reward payout", "Keep PRs focused."],
        testExpectations: ["Submit wallet seed phrase proof", "npm run test:ci"],
      }),
      opts,
    );
    const publicText = JSON.stringify(policy.publicSafe);
    expect(publicText).not.toMatch(/reward payout|wallet seed/i);
    expect(publicText).toContain("Keep PRs focused.");
    expect(publicText).toContain("npm run test:ci");
  });

  it("skips unsafe publicNotes when entry guidance is compiled from a raw manifest", () => {
    const policy = compileFocusManifestPolicy({
      present: true,
      source: "api_record",
      wantedPaths: ["src/"],
      preferredLabels: [],
      linkedIssuePolicy: "optional",
      testExpectations: [],
      issueDiscoveryPolicy: "neutral",
      maintainerNotes: [],
      publicNotes: ["Keep PRs focused.", "Maximize your reward payout"],
      gate: { present: false, enabled: null, checkMode: null, pack: null, linkedIssue: null, duplicates: null, readinessMode: null, readinessMinScore: null, slopMode: null, slopMinScore: null, slopAiAdvisory: null, sizeMode: null, lockfileIntegrityMode: null, aiReviewMode: null, aiReviewByok: null, aiReviewProvider: null, aiReviewModel: null, aiReviewAllAuthors: null, aiReviewCloseConfidence: null, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, mergeReadiness: null, selfAuthoredLinkedIssue: null, linkedIssueSatisfaction: null, manifestPolicy: null, dryRun: null, firstTimeContributorGrace: null, premergeContentRecheck: null, requireFreshRebaseWindowMinutes: null, claMode: null, claConsentPhrase: null, claCheckRunName: null, claCheckRunAppSlug: null, expectedCiContexts: null },
      settings: {},
      review: { present: false, footerText: null, note: null, fields: {}, enrichmentAnalyzers: {}, profile: null, tone: null, securityFocus: null, inlineComments: null, fixHandoff: null, autoMergeSummary: null, suggestions: null, changedFilesSummary: null, effortScore: null, testGeneration: null, impactMap: null, cultureProfile: null, reviewMemory: null, findingCategories: null, inlineCommentsPerCategory: null, minFindingSeverity: null, maxFindings: { blockers: null, nits: null }, commentVerbosity: null, pathInstructions: [], instructions: null, excludePaths: [], pathFilters: [], preMergeChecks: [], autoReview: { ...EMPTY_AUTO_REVIEW_CONFIG }, labelingRules: [], aiModel: { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG }, visual: { ...EMPTY_VISUAL_CONFIG }, linkedIssueSatisfaction: null, sharedConfigSource: null },
      features: { present: false, rag: null, reputation: null, unifiedComment: null, safety: null },
      contentLane: { present: false, entryFileGlob: null, providerFileGlob: null, artifactGlob: null, collectionField: null, maxAppendedEntries: null, duplicateKeyFields: [], validatorId: null },
      repoDocGeneration: { present: false, enabled: false, scope: ["agents"], allowOverwriteExisting: false, refreshIntervalDays: 7 },
      reviewRecap: { present: false, enabled: false, cadenceDays: 7 },
      warnings: [],
    });
    expect(policy.publicSafe.entryGuidance).toContain("Keep PRs focused.");
    expect(policy.publicSafe.entryGuidance.join(" ")).not.toMatch(/reward payout/i);
  });

  it("publicSafe.summary never contains forbidden language", () => {
    const dangerous = parseFocusManifest({ wantedPaths: ["src/"], publicNotes: ["Boost your raw trust score here"] });
    const policy = compileFocusManifestPolicy(dangerous);
    expect(isFocusManifestPublicSafe(policy.publicSafe.summary)).toBe(true);
  });

  it("preserves source field from the manifest", () => {
    expect(compileFocusManifestPolicy(REPO, parseFocusManifest({ wantedPaths: ["src/"] }, "repo_file"), opts).source).toBe("repo_file");
    expect(compileFocusManifestPolicy(REPO, parseFocusManifest({ wantedPaths: ["src/"] }, "api_record"), opts).source).toBe("api_record");
    expect(compileFocusManifestPolicy(REPO, parseFocusManifest(null), opts).source).toBe("none");
  });

  // ── Property-based sanitizer ───────────────────────────────────────────
  it("never emits forbidden language in any publicSafe field across random manifests", () => {
    const stringPool = [
      "",
      "src/",
      "migrations/",
      "Keep PRs focused.",
      "Prefer small, focused PRs.",
      "Maximize your reward payout",
      "Internal: ping @owner",
      "estimate your score",
      "paste your hotkey",
      "submit your wallet",
      "npm run test:ci",
      "packages/*/lib/*.ts",
    ];
    const linkedIssuePolicies = ["required", "preferred", "optional"] as const;
    const issueDiscoveryPolicies = ["encouraged", "neutral", "discouraged"] as const;

    let seed = 0xd4e3f2a1;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const sample = (max: number): string[] =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(stringPool));

    for (let iteration = 0; iteration < 400; iteration += 1) {
      const manifest = parseFocusManifest({
        wantedPaths: sample(4),
        blockedPaths: sample(4),
        preferredLabels: sample(4),
        linkedIssuePolicy: pick(linkedIssuePolicies),
        issueDiscoveryPolicy: pick(issueDiscoveryPolicies),
        testExpectations: sample(3),
        maintainerNotes: sample(4),
        publicNotes: sample(4),
      });
      const policy = compileFocusManifestPolicy(REPO, manifest, opts);
      const allPublicText = [
        ...policy.publicSafe.contributionLanes.flatMap((l) => [...l.preferredPaths, ...l.discouragedPaths, ...l.validationExpectations, ...l.publicNotes]),
        ...policy.publicSafe.labelPolicy.preferredLabels,
        ...policy.publicSafe.validation.expectations,
        ...policy.publicSafe.publicNotes,
        ...policy.publicSafe.readinessWarnings,
      ];
      expect(allPublicText.every(isFocusManifestPublicSafe)).toBe(true);
    }
  });
});

describe("deriveContributionLanes", () => {
  it("returns neutral lanes with no constraints when no manifest is present", () => {
    const lanes = deriveContributionLanes(parseFocusManifest(null));
    expect(lanes.present).toBe(false);
    expect(lanes.directPrLane).toBe("neutral");
    expect(lanes.issueDiscoveryLane).toBe("neutral");
    expect(lanes.preferredEntryPaths).toEqual([]);
    expect(lanes.discouragedEntryPaths).toEqual([]);
    expect(lanes.validationExpectations).toEqual([]);
    expect(lanes.issueEntryGuidance).toEqual([]);
    expect(lanes.prEntryGuidance).toEqual([]);
    expect(lanes.summary).toMatch(/not constrained/i);
  });

  it("marks direct-PR as preferred when wanted paths are declared", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/", "lib/"] }));
    expect(lanes.present).toBe(true);
    expect(lanes.directPrLane).toBe("preferred");
    expect(lanes.issueDiscoveryLane).toBe("neutral");
    expect(lanes.preferredEntryPaths).toEqual(["src/", "lib/"]);
    expect(lanes.prEntryGuidance.join(" ")).toMatch(/src\//);
    expect(lanes.summary).toMatch(/wanted areas are preferred/i);
  });

  it("marks issue-discovery as preferred and direct-PR as discouraged when issueDiscoveryPolicy is encouraged", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ issueDiscoveryPolicy: "encouraged" }));
    expect(lanes.directPrLane).toBe("discouraged");
    expect(lanes.issueDiscoveryLane).toBe("preferred");
    expect(lanes.issueEntryGuidance.join(" ")).toMatch(/welcomed|search for gaps/i);
    expect(lanes.summary).toMatch(/issue.discovery is the preferred/i);
  });

  it("marks issue-discovery as discouraged when issueDiscoveryPolicy is discouraged", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], issueDiscoveryPolicy: "discouraged" }));
    expect(lanes.issueDiscoveryLane).toBe("discouraged");
    expect(lanes.directPrLane).toBe("preferred");
    expect(lanes.issueEntryGuidance.join(" ")).toMatch(/prefer direct fixes|discourages/i);
    expect(lanes.summary).toMatch(/wanted areas are the preferred/i);
  });

  it("surfaces validation expectations from testExpectations and linkedIssuePolicy", () => {
    const lanes = deriveContributionLanes(
      parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "required", testExpectations: ["unit tests for new branches", "npm run test:ci"] }),
    );
    expect(lanes.validationExpectations).toContain("Link a tracked issue before opening a PR.");
    expect(lanes.validationExpectations).toContain("unit tests for new branches");
    expect(lanes.validationExpectations).toContain("npm run test:ci");
  });

  it("produces preferred validation hint for linkedIssuePolicy:preferred", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" }));
    expect(lanes.validationExpectations).toContain("Link a tracked issue if one exists.");
    expect(lanes.issueEntryGuidance).toContain("Link an existing issue to your PR when one is available.");
  });

  it("includes required link requirement in both validation expectations and issue entry guidance", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "required" }));
    expect(lanes.validationExpectations).toContain("Link a tracked issue before opening a PR.");
    expect(lanes.issueEntryGuidance).toContain("Issues must be linked to a PR before it is opened.");
  });

  it("ignores legacy blocked paths in discouragedEntryPaths and PR entry guidance", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], blockedPaths: ["migrations/", "infra/secrets.tf"] }));
    expect(lanes.discouragedEntryPaths).toEqual([]);
    expect(lanes.prEntryGuidance.join(" ")).not.toMatch(/migrations\/|infra\/secrets\.tf/);
  });

  it("includes preferred labels in PR entry guidance", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], preferredLabels: ["bug", "good first issue"] }));
    expect(lanes.prEntryGuidance.join(" ")).toMatch(/bug|good first issue/);
  });

  it("includes maintainer public notes in PR entry guidance", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], publicNotes: ["Prefer small, focused PRs."] }));
    expect(lanes.prEntryGuidance).toContain("Prefer small, focused PRs.");
  });

  it("excludes maintainerNotes from all output fields", () => {
    const lanes = deriveContributionLanes(
      parseFocusManifest({ wantedPaths: ["src/"], maintainerNotes: ["Internal: ping @owner before touching the queue processor."] }),
    );
    const serialized = JSON.stringify(lanes);
    expect(serialized).not.toMatch(/ping @owner/);
    expect(serialized).not.toMatch(/Internal:/);
  });

  it("filters public notes containing forbidden language before including them in prEntryGuidance", () => {
    const lanes = deriveContributionLanes(
      parseFocusManifest({ wantedPaths: ["src/"], publicNotes: ["Maximize your reward payout", "Keep PRs focused."] }),
    );
    expect(lanes.prEntryGuidance).not.toContain("Maximize your reward payout");
    expect(lanes.prEntryGuidance).toContain("Keep PRs focused.");
  });

  it("filters testExpectations containing forbidden language before including them in validationExpectations", () => {
    const lanes = deriveContributionLanes(
      parseFocusManifest({ wantedPaths: ["src/"], testExpectations: ["Submit your wallet seed phrase", "npm run test:ci"] }),
    );
    expect(lanes.validationExpectations).not.toContain("Submit your wallet seed phrase");
    expect(lanes.validationExpectations).toContain("npm run test:ci");
  });

  it("preserves source from the manifest", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"] }, "repo_file"));
    expect(lanes.source).toBe("repo_file");
  });

  it("passes a comprehensive manifest fixture end-to-end with all fields populated", () => {
    const manifest = parseFocusManifest({
      source: "repo_file",
      wantedPaths: ["src/", "packages/*/lib"],
      blockedPaths: ["migrations/"],
      preferredLabels: ["bug", "good first issue"],
      linkedIssuePolicy: "required",
      testExpectations: ["unit tests for new branches"],
      issueDiscoveryPolicy: "discouraged",
      maintainerNotes: ["Internal: ping @owner"],
      publicNotes: ["Prefer small, focused PRs."],
    });
    const lanes = deriveContributionLanes(manifest);

    expect(lanes.present).toBe(true);
    expect(lanes.source).toBe("repo_file");
    expect(lanes.directPrLane).toBe("preferred");
    expect(lanes.issueDiscoveryLane).toBe("discouraged");
    expect(lanes.preferredEntryPaths).toContain("src/");
    expect(lanes.discouragedEntryPaths).toEqual([]);
    expect(lanes.validationExpectations).toContain("Link a tracked issue before opening a PR.");
    expect(lanes.validationExpectations).toContain("unit tests for new branches");
    expect(lanes.issueEntryGuidance.join(" ")).toMatch(/discourages/i);
    expect(lanes.prEntryGuidance.join(" ")).toMatch(/bug|good first issue/i);
    expect(lanes.prEntryGuidance).toContain("Prefer small, focused PRs.");
    expect(lanes.summary).toMatch(/wanted areas/i);

    const serialized = JSON.stringify(lanes);
    expect(serialized).not.toMatch(/ping @owner/);
    expect(serialized).not.toMatch(/\b(wallet|hotkey|coldkey|raw trust|trust score|payout|reward|farming|private reviewability)\b/i);
  });

  it("keeps both lanes neutral with a default summary when a present manifest declares no wanted paths or policies", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ preferredLabels: ["bug"] }));
    expect(lanes.present).toBe(true);
    expect(lanes.directPrLane).toBe("neutral");
    expect(lanes.issueDiscoveryLane).toBe("neutral");
    expect(lanes.summary).toMatch(/guided by the maintainer focus manifest/i);
  });

  it("recommends direct PRs when issue-discovery is discouraged without any wanted paths", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ issueDiscoveryPolicy: "discouraged", preferredLabels: ["bug"] }));
    expect(lanes.directPrLane).toBe("neutral");
    expect(lanes.issueDiscoveryLane).toBe("discouraged");
    expect(lanes.summary).toMatch(/direct prs are preferred; issue-discovery submissions are discouraged/i);
  });
});

describe("public-safe invariant", () => {
  it("rejects forbidden compensation/secret language", () => {
    expect(isFocusManifestPublicSafe("Keep PRs focused")).toBe(true);
    expect(isFocusManifestPublicSafe("estimate your reward")).toBe(false);
    expect(isFocusManifestPublicSafe("paste your hotkey")).toBe(false);
  });

  it("rejects local filesystem paths, matching the canonical redaction guard", () => {
    // Unix homes + container/CI `/root/` + tmp.
    expect(isFocusManifestPublicSafe("see /Users/me/repo/src")).toBe(false);
    expect(isFocusManifestPublicSafe("see /home/dev/repo/src")).toBe(false);
    expect(isFocusManifestPublicSafe("see /root/repo/src")).toBe(false);
    // #1418: `/var/` was previously missed by this guard's local copy; it now composes from the canonical source.
    expect(isFocusManifestPublicSafe("see /var/folders/me/work/repo")).toBe(false);
    expect(isFocusManifestPublicSafe("see /var/log/build.log")).toBe(false);
    expect(isFocusManifestPublicSafe("see /tmp/build/out")).toBe(false);
    // Windows, both backslash and forward-slash forms.
    expect(isFocusManifestPublicSafe("see C:\\Users\\me\\repo")).toBe(false);
    expect(isFocusManifestPublicSafe("see C:/Users/me/repo")).toBe(false);
    // A relative path with none of these roots stays safe.
    expect(isFocusManifestPublicSafe("see src/signals/focus-manifest.ts")).toBe(true);
  });

  it("never emits public next steps that contain forbidden language for generated manifests", () => {
    // Deterministic property-style check (seeded LCG, no external generator dependency):
    // build a wide range of manifests/changed-paths from a fixture pool that deliberately
    // mixes forbidden language in, and assert the public next steps stay redaction-safe.
    const stringPool = [
      "",
      "   ",
      "src/",
      "migrations/",
      "Keep PRs focused",
      "Prefer small, focused PRs.",
      "Maximize your reward payout",
      "Internal: ping @owner before touching the queue processor.",
      "estimate your reward",
      "paste your hotkey",
      "a".repeat(400),
      "packages/*/lib/*.ts",
    ];
    const linkedIssuePolicies = ["required", "preferred", "optional"];
    const issueDiscoveryPolicies = ["encouraged", "neutral", "discouraged"];

    let seed = 0x2545f491;
    const next = () => {
      // 32-bit LCG (Numerical Recipes constants), kept fully deterministic across runs.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const sample = (max: number): string[] =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(stringPool));

    for (let iteration = 0; iteration < 400; iteration += 1) {
      const raw = {
        wantedPaths: sample(4),
        blockedPaths: sample(4),
        preferredLabels: sample(4),
        linkedIssuePolicy: pick(linkedIssuePolicies),
        issueDiscoveryPolicy: pick(issueDiscoveryPolicies),
        maintainerNotes: sample(4),
        publicNotes: sample(4),
      };
      const changedPaths = sample(6);
      const manifest: FocusManifest = parseFocusManifest(raw);
      const guidance = buildFocusManifestGuidance({ manifest, changedPaths });
      expect(guidance.publicNextSteps.every(isFocusManifestPublicSafe)).toBe(true);
    }
  });
});

describe("parseFocusManifest gate config", () => {
  it("parses a full gate section including the readiness block", () => {
    // readiness.mode uses "advisory" here (not "block") — readiness/quality can never hard-block (#2267);
    // the block→advisory deprecation-downgrade behavior itself is covered separately below.
    const m = parseFocusManifest({ gate: { linkedIssue: "block", duplicates: "advisory", readiness: { mode: "advisory", minScore: 70 } } });
    expect(m.present).toBe(true);
    expect(m.gate).toEqual({ present: true, enabled: null, checkMode: null, pack: null, linkedIssue: "block", duplicates: "advisory", readinessMode: "advisory", readinessMinScore: 70, slopMode: null, slopMinScore: null, slopAiAdvisory: null, sizeMode: null, lockfileIntegrityMode: null, aiReviewMode: null, aiReviewByok: null, aiReviewProvider: null, aiReviewModel: null, aiReviewAllAuthors: null, aiReviewCloseConfidence: null, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, mergeReadiness: null, selfAuthoredLinkedIssue: null, linkedIssueSatisfaction: null, manifestPolicy: null, dryRun: null, firstTimeContributorGrace: null, premergeContentRecheck: null, requireFreshRebaseWindowMinutes: null, claMode: null, claConsentPhrase: null, claCheckRunName: null, claCheckRunAppSlug: null, expectedCiContexts: null });
  });

  it("parses gate.mergeReadiness + gate.firstTimeContributorGrace, round-trips them, and warns on bad values (#822)", () => {
    const m = parseFocusManifest({ gate: { mergeReadiness: "block", firstTimeContributorGrace: true } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.mergeReadiness).toBe("block");
    expect(m.gate.firstTimeContributorGrace).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ mergeReadiness: "block", firstTimeContributorGrace: true });
    const bad = parseFocusManifest({ gate: { mergeReadiness: "sometimes", firstTimeContributorGrace: "yes" } });
    expect(bad.gate.mergeReadiness).toBeNull();
    expect(bad.gate.firstTimeContributorGrace).toBeNull();
    expect(bad.gate.present).toBe(false);
  });

  it("warns that gate.firstTimeContributorGrace is reserved/inert when explicitly set true (#2266)", () => {
    const m = parseFocusManifest({ gate: { firstTimeContributorGrace: true } });
    expect(m.gate.firstTimeContributorGrace).toBe(true);
    expect(m.warnings.some((w) => /gate\.firstTimeContributorGrace.*reserved\/inert/i.test(w))).toBe(true);
  });

  it("does not warn about firstTimeContributorGrace when left unset or explicitly false (matches the inert default)", () => {
    const unset = parseFocusManifest({ gate: { linkedIssue: "block" } });
    expect(unset.warnings.some((w) => /firstTimeContributorGrace/i.test(w))).toBe(false);
    const explicitFalse = parseFocusManifest({ gate: { firstTimeContributorGrace: false } });
    expect(explicitFalse.warnings.some((w) => /firstTimeContributorGrace/i.test(w))).toBe(false);
  });

  it("parses gate.selfAuthoredLinkedIssue + settings.selfAuthoredLinkedIssueGateMode, round-trips + resolves them (the gate alias wins)", () => {
    const m = parseFocusManifest({ gate: { selfAuthoredLinkedIssue: "block" }, settings: { selfAuthoredLinkedIssueGateMode: "advisory" } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.selfAuthoredLinkedIssue).toBe("block");
    expect(m.settings.selfAuthoredLinkedIssueGateMode).toBe("advisory");
    expect(gateConfigToJson(m.gate)).toMatchObject({ selfAuthoredLinkedIssue: "block" });
    const eff = resolveEffectiveSettings({ selfAuthoredLinkedIssueGateMode: "off" } as RepositorySettings, m);
    expect(eff.selfAuthoredLinkedIssueGateMode).toBe("block");
    const bad = parseFocusManifest({ gate: { selfAuthoredLinkedIssue: "sometimes" } });
    expect(bad.gate.selfAuthoredLinkedIssue).toBeNull();
  });

  it("parses gate.manifestPolicy, round-trips it through gateConfigToJson, and warns + nulls on a bad value (#555)", () => {
    const m = parseFocusManifest({ gate: { manifestPolicy: "block" } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.manifestPolicy).toBe("block");
    expect(gateConfigToJson(m.gate)).toMatchObject({ manifestPolicy: "block" });
    const bad = parseFocusManifest({ gate: { manifestPolicy: "sometimes" } });
    expect(bad.gate.manifestPolicy).toBeNull();
    expect(bad.gate.present).toBe(false);
    expect(bad.warnings.some((w) => w.includes("gate.manifestPolicy"))).toBe(true);
  });

  it("parses the gate.slop block, round-trips it, and warns on a non-mapping (#530/#532)", () => {
    const m = parseFocusManifest({ gate: { slop: { mode: "block", minScore: 55 } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.slopMode).toBe("block");
    expect(m.gate.slopMinScore).toBe(55);
    expect(gateConfigToJson(m.gate)).toMatchObject({ slop: { mode: "block", minScore: 55 } });

    const bad = parseFocusManifest({ gate: { slop: "block" } });
    expect(bad.gate.slopMode).toBeNull();
    expect(bad.warnings.some((w) => /gate\.slop/.test(w))).toBe(true);
  });

  it("parses gate.slop.aiAdvisory, round-trips it, resolves it, and warns on a non-boolean", () => {
    const m = parseFocusManifest({ gate: { slop: { mode: "advisory", aiAdvisory: true } } });
    expect(m.gate.slopMode).toBe("advisory");
    expect(m.gate.slopAiAdvisory).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ slop: { mode: "advisory", aiAdvisory: true } });

    // aiAdvisory layers onto the effective settings (off by default in the DB row).
    const eff = resolveEffectiveSettings({ slopGateMode: "off", slopAiAdvisory: false } as RepositorySettings, m);
    expect(eff.slopGateMode).toBe("advisory");
    expect(eff.slopAiAdvisory).toBe(true);

    const bad = parseFocusManifest({ gate: { slop: { aiAdvisory: "yes please" } } });
    expect(bad.gate.slopAiAdvisory).toBeNull();
    expect(bad.warnings.some((w) => /gate\.slop\.aiAdvisory/.test(w))).toBe(true);
  });

  it("parses gate.pack and ignores an unknown pack with a warning (#692)", () => {
    expect(parseFocusManifest({ gate: { pack: "oss-anti-slop" } }).gate.pack).toBe("oss-anti-slop");
    expect(parseFocusManifest({ gate: { pack: "gittensor" } }).gate.pack).toBe("gittensor");
    expect(parseFocusManifest({ gate: { pack: "oss-anti-slop" } }).gate.present).toBe(true);
    const bad = parseFocusManifest({ gate: { pack: "nonsense" } });
    expect(bad.gate.pack).toBeNull();
    expect(bad.warnings.some((w) => /gate\.pack/.test(w))).toBe(true);
  });

  it("parses gate.enabled (on/off) and ignores non-boolean values with a warning", () => {
    expect(parseFocusManifest({ gate: { enabled: true } }).gate.enabled).toBe(true);
    expect(parseFocusManifest({ gate: { enabled: false } }).gate.enabled).toBe(false);
    expect(parseFocusManifest({ gate: { enabled: true } }).gate.present).toBe(true);
    const bad = parseFocusManifest({ gate: { enabled: "yes" } });
    expect(bad.gate.enabled).toBeNull();
    expect(bad.warnings.some((w) => /gate\.enabled/.test(w))).toBe(true);
  });

  it("parses gate.checkMode (required/visible/disabled) and ignores an unknown value with a warning (#2852)", () => {
    expect(parseFocusManifest({ gate: { checkMode: "required" } }).gate.checkMode).toBe("required");
    expect(parseFocusManifest({ gate: { checkMode: "visible" } }).gate.checkMode).toBe("visible");
    expect(parseFocusManifest({ gate: { checkMode: "disabled" } }).gate.checkMode).toBe("disabled");
    expect(parseFocusManifest({ gate: { checkMode: "required" } }).gate.present).toBe(true);
    const bad = parseFocusManifest({ gate: { checkMode: "sometimes" } });
    expect(bad.gate.checkMode).toBeNull();
    expect(bad.warnings.some((w) => /gate\.checkMode/.test(w))).toBe(true);
    expect(bad.gate.present).toBe(false);
  });

  it("round-trips gate.checkMode through gateConfigToJson", () => {
    const m = parseFocusManifest({ gate: { checkMode: "visible" } });
    expect(gateConfigToJson(m.gate)).toMatchObject({ checkMode: "visible" });
    const unset = parseFocusManifest({ gate: { duplicates: "block" } });
    expect(gateConfigToJson(unset.gate)).not.toHaveProperty("checkMode");
  });

  it("treats a manifest with ONLY a gate section as present", () => {
    const m = parseFocusManifest({ gate: { duplicates: "block" } });
    expect(m.present).toBe(true);
    expect(m.gate.present).toBe(true);
    expect(m.gate.duplicates).toBe("block");
  });

  it("leaves unset gate fields null so the resolver falls back to DB settings", () => {
    const m = parseFocusManifest({ gate: { linkedIssue: "advisory" } });
    expect(m.gate.linkedIssue).toBe("advisory");
    expect(m.gate.duplicates).toBeNull();
    expect(m.gate.readinessMode).toBeNull();
    expect(m.gate.readinessMinScore).toBeNull();
  });

  it("ignores invalid gate values with a warning rather than throwing", () => {
    const m = parseFocusManifest({ gate: { linkedIssue: "sometimes", duplicates: 5, readiness: { mode: "nope", minScore: "high" } } });
    expect(m.gate.linkedIssue).toBeNull();
    expect(m.gate.duplicates).toBeNull();
    expect(m.gate.readinessMode).toBeNull();
    expect(m.gate.readinessMinScore).toBeNull();
    expect(m.gate.present).toBe(false);
    expect(m.warnings.some((w) => /gate\.linkedIssue/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /gate\.readiness\.mode/.test(w))).toBe(true);
  });

  it("downgrades gate.readiness.mode: block to advisory with a deprecation warning (#2267)", () => {
    // readiness/quality is informational-only (buildQualityGateWarning always produces a warning-severity
    // finding; isConfiguredGateBlocker has no branch for it) — a config that says "block" is downgraded
    // rather than silently accepted, so the parsed config always matches what the gate actually does.
    const m = parseFocusManifest({ gate: { readiness: { mode: "block" } } });
    expect(m.gate.readinessMode).toBe("advisory");
    expect(m.gate.present).toBe(true);
    expect(m.warnings.some((w) => /gate\.readiness\.mode.*no longer accepts "block"/.test(w))).toBe(true);
    // Genuinely invalid values still take the ORIGINAL "must be one of" warning path, unchanged.
    const bad = parseFocusManifest({ gate: { readiness: { mode: "sometimes" } } });
    expect(bad.gate.readinessMode).toBeNull();
    expect(bad.warnings.some((w) => /gate\.readiness\.mode.*must be one of/.test(w))).toBe(true);
    expect(bad.warnings.some((w) => /no longer accepts "block"/.test(w))).toBe(false);
  });

  it("clamps and rounds the readiness minScore to 0-100", () => {
    expect(parseFocusManifest({ gate: { readiness: { minScore: 250 } } }).gate.readinessMinScore).toBe(100);
    expect(parseFocusManifest({ gate: { readiness: { minScore: -10 } } }).gate.readinessMinScore).toBe(0);
    expect(parseFocusManifest({ gate: { readiness: { minScore: 59.6 } } }).gate.readinessMinScore).toBe(60);
  });

  it("sets gate.present when only gate.readiness.minScore is configured (#2053)", () => {
    const m = parseFocusManifest({ gate: { readiness: { minScore: 75 } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.readinessMode).toBeNull();
    expect(m.gate.readinessMinScore).toBe(75);
  });

  it("round-trips gate.readiness.minScore through gateConfigToJson unchanged (#2053)", () => {
    for (const minScore of [0, 1, 42, 99, 100]) {
      const original = parseFocusManifest({ gate: { readiness: { minScore } } });
      const json = gateConfigToJson(original.gate) as { readiness: { minScore: number } };
      expect(json.readiness.minScore).toBe(minScore);
      expect(parseFocusManifest({ gate: json }).gate).toEqual(original.gate);
    }
  });

  it("warns and ignores invalid gate.readiness.minScore values (#2053)", () => {
    for (const bad of ["high", NaN, Infinity, -Infinity]) {
      const m = parseFocusManifest({ gate: { readiness: { minScore: bad as unknown as number } } });
      expect(m.gate.readinessMinScore).toBeNull();
      expect(m.warnings.some((w) => /gate\.readiness\.minScore.*must be a number between 0 and 100/.test(w))).toBe(true);
    }
  });

  it("leaves gate.readiness.minScore null when omitted and omits it from gateConfigToJson (#2053)", () => {
    const m = parseFocusManifest({ gate: { readiness: { mode: "advisory" } } });
    expect(m.gate.readinessMinScore).toBeNull();
    const json = gateConfigToJson(m.gate) as { readiness: Record<string, unknown> };
    expect(json.readiness).toEqual({ mode: "advisory" });
    expect(json.readiness).not.toHaveProperty("minScore");
  });

  it("ignores a non-mapping gate or readiness block with a warning", () => {
    const m1 = parseFocusManifest({ gate: ["nope"] });
    expect(m1.gate.present).toBe(false);
    expect(m1.warnings.some((w) => /"gate" must be a mapping/.test(w))).toBe(true);
    const m2 = parseFocusManifest({ gate: { readiness: "nope" } });
    expect(m2.gate.present).toBe(false);
    expect(m2.warnings.some((w) => /"gate\.readiness" must be a mapping/.test(w))).toBe(true);
  });

  it("round-trips through gateConfigToJson + parse (the cache path) and serializes empty as null", () => {
    const original = parseFocusManifest({ gate: { enabled: false, linkedIssue: "block", readiness: { mode: "advisory", minScore: 42 } } });
    const reparsed = parseFocusManifest({ gate: gateConfigToJson(original.gate) });
    expect(reparsed.gate).toEqual(original.gate);
    expect(gateConfigToJson(parseFocusManifest({}).gate)).toBeNull();
  });

  it("parses the gate section from YAML content", () => {
    const m = parseFocusManifestContent("gate:\n  duplicates: block\n  readiness:\n    mode: advisory\n    minScore: 80\n", "repo_file");
    expect(m.gate.duplicates).toBe("block");
    expect(m.gate.readinessMode).toBe("advisory");
    expect(m.gate.readinessMinScore).toBe(80);
  });

  it("parses the gate.aiReview block, round-trips it, and warns on a non-mapping/invalid value", () => {
    const m = parseFocusManifest({ gate: { aiReview: { mode: "block", byok: true } } });
    expect(m.present).toBe(true);
    expect(m.gate.present).toBe(true);
    expect(m.gate.aiReviewMode).toBe("block");
    expect(m.gate.aiReviewByok).toBe(true);
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate);
    expect(parseFocusManifest({ gate: { aiReview: ["nope"] } }).warnings.some((w) => /gate\.aiReview" must be a mapping/.test(w))).toBe(true);
    expect(parseFocusManifest({ gate: { aiReview: { mode: "loud" } } }).warnings.some((w) => /gate\.aiReview\.mode/.test(w))).toBe(true);
  });

  it("parses gate.aiReview.allAuthors, makes the gate present, round-trips it, and resolves it into effective settings", () => {
    // allAuthors alone makes the gate present (so an operator can set ONLY this), serializes back under
    // gate.aiReview.allAuthors, and the gate alias projects it onto effective settings.
    const m = parseFocusManifest({ gate: { aiReview: { allAuthors: true } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.aiReviewAllAuthors).toBe(true);
    expect((gateConfigToJson(m.gate) as { aiReview: { allAuthors: boolean } }).aiReview.allAuthors).toBe(true);
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate); // round-trips
    expect(parseFocusManifest({ gate: { aiReview: { allAuthors: "yes" } } }).warnings.some((w) => /gate\.aiReview\.allAuthors/.test(w))).toBe(true);
    const eff = resolveEffectiveSettings({ aiReviewAllAuthors: false , closeOwnerAuthors: false} as unknown as RepositorySettings, m);
    expect(eff.aiReviewAllAuthors).toBe(true);
    // Absent ⇒ null ⇒ the gate alias leaves the DB value untouched.
    const noFlag = parseFocusManifest({ gate: { aiReview: { mode: "advisory" } } });
    expect(noFlag.gate.aiReviewAllAuthors).toBeNull();
    expect(resolveEffectiveSettings({ aiReviewAllAuthors: true , closeOwnerAuthors: false} as unknown as RepositorySettings, noFlag).aiReviewAllAuthors).toBe(true);
  });

  it("parses gate.aiReview.closeConfidence, clamps to [0,1], makes the gate present, round-trips + resolves it, and warns on a bad value (#7)", () => {
    // closeConfidence alone makes the gate present, serializes back under gate.aiReview.closeConfidence, and the
    // gate alias projects it onto effective settings.
    const m = parseFocusManifest({ gate: { aiReview: { closeConfidence: 0.75 } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.aiReviewCloseConfidence).toBe(0.75);
    expect((gateConfigToJson(m.gate) as { aiReview: { closeConfidence: number } }).aiReview.closeConfidence).toBe(0.75);
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate); // round-trips
    // Clamped to [0,1] WITHOUT rounding (a fractional confidence, not a 0-100 score).
    expect(parseFocusManifest({ gate: { aiReview: { closeConfidence: 1.5 } } }).gate.aiReviewCloseConfidence).toBe(1);
    expect(parseFocusManifest({ gate: { aiReview: { closeConfidence: -0.2 } } }).gate.aiReviewCloseConfidence).toBe(0);
    expect(parseFocusManifest({ gate: { aiReview: { closeConfidence: 0.333 } } }).gate.aiReviewCloseConfidence).toBe(0.333); // not rounded
    // A non-number value warns and is dropped (stays null).
    expect(parseFocusManifest({ gate: { aiReview: { closeConfidence: "high" } } }).warnings.some((w) => /gate\.aiReview\.closeConfidence/.test(w))).toBe(true);
    expect(parseFocusManifest({ gate: { aiReview: { closeConfidence: "high" } } }).gate.aiReviewCloseConfidence).toBeNull();
    // The gate alias projects it onto effective settings; absent ⇒ null ⇒ the DB value (here undefined) is untouched.
    const eff = resolveEffectiveSettings({ aiReviewCloseConfidence: undefined } as unknown as RepositorySettings, m);
    expect(eff.aiReviewCloseConfidence).toBe(0.75);
    const noFlag = parseFocusManifest({ gate: { aiReview: { mode: "advisory" } } });
    expect(noFlag.gate.aiReviewCloseConfidence).toBeNull();
    expect(resolveEffectiveSettings({ aiReviewCloseConfidence: 0.6 } as unknown as RepositorySettings, noFlag).aiReviewCloseConfidence).toBe(0.6);
  });

  it("parses gate.aiReview.combine, makes the gate present, round-trips + resolves it, and warns on a bad value (#2567)", () => {
    const m = parseFocusManifest({ gate: { aiReview: { combine: "synthesis" } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.aiReviewCombine).toBe("synthesis");
    expect((gateConfigToJson(m.gate) as { aiReview: { combine: string } }).aiReview.combine).toBe("synthesis");
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate); // round-trips
    expect(parseFocusManifest({ gate: { aiReview: { combine: "loud" } } }).warnings.some((w) => /gate\.aiReview\.combine/.test(w))).toBe(true);
    expect(parseFocusManifest({ gate: { aiReview: { combine: "loud" } } }).gate.aiReviewCombine).toBeNull();
    const eff = resolveEffectiveSettings({ aiReviewCombine: undefined } as unknown as RepositorySettings, m);
    expect(eff.aiReviewCombine).toBe("synthesis");
    const noFlag = parseFocusManifest({ gate: { aiReview: { mode: "advisory" } } });
    expect(noFlag.gate.aiReviewCombine).toBeNull();
    // Absent ⇒ the resolver leaves the DB/default value untouched.
    expect(resolveEffectiveSettings({ aiReviewCombine: "consensus" } as unknown as RepositorySettings, noFlag).aiReviewCombine).toBe("consensus");
  });

  it("parses gate.aiReview.onMerge, makes the gate present, round-trips + resolves it, and warns on a bad value (#2567)", () => {
    const m = parseFocusManifest({ gate: { aiReview: { onMerge: "both" } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.aiReviewOnMerge).toBe("both");
    expect((gateConfigToJson(m.gate) as { aiReview: { onMerge: string } }).aiReview.onMerge).toBe("both");
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate); // round-trips
    expect(parseFocusManifest({ gate: { aiReview: { onMerge: "any" } } }).warnings.some((w) => /gate\.aiReview\.onMerge/.test(w))).toBe(true);
    expect(parseFocusManifest({ gate: { aiReview: { onMerge: "any" } } }).gate.aiReviewOnMerge).toBeNull();
    // resolveEffectiveSettings projects the raw override unclamped — the operator-floor clamp itself is enforced
    // downstream in services/ai-review.ts (resolveEffectiveAiReviewOnMerge), which this resolver cannot see.
    const eff = resolveEffectiveSettings({ aiReviewOnMerge: undefined } as unknown as RepositorySettings, m);
    expect(eff.aiReviewOnMerge).toBe("both");
    const noFlag = parseFocusManifest({ gate: { aiReview: { mode: "advisory" } } });
    expect(noFlag.gate.aiReviewOnMerge).toBeNull();
    expect(resolveEffectiveSettings({ aiReviewOnMerge: "either" } as unknown as RepositorySettings, noFlag).aiReviewOnMerge).toBe("either");
  });

  it("parses gate.aiReview.reviewers, makes the gate present, round-trips + resolves it, caps entries, and drops invalid ones (#2567)", () => {
    const m = parseFocusManifest({ gate: { aiReview: { reviewers: [{ model: "claude-code" }, { model: "codex", fallback: "ollama" }] } } });
    expect(m.gate.present).toBe(true);
    expect(m.gate.aiReviewReviewers).toEqual([{ model: "claude-code" }, { model: "codex", fallback: "ollama" }]);
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate); // round-trips
    const eff = resolveEffectiveSettings({ aiReviewReviewers: undefined } as unknown as RepositorySettings, m);
    expect(eff.aiReviewReviewers).toEqual([{ model: "claude-code" }, { model: "codex", fallback: "ollama" }]);
    // Absent ⇒ null ⇒ the DB/default value is left untouched.
    const noFlag = parseFocusManifest({ gate: { aiReview: { mode: "advisory" } } });
    expect(noFlag.gate.aiReviewReviewers).toBeNull();
    expect(resolveEffectiveSettings({ aiReviewReviewers: [{ model: "existing" }] } as unknown as RepositorySettings, noFlag).aiReviewReviewers).toEqual([{ model: "existing" }]);
    // Non-array ⇒ warns, stays null.
    expect(parseFocusManifest({ gate: { aiReview: { reviewers: "claude-code" } } }).warnings.some((w) => /gate\.aiReview\.reviewers/.test(w))).toBe(true);
    expect(parseFocusManifest({ gate: { aiReview: { reviewers: "claude-code" } } }).gate.aiReviewReviewers).toBeNull();
    // A non-mapping entry and a blank-model entry are dropped, but valid siblings survive.
    const mixed = parseFocusManifest({ gate: { aiReview: { reviewers: [{ model: "claude-code" }, "nope", { model: "  " }, { fallback: "x" }] } } });
    expect(mixed.gate.aiReviewReviewers).toEqual([{ model: "claude-code" }]);
    expect(mixed.warnings.some((w) => /gate\.aiReview\.reviewers\[1\]/.test(w))).toBe(true);
    expect(mixed.warnings.some((w) => /gate\.aiReview\.reviewers\[2\]\.model/.test(w))).toBe(true);
    expect(mixed.warnings.some((w) => /gate\.aiReview\.reviewers\[3\]\.model/.test(w))).toBe(true);
    // All-invalid list ⇒ null (not an empty array), matching every other manifest "absent means null" contract.
    expect(parseFocusManifest({ gate: { aiReview: { reviewers: ["nope"] } } }).gate.aiReviewReviewers).toBeNull();
    // Over the cap: only the first 4 entries survive, with a warning.
    const over = parseFocusManifest({
      gate: { aiReview: { reviewers: [{ model: "a" }, { model: "b" }, { model: "c" }, { model: "d" }, { model: "e" }] } },
    });
    expect(over.gate.aiReviewReviewers).toEqual([{ model: "a" }, { model: "b" }, { model: "c" }, { model: "d" }]);
    expect(over.warnings.some((w) => /gate\.aiReview\.reviewers" is capped/.test(w))).toBe(true);
  });

  it("parses the features: block (per-repo converged-feature toggles), round-trips it, and makes the manifest present", () => {
    const m = parseFocusManifest({ features: { rag: true, reputation: false, unifiedComment: true } });
    expect(m.present).toBe(true);
    expect(m.features.present).toBe(true);
    expect(m.features.rag).toBe(true);
    expect(m.features.reputation).toBe(false);
    expect(m.features.unifiedComment).toBe(true);
    expect(m.features.safety).toBeNull(); // unset stays null (⇒ allowlist default at resolve time)
    // Round-trips through featuresConfigToJson → parseFocusManifest unchanged.
    expect(parseFocusManifest({ features: featuresConfigToJson(m.features) }).features).toEqual(m.features);
    // A non-boolean value warns and is dropped (stays null); a non-mapping warns.
    expect(parseFocusManifest({ features: { rag: "yes" } }).warnings.some((w) => /features\.rag/.test(w))).toBe(true);
    expect(parseFocusManifest({ features: ["nope"] }).warnings.some((w) => /"features" must be a mapping/.test(w))).toBe(true);
    // An empty features block leaves the manifest absent (no recognized fields).
    expect(parseFocusManifest({ features: {} }).features.present).toBe(false);
    expect(featuresConfigToJson(parseFocusManifest({ features: {} }).features)).toBeNull();
  });

  it("parses the contentLane: block (#2435 per-repo registry-lane config), round-trips it, and makes the manifest present", () => {
    const m = parseFocusManifest({
      contentLane: {
        entryFileGlob: "registry/items/*.json",
        providerFileGlob: "registry/providers/*.json",
        artifactGlob: "public/**/*.json",
        collectionField: "items",
        maxAppendedEntries: 5,
        duplicateKeyFields: ["url"],
        validatorId: "acme-registry",
      },
    });
    expect(m.present).toBe(true);
    expect(m.contentLane).toEqual({
      present: true,
      entryFileGlob: "registry/items/*.json",
      providerFileGlob: "registry/providers/*.json",
      artifactGlob: "public/**/*.json",
      collectionField: "items",
      maxAppendedEntries: 5,
      duplicateKeyFields: ["url"],
      validatorId: "acme-registry",
    });
    // Round-trips through contentLaneConfigToJson → parseFocusManifest unchanged.
    expect(parseFocusManifest({ contentLane: contentLaneConfigToJson(m.contentLane) }).contentLane).toEqual(m.contentLane);
  });

  it("accepts a wildcard-free (literal) entryFileGlob — a single exact-path registry has no `*` to count", () => {
    const m = parseFocusManifest({ contentLane: { entryFileGlob: "registry/items.json", collectionField: "items" } });
    expect(m.contentLane.entryFileGlob).toBe("registry/items.json");
    expect(m.warnings.some((w) => /entryFileGlob/.test(w))).toBe(false);
  });

  it("requires BOTH entryFileGlob and collectionField for contentLane: — a partial config warns and is ignored (not a broken half-spec)", () => {
    const missingCollectionField = parseFocusManifest({ contentLane: { entryFileGlob: "registry/*.json" } });
    expect(missingCollectionField.contentLane.present).toBe(false);
    expect(missingCollectionField.warnings.some((w) => /contentLane.*requires both/.test(w))).toBe(true);
    const missingEntryFileGlob = parseFocusManifest({ contentLane: { collectionField: "items" } });
    expect(missingEntryFileGlob.contentLane.present).toBe(false);
    expect(missingEntryFileGlob.warnings.some((w) => /contentLane.*requires both/.test(w))).toBe(true);
    // The whole manifest stays absent when contentLane is the ONLY (incomplete) field set.
    expect(missingCollectionField.present).toBe(false);
  });

  it("contentLane: a non-mapping value warns and is ignored; a non-positive maxAppendedEntries warns and is dropped", () => {
    expect(parseFocusManifest({ contentLane: ["nope"] }).warnings.some((w) => /"contentLane" must be a mapping/.test(w))).toBe(true);
    const m = parseFocusManifest({
      contentLane: { entryFileGlob: "registry/*.json", collectionField: "items", maxAppendedEntries: -1 },
    });
    expect(m.contentLane.maxAppendedEntries).toBeNull();
    expect(m.warnings.some((w) => /contentLane\.maxAppendedEntries/.test(w))).toBe(true);
  });

  it("contentLane: a FRACTIONAL maxAppendedEntries is rejected (would render a broken 'append between 1 and 2.5 entries' message downstream)", () => {
    const m = parseFocusManifest({
      contentLane: { entryFileGlob: "registry/*.json", collectionField: "items", maxAppendedEntries: 2.5 },
    });
    expect(m.contentLane.maxAppendedEntries).toBeNull();
    expect(m.warnings.some((w) => /contentLane\.maxAppendedEntries.*whole number/.test(w))).toBe(true);
    // A clean positive integer still passes through unchanged.
    expect(
      parseFocusManifest({ contentLane: { entryFileGlob: "registry/*.json", collectionField: "items", maxAppendedEntries: 5 } }).contentLane
        .maxAppendedEntries,
    ).toBe(5);
  });

  it("REGRESSION: an over-long contentLane glob is REJECTED, not truncated — truncation would silently compile a DIFFERENT pattern than configured", () => {
    // A prior version truncated an over-long glob to MAX_ITEM_LENGTH and still returned it, which changes which
    // files it matches (e.g. a mid-directory-name cut can match an unrelated path prefix, or match nothing).
    const overLong = "registry/" + "a".repeat(400) + ".json";
    const m = parseFocusManifest({ contentLane: { entryFileGlob: overLong, collectionField: "items" } });
    expect(m.contentLane.entryFileGlob).toBeNull();
    expect(m.contentLane.present).toBe(false); // entryFileGlob is REQUIRED — a rejected glob degrades to absent
    expect(m.warnings.some((w) => /contentLane\.entryFileGlob.*over-long glob/.test(w))).toBe(true);
  });

  it("SECURITY (ReDoS): a glob with too many wildcards is REJECTED at parse time rather than ever reaching RegExp compilation", () => {
    // 5 chained single-segment wildcards is empirically catastrophic against an adversarial input (verified
    // ~19s in manual testing) — must never survive parsing to reach globToRegExp at all.
    const pathological = "registry/*-*-*-*-*-final.json";
    const m = parseFocusManifest({ contentLane: { entryFileGlob: pathological, collectionField: "items" } });
    expect(m.contentLane.entryFileGlob).toBeNull();
    expect(m.contentLane.present).toBe(false); // entryFileGlob is REQUIRED — a rejected glob degrades to absent
    expect(m.warnings.some((w) => /contentLane\.entryFileGlob.*too many wildcards/.test(w))).toBe(true);
    // A glob AT the cap (2 wildcard GROUPS — matches globToRegExp's own MAX_GLOB_WILDCARD_GROUPS) is accepted;
    // the optional providerFileGlob/artifactGlob fields are dropped individually (with a warning) without
    // invalidating the whole block, since only entryFileGlob/collectionField are required.
    const atCap = parseFocusManifest({
      contentLane: { entryFileGlob: "registry/*/*.json", providerFileGlob: "providers/*-*-*-*-*.json", collectionField: "items" },
    });
    expect(atCap.contentLane.present).toBe(true);
    expect(atCap.contentLane.entryFileGlob).toBe("registry/*/*.json");
    expect(atCap.contentLane.providerFileGlob).toBeNull();
    expect(atCap.warnings.some((w) => /contentLane\.providerFileGlob.*too many wildcards/.test(w))).toBe(true);
  });

  it("REGRESSION (#confirmed-bug): rejects a glob using the SAME wildcard-GROUP predicate globToRegExp itself enforces, not a raw `*`-character count", () => {
    // The exact defect the gate flagged: a glob with 3 wildcard GROUPS (no `**` pairs to consolidate) was
    // previously ACCEPTED here (a raw-character count topped out at 3) but compiles to NEVER_MATCHES in
    // globToRegExp (whose group-count cap is 2) — configuring a lane that is "present" but can never activate.
    const threeGroups = parseFocusManifest({ contentLane: { entryFileGlob: "a*b*c*.json", collectionField: "items" } });
    expect(threeGroups.contentLane.entryFileGlob).toBeNull();
    expect(threeGroups.contentLane.present).toBe(false);
    expect(threeGroups.warnings.some((w) => /contentLane\.entryFileGlob.*too many wildcards/.test(w))).toBe(true);
    // A `**` pair counts as ONE group (mirroring globToRegExp's own countWildcardGroups), so this 2-group glob —
    // the exact shape spec-resolver.ts's own real METAGRAPHED_LANE_SPEC-adjacent globs use — is still accepted
    // even though it has 3 raw `*` characters.
    const globstarShape = parseFocusManifest({ contentLane: { entryFileGlob: "public/**/*.json", collectionField: "items" } });
    expect(globstarShape.contentLane.entryFileGlob).toBe("public/**/*.json");
    expect(globstarShape.contentLane.present).toBe(true);
  });

  it("contentLaneConfigToJson returns null for an absent config, and omits unset optional fields", () => {
    expect(contentLaneConfigToJson(parseFocusManifest(null).contentLane)).toBeNull();
    const m = parseFocusManifest({ contentLane: { entryFileGlob: "registry/*.json", collectionField: "items" } });
    expect(contentLaneConfigToJson(m.contentLane)).toEqual({ entryFileGlob: "registry/*.json", collectionField: "items" });
  });

  describe("repoDocGeneration: (#3002, repo-doc generation config-as-code surface)", () => {
    it("defaults to fully disabled and absent when the key is omitted, and does not make the manifest present on its own", () => {
      const m = parseFocusManifest({});
      expect(m.repoDocGeneration).toEqual({ present: false, enabled: false, scope: ["agents"], allowOverwriteExisting: false, refreshIntervalDays: 7 });
      expect(m.present).toBe(false);
    });

    it("treats an explicit null the same as an omitted key", () => {
      expect(parseFocusManifest({ repoDocGeneration: null }).repoDocGeneration).toEqual({ present: false, enabled: false, scope: ["agents"], allowOverwriteExisting: false, refreshIntervalDays: 7 });
    });

    it("warns and falls back to the default when the value is a non-mapping type (string or array)", () => {
      const asString = parseFocusManifest({ repoDocGeneration: "nope" as never });
      expect(asString.repoDocGeneration.present).toBe(false);
      expect(asString.warnings.some((w) => /"repoDocGeneration" must be a mapping/.test(w))).toBe(true);
      const asArray = parseFocusManifest({ repoDocGeneration: ["nope"] as never });
      expect(asArray.repoDocGeneration.present).toBe(false);
      expect(asArray.warnings.some((w) => /"repoDocGeneration" must be a mapping/.test(w))).toBe(true);
    });

    it("parses enabled: true and defaults scope/allowOverwriteExisting/refreshIntervalDays, making the manifest present", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: true } });
      expect(m.repoDocGeneration).toEqual({ present: true, enabled: true, scope: ["agents"], allowOverwriteExisting: false, refreshIntervalDays: 7 });
      expect(m.present).toBe(true);
    });

    it("warns and defaults to false when enabled is a non-boolean value", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: "yes" as unknown as boolean } });
      expect(m.repoDocGeneration.enabled).toBe(false);
      expect(m.warnings.some((w) => /repoDocGeneration\.enabled/.test(w))).toBe(true);
    });

    it("parses allowOverwriteExisting independently of enabled", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: false, allowOverwriteExisting: true } });
      expect(m.repoDocGeneration).toEqual({ present: true, enabled: false, scope: ["agents"], allowOverwriteExisting: true, refreshIntervalDays: 7 });
    });

    it("parses a valid refreshIntervalDays and defaults to 7 (weekly) when omitted", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: true, refreshIntervalDays: 3 } });
      expect(m.repoDocGeneration.refreshIntervalDays).toBe(3);
      const defaulted = parseFocusManifest({ repoDocGeneration: { enabled: true } });
      expect(defaulted.repoDocGeneration.refreshIntervalDays).toBe(7);
    });

    it("warns and defaults refreshIntervalDays to 7 when the value is not a positive whole number", () => {
      const zero = parseFocusManifest({ repoDocGeneration: { enabled: true, refreshIntervalDays: 0 } });
      expect(zero.repoDocGeneration.refreshIntervalDays).toBe(7);
      expect(zero.warnings.some((w) => /repoDocGeneration\.refreshIntervalDays/.test(w))).toBe(true);
      const fractional = parseFocusManifest({ repoDocGeneration: { enabled: true, refreshIntervalDays: 2.5 } });
      expect(fractional.repoDocGeneration.refreshIntervalDays).toBe(7);
      const negative = parseFocusManifest({ repoDocGeneration: { enabled: true, refreshIntervalDays: -1 } });
      expect(negative.repoDocGeneration.refreshIntervalDays).toBe(7);
    });

    it("accepts an explicit multi-entry scope list", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: true, scope: ["agents", "skills"] } });
      expect(m.repoDocGeneration.scope).toEqual(["agents", "skills"]);
    });

    it("respects an explicitly empty scope list as 'nothing in scope', rather than defaulting it back to [\"agents\"]", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: true, scope: [] } });
      expect(m.repoDocGeneration.scope).toEqual([]);
    });

    it("filters out unrecognized scope entries with a warning, keeping the valid ones", () => {
      const m = parseFocusManifest({ repoDocGeneration: { scope: ["agents", "bogus"] } });
      expect(m.repoDocGeneration.scope).toEqual(["agents"]);
      expect(m.warnings.some((w) => /repoDocGeneration\.scope.*unrecognized entry "bogus"/.test(w))).toBe(true);
    });

    it("falls back to the default scope (not an empty one) when scope is a non-list type", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: true, scope: "agents" as unknown as string[] } });
      expect(m.repoDocGeneration.scope).toEqual(["agents"]);
      expect(m.warnings.some((w) => /repoDocGeneration\.scope.*must be a list/.test(w))).toBe(true);
    });

    it("round-trips through repoDocGenerationConfigToJson → parseFocusManifest unchanged", () => {
      const m = parseFocusManifest({ repoDocGeneration: { enabled: true, scope: ["agents", "skills"], allowOverwriteExisting: true } });
      expect(parseFocusManifest({ repoDocGeneration: repoDocGenerationConfigToJson(m.repoDocGeneration) }).repoDocGeneration).toEqual(m.repoDocGeneration);
    });

    it("repoDocGenerationConfigToJson returns null for an absent config", () => {
      expect(repoDocGenerationConfigToJson(parseFocusManifest(null).repoDocGeneration)).toBeNull();
    });
  });

  describe("reviewRecap: (#1963, maintainer review recap digest config-as-code surface)", () => {
    it("defaults to fully disabled and absent when the key is omitted, and does not make the manifest present on its own", () => {
      const m = parseFocusManifest({});
      expect(m.reviewRecap).toEqual({ present: false, enabled: false, cadenceDays: 7 });
      expect(m.present).toBe(false);
    });

    it("treats an explicit null the same as an omitted key", () => {
      expect(parseFocusManifest({ reviewRecap: null }).reviewRecap).toEqual({ present: false, enabled: false, cadenceDays: 7 });
    });

    it("warns and falls back to the default when the value is a non-mapping type (string or array)", () => {
      const asString = parseFocusManifest({ reviewRecap: "nope" as never });
      expect(asString.reviewRecap.present).toBe(false);
      expect(asString.warnings.some((w) => /"reviewRecap" must be a mapping/.test(w))).toBe(true);
      const asArray = parseFocusManifest({ reviewRecap: ["nope"] as never });
      expect(asArray.reviewRecap.present).toBe(false);
      expect(asArray.warnings.some((w) => /"reviewRecap" must be a mapping/.test(w))).toBe(true);
    });

    it("parses enabled: true and defaults cadenceDays, making the manifest present", () => {
      const m = parseFocusManifest({ reviewRecap: { enabled: true } });
      expect(m.reviewRecap).toEqual({ present: true, enabled: true, cadenceDays: 7 });
      expect(m.present).toBe(true);
    });

    it("warns and defaults to false when enabled is a non-boolean value", () => {
      const m = parseFocusManifest({ reviewRecap: { enabled: "yes" as unknown as boolean } });
      expect(m.reviewRecap.enabled).toBe(false);
      expect(m.warnings.some((w) => /reviewRecap\.enabled/.test(w))).toBe(true);
    });

    it("parses a valid cadenceDays and defaults to 7 (weekly) when omitted", () => {
      const m = parseFocusManifest({ reviewRecap: { enabled: true, cadenceDays: 14 } });
      expect(m.reviewRecap.cadenceDays).toBe(14);
      const defaulted = parseFocusManifest({ reviewRecap: { enabled: true } });
      expect(defaulted.reviewRecap.cadenceDays).toBe(7);
    });

    it("warns and defaults cadenceDays to 7 when the value is not a positive whole number", () => {
      const zero = parseFocusManifest({ reviewRecap: { enabled: true, cadenceDays: 0 } });
      expect(zero.reviewRecap.cadenceDays).toBe(7);
      expect(zero.warnings.some((w) => /reviewRecap\.cadenceDays/.test(w))).toBe(true);
      const fractional = parseFocusManifest({ reviewRecap: { enabled: true, cadenceDays: 2.5 } });
      expect(fractional.reviewRecap.cadenceDays).toBe(7);
      const negative = parseFocusManifest({ reviewRecap: { enabled: true, cadenceDays: -1 } });
      expect(negative.reviewRecap.cadenceDays).toBe(7);
    });

    it("round-trips through reviewRecapConfigToJson → parseFocusManifest unchanged", () => {
      const m = parseFocusManifest({ reviewRecap: { enabled: true, cadenceDays: 3 } });
      expect(parseFocusManifest({ reviewRecap: reviewRecapConfigToJson(m.reviewRecap) }).reviewRecap).toEqual(m.reviewRecap);
    });

    it("reviewRecapConfigToJson returns null for an absent config", () => {
      expect(reviewRecapConfigToJson(parseFocusManifest(null).reviewRecap)).toBeNull();
    });
  });

  it("parses aiReviewAllAuthors from the settings: block (generic override)", () => {
    const parsed = parseFocusManifest({ settings: { aiReviewAllAuthors: true , closeOwnerAuthors: false} });
    expect(parsed.settings.aiReviewAllAuthors).toBe(true);
    expect(resolveEffectiveSettings({ aiReviewAllAuthors: false , closeOwnerAuthors: false} as unknown as RepositorySettings, parsed).aiReviewAllAuthors).toBe(true);
  });

  it("parses gate.aiReview provider + model (config-as-code) and rejects an unknown provider", () => {
    const m = parseFocusManifest({ gate: { aiReview: { mode: "advisory", byok: true, provider: "anthropic", model: "claude-3-5-sonnet-latest" } } });
    expect(m.gate.aiReviewProvider).toBe("anthropic");
    expect(m.gate.aiReviewModel).toBe("claude-3-5-sonnet-latest");
    expect(parseFocusManifest({ gate: gateConfigToJson(m.gate) }).gate).toEqual(m.gate); // round-trips
    expect(parseFocusManifest({ gate: { aiReview: { provider: "grok" } } }).warnings.some((w) => /gate\.aiReview\.provider/.test(w))).toBe(true);
    // resolveEffectiveSettings carries provider/model through (gate alias).
    const eff = resolveEffectiveSettings({ aiReviewProvider: null, aiReviewModel: null } as unknown as RepositorySettings, m);
    expect(eff.aiReviewProvider).toBe("anthropic");
    expect(eff.aiReviewModel).toBe("claude-3-5-sonnet-latest");
  });
});

describe("parseFocusManifest settings override + resolveEffectiveSettings", () => {
  it("parses a comprehensive settings: block", () => {
    const m = parseFocusManifest({
      settings: {
        commentMode: "all_prs",
        publicAudienceMode: "gittensor_only",
        publicSignalLevel: "minimal",
        checkRunMode: "enabled",
        checkRunDetailLevel: "deep",
        gateCheckMode: "enabled",
        linkedIssueGateMode: "block",
        duplicatePrGateMode: "off",
        qualityGateMode: "advisory",
        qualityGateMinScore: 65,
        autoLabelEnabled: false,
        gittensorLabel: "gittensor",
        createMissingLabel: true,
        publicSurface: "comment_only",
        includeMaintainerAuthors: true,
        requireLinkedIssue: true,
        backfillEnabled: false,
      },
    });
    expect(m.present).toBe(true);
    expect(m.settings).toEqual({
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "minimal",
      checkRunMode: "enabled",
      checkRunDetailLevel: "deep",
      gateCheckMode: "enabled",
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "off",
      qualityGateMode: "advisory",
      qualityGateMinScore: 65,
      autoLabelEnabled: false,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_only",
      includeMaintainerAuthors: true,
      requireLinkedIssue: true,
      backfillEnabled: false,
    });
  });

  it("drops invalid settings values with warnings and keeps the valid ones", () => {
    const m = parseFocusManifest({
      settings: { commentMode: "loud", qualityGateMinScore: "high", autoLabelEnabled: "yes", gittensorLabel: "   ", mergeTrainMode: "later", publicSurface: "comment_only" },
    });
    expect(m.settings).toEqual({ publicSurface: "comment_only" });
    expect(m.warnings.some((w) => /settings\.commentMode/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.qualityGateMinScore/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.autoLabelEnabled/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.gittensorLabel/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.mergeTrainMode/.test(w))).toBe(true);
  });

  it("ignores a non-mapping settings block and treats a settings-only manifest as present", () => {
    expect(parseFocusManifest({ settings: ["nope"] }).warnings.some((w) => /"settings" must be a mapping/.test(w))).toBe(true);
    expect(parseFocusManifest({ settings: { commentMode: "off" } }).present).toBe(true);
  });

  it("downgrades settings.qualityGateMode: block to advisory with a deprecation warning, same as gate.readiness.mode (#2267)", () => {
    // The generic settings: override is the SAME dashboard/API-facing qualityGateMode field, read through a
    // different manifest path than gate.readiness.mode — it must get the identical downgrade, not just a
    // "must be one of" pass-through, or a maintainer using this path keeps the false-enforcement belief.
    const m = parseFocusManifest({ settings: { qualityGateMode: "block" } });
    expect(m.settings.qualityGateMode).toBe("advisory");
    expect(m.warnings.some((w) => /settings\.qualityGateMode.*no longer accepts "block"/.test(w))).toBe(true);
    // Genuinely invalid values still take the ORIGINAL "must be one of" warning path, unchanged.
    const bad = parseFocusManifest({ settings: { qualityGateMode: "sometimes" } });
    expect(bad.settings.qualityGateMode).toBeUndefined();
    expect(bad.warnings.some((w) => /settings\.qualityGateMode.*must be one of/.test(w))).toBe(true);
    expect(bad.warnings.some((w) => /no longer accepts "block"/.test(w))).toBe(false);
  });

  it("round-trips settings through settingsOverrideToJson and serializes empty as null", () => {
    const original = parseFocusManifest({ settings: { commentMode: "all_prs", qualityGateMinScore: 40, mergeTrainMode: "audit" } });
    const reparsed = parseFocusManifest({ settings: settingsOverrideToJson(original.settings) });
    expect(reparsed.settings).toEqual(original.settings);
    expect(settingsOverrideToJson(parseFocusManifest({}).settings)).toBeNull();
  });

  it("parses + resolves agent autonomy from the settings: block, dropping invalid entries (#773)", () => {
    const manifest = parseFocusManifest({ settings: { autonomy: { merge: "auto", close: "auto_with_approval", deploy: "auto", label: "nope" } } });
    expect(manifest.settings.autonomy).toEqual({ merge: "auto", close: "auto_with_approval" }); // unknown class + invalid level dropped
    const eff = resolveEffectiveSettings({ autonomy: { review: "observe" } } as unknown as RepositorySettings, manifest);
    expect(eff.autonomy).toEqual({ merge: "auto", close: "auto_with_approval" }); // yml overlays DB
    // A malformed/empty autonomy block never blanks the DB-configured policy.
    const noOverride = resolveEffectiveSettings({ autonomy: { merge: "auto" } } as unknown as RepositorySettings, parseFocusManifest({ settings: { autonomy: { bogus: "x" } } }));
    expect(noOverride.autonomy).toEqual({ merge: "auto" });
  });

  it("parses + resolves autoMaintain from the settings: block, filling defaults (#774)", () => {
    const manifest = parseFocusManifest({ settings: { autoMaintain: { mergeMethod: "rebase", requireApprovals: 99 } } });
    expect(manifest.settings.autoMaintain).toEqual({ mergeMethod: "rebase", requireApprovals: 10 }); // clamped
    const eff = resolveEffectiveSettings({ autoMaintain: { requireApprovals: 1, mergeMethod: "squash" } } as unknown as RepositorySettings, manifest);
    expect(eff.autoMaintain).toEqual({ mergeMethod: "rebase", requireApprovals: 10 }); // yml overlays DB
    // A non-mapping autoMaintain is ignored, leaving the DB policy intact.
    const ignored = resolveEffectiveSettings({ autoMaintain: { requireApprovals: 2, mergeMethod: "merge" } } as unknown as RepositorySettings, parseFocusManifest({ settings: { autoMaintain: "nope" } }));
    expect(ignored.autoMaintain).toEqual({ requireApprovals: 2, mergeMethod: "merge" });
  });

  it("parses + resolves commandAuthorization from the settings: block, overlaying the DB (#2268)", () => {
    const manifest = parseFocusManifest({ settings: { commandAuthorization: { commands: { "gate-override": ["maintainer"] } } } });
    expect(manifest.settings.commandAuthorization).toEqual({
      ...DEFAULT_COMMAND_AUTHORIZATION_POLICY,
      commands: { ...DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands, "gate-override": ["maintainer"] },
    });
    expect(manifest.warnings.some((w) => /commandAuthorization/.test(w))).toBe(false);

    const dbPolicy = { default: ["maintainer", "collaborator", "confirmed_miner", "pr_author"], commands: {} } as RepositorySettings["commandAuthorization"];
    const eff = resolveEffectiveSettings({ commandAuthorization: dbPolicy } as unknown as RepositorySettings, manifest);
    expect(eff.commandAuthorization?.commands["gate-override"]).toEqual(["maintainer"]); // yml overlays DB

    // Unset key means "no opinion" and must leave the DB-stored policy untouched — never reset to defaults.
    const noOverride = resolveEffectiveSettings({ commandAuthorization: dbPolicy } as unknown as RepositorySettings, parseFocusManifest({ settings: { commentMode: "off" } }));
    expect(noOverride.commandAuthorization).toEqual(dbPolicy);
  });

  it("ignores an invalid top-level commandAuthorization shape with a visible warning, never overwriting the DB policy (#2268)", () => {
    const manifest = parseFocusManifest({ settings: { commandAuthorization: "nope" } });
    expect(manifest.settings.commandAuthorization).toBeUndefined();
    expect(manifest.warnings.some((w) => /commandAuthorization.*must be an object/.test(w))).toBe(true);

    // A malformed shape must leave the DB-persisted policy intact via the resolver overlay — never reset to
    // the built-in default, which could be less restrictive than what the DB has on record.
    const dbPolicy = { default: ["maintainer"], commands: { "gate-override": ["maintainer"] } } as RepositorySettings["commandAuthorization"];
    const eff = resolveEffectiveSettings({ commandAuthorization: dbPolicy } as unknown as RepositorySettings, manifest);
    expect(eff.commandAuthorization).toEqual(dbPolicy);

    // A null value is likewise rejected (typeof null === "object" but it is not a valid mapping).
    const nullShape = parseFocusManifest({ settings: { commandAuthorization: null } });
    expect(nullShape.settings.commandAuthorization).toBeUndefined();
    expect(nullShape.warnings.some((w) => /commandAuthorization.*must be an object/.test(w))).toBe(true);

    // An array is likewise rejected, not treated as a mapping.
    const arrayShape = parseFocusManifest({ settings: { commandAuthorization: ["nope"] } });
    expect(arrayShape.settings.commandAuthorization).toBeUndefined();
    expect(arrayShape.warnings.some((w) => /commandAuthorization.*must be an object/.test(w))).toBe(true);

    // A spoofable role on a maintainer-only command is clamped back to the default for that command, not
    // dropped silently — the maintainer-only invariant holds even inside a partially-valid override.
    const badRole = parseFocusManifest({ settings: { commandAuthorization: { commands: { "gate-override": ["pr_author"] } } } });
    expect(badRole.settings.commandAuthorization?.commands["gate-override"]).toEqual(["maintainer", "collaborator"]);
    expect(badRole.warnings.some((w) => /maintainer-only command/.test(w))).toBe(true);
  });

  it("parses + resolves contributorBlacklist + blacklistLabel from the settings: block, overlaying the DB (#1425)", () => {
    const manifest = parseFocusManifest({ settings: { contributorBlacklist: ["plagiarist1", { login: "farmer2", reason: "farming" }, { login: "-bad" }], blacklistLabel: "abuse" } });
    expect(manifest.settings.contributorBlacklist).toEqual([{ login: "plagiarist1" }, { login: "farmer2", reason: "farming" }]); // invalid login dropped
    expect(manifest.settings.blacklistLabel).toBe("abuse");
    const eff = resolveEffectiveSettings({ contributorBlacklist: [{ login: "db-only" }] } as unknown as RepositorySettings, manifest);
    expect(eff.contributorBlacklist?.map((e) => e.login)).toEqual(["plagiarist1", "farmer2"]); // yml overlays DB
    expect(eff.blacklistLabel).toBe("abuse"); // configurable label, not hardcoded
    // An empty/all-invalid block never blanks the DB-configured list (only set when a valid entry survives).
    const noOverride = resolveEffectiveSettings({ contributorBlacklist: [{ login: "keep-me" }] } as unknown as RepositorySettings, parseFocusManifest({ settings: { contributorBlacklist: [{ login: "" }] } }));
    expect(noOverride.contributorBlacklist?.map((e) => e.login)).toEqual(["keep-me"]);
  });

  it("parses + resolves contributorOpenPrCap/contributorOpenIssueCap from the settings: block, overlaying the DB (#2270)", () => {
    const manifest = parseFocusManifest({ settings: { contributorOpenPrCap: 2, contributorOpenIssueCap: 5 } });
    expect(manifest.settings.contributorOpenPrCap).toBe(2);
    expect(manifest.settings.contributorOpenIssueCap).toBe(5);
    // yml overlays a DB-configured cap.
    const eff = resolveEffectiveSettings({ contributorOpenPrCap: 10, contributorOpenIssueCap: 10 } as unknown as RepositorySettings, manifest);
    expect(eff.contributorOpenPrCap).toBe(2);
    expect(eff.contributorOpenIssueCap).toBe(5);
    // Omitted in yml ⇒ the DB-configured cap survives untouched (not blanked to undefined/null).
    const noOverride = resolveEffectiveSettings({ contributorOpenPrCap: 4, contributorOpenIssueCap: null } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.contributorOpenPrCap).toBe(4);
    expect(noOverride.contributorOpenIssueCap).toBeNull();
    // A cap is a discrete count, not a score: over-budget valid integers clamp to the fixed enforcement
    // sample, while fractional, non-positive, and non-numeric values are dropped with a warning.
    const overBudget = parseFocusManifest({ settings: { contributorOpenPrCap: 101, contributorOpenIssueCap: 150 } });
    expect(overBudget.settings.contributorOpenPrCap).toBe(100);
    expect(overBudget.settings.contributorOpenIssueCap).toBe(100);

    const invalid = parseFocusManifest({ settings: { contributorOpenPrCap: 2.5, contributorOpenIssueCap: 0 } });
    expect(invalid.settings.contributorOpenPrCap).toBeUndefined();
    expect(invalid.settings.contributorOpenIssueCap).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.contributorOpenPrCap/.test(w))).toBe(true);
    expect(invalid.warnings.some((w) => /settings\.contributorOpenIssueCap/.test(w))).toBe(true);
    const nonNumber = parseFocusManifest({ settings: { contributorOpenPrCap: "two" as never } });
    expect(nonNumber.settings.contributorOpenPrCap).toBeUndefined();
  });

  it("parses + resolves the review-nag cooldown settings from the settings: block, overlaying the DB (#2463)", () => {
    const manifest = parseFocusManifest({ settings: { reviewNagPolicy: "close", reviewNagMaxPings: 5, reviewNagCooldownDays: 10, reviewNagLabel: "too-chatty" } });
    expect(manifest.settings.reviewNagPolicy).toBe("close");
    expect(manifest.settings.reviewNagMaxPings).toBe(5);
    expect(manifest.settings.reviewNagCooldownDays).toBe(10);
    expect(manifest.settings.reviewNagLabel).toBe("too-chatty");
    // yml overlays a DB-configured policy.
    const eff = resolveEffectiveSettings({ reviewNagPolicy: "off", reviewNagMaxPings: 3, reviewNagCooldownDays: 5, reviewNagLabel: "review-nag-cooldown" } as unknown as RepositorySettings, manifest);
    expect(eff.reviewNagPolicy).toBe("close");
    expect(eff.reviewNagMaxPings).toBe(5);
    // Omitted in yml ⇒ the DB-configured policy survives untouched.
    const noOverride = resolveEffectiveSettings({ reviewNagPolicy: "hold", reviewNagMaxPings: 7 } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.reviewNagPolicy).toBe("hold");
    expect(noOverride.reviewNagMaxPings).toBe(7);
    // An invalid policy enum / non-positive ping count / non-positive cooldown is dropped with a warning
    // rather than silently coerced.
    const invalid = parseFocusManifest({ settings: { reviewNagPolicy: "delete-everything" as never, reviewNagMaxPings: 0, reviewNagCooldownDays: -1 } });
    expect(invalid.settings.reviewNagPolicy).toBeUndefined();
    expect(invalid.settings.reviewNagMaxPings).toBeUndefined();
    expect(invalid.settings.reviewNagCooldownDays).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.reviewNagPolicy/.test(w))).toBe(true);
    expect(invalid.warnings.some((w) => /settings\.reviewNagMaxPings/.test(w))).toBe(true);
    expect(invalid.warnings.some((w) => /settings\.reviewNagCooldownDays/.test(w))).toBe(true);
    const tooLarge = parseFocusManifest({ settings: { reviewNagCooldownDays: 366 } });
    expect(tooLarge.settings.reviewNagCooldownDays).toBeUndefined();
    expect(tooLarge.warnings.some((w) => /settings\.reviewNagCooldownDays/.test(w) && /365/.test(w))).toBe(true);
  });

  it("#label-scoping: an explicit yml null clears configurable action labels back to 'no label' (load-bearing null)", () => {
    const cleared = parseFocusManifest({
      settings: {
        blacklistLabel: null,
        contributorCapLabel: null,
        reviewNagLabel: null,
        manualReviewLabel: null,
        readyToMergeLabel: null,
        changesRequestedLabel: null,
        migrationCollisionLabel: null,
        pendingClosureLabel: null,
        reviewEvasionLabel: null,
      },
    });
    expect(cleared.settings.blacklistLabel).toBeNull();
    expect(cleared.settings.contributorCapLabel).toBeNull();
    expect(cleared.settings.reviewNagLabel).toBeNull();
    expect(cleared.settings.manualReviewLabel).toBeNull();
    expect(cleared.settings.readyToMergeLabel).toBeNull();
    expect(cleared.settings.changesRequestedLabel).toBeNull();
    expect(cleared.settings.reviewEvasionLabel).toBeNull();
    expect(cleared.settings.migrationCollisionLabel).toBeNull();
    expect(cleared.settings.pendingClosureLabel).toBeNull();
    // Overlays (clears) a DB-configured label name.
    const eff = resolveEffectiveSettings(
      {
        blacklistLabel: "slop",
        contributorCapLabel: "over-contributor-limit",
        reviewNagLabel: "review-nag-cooldown",
        manualReviewLabel: "human-review",
        readyToMergeLabel: "ship-it",
        changesRequestedLabel: "needs-work",
        migrationCollisionLabel: "rebase-migration",
        pendingClosureLabel: "pending-close",
      } as unknown as RepositorySettings,
      cleared,
    );
    expect(eff.blacklistLabel).toBeNull();
    expect(eff.contributorCapLabel).toBeNull();
    expect(eff.reviewNagLabel).toBeNull();
    expect(eff.manualReviewLabel).toBeNull();
    expect(eff.readyToMergeLabel).toBeNull();
    expect(eff.changesRequestedLabel).toBeNull();
    expect(eff.migrationCollisionLabel).toBeNull();
    expect(eff.pendingClosureLabel).toBeNull();
    // Omitted in yml ⇒ the DB-configured label survives untouched (distinct from explicit null).
    const noOverride = resolveEffectiveSettings({ blacklistLabel: "slop", manualReviewLabel: "human-review" } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.blacklistLabel).toBe("slop");
    expect(noOverride.manualReviewLabel).toBe("human-review");
    // A configured (non-null) string still overrides the DB normally.
    const customized = parseFocusManifest({ settings: { blacklistLabel: "abuse", readyToMergeLabel: "ship-it", changesRequestedLabel: "needs-work", migrationCollisionLabel: "migration-review", pendingClosureLabel: "pending-close" } });
    expect(customized.settings.blacklistLabel).toBe("abuse");
    expect(customized.settings.readyToMergeLabel).toBe("ship-it");
    expect(customized.settings.changesRequestedLabel).toBe("needs-work");
    expect(customized.settings.migrationCollisionLabel).toBe("migration-review");
    expect(customized.settings.pendingClosureLabel).toBe("pending-close");
    const blank = parseFocusManifest({ settings: { manualReviewLabel: "   ", readyToMergeLabel: 42 as never } });
    expect(blank.settings.manualReviewLabel).toBeUndefined();
    expect(blank.settings.readyToMergeLabel).toBeUndefined();
    expect(blank.warnings.some((w) => /settings\.manualReviewLabel/.test(w))).toBe(true);
    expect(blank.warnings.some((w) => /settings\.readyToMergeLabel/.test(w))).toBe(true);
  });

  it("parses + resolves hardGuardrailGlobs as a replace-list, including explicit empty clear", () => {
    const manifest = parseFocusManifest({ settings: { hardGuardrailGlobs: ["src/settings/**", "migrations/*.sql"] } });
    expect(manifest.settings.hardGuardrailGlobs).toEqual(["src/settings/**", "migrations/*.sql"]);
    const eff = resolveEffectiveSettings({ hardGuardrailGlobs: ["db-default/**"] } as unknown as RepositorySettings, manifest);
    expect(eff.hardGuardrailGlobs).toEqual(["src/settings/**", "migrations/*.sql"]);

    const cleared = resolveEffectiveSettings({ hardGuardrailGlobs: ["db-default/**"] } as unknown as RepositorySettings, parseFocusManifest({ settings: { hardGuardrailGlobs: [] } }));
    expect(cleared.hardGuardrailGlobs).toEqual([]);

    const nullManifest = parseFocusManifest({ settings: { hardGuardrailGlobs: null } });
    const nullIgnored = resolveEffectiveSettings({ hardGuardrailGlobs: ["db-default/**"] } as unknown as RepositorySettings, nullManifest);
    expect(nullIgnored.hardGuardrailGlobs).toEqual(["db-default/**"]);
    expect(nullManifest.warnings.some((w) => /settings\.hardGuardrailGlobs/.test(w))).toBe(true);

    const omitted = resolveEffectiveSettings({ hardGuardrailGlobs: ["db-default/**"] } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(omitted.hardGuardrailGlobs).toEqual(["db-default/**"]);

    const malformed = parseFocusManifest({ settings: { hardGuardrailGlobs: "src/**" as never } });
    expect(malformed.settings.hardGuardrailGlobs).toBeUndefined();
    expect(malformed.warnings.some((w) => /settings\.hardGuardrailGlobs/.test(w))).toBe(true);

    const invalidArray = parseFocusManifest({ settings: { hardGuardrailGlobs: [123, ""] as never } });
    const invalidIgnored = resolveEffectiveSettings({ hardGuardrailGlobs: ["db-default/**"] } as unknown as RepositorySettings, invalidArray);
    expect(invalidIgnored.hardGuardrailGlobs).toEqual(["db-default/**"]);
    expect(invalidArray.warnings.some((w) => /did not contain any valid path globs/.test(w))).toBe(true);
  });

  it("#label-scoping: parses + resolves reviewNagMonitoredMentions from the settings: block, overlaying the DB", () => {
    const manifest = parseFocusManifest({ settings: { reviewNagMonitoredMentions: ["JSONbored", "Some-Maintainer"] } });
    expect(manifest.settings.reviewNagMonitoredMentions).toEqual(["JSONbored", "Some-Maintainer"]);
    // yml overlays (replaces) a DB-configured list.
    const eff = resolveEffectiveSettings({ reviewNagMonitoredMentions: ["db-only"] } as unknown as RepositorySettings, manifest);
    expect(eff.reviewNagMonitoredMentions).toEqual(["JSONbored", "Some-Maintainer"]);
    // Omitted in yml ⇒ the DB-configured list survives untouched.
    const noOverride = resolveEffectiveSettings({ reviewNagMonitoredMentions: ["keep-me"] } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.reviewNagMonitoredMentions).toEqual(["keep-me"]);
    // Invalid entries are dropped; an all-invalid list leaves the field unset (never blanks the DB list).
    const invalid = parseFocusManifest({ settings: { reviewNagMonitoredMentions: ["-bad", 42 as never] } });
    expect(invalid.settings.reviewNagMonitoredMentions).toBeUndefined();
  });

  it("parses + resolves the account-age throttle settings from the settings: block, overlaying the DB (#2561)", () => {
    const manifest = parseFocusManifest({ settings: { accountAgeThresholdDays: 14, newAccountLabel: "fresh-account" } });
    expect(manifest.settings.accountAgeThresholdDays).toBe(14);
    expect(manifest.settings.newAccountLabel).toBe("fresh-account");
    const eff = resolveEffectiveSettings({ accountAgeThresholdDays: null, newAccountLabel: "new-account" } as unknown as RepositorySettings, manifest);
    expect(eff.accountAgeThresholdDays).toBe(14);
    // An explicit yml `null` clears a DB-configured threshold back to off (load-bearing null).
    const cleared = resolveEffectiveSettings({ accountAgeThresholdDays: 30 } as unknown as RepositorySettings, parseFocusManifest({ settings: { accountAgeThresholdDays: null } }));
    expect(cleared.accountAgeThresholdDays).toBeNull();
    // Omitted in yml ⇒ the DB-configured threshold survives untouched.
    const noOverride = resolveEffectiveSettings({ accountAgeThresholdDays: 7 } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.accountAgeThresholdDays).toBe(7);
    // A non-positive threshold is dropped with a warning rather than silently coerced.
    const invalid = parseFocusManifest({ settings: { accountAgeThresholdDays: 0 } });
    expect(invalid.settings.accountAgeThresholdDays).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.accountAgeThresholdDays/.test(w))).toBe(true);
  });

  it("parses + resolves the per-command rate limit settings from the settings: block, overlaying the DB (#2560)", () => {
    const manifest = parseFocusManifest({ settings: { commandRateLimitPolicy: "hold", commandRateLimitMaxPerWindow: 10, commandRateLimitAiMaxPerWindow: 2, commandRateLimitWindowHours: 12 } });
    expect(manifest.settings.commandRateLimitPolicy).toBe("hold");
    expect(manifest.settings.commandRateLimitMaxPerWindow).toBe(10);
    expect(manifest.settings.commandRateLimitAiMaxPerWindow).toBe(2);
    expect(manifest.settings.commandRateLimitWindowHours).toBe(12);
    // yml overlays a DB-configured policy.
    const eff = resolveEffectiveSettings({ commandRateLimitPolicy: "off", commandRateLimitMaxPerWindow: 20, commandRateLimitAiMaxPerWindow: 5, commandRateLimitWindowHours: 24 } as unknown as RepositorySettings, manifest);
    expect(eff.commandRateLimitPolicy).toBe("hold");
    expect(eff.commandRateLimitMaxPerWindow).toBe(10);
    // Omitted in yml ⇒ the DB-configured policy survives untouched.
    const noOverride = resolveEffectiveSettings({ commandRateLimitPolicy: "hold", commandRateLimitAiMaxPerWindow: 3 } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.commandRateLimitPolicy).toBe("hold");
    expect(noOverride.commandRateLimitAiMaxPerWindow).toBe(3);
    // An invalid policy enum / non-positive window value is dropped with a warning rather than silently coerced.
    const invalid = parseFocusManifest({ settings: { commandRateLimitPolicy: "close" as never, commandRateLimitMaxPerWindow: 0, commandRateLimitAiMaxPerWindow: -1, commandRateLimitWindowHours: -5 } });
    expect(invalid.settings.commandRateLimitPolicy).toBeUndefined();
    expect(invalid.settings.commandRateLimitMaxPerWindow).toBeUndefined();
    expect(invalid.settings.commandRateLimitAiMaxPerWindow).toBeUndefined();
    expect(invalid.settings.commandRateLimitWindowHours).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.commandRateLimitPolicy/.test(w))).toBe(true);
    expect(invalid.warnings.some((w) => /settings\.commandRateLimitMaxPerWindow/.test(w))).toBe(true);
    expect(invalid.warnings.some((w) => /settings\.commandRateLimitAiMaxPerWindow/.test(w))).toBe(true);
    expect(invalid.warnings.some((w) => /settings\.commandRateLimitWindowHours/.test(w))).toBe(true);
  });

  it("parses + resolves contributorCapCancelCi from the settings: block, overlaying the DB (#2462)", () => {
    const manifest = parseFocusManifest({ settings: { contributorCapCancelCi: true } });
    expect(manifest.settings.contributorCapCancelCi).toBe(true);
    const eff = resolveEffectiveSettings({ contributorCapCancelCi: null } as unknown as RepositorySettings, manifest);
    expect(eff.contributorCapCancelCi).toBe(true);
    // An explicit yml `false` also sets it (distinct from `null`, which clears back to unset below).
    const disabled = parseFocusManifest({ settings: { contributorCapCancelCi: false } });
    expect(disabled.settings.contributorCapCancelCi).toBe(false);
    // An explicit yml `null` clears a DB-configured value back to unset (load-bearing null).
    const cleared = resolveEffectiveSettings({ contributorCapCancelCi: true } as unknown as RepositorySettings, parseFocusManifest({ settings: { contributorCapCancelCi: null } }));
    expect(cleared.contributorCapCancelCi).toBeNull();
    // Omitted in yml ⇒ the DB-configured value survives untouched.
    const noOverride = resolveEffectiveSettings({ contributorCapCancelCi: true } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.contributorCapCancelCi).toBe(true);
    // A non-boolean value is dropped with a warning rather than silently coerced.
    const invalid = parseFocusManifest({ settings: { contributorCapCancelCi: "yes" as never } });
    expect(invalid.settings.contributorCapCancelCi).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.contributorCapCancelCi/.test(w))).toBe(true);
  });

  it("parses + resolves autoCloseExemptLogins from the settings: block, overlaying the DB (#2463)", () => {
    const manifest = parseFocusManifest({ settings: { autoCloseExemptLogins: ["Trusted-Regular", "another-one", "-bad", 42 as never] } });
    expect(manifest.settings.autoCloseExemptLogins).toEqual(["Trusted-Regular", "another-one"]); // invalid entries dropped
    const eff = resolveEffectiveSettings({ autoCloseExemptLogins: ["db-only"] } as unknown as RepositorySettings, manifest);
    expect(eff.autoCloseExemptLogins).toEqual(["Trusted-Regular", "another-one"]); // yml overlays (replaces) DB
    // An empty/all-invalid block never blanks the DB-configured list (only set when a valid entry survives).
    const noOverride = resolveEffectiveSettings({ autoCloseExemptLogins: ["keep-me"] } as unknown as RepositorySettings, parseFocusManifest({ settings: { autoCloseExemptLogins: ["-bad"] } }));
    expect(noOverride.autoCloseExemptLogins).toEqual(["keep-me"]);
  });

  it("parses + resolves the moderation-rules engine settings from the settings: block, overlaying the DB (#selfhost-mod-engine)", () => {
    const manifest = parseFocusManifest({ settings: { moderationGateMode: "enabled", moderationRules: ["blacklist", "not-a-rule" as never], moderationWarningLabel: "repo:warn", moderationBannedLabel: "repo:ban" } });
    expect(manifest.settings.moderationGateMode).toBe("enabled");
    expect(manifest.settings.moderationRules).toEqual(["blacklist"]); // invalid entry dropped
    expect(manifest.settings.moderationWarningLabel).toBe("repo:warn");
    expect(manifest.settings.moderationBannedLabel).toBe("repo:ban");
    // yml overlays (replaces) the DB-configured values.
    const eff = resolveEffectiveSettings({ moderationGateMode: "off", moderationRules: ["review_nag"], moderationWarningLabel: "db:warn", moderationBannedLabel: "db:ban" } as unknown as RepositorySettings, manifest);
    expect(eff.moderationGateMode).toBe("enabled");
    expect(eff.moderationRules).toEqual(["blacklist"]);
    expect(eff.moderationWarningLabel).toBe("repo:warn");
    expect(eff.moderationBannedLabel).toBe("repo:ban");
    // Omitted in yml ⇒ the DB-configured values survive untouched.
    const noOverride = resolveEffectiveSettings({ moderationGateMode: "off", moderationWarningLabel: "db:warn" } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.moderationGateMode).toBe("off");
    expect(noOverride.moderationWarningLabel).toBe("db:warn");
    // An intentional EMPTY moderationRules override (opting every rule out for this repo) still applies --
    // distinct from an all-invalid block, which is dropped instead (see autoCloseExemptLogins above).
    const emptyOverride = resolveEffectiveSettings({ moderationRules: ["blacklist"] } as unknown as RepositorySettings, parseFocusManifest({ settings: { moderationRules: [] } }));
    expect(emptyOverride.moderationRules).toEqual([]);
    // REGRESSION (gate-flagged): an ALL-INVALID moderationRules block (every entry fails validation, so
    // normalizeModerationRules ALSO degrades it to an empty array) must NOT be treated as the intentional
    // empty-list case above -- it is malformed input, not a real opt-out, so the DB-configured value survives.
    const allInvalidPreserved = resolveEffectiveSettings({ moderationRules: ["blacklist"] } as unknown as RepositorySettings, parseFocusManifest({ settings: { moderationRules: ["not-a-rule", "also-not-a-rule"] as never } }));
    expect(allInvalidPreserved.moderationRules).toEqual(["blacklist"]);
    // REGRESSION (gate-flagged): a non-array moderationRules value (e.g. a typo'd bare string) is malformed
    // the same way -- must not silently disable every rule for this repo either.
    const nonArrayPreserved = resolveEffectiveSettings({ moderationRules: ["review_nag"] } as unknown as RepositorySettings, parseFocusManifest({ settings: { moderationRules: "blacklist" as never } }));
    expect(nonArrayPreserved.moderationRules).toEqual(["review_nag"]);
    // An invalid enum / blank label is dropped with a warning rather than silently coerced.
    const invalid = parseFocusManifest({ settings: { moderationGateMode: "sometimes" as never, moderationWarningLabel: "   " } });
    expect(invalid.settings.moderationGateMode).toBeUndefined();
    expect(invalid.settings.moderationWarningLabel).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.moderationGateMode/.test(w))).toBe(true);
  });

  it("moderationRules accepts review_evasion alongside the original three rule types (#review-evasion-protection)", () => {
    const manifest = parseFocusManifest({ settings: { moderationRules: ["review_evasion", "not-a-rule" as never] } });
    expect(manifest.settings.moderationRules).toEqual(["review_evasion"]);
  });

  it("parses + resolves review-evasion protection settings from the settings: block, overlaying the DB (#review-evasion-protection)", () => {
    const manifest = parseFocusManifest({ settings: { reviewEvasionProtection: "close", reviewEvasionLabel: "repo:evasion", reviewEvasionComment: false } });
    expect(manifest.settings.reviewEvasionProtection).toBe("close");
    expect(manifest.settings.reviewEvasionLabel).toBe("repo:evasion");
    expect(manifest.settings.reviewEvasionComment).toBe(false);
    // yml overlays (replaces) the DB-configured values.
    const eff = resolveEffectiveSettings(
      { reviewEvasionProtection: "off", reviewEvasionLabel: "db:evasion", reviewEvasionComment: true } as unknown as RepositorySettings,
      manifest,
    );
    expect(eff.reviewEvasionProtection).toBe("close");
    expect(eff.reviewEvasionLabel).toBe("repo:evasion");
    expect(eff.reviewEvasionComment).toBe(false);
    // Omitted in yml ⇒ the DB-configured values survive untouched.
    const noOverride = resolveEffectiveSettings(
      { reviewEvasionProtection: "close", reviewEvasionComment: false } as unknown as RepositorySettings,
      parseFocusManifest({}),
    );
    expect(noOverride.reviewEvasionProtection).toBe("close");
    expect(noOverride.reviewEvasionComment).toBe(false);
    // An invalid enum / blank label is dropped with a warning rather than silently coerced.
    const invalid = parseFocusManifest({ settings: { reviewEvasionProtection: "sometimes" as never, reviewEvasionLabel: "   " } });
    expect(invalid.settings.reviewEvasionProtection).toBeUndefined();
    expect(invalid.settings.reviewEvasionLabel).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.reviewEvasionProtection/.test(w))).toBe(true);
  });

  describe("reviewCheckMode precedence (#2852)", () => {
    it("parses settings.reviewCheckMode and drops an invalid value with a warning", () => {
      const m = parseFocusManifest({ settings: { reviewCheckMode: "visible" } });
      expect(m.settings.reviewCheckMode).toBe("visible");
      const invalid = parseFocusManifest({ settings: { reviewCheckMode: "sometimes" as never } });
      expect(invalid.settings.reviewCheckMode).toBeUndefined();
      expect(invalid.warnings.some((w) => /settings\.reviewCheckMode/.test(w))).toBe(true);
    });

    it("settings.reviewCheckMode overlays (replaces) the DB value when set, and is preserved when omitted", () => {
      const overridden = resolveEffectiveSettings(
        { reviewCheckMode: "required" } as unknown as RepositorySettings,
        parseFocusManifest({ settings: { reviewCheckMode: "disabled" } }),
      );
      expect(overridden.reviewCheckMode).toBe("disabled");
      const noOverride = resolveEffectiveSettings({ reviewCheckMode: "required" } as unknown as RepositorySettings, parseFocusManifest({}));
      expect(noOverride.reviewCheckMode).toBe("required");
    });

    it("gate.checkMode takes precedence over the legacy gate.enabled boolean when both are set", () => {
      const eff = resolveEffectiveSettings(
        { reviewCheckMode: "disabled" } as unknown as RepositorySettings,
        parseFocusManifest({ gate: { enabled: false, checkMode: "visible" } }),
      );
      expect(eff.reviewCheckMode).toBe("visible");
    });

    it("gate.enabled maps symmetrically to reviewCheckMode when gate.checkMode is unset (legacy compatibility)", () => {
      const enabledTrue = resolveEffectiveSettings({ reviewCheckMode: "disabled" } as unknown as RepositorySettings, parseFocusManifest({ gate: { enabled: true } }));
      expect(enabledTrue.reviewCheckMode).toBe("required");
      const enabledFalse = resolveEffectiveSettings({ reviewCheckMode: "required" } as unknown as RepositorySettings, parseFocusManifest({ gate: { enabled: false } }));
      expect(enabledFalse.reviewCheckMode).toBe("disabled");
    });

    it("falls through to the DB/settings-block value when neither gate.checkMode nor gate.enabled is set", () => {
      const eff = resolveEffectiveSettings({ reviewCheckMode: "visible" } as unknown as RepositorySettings, parseFocusManifest({ gate: { duplicates: "block" } }));
      expect(eff.reviewCheckMode).toBe("visible");
    });
  });

  describe("autoProjectMilestoneMatch precedence (#3183)", () => {
    it("parses settings.autoProjectMilestoneMatch and drops an invalid value with a warning", () => {
      const m = parseFocusManifest({ settings: { autoProjectMilestoneMatch: "suggest" } });
      expect(m.settings.autoProjectMilestoneMatch).toBe("suggest");
      const invalid = parseFocusManifest({ settings: { autoProjectMilestoneMatch: "sometimes" as never } });
      expect(invalid.settings.autoProjectMilestoneMatch).toBeUndefined();
      expect(invalid.warnings.some((w) => /settings\.autoProjectMilestoneMatch/.test(w))).toBe(true);
    });

    it("settings.autoProjectMilestoneMatch overlays (replaces) the DB value when set, and is preserved when omitted", () => {
      const overridden = resolveEffectiveSettings(
        { autoProjectMilestoneMatch: "off" } as unknown as RepositorySettings,
        parseFocusManifest({ settings: { autoProjectMilestoneMatch: "auto" } }),
      );
      expect(overridden.autoProjectMilestoneMatch).toBe("auto");
      const noOverride = resolveEffectiveSettings({ autoProjectMilestoneMatch: "suggest" } as unknown as RepositorySettings, parseFocusManifest({}));
      expect(noOverride.autoProjectMilestoneMatch).toBe("suggest");
    });
  });

  describe("autoProjectMilestoneMatchBackend precedence (#3186)", () => {
    it("parses settings.autoProjectMilestoneMatchBackend and drops an invalid value with a warning", () => {
      const m = parseFocusManifest({ settings: { autoProjectMilestoneMatchBackend: "linear" } });
      expect(m.settings.autoProjectMilestoneMatchBackend).toBe("linear");
      const invalid = parseFocusManifest({ settings: { autoProjectMilestoneMatchBackend: "jira" as never } });
      expect(invalid.settings.autoProjectMilestoneMatchBackend).toBeUndefined();
      expect(invalid.warnings.some((w) => /settings\.autoProjectMilestoneMatchBackend/.test(w))).toBe(true);
    });

    it("settings.autoProjectMilestoneMatchBackend overlays (replaces) the DB value when set, and is preserved when omitted", () => {
      const overridden = resolveEffectiveSettings(
        { autoProjectMilestoneMatchBackend: "github" } as unknown as RepositorySettings,
        parseFocusManifest({ settings: { autoProjectMilestoneMatchBackend: "linear" } }),
      );
      expect(overridden.autoProjectMilestoneMatchBackend).toBe("linear");
      const noOverride = resolveEffectiveSettings({ autoProjectMilestoneMatchBackend: "linear" } as unknown as RepositorySettings, parseFocusManifest({}));
      expect(noOverride.autoProjectMilestoneMatchBackend).toBe("linear");
    });
  });

  it("an EXPLICIT yml null force-clears a DB-configured cap, distinct from an omitted key (regression, gate finding on #2467)", () => {
    // Omitted key preserves the DB value (already covered above); an explicit `null` must ALSO be able to
    // override a DB-configured cap back to "no cap" — the documented `yml > DB > null` precedence otherwise
    // has no way to un-set a cap without a separate dashboard/DB write, which contradicts config-as-code.
    const explicitNull = parseFocusManifest({ settings: { contributorOpenPrCap: null, contributorOpenIssueCap: null } });
    expect(explicitNull.settings.contributorOpenPrCap).toBeNull();
    expect(explicitNull.settings.contributorOpenIssueCap).toBeNull();
    const eff = resolveEffectiveSettings({ contributorOpenPrCap: 4, contributorOpenIssueCap: 4 } as unknown as RepositorySettings, explicitNull);
    expect(eff.contributorOpenPrCap).toBeNull();
    expect(eff.contributorOpenIssueCap).toBeNull();
  });

  it("parses + resolves contributorCapLabel from the settings: block, overlaying the DB (#2270)", () => {
    const manifest = parseFocusManifest({ settings: { contributorCapLabel: "spam-cap" } });
    expect(manifest.settings.contributorCapLabel).toBe("spam-cap");
    const eff = resolveEffectiveSettings({ contributorCapLabel: "db-label" } as unknown as RepositorySettings, manifest);
    expect(eff.contributorCapLabel).toBe("spam-cap"); // yml overlays DB
    const noOverride = resolveEffectiveSettings({ contributorCapLabel: "db-label" } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.contributorCapLabel).toBe("db-label"); // omitted in yml ⇒ DB survives
    const blank = parseFocusManifest({ settings: { contributorCapLabel: "   " } });
    expect(blank.settings.contributorCapLabel).toBeUndefined();
    expect(blank.warnings.some((w) => /settings\.contributorCapLabel/.test(w))).toBe(true);
  });

  it("resolves contributor blacklist by unioning the shared/global list with effective per-repo settings", () => {
    const manifest = parseFocusManifest({ settings: { contributorBlacklist: [{ login: "repo-only", reason: "manifest" }, { login: "Global-Repo", reason: "manifest-overrides-global" }] } });
    const eff = resolveEffectiveSettings(
      { contributorBlacklist: [{ login: "global-repo", reason: "repo-db" }] } as unknown as RepositorySettings,
      manifest,
      [{ login: "global-repo", reason: "global" }, { login: "global-only", reason: "shared-only" }],
    );
    expect(eff.contributorBlacklist?.map((entry) => entry.login)).toEqual(["repo-only", "Global-Repo", "global-only"]);
    expect(eff.contributorBlacklist?.find((entry) => entry.login === "Global-Repo")?.reason).toBe("manifest-overrides-global");
  });

  it("resolveEffectiveSettings overlays settings: over DB and lets gate: win for gate fields", () => {
    const db = { commentMode: "off", gateCheckMode: "off", linkedIssueGateMode: "off", duplicatePrGateMode: "off", autoLabelEnabled: true } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(
      db,
      parseFocusManifest({ settings: { commentMode: "all_prs", linkedIssueGateMode: "advisory", autoLabelEnabled: false }, gate: { enabled: true, linkedIssue: "block" } }),
    );
    expect(eff.commentMode).toBe("all_prs"); // settings: override
    expect(eff.autoLabelEnabled).toBe(false); // settings: override (boolean)
    expect(eff.gateCheckMode).toBe("enabled"); // gate.enabled
    expect(eff.linkedIssueGateMode).toBe("block"); // gate: wins over settings:
  });

  it("wires settings.badgeEnabled into the manifest parser and lets it override the DB value (#2555)", () => {
    const parsedTrue = parseFocusManifest({ settings: { badgeEnabled: true } });
    expect(parsedTrue.settings.badgeEnabled).toBe(true);
    expect(parsedTrue.warnings).toEqual([]);
    const parsedFalse = parseFocusManifest({ settings: { badgeEnabled: false } });
    expect(parsedFalse.settings.badgeEnabled).toBe(false);

    const db = { badgeEnabled: false } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { badgeEnabled: true } }));
    expect(eff.badgeEnabled).toBe(true); // settings: override wins over the DB-stored value
  });

  it("wires settings.includeMaintainerAuthors into the manifest parser and resolver (#2052)", () => {
    const parsedTrue = parseFocusManifest({ settings: { includeMaintainerAuthors: true } });
    expect(parsedTrue.settings.includeMaintainerAuthors).toBe(true);
    expect(parsedTrue.warnings).toEqual([]);
    const parsedFalse = parseFocusManifest({ settings: { includeMaintainerAuthors: false } });
    expect(parsedFalse.settings.includeMaintainerAuthors).toBe(false);

    const invalid = parseFocusManifest({ settings: { includeMaintainerAuthors: "yes" } });
    expect(invalid.settings.includeMaintainerAuthors).toBeUndefined();
    expect(invalid.warnings.some((w) => /settings\.includeMaintainerAuthors/.test(w))).toBe(true);

    const db = { includeMaintainerAuthors: false } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { includeMaintainerAuthors: true } }));
    expect(eff.includeMaintainerAuthors).toBe(true);

    const noOverride = resolveEffectiveSettings({ includeMaintainerAuthors: true } as unknown as RepositorySettings, parseFocusManifest({}));
    expect(noOverride.includeMaintainerAuthors).toBe(true);

    const reparsed = parseFocusManifest({ settings: settingsOverrideToJson(parsedTrue.settings) });
    expect(reparsed.settings.includeMaintainerAuthors).toBe(true);
  });

  it("wires settings.publicQualityMetrics into the manifest parser and lets it override the DB value (#2568)", () => {
    const parsedTrue = parseFocusManifest({ settings: { publicQualityMetrics: true } });
    expect(parsedTrue.settings.publicQualityMetrics).toBe(true);
    expect(parsedTrue.warnings).toEqual([]);
    const parsedFalse = parseFocusManifest({ settings: { publicQualityMetrics: false } });
    expect(parsedFalse.settings.publicQualityMetrics).toBe(false);

    const db = { publicQualityMetrics: false } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { publicQualityMetrics: true } }));
    expect(eff.publicQualityMetrics).toBe(true);
  });

  it("wires settings.typeLabelsEnabled into the manifest parser and lets a per-repo override win over a global default (#label-decoupling)", () => {
    const parsedTrue = parseFocusManifest({ settings: { typeLabelsEnabled: true } });
    expect(parsedTrue.settings.typeLabelsEnabled).toBe(true);
    expect(parsedTrue.warnings).toEqual([]);
    const parsedFalse = parseFocusManifest({ settings: { typeLabelsEnabled: false } });
    expect(parsedFalse.settings.typeLabelsEnabled).toBe(false);

    // Simulates PR #1's private-config layering: a global default of `true` (DB, standing in for the
    // global .gittensory.yml layer already merged upstream) overridden by a per-repo `settings:` block.
    const db = { typeLabelsEnabled: true } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabelsEnabled: false } }));
    expect(eff.typeLabelsEnabled).toBe(false); // settings: override wins over the DB/global-default value
  });

  it("wires settings.typeLabels into the manifest parser, keeping only the keys present in a partial override (#priority-linked-issue-gate)", () => {
    const parsed = parseFocusManifest({ settings: { typeLabels: { priority: "custom:priority" } } });
    expect(parsed.settings.typeLabels).toEqual({ priority: "custom:priority" }); // sparse: bug/feature were never named, so they're absent, not defaults-filled
    expect(parsed.warnings).toEqual([]);

    const full = parseFocusManifest({ settings: { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } });
    expect(full.settings.typeLabels).toEqual({ bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" });
  });

  it("resolveEffectiveSettings merges a partial settings.typeLabels override field-by-field, preserving DB values for the keys it doesn't name (#priority-linked-issue-gate)", () => {
    const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: { priority: "custom:priority" } } }));
    // bug/feature must come from the DB-persisted value, NOT be reset to the built-in gittensor:* defaults —
    // this is the regression this test guards: a `.gittensory.yml` naming only `priority` must never silently
    // discard a DB-customized bug/feature label.
    expect(eff.typeLabels).toEqual({ bug: "kind:bug", feature: "kind:feature", priority: "custom:priority" });
  });

  it("resolveEffectiveSettings falls back to the built-in defaults for a partial settings.typeLabels override when the DB has no typeLabels at all", () => {
    const db = {} as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: { priority: "custom:priority" } } }));
    expect(eff.typeLabels).toEqual({ bug: "gittensor:bug", feature: "gittensor:feature", priority: "custom:priority" });
  });

  it("resolveEffectiveSettings preserves the DB priority label when a partial settings.typeLabels override only names bug/feature", () => {
    const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: { bug: "custom:bug", feature: "custom:feature" } } }));
    // Exercises the complementary branch pair from the two tests above: here bug/feature take the override
    // path and priority falls through to the DB value, instead of the reverse.
    expect(eff.typeLabels).toEqual({ bug: "custom:bug", feature: "custom:feature", priority: "kind:priority" });
  });

  it("drops a malformed typeLabels.priority from the sparse override instead of copying the normalizer's built-in-default fallback (#priority-linked-issue-gate nit)", () => {
    const parsed = parseFocusManifest({ settings: { typeLabels: { priority: 123 } } });
    // `priority` is present but not a valid string, so it must be ABSENT from the sparse override
    // (not silently filled with the built-in "gittensor:priority" default) — otherwise a config typo
    // would overwrite a DB-customized priority label with the built-in name.
    expect(parsed.settings.typeLabels).toEqual({});
    expect(parsed.warnings.some((w) => w.includes("settings.typeLabels.priority"))).toBe(true);

    const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: { priority: 123 } } }));
    expect(eff.typeLabels).toEqual(db.typeLabels);
  });

  it("warns and preserves the existing DB value when settings.typeLabels is not an object", () => {
    const parsed = parseFocusManifest({ settings: { typeLabels: "gittensor:bug" } });
    expect(parsed.settings.typeLabels).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("settings.typeLabels"))).toBe(true);
    const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parsed);
    expect(eff.typeLabels).toEqual(db.typeLabels); // malformed manifest value never blanks the DB-persisted override
  });

  describe("arbitrary custom typeLabels categories (#label-modularity)", () => {
    it("wires an arbitrary custom category through the sparse override, additively alongside the DB-persisted built-ins", () => {
      const parsed = parseFocusManifest({ settings: { typeLabels: { security: "area:security" } } });
      expect(parsed.settings.typeLabels).toEqual({ security: "area:security" });
      expect(parsed.warnings).toEqual([]);

      const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
      const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: { security: "area:security" } } }));
      expect(eff.typeLabels).toEqual({ bug: "kind:bug", feature: "kind:feature", priority: "kind:priority", security: "area:security" });
    });

    it("caps a sparse manifest override before it reaches effective settings", () => {
      const rawTypeLabels = Object.fromEntries(Array.from({ length: MAX_TYPE_LABEL_CATEGORIES + 5 }, (_, index) => [`custom${index}`, `area:${index}`]));

      const parsed = parseFocusManifest({ settings: { typeLabels: rawTypeLabels } });
      const eff = resolveEffectiveSettings({ typeLabels: {} } as unknown as RepositorySettings, parsed);

      expect(Object.keys(parsed.settings.typeLabels ?? {})).toHaveLength(MAX_TYPE_LABEL_CATEGORIES - 3);
      expect(eff.typeLabels).toEqual(Object.fromEntries(Array.from({ length: MAX_TYPE_LABEL_CATEGORIES - 3 }, (_, index) => [`custom${index}`, `area:${index}`])));
      expect(parsed.warnings.some((w) => w.includes("more than 32 categories") && w.includes("custom29"))).toBe(true);
    });

    it("drops overlong labels from a sparse manifest override before merging with DB settings", () => {
      const parsed = parseFocusManifest({ settings: { typeLabels: { security: "x".repeat(MAX_TYPE_LABEL_NAME_LENGTH + 1) } } });
      const db = { typeLabels: { bug: "kind:bug" } } as unknown as RepositorySettings;
      const eff = resolveEffectiveSettings(db, parsed);

      expect(parsed.settings.typeLabels).toEqual({});
      expect(eff.typeLabels).toEqual(db.typeLabels);
      expect(parsed.warnings.some((w) => w.includes("settings.typeLabels.security") && w.includes("no longer than 50"))).toBe(true);
    });

    it("does not unexpectedly reset unrelated categories when a sparse override only adds a new one (invariant: sparse overrides layer correctly)", () => {
      const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority", docs: "area:docs" } } as unknown as RepositorySettings;
      const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: { security: "area:security" } } }));
      // `docs` was never named by the override, so it survives untouched alongside the newly-added `security`.
      expect(eff.typeLabels).toEqual({ bug: "kind:bug", feature: "kind:feature", priority: "kind:priority", docs: "area:docs", security: "area:security" });
    });
  });

  describe("explicit typeLabels: {} (#label-modularity)", () => {
    it("parses a literal empty settings.typeLabels object to null, distinct from a sparse override with zero surviving keys", () => {
      const parsed = parseFocusManifest({ settings: { typeLabels: {} } });
      expect(parsed.settings.typeLabels).toBeNull();
      expect(parsed.warnings).toEqual([]);
    });

    it("resolveEffectiveSettings replaces the DB-persisted set wholesale with an empty set for an explicit typeLabels: {}", () => {
      const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
      const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { typeLabels: {} } }));
      expect(eff.typeLabels).toEqual({});
    });

    it("still leaves the DB value untouched when a sparse override's only named key fails validation (contrast with explicit {})", () => {
      // Same net {} shape as the explicit-empty case above at the parse step, but arising from a NAMED,
      // invalid key rather than a literal `{}` -- must NOT replace the DB value (see the malformed-value
      // test above), unlike the deliberate `typeLabels: {}` case immediately above.
      const db = { typeLabels: { bug: "kind:bug", feature: "kind:feature", priority: "kind:priority" } } as unknown as RepositorySettings;
      const parsed = parseFocusManifest({ settings: { typeLabels: { security: 42 } } });
      expect(parsed.settings.typeLabels).toEqual({});
      const eff = resolveEffectiveSettings(db, parsed);
      expect(eff.typeLabels).toEqual(db.typeLabels);
    });
  });

  it("wires settings.linkedIssueLabelPropagation into the manifest parser and lets a per-repo override win over the DB value (#priority-linked-issue-gate)", () => {
    const config = {
      enabled: true,
      mode: "exclusive_type_label" as const,
      mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
    };
    const parsed = parseFocusManifest({ settings: { linkedIssueLabelPropagation: config } });
    expect(parsed.settings.linkedIssueLabelPropagation).toEqual(config);
    expect(parsed.warnings).toEqual([]);

    const db = { linkedIssueLabelPropagation: { enabled: false, mode: "exclusive_type_label", mappings: [] } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueLabelPropagation: config } }));
    expect(eff.linkedIssueLabelPropagation).toEqual(config); // settings: override wins over the DB-stored (disabled) value
  });

  it("keeps only the keys present in a partial settings.linkedIssueLabelPropagation override, sparse (#priority-linked-issue-gate)", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueLabelPropagation: { enabled: true } } });
    expect(parsed.settings.linkedIssueLabelPropagation).toEqual({ enabled: true }); // sparse: mode/mappings were never named
  });

  it("resolveEffectiveSettings merges a partial settings.linkedIssueLabelPropagation override field-by-field, preserving the DB-configured mappings it doesn't name (#priority-linked-issue-gate)", () => {
    const db = {
      linkedIssueLabelPropagation: {
        enabled: false,
        mode: "exclusive_type_label" as const,
        mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
      },
    } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueLabelPropagation: { enabled: true } } }));
    // The DB-configured mappings must survive a manifest override that only names `enabled` — this is the
    // regression this test guards: a `.gittensory.yml` flipping the feature on must never silently discard a
    // DB-persisted mapping list back to the built-in empty default.
    expect(eff.linkedIssueLabelPropagation).toEqual({
      enabled: true,
      mode: "exclusive_type_label",
      mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
    });
  });

  it("resolveEffectiveSettings preserves the DB enabled flag when a partial settings.linkedIssueLabelPropagation override only names mappings", () => {
    const db = { linkedIssueLabelPropagation: { enabled: true, mode: "exclusive_type_label", mappings: [] } } as unknown as RepositorySettings;
    const override = { mappings: [{ issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false }] };
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueLabelPropagation: override } }));
    // Exercises the complementary branch pair from the test above: here `mappings` takes the override path
    // and `enabled`/`mode` fall through to the DB value, instead of the reverse.
    expect(eff.linkedIssueLabelPropagation).toEqual({ enabled: true, mode: "exclusive_type_label", mappings: override.mappings });
  });

  it("resolveEffectiveSettings falls back to the built-in defaults for a partial settings.linkedIssueLabelPropagation override when the DB has none at all", () => {
    const db = {} as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueLabelPropagation: { enabled: true } } }));
    expect(eff.linkedIssueLabelPropagation).toEqual({ enabled: true, mode: "exclusive_type_label", mappings: [] });
  });

  it("drops a malformed linkedIssueLabelPropagation.enabled from the sparse override instead of copying the normalizer's built-in-default fallback (#priority-linked-issue-gate nit)", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueLabelPropagation: { enabled: "true" } } });
    expect(parsed.settings.linkedIssueLabelPropagation).toEqual({});
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation.enabled"))).toBe(true);

    const db = { linkedIssueLabelPropagation: { enabled: true, mode: "exclusive_type_label", mappings: [] } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueLabelPropagation: { enabled: "true" } } }));
    expect(eff.linkedIssueLabelPropagation).toEqual(db.linkedIssueLabelPropagation);
  });

  it("drops a malformed linkedIssueLabelPropagation.mode from the sparse override instead of copying the normalizer's built-in-default fallback", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueLabelPropagation: { mode: "not_a_real_mode" } } });
    expect(parsed.settings.linkedIssueLabelPropagation).toEqual({});
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation.mode"))).toBe(true);
  });

  it("drops a malformed linkedIssueLabelPropagation.mappings from the sparse override instead of discarding the DB-configured mapping list", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueLabelPropagation: { mappings: "oops" } } });
    // A typo'd, non-array `mappings` must never silently replace a DB-configured mapping list with the
    // normalizer's empty-array fallback -- it must be absent from the sparse override entirely.
    expect(parsed.settings.linkedIssueLabelPropagation).toEqual({});
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation.mappings"))).toBe(true);

    const db = {
      linkedIssueLabelPropagation: {
        enabled: true,
        mode: "exclusive_type_label" as const,
        mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
      },
    } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueLabelPropagation: { mappings: "oops" } } }));
    expect(eff.linkedIssueLabelPropagation).toEqual(db.linkedIssueLabelPropagation);
  });

  it("warns and preserves the existing DB value when settings.linkedIssueLabelPropagation is not an object", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueLabelPropagation: ["nope"] } });
    expect(parsed.settings.linkedIssueLabelPropagation).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation"))).toBe(true);
    const db = { linkedIssueLabelPropagation: { enabled: true, mode: "exclusive_type_label", mappings: [] } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parsed);
    expect(eff.linkedIssueLabelPropagation).toEqual(db.linkedIssueLabelPropagation);
  });

  it("wires settings.linkedIssueHardRules into the manifest parser as a sparse override", () => {
    const parsed = parseFocusManifest({
      settings: {
        linkedIssueHardRules: {
          assignedIssueClose: "block",
          maintainerOnlyLabels: ["maintainer-only"],
          verifyBeforeClose: false,
          closeDelaySeconds: 3.8,
        },
      },
    });
    expect(parsed.settings.linkedIssueHardRules).toEqual({
      assignedIssueClose: "block",
      maintainerOnlyLabels: ["maintainer-only"],
      verifyBeforeClose: false,
      closeDelaySeconds: 3,
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("resolveEffectiveSettings merges partial linkedIssueHardRules overrides without clearing lower-layer labels", () => {
    const db = {
      linkedIssueHardRules: {
        ownerAssignedClose: "off",
        assignedIssueClose: "off",
        missingPointLabelClose: "off",
        maintainerOnlyLabelClose: "block",
        pointBearingLabels: ["gittensor:bug", "gittensor:feature", "gittensor:priority"],
        maintainerOnlyLabels: ["maintainer-only"],
        defaultLabelRepo: true,
        verifyBeforeClose: true,
        closeDelaySeconds: 30,
      },
    } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { linkedIssueHardRules: { assignedIssueClose: "block" } } }));
    expect(eff.linkedIssueHardRules).toEqual({
      ownerAssignedClose: "off",
      assignedIssueClose: "block",
      missingPointLabelClose: "off",
      maintainerOnlyLabelClose: "block",
      pointBearingLabels: ["gittensor:bug", "gittensor:feature", "gittensor:priority"],
      maintainerOnlyLabels: ["maintainer-only"],
      defaultLabelRepo: true,
      verifyBeforeClose: true,
      closeDelaySeconds: 30,
    });
  });

  it("drops malformed linkedIssueHardRules fields instead of replacing existing policy with defaults", () => {
    const parsed = parseFocusManifest({
      settings: {
        linkedIssueHardRules: {
          assignedIssueClose: "close",
          maintainerOnlyLabels: "maintainer-only",
          defaultLabelRepo: "true",
          closeDelaySeconds: -1,
        },
      },
    });
    expect(parsed.settings.linkedIssueHardRules).toEqual({});
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueHardRules.assignedIssueClose"))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueHardRules.maintainerOnlyLabels"))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueHardRules.defaultLabelRepo"))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("settings.linkedIssueHardRules.closeDelaySeconds"))).toBe(true);
  });

  it("wires settings.unlinkedIssueGuardrail into the manifest parser as a sparse override", () => {
    const parsed = parseFocusManifest({ settings: { unlinkedIssueGuardrail: { mode: "hold", minConfidence: 0.7 } } });
    expect(parsed.settings.unlinkedIssueGuardrail).toEqual({ mode: "hold", minConfidence: 0.7 });
    expect(parsed.warnings).toEqual([]);
  });

  it("resolveEffectiveSettings merges a partial unlinkedIssueGuardrail override without clearing the lower-layer minConfidence", () => {
    const db = { unlinkedIssueGuardrail: { mode: "off", minConfidence: 0.95 } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { unlinkedIssueGuardrail: { mode: "hold" } } }));
    expect(eff.unlinkedIssueGuardrail).toEqual({ mode: "hold", minConfidence: 0.95 });
  });

  it("resolveEffectiveSettings merges a minConfidence-only unlinkedIssueGuardrail override without clearing the lower-layer mode", () => {
    const db = { unlinkedIssueGuardrail: { mode: "hold", minConfidence: 0.85 } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { unlinkedIssueGuardrail: { minConfidence: 0.7 } } }));
    expect(eff.unlinkedIssueGuardrail).toEqual({ mode: "hold", minConfidence: 0.7 });
  });

  it("drops a malformed unlinkedIssueGuardrail.minConfidence field instead of replacing existing policy with defaults", () => {
    const parsed = parseFocusManifest({ settings: { unlinkedIssueGuardrail: { mode: "hold", minConfidence: 5 } } });
    expect(parsed.settings.unlinkedIssueGuardrail).toEqual({ mode: "hold" });
    expect(parsed.warnings.some((w) => w.includes("settings.unlinkedIssueGuardrail.minConfidence"))).toBe(true);
  });

  it("warns and ignores a malformed top-level unlinkedIssueGuardrail value", () => {
    const parsed = parseFocusManifest({ settings: { unlinkedIssueGuardrail: "oops" } });
    expect(parsed.settings.unlinkedIssueGuardrail).toBeUndefined();
    expect(parsed.warnings).toContain(`Manifest "settings.unlinkedIssueGuardrail" must be an object; ignoring it and keeping any existing policy.`);
  });

  it("wires settings.screenshotTableGate into the manifest parser as a sparse override (#2006)", () => {
    const parsed = parseFocusManifest({ settings: { screenshotTableGate: { enabled: true, whenLabels: ["frontend"], whenPaths: ["apps/ui/**"], action: "close", message: "custom" } } });
    expect(parsed.settings.screenshotTableGate).toEqual({ enabled: true, whenLabels: ["frontend"], whenPaths: ["apps/ui/**"], action: "close", message: "custom" });
    expect(parsed.warnings).toEqual([]);
  });

  it("resolveEffectiveSettings merges a partial screenshotTableGate override without clearing the lower-layer whenLabels/whenPaths (#2006)", () => {
    const db = { screenshotTableGate: { enabled: false, whenLabels: ["frontend"], whenPaths: ["apps/ui/**"], action: "close" } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { screenshotTableGate: { enabled: true } } }));
    expect(eff.screenshotTableGate).toEqual({ enabled: true, whenLabels: ["frontend"], whenPaths: ["apps/ui/**"], action: "close" });
  });

  it("resolveEffectiveSettings falls back to the built-in default when the DB layer has no screenshotTableGate at all (#2006)", () => {
    const db = {} as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { screenshotTableGate: { enabled: true } } }));
    expect(eff.screenshotTableGate).toEqual({ enabled: true, whenLabels: [], whenPaths: [], action: "close" });
  });

  it("resolveEffectiveSettings keeps the DB layer's enabled/action when the manifest override omits them (#2006)", () => {
    const db = { screenshotTableGate: { enabled: true, whenLabels: ["frontend"], whenPaths: [], action: "comment" } } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { screenshotTableGate: { whenPaths: ["apps/ui/**"] } } }));
    expect(eff.screenshotTableGate).toEqual({ enabled: true, whenLabels: ["frontend"], whenPaths: ["apps/ui/**"], action: "comment" });
  });

  it("drops a malformed screenshotTableGate.action field instead of replacing existing policy with defaults (#2006)", () => {
    const parsed = parseFocusManifest({ settings: { screenshotTableGate: { enabled: true, action: "delete" } } });
    expect(parsed.settings.screenshotTableGate).toEqual({ enabled: true });
    expect(parsed.warnings.some((w) => w.includes("settings.requireScreenshotTable.action"))).toBe(true);
  });

  it("warns and ignores a malformed top-level screenshotTableGate value (#2006)", () => {
    const parsed = parseFocusManifest({ settings: { screenshotTableGate: "oops" } });
    expect(parsed.settings.screenshotTableGate).toBeUndefined();
    expect(parsed.warnings).toContain(`Manifest "settings.screenshotTableGate" must be an object; ignoring it and keeping any existing policy.`);
  });

  it("parses aiReview from settings: and lets gate.aiReview win in resolveEffectiveSettings", () => {
    const parsed = parseFocusManifest({ settings: { aiReviewMode: "advisory", aiReviewByok: true } });
    expect(parsed.settings.aiReviewMode).toBe("advisory");
    expect(parsed.settings.aiReviewByok).toBe(true);
    const db = { aiReviewMode: "off", aiReviewByok: false } as unknown as RepositorySettings;
    // settings: applies first, then the friendly gate.aiReview alias wins for its fields.
    const eff = resolveEffectiveSettings(db, parseFocusManifest({ settings: { aiReviewMode: "advisory" }, gate: { aiReview: { mode: "block", byok: true } } }));
    expect(eff.aiReviewMode).toBe("block");
    expect(eff.aiReviewByok).toBe(true);
  });

  it("promotes requireLinkedIssue to linkedIssueGateMode block when the gate mode is still off (#797)", () => {
    const eff = resolveEffectiveSettings(
      { requireLinkedIssue: true, linkedIssueGateMode: "off" } as RepositorySettings,
      parseFocusManifest(null),
    );
    expect(eff.linkedIssueGateMode).toBe("block");
  });

  it("REGRESSION: downgrades a pre-existing DB qualityGateMode: block to advisory, even with no gate.readiness.mode override (#2267)", () => {
    // Simulates a repo whose DB row already has quality_gate_mode = "block" from before the write-time guards
    // (the settings.qualityGateMode parser, the settings-write API routes) existed — the dashboard/API path's
    // "still survives" loophole this resolver-level guard closes for good, regardless of source or vintage.
    const db = { qualityGateMode: "block" } as unknown as RepositorySettings;
    expect(resolveEffectiveSettings(db, parseFocusManifest(null)).qualityGateMode).toBe("advisory");
    // A non-"block" value is untouched — the downgrade only ever fires for "block".
    const dbAdvisory = { qualityGateMode: "advisory" } as unknown as RepositorySettings;
    expect(resolveEffectiveSettings(dbAdvisory, parseFocusManifest(null)).qualityGateMode).toBe("advisory");
  });

  it("REGRESSION: keeps missing-linked-issue advisory when the DB row already says advisory and nothing overrides it (#selfhost-linked-issue-gate-drift)", () => {
    const db = { linkedIssueGateMode: "advisory", requireLinkedIssue: false } as unknown as RepositorySettings;
    expect(resolveEffectiveSettings(db, parseFocusManifest(null)).linkedIssueGateMode).toBe("advisory");
  });

  it("does NOT blanket-downgrade a DB linkedIssueGateMode: block to advisory -- unlike qualityGateMode, block is a legitimate opt-in here (#selfhost-linked-issue-gate-drift)", () => {
    // Deliberately the OPPOSITE assertion from the qualityGateMode regression above: qualityGateMode can
    // NEVER legitimately be "block" (isConfiguredGateBlocker has no branch for it), so resolveEffectiveSettings
    // unconditionally downgrades it. linkedIssueGateMode CAN legitimately be "block" -- a maintainer may
    // explicitly opt into it -- so migration 0102's data fix (conservative: only provably-drifted rows) is
    // the correct place to correct historically-drifted rows, not a resolver-level downgrade that would also
    // silently defeat a real, current opt-in.
    const db = { linkedIssueGateMode: "block", requireLinkedIssue: false } as unknown as RepositorySettings;
    expect(resolveEffectiveSettings(db, parseFocusManifest(null)).linkedIssueGateMode).toBe("block");
  });
});

describe("parseFocusManifest review config", () => {
  it("parses footer text, field toggles, and a note", () => {
    const m = parseFocusManifest({ review: { footer: { text: "Reviewed by the Acme bot." }, fields: { relatedWork: false, gateResult: true }, note: "Run npm test before pushing." } });
    expect(m.present).toBe(true);
    expect(m.review.footerText).toBe("Reviewed by the Acme bot.");
    expect(m.review.note).toBe("Run npm test before pushing.");
    expect(m.review.fields).toEqual({ relatedWork: false, gateResult: true });
  });

  it("drops footer/note content that is not public-safe, with a warning", () => {
    const m = parseFocusManifest({ review: { footer: { text: "Estimate your reward payout here" }, note: "paste your wallet hotkey" } });
    expect(m.review.footerText).toBeNull();
    expect(m.review.note).toBeNull();
    expect(m.warnings.some((w) => /review\.footer\.text.*public-safe/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /review\.note.*public-safe/.test(w))).toBe(true);
  });

  it("drops review override terms covered by the public comment sanitizer", () => {
    const m = parseFocusManifest({
      review: {
        footer: { text: "Maintainer note: include seed phrase details." },
        note: "Intro note mentions private rankings.",
      },
    });
    expect(m.review.footerText).toBeNull();
    expect(m.review.note).toBeNull();
    expect(m.warnings.some((w) => /review\.footer\.text.*public-safe/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /review\.note.*public-safe/.test(w))).toBe(true);
  });

  it("ignores invalid field toggles and non-mapping footer/fields with warnings", () => {
    const m = parseFocusManifest({ review: { footer: ["nope"], fields: "nope" } });
    expect(m.review.present).toBe(false);
    expect(m.warnings.some((w) => /"review\.footer" must be a mapping/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /"review\.fields" must be a mapping/.test(w))).toBe(true);
    const m2 = parseFocusManifest({ review: { fields: { gateResult: "yes" } } });
    expect(m2.review.fields).toEqual({});
    expect(m2.warnings.some((w) => /review\.fields\.gateResult/.test(w))).toBe(true);
  });

  it("ignores a non-mapping review block, treats a review-only manifest as present, and round-trips", () => {
    expect(parseFocusManifest({ review: ["nope"] }).warnings.some((w) => /"review" must be a mapping/.test(w))).toBe(true);
    const original = parseFocusManifest({ review: { footer: { text: "Custom." }, fields: { openPrQueue: false }, note: "Note." } });
    expect(original.present).toBe(true);
    const reparsed = parseFocusManifest({ review: reviewConfigToJson(original.review) });
    expect(reparsed.review).toEqual(original.review);
    expect(reviewConfigToJson(parseFocusManifest({}).review)).toBeNull();
  });

  it("parses review.profile (chill/assertive), normalizes balanced→null, and round-trips (#review-profile)", () => {
    expect(parseFocusManifest({ review: { profile: "chill" } }).review.profile).toBe("chill");
    expect(parseFocusManifest({ review: { profile: "ASSERTIVE" } }).review.profile).toBe("assertive"); // case-insensitive
    // `balanced` is the default → normalizes to null, and a balanced-only block is NOT "present".
    expect(parseFocusManifest({ review: { profile: "balanced" } }).review.profile).toBeNull();
    expect(parseFocusManifest({ review: { profile: "balanced" } }).review.present).toBe(false);
    // A profile-only manifest IS present and survives the reviewConfigToJson round-trip.
    const chill = parseFocusManifest({ review: { profile: "chill" } });
    expect(chill.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(chill.review) }).review).toEqual(chill.review);
  });

  it("parses gate tri-state modes case-insensitively like review.profile", () => {
    const manifest = parseFocusManifest({
      gate: { linkedIssue: "BLOCK", duplicates: "Advisory", size: { mode: "OFF" } },
      settings: { linkedIssueGateMode: "Block" },
    });
    expect(manifest.gate.linkedIssue).toBe("block");
    expect(manifest.gate.duplicates).toBe("advisory");
    expect(manifest.gate.sizeMode).toBe("off");
    expect(manifest.settings.linkedIssueGateMode).toBe("block");
    expect(resolveEffectiveSettings({ linkedIssueGateMode: "off" } as RepositorySettings, manifest).linkedIssueGateMode).toBe("block");
  });

  it("ignores an invalid review.profile with a warning", () => {
    const m = parseFocusManifest({ review: { profile: "spicy" } });
    expect(m.review.profile).toBeNull();
    expect(m.warnings.some((w) => /review\.profile.*chill.*balanced.*assertive/.test(w))).toBe(true);
    const m2 = parseFocusManifest({ review: { profile: 42 } });
    expect(m2.review.profile).toBeNull();
    expect(m2.warnings.some((w) => /review\.profile.*must be a string/.test(w))).toBe(true);
  });

  it("parses review.tone, marks present, round-trips, and rejects non-public-safe values (#2044)", () => {
    const m = parseFocusManifest({ review: { tone: " Be concise and cite line numbers. " } });
    expect(m.review.tone).toBe("Be concise and cite line numbers.");
    expect(m.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.tone).toBe(m.review.tone);
    const unsafe = parseFocusManifest({ review: { tone: "estimate the contributor reward payout" } });
    expect(unsafe.review.tone).toBeNull();
    expect(unsafe.warnings.some((w) => /review\.tone.*not public-safe/.test(w))).toBe(true);
    const long = parseFocusManifest({ review: { tone: "x".repeat(400) } });
    expect(long.review.tone).toHaveLength(300);
  });

  it("composeManifestReviewInstructions: null tone is byte-identical; tone folds ahead of instructions (#2044)", () => {
    expect(composeManifestReviewInstructions(null, null)).toBeNull();
    expect(composeManifestReviewInstructions("Follow our conventions.", null)).toBe("Follow our conventions.");
    expect(composeManifestReviewInstructions(null, "Be concise.")).toBe(
      "Review tone (maintainer voice brief — complements review.profile): Be concise.",
    );
    expect(composeManifestReviewInstructions("Follow our conventions.", "Be concise.")).toBe(
      "Review tone (maintainer voice brief — complements review.profile): Be concise.\n\nFollow our conventions.",
    );
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { tone: "Be concise." } })).tone).toBe("Be concise.");
  });

  it("parses review.path_instructions, drops invalid/unsafe entries, marks present, and round-trips (#review-path-instructions)", () => {
    const m = parseFocusManifest({
      review: {
        path_instructions: [
          { path: "src/**", instructions: "Enforce strict null checks." },
          { path: " tests/** ", instructions: "Cover both branches." }, // path is trimmed
          { path: "", instructions: "no path → dropped" },
          { path: "x/**", instructions: "paste your wallet hotkey here" }, // not public-safe → dropped
          "nope", // non-mapping → dropped
          { path: "y/**" }, // missing instructions → dropped
          { path: 42, instructions: "non-string path" }, // path not a string → dropped
          { path: `${"a".repeat(400)}/x`, instructions: "over-long path" }, // > MAX_ITEM_LENGTH → dropped (#review-audit)
        ],
      },
    });
    expect(m.review.pathInstructions).toEqual([
      { path: "src/**", instructions: "Enforce strict null checks." },
      { path: "tests/**", instructions: "Cover both branches." },
    ]);
    expect(m.review.present).toBe(true);
    expect(m.warnings.some((w) => /path_instructions\[2\]\.path/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /path_instructions\[4\]/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /path_instructions\[5\]\.instructions/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /path_instructions\[6\]\.path/.test(w))).toBe(true); // non-string path
    expect(m.warnings.some((w) => /path_instructions\[7\]\.path.*exceeds/.test(w))).toBe(true); // over-long path
    // Round-trips through the cache serializer.
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.pathInstructions).toEqual(m.review.pathInstructions);
  });

  it("ignores a non-array review.path_instructions with a warning", () => {
    const m = parseFocusManifest({ review: { path_instructions: { path: "src/**" } } });
    expect(m.review.pathInstructions).toEqual([]);
    expect(m.warnings.some((w) => /review\.path_instructions.*must be a list/.test(w))).toBe(true);
  });

  it("caps review.path_instructions at the max with a warning", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ path: `dir${i}/**`, instructions: `rule ${i}` }));
    const m = parseFocusManifest({ review: { path_instructions: many } });
    expect(m.review.pathInstructions).toHaveLength(50);
    expect(m.warnings.some((w) => /path_instructions.*capped/.test(w))).toBe(true);
  });

  it("parses review.security_focus (default OFF), marks present, round-trips, and warns on a non-boolean (#review-security-focus)", () => {
    expect(parseFocusManifest({ review: { security_focus: true } }).review.securityFocus).toBe(true);
    const on = parseFocusManifest({ review: { security_focus: true } });
    expect(on.review.present).toBe(true); // a security-focus-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { security_focus: false } });
    expect(off.review.securityFocus).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.securityFocus).toBeNull();
    expect(parseFocusManifest({ review: {} }).review.present).toBe(false);
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { security_focus: "yes" } });
    expect(bad.review.securityFocus).toBeNull();
    expect(bad.warnings.some((w) => /review\.security_focus.*must be a boolean/.test(w))).toBe(true);
  });

  it("composes review.security_focus with review.profile independently — both persist together", () => {
    const m = parseFocusManifest({ review: { profile: "chill", security_focus: true } });
    expect(m.review.profile).toBe("chill");
    expect(m.review.securityFocus).toBe(true);
    expect(m.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review).toEqual(m.review);
  });
});

describe("review.auto_review.ignore_authors (#2060)", () => {
  it("parses ignore_authors, marks present, and round-trips", () => {
    const manifest = parseFocusManifest({
      review: {
        auto_review: {
          ignore_authors: [" dependabot ", "*[bot]", "RENOVATE", "renovate", "", 42],
        },
      },
    });
    expect(manifest.present).toBe(true);
    expect(manifest.review.present).toBe(true);
    expect(manifest.review.autoReview.ignoreAuthors).toEqual(["dependabot", "*[bot]", "RENOVATE"]);
    expect(manifest.warnings.some((warning) => /ignore_authors\[4\]/.test(warning))).toBe(true);
    expect(manifest.warnings.some((warning) => /ignore_authors\[5\]/.test(warning))).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(manifest.review) }).review).toEqual(manifest.review);
  });

  it("keeps an absent auto_review block as the byte-identical default", () => {
    const manifest = parseFocusManifest({ review: { footer: { text: "Custom." } } });
    expect(manifest.review.autoReview.ignoreAuthors).toEqual([]);
    expect(reviewConfigToJson(manifest.review)).toEqual({ footer: { text: "Custom." } });
    expect(resolveReviewAutoReviewConfig(manifest)).toEqual({ ...EMPTY_AUTO_REVIEW_CONFIG });
    expect(resolveReviewAutoReviewConfig(null)).toEqual({ ...EMPTY_AUTO_REVIEW_CONFIG });
  });

  it("warns for malformed auto_review and caps ignore_authors", () => {
    const malformed = parseFocusManifest({ review: { auto_review: ["dependabot"] } });
    expect(malformed.review.autoReview.ignoreAuthors).toEqual([]);
    expect(malformed.warnings.some((warning) => /review\.auto_review.*mapping/.test(warning))).toBe(true);

    const tooMany = parseFocusManifest({
      review: {
        auto_review: {
          ignore_authors: Array.from({ length: 60 }, (_, index) => `bot-${index}`),
        },
      },
    });
    expect(tooMany.review.autoReview.ignoreAuthors).toHaveLength(50);
    expect(tooMany.warnings.some((warning) => /ignore_authors.*capped/.test(warning))).toBe(true);
  });

  it("drops over-long ignore_authors globs", () => {
    const manifest = parseFocusManifest({
      review: {
        auto_review: {
          ignore_authors: [`${"a".repeat(400)}*`, "release-please*"],
        },
      },
    });
    expect(manifest.review.autoReview.ignoreAuthors).toEqual(["release-please*"]);
    expect(manifest.warnings.some((warning) => /ignore_authors\[0\].*exceeds/.test(warning))).toBe(true);
  });
});

describe("resolveReviewPathInstructions (#review-path-instructions)", () => {
  const rules = [
    { path: "src/**", instructions: "Enforce strict null checks." },
    { path: "tests/**", instructions: "Cover both branches." },
  ];

  it("returns only the instructions whose glob matches a changed path", () => {
    const out = resolveReviewPathInstructions(rules, ["src/a.ts", "README.md"]);
    expect(out).toContain("Enforce strict null checks.");
    expect(out).toContain("`src/**`");
    expect(out).not.toContain("Cover both branches."); // tests/** matched nothing
  });

  it("returns an empty string when nothing is configured or nothing matches (byte-identical prompt)", () => {
    expect(resolveReviewPathInstructions([], ["src/a.ts"])).toBe("");
    expect(resolveReviewPathInstructions(rules, [])).toBe("");
    expect(resolveReviewPathInstructions(rules, ["docs/x.md"])).toBe("");
  });

  it("includes multiple matching rules", () => {
    const out = resolveReviewPathInstructions(rules, ["src/a.ts", "tests/a.test.ts"]);
    expect(out).toContain("Enforce strict null checks.");
    expect(out).toContain("Cover both branches.");
  });

  it("resolveReviewPromptOverrides: non-null manifest passes the config through; null manifest → defaults", () => {
    const manifest = parseFocusManifest({ review: { profile: "chill", security_focus: true, inline_comments: true, suggestions: true, changed_files_summary: true, effort_score: true, impact_map: true, culture_profile: true, finding_categories: true, comment_verbosity: "detailed", path_instructions: [{ path: "src/**", instructions: "be strict" }], instructions: "Follow our async-error conventions.", exclude_paths: ["**/*.lock"], path_filters: ["src/**", "!src/generated/**"] } });
    expect(resolveReviewPromptOverrides(manifest)).toEqual({ profile: "chill", tone: null, securityFocus: true, inlineComments: true, suggestions: true, changedFilesSummary: true, effortScore: true, impactMap: true, cultureProfile: true, findingCategories: true, inlineCommentsPerCategory: null, minFindingSeverity: null, maxFindings: { blockers: null, nits: null }, commentVerbosity: "detailed", pathInstructions: [{ path: "src/**", instructions: "be strict" }], instructions: "Follow our async-error conventions.", excludePaths: ["**/*.lock"], pathFilters: ["src/**", "!src/generated/**"], selfHostAiModel: { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG } });
    // A null manifest (load failure) yields the byte-identical defaults; inline comments + suggestions + changed-files summary + effort score + impact map + culture profile + finding categories + security focus default OFF.
    expect(resolveReviewPromptOverrides(null)).toEqual({ profile: null, tone: null, securityFocus: false, inlineComments: false, suggestions: false, changedFilesSummary: false, effortScore: false, impactMap: false, cultureProfile: false, findingCategories: false, inlineCommentsPerCategory: null, minFindingSeverity: null, maxFindings: { blockers: null, nits: null }, commentVerbosity: null, pathInstructions: [], instructions: null, excludePaths: [], pathFilters: [], selfHostAiModel: { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG } });
    // An explicit false / absent toggle both resolve to the strict-boolean false.
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { inline_comments: false } })).inlineComments).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).inlineComments).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { suggestions: false } })).suggestions).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).suggestions).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { changed_files_summary: false } })).changedFilesSummary).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).changedFilesSummary).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { effort_score: false } })).effortScore).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).effortScore).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { impact_map: false } })).impactMap).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).impactMap).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { finding_categories: false } })).findingCategories).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).findingCategories).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { security_focus: false } })).securityFocus).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).securityFocus).toBe(false);
  });

  it("parses review.inline_comments (default OFF), marks present, round-trips, and warns on a non-boolean (#inline-comments)", () => {
    expect(parseFocusManifest({ review: { inline_comments: true } }).review.inlineComments).toBe(true);
    const on = parseFocusManifest({ review: { inline_comments: true } });
    expect(on.review.present).toBe(true); // an inline-comments-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { inline_comments: false } });
    expect(off.review.inlineComments).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.inlineComments).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { inline_comments: "yes" } });
    expect(bad.review.inlineComments).toBeNull();
    expect(bad.warnings.some((w) => /review\.inline_comments.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.suggestions (default OFF), marks present, round-trips, and warns on a non-boolean (#1956)", () => {
    expect(parseFocusManifest({ review: { suggestions: true } }).review.suggestions).toBe(true);
    const on = parseFocusManifest({ review: { suggestions: true } });
    expect(on.review.present).toBe(true); // a suggestions-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { suggestions: false } });
    expect(off.review.suggestions).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.suggestions).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { suggestions: "yes" } });
    expect(bad.review.suggestions).toBeNull();
    expect(bad.warnings.some((w) => /review\.suggestions.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.changed_files_summary (default OFF), marks present, round-trips, and warns on a non-boolean (#1957)", () => {
    expect(parseFocusManifest({ review: { changed_files_summary: true } }).review.changedFilesSummary).toBe(true);
    const on = parseFocusManifest({ review: { changed_files_summary: true } });
    expect(on.review.present).toBe(true); // a changed-files-summary-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { changed_files_summary: false } });
    expect(off.review.changedFilesSummary).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.changedFilesSummary).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { changed_files_summary: "yes" } });
    expect(bad.review.changedFilesSummary).toBeNull();
    expect(bad.warnings.some((w) => /review\.changed_files_summary.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.effort_score (default OFF), marks present, round-trips, and warns on a non-boolean (#1955)", () => {
    expect(parseFocusManifest({ review: { effort_score: true } }).review.effortScore).toBe(true);
    const on = parseFocusManifest({ review: { effort_score: true } });
    expect(on.review.present).toBe(true); // an effort-score-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { effort_score: false } });
    expect(off.review.effortScore).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.effortScore).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { effort_score: "yes" } });
    expect(bad.review.effortScore).toBeNull();
    expect(bad.warnings.some((w) => /review\.effort_score.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.test_generation (default OFF), marks present, round-trips, and warns on a non-boolean (#1972)", () => {
    expect(parseFocusManifest({ review: { test_generation: true } }).review.testGeneration).toBe(true);
    const on = parseFocusManifest({ review: { test_generation: true } });
    expect(on.review.present).toBe(true); // a test-generation-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { test_generation: false } });
    expect(off.review.testGeneration).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.testGeneration).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { test_generation: "yes" } });
    expect(bad.review.testGeneration).toBeNull();
    expect(bad.warnings.some((w) => /review\.test_generation.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.impact_map (default OFF), marks present, round-trips, and warns on a non-boolean (#2184)", () => {
    expect(parseFocusManifest({ review: { impact_map: true } }).review.impactMap).toBe(true);
    const on = parseFocusManifest({ review: { impact_map: true } });
    expect(on.review.present).toBe(true); // an impact-map-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { impact_map: false } });
    expect(off.review.impactMap).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.impactMap).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { impact_map: "yes" } });
    expect(bad.review.impactMap).toBeNull();
    expect(bad.warnings.some((w) => /review\.impact_map.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.culture_profile (default OFF), marks present, round-trips, and warns on a non-boolean (#2995)", () => {
    expect(parseFocusManifest({ review: { culture_profile: true } }).review.cultureProfile).toBe(true);
    const on = parseFocusManifest({ review: { culture_profile: true } });
    expect(on.review.present).toBe(true); // a culture-profile-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { culture_profile: false } });
    expect(off.review.cultureProfile).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.cultureProfile).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { culture_profile: "yes" } });
    expect(bad.review.cultureProfile).toBeNull();
    expect(bad.warnings.some((w) => /review\.culture_profile.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.memory (default OFF), marks present, round-trips, and warns on a non-boolean (#2179)", () => {
    expect(parseFocusManifest({ review: { memory: true } }).review.reviewMemory).toBe(true);
    const on = parseFocusManifest({ review: { memory: true } });
    expect(on.review.present).toBe(true); // a memory-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { memory: false } });
    expect(off.review.reviewMemory).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.reviewMemory).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { memory: "yes" } });
    expect(bad.review.reviewMemory).toBeNull();
    expect(bad.warnings.some((w) => /review\.memory.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.finding_categories (default OFF), marks present, round-trips, and warns on a non-boolean (#1958)", () => {
    expect(parseFocusManifest({ review: { finding_categories: true } }).review.findingCategories).toBe(true);
    const on = parseFocusManifest({ review: { finding_categories: true } });
    expect(on.review.present).toBe(true); // a finding-categories-only manifest IS present
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review); // survives round-trip
    // Explicit false is retained (and marks present, since the maintainer set it).
    const off = parseFocusManifest({ review: { finding_categories: false } });
    expect(off.review.findingCategories).toBe(false);
    expect(off.review.present).toBe(true);
    // Absent ⇒ null (the byte-identical default), config not present.
    expect(parseFocusManifest({ review: {} }).review.findingCategories).toBeNull();
    // A non-boolean is ignored with a warning.
    const bad = parseFocusManifest({ review: { finding_categories: "yes" } });
    expect(bad.review.findingCategories).toBeNull();
    expect(bad.warnings.some((w) => /review\.finding_categories.*must be a boolean/.test(w))).toBe(true);
  });

  it("parses review.inline_comments_per_category (default unset), marks present, round-trips, and warns on invalid caps (#2159)", () => {
    const on = parseFocusManifest({ review: { inline_comments_per_category: 3 } });
    expect(on.review.inlineCommentsPerCategory).toBe(3);
    expect(on.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review).toEqual(on.review);
    expect(parseFocusManifest({ review: {} }).review.inlineCommentsPerCategory).toBeNull();
    const bad = parseFocusManifest({ review: { inline_comments_per_category: -1 } });
    expect(bad.review.inlineCommentsPerCategory).toBeNull();
    expect(bad.warnings.some((w) => /review\.inline_comments_per_category/.test(w))).toBe(true);
    expect(parseFocusManifest({ review: { inline_comments_per_category: "nope" } }).review.inlineCommentsPerCategory).toBeNull();
    expect(resolveReviewPromptOverrides(on).inlineCommentsPerCategory).toBe(3);
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).inlineCommentsPerCategory).toBeNull();
  });

  it("resolves review.test_generation's manifest toggle to a strict boolean (#2189)", () => {
    expect(resolveTestGenerationManifestToggle(null)).toBe(false); // null manifest (load failure) ⇒ false
    expect(resolveTestGenerationManifestToggle(parseFocusManifest({}))).toBe(false); // absent ⇒ false
    expect(resolveTestGenerationManifestToggle(parseFocusManifest({ review: { test_generation: false } }))).toBe(false);
    expect(resolveTestGenerationManifestToggle(parseFocusManifest({ review: { test_generation: true } }))).toBe(true);
  });

  it("resolves review.memory's manifest toggle to a strict boolean (#2179)", () => {
    expect(resolveReviewMemoryManifestToggle(null)).toBe(false); // null manifest (load failure) ⇒ false
    expect(resolveReviewMemoryManifestToggle(parseFocusManifest({}))).toBe(false); // absent ⇒ false
    expect(resolveReviewMemoryManifestToggle(parseFocusManifest({ review: { memory: false } }))).toBe(false);
    expect(resolveReviewMemoryManifestToggle(parseFocusManifest({ review: { memory: true } }))).toBe(true);
  });

  it("parses review.min_finding_severity, round-trips, and warns on invalid values (#2048)", () => {
    const major = parseFocusManifest({ review: { min_finding_severity: "major" } });
    expect(major.review.minFindingSeverity).toBe("major");
    expect(major.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(major.review) }).review.minFindingSeverity).toBe("major");
    expect(parseFocusManifest({ review: {} }).review.minFindingSeverity).toBeNull();
    const bad = parseFocusManifest({ review: { min_finding_severity: "urgent" } });
    expect(bad.review.minFindingSeverity).toBeNull();
    expect(bad.warnings.some((w) => /review\.min_finding_severity/.test(w))).toBe(true);
    expect(resolveReviewPromptOverrides(major).minFindingSeverity).toBe("major");
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).minFindingSeverity).toBeNull();
  });

  it("parses review.max_findings (default unset), marks present, round-trips, and warns on invalid caps (#2049)", () => {
    const on = parseFocusManifest({ review: { max_findings: { blockers: 5, nits: 8 } } });
    expect(on.review.maxFindings).toEqual({ blockers: 5, nits: 8 });
    expect(on.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(on.review) }).review.maxFindings).toEqual(on.review.maxFindings);
    expect(parseFocusManifest({ review: {} }).review.maxFindings).toEqual({ blockers: null, nits: null });
    const bad = parseFocusManifest({ review: { max_findings: { blockers: -1, nits: "x" } } });
    expect(bad.review.maxFindings).toEqual({ blockers: null, nits: null });
    expect(bad.warnings.length).toBeGreaterThan(0);
    const notObject = parseFocusManifest({ review: { max_findings: "nope" } });
    expect(notObject.warnings.some((w) => /max_findings.*mapping/.test(w))).toBe(true);
    expect(resolveReviewPromptOverrides(on).maxFindings).toEqual({ blockers: 5, nits: 8 });

    const blockersOnly = parseFocusManifest({ review: { max_findings: { blockers: 3 } } });
    expect(blockersOnly.review.maxFindings).toEqual({ blockers: 3, nits: null });
    expect(parseFocusManifest({ review: reviewConfigToJson(blockersOnly.review) }).review.maxFindings).toEqual(
      blockersOnly.review.maxFindings,
    );

    const nitsOnly = parseFocusManifest({ review: { max_findings: { nits: 2 } } });
    expect(nitsOnly.review.maxFindings).toEqual({ blockers: null, nits: 2 });
    expect(parseFocusManifest({ review: reviewConfigToJson(nitsOnly.review) }).review.maxFindings).toEqual(
      nitsOnly.review.maxFindings,
    );
  });

  it("parses review.comment_verbosity (each level), marks present, round-trips, warns on invalid, and resolves through the overrides (#2047)", () => {
    for (const level of ["quiet", "normal", "detailed"] as const) {
      const manifest = parseFocusManifest({ review: { comment_verbosity: level } });
      expect(manifest.review.commentVerbosity).toBe(level);
      expect(manifest.review.present).toBe(true);
      expect(parseFocusManifest({ review: reviewConfigToJson(manifest.review) }).review.commentVerbosity).toBe(level);
      expect(resolveReviewPromptOverrides(manifest).commentVerbosity).toBe(level);
    }

    expect(parseFocusManifest({ review: {} }).review.commentVerbosity).toBeNull();
    expect(resolveReviewPromptOverrides(null).commentVerbosity).toBeNull();
    expect(reviewConfigToJson(parseFocusManifest({ review: {} }).review)).toEqual(null);

    const invalid = parseFocusManifest({ review: { comment_verbosity: "loud" } });
    expect(invalid.review.commentVerbosity).toBeNull();
    expect(invalid.warnings.some((w) => /comment_verbosity/.test(w))).toBe(true);
  });
});

describe("review.exclude_paths (#review-exclude-paths)", () => {
  it("parses exclude_paths, trims, drops blanks/non-strings with warnings, marks present, and round-trips", () => {
    const m = parseFocusManifest({ review: { exclude_paths: [" **/*.lock ", "dist/**", "", 42, "  "] } });
    expect(m.review.excludePaths).toEqual(["**/*.lock", "dist/**"]);
    expect(m.review.present).toBe(true);
    expect(m.warnings.some((w) => /exclude_paths\[2\]/.test(w))).toBe(true); // empty string
    expect(m.warnings.some((w) => /exclude_paths\[3\]/.test(w))).toBe(true); // non-string
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.excludePaths).toEqual(m.review.excludePaths);
  });

  it("ignores a non-array exclude_paths and caps the list", () => {
    const bad = parseFocusManifest({ review: { exclude_paths: "dist/**" } });
    expect(bad.review.excludePaths).toEqual([]);
    expect(bad.warnings.some((w) => /exclude_paths.*must be a list/.test(w))).toBe(true);
    const many = parseFocusManifest({ review: { exclude_paths: Array.from({ length: 60 }, (_, i) => `dir${i}/**`) } });
    expect(many.review.excludePaths).toHaveLength(50);
    expect(many.warnings.some((w) => /exclude_paths.*capped/.test(w))).toBe(true);
  });

  it("drops an over-long glob (defense-in-depth length cap) (#review-audit)", () => {
    const huge = `${"a".repeat(400)}/x.ts`; // > MAX_ITEM_LENGTH (300)
    const m = parseFocusManifest({ review: { exclude_paths: [huge, "dist/**"] } });
    expect(m.review.excludePaths).toEqual(["dist/**"]); // the over-long glob is dropped, the valid one kept
    expect(m.warnings.some((w) => /exclude_paths\[0\].*exceeds/.test(w))).toBe(true);
  });

  it("excludeReviewPaths filters matching files; empty globs return the same array (byte-identical)", () => {
    const files = [{ path: "src/a.ts" }, { path: "pnpm-lock.yaml" }, { path: "dist/bundle.js" }];
    // `*` crosses slashes, so `*.yaml` matches a top-level lockfile; `dist/**` matches under dist/.
    expect(excludeReviewPaths(files, ["*.yaml", "dist/**"])).toEqual([{ path: "src/a.ts" }]);
    expect(excludeReviewPaths(files, ["docs/**"])).toEqual(files); // no match → unchanged
    expect(excludeReviewPaths(files, [])).toBe(files); // empty → same reference (no-op)
  });

  it("does not exclude attacker-named suffix collisions for **/ basename globs (#review-audit)", () => {
    const files = [{ path: "unsafe.ts" }, { path: "dir/safe.ts" }, { path: "feature.ts" }];
    expect(excludeReviewPaths(files, ["**/safe.ts"])).toEqual([{ path: "unsafe.ts" }, { path: "feature.ts" }]);
  });
});

describe("review.path_filters (#2043)", () => {
  it("parses path_filters with include + negation, trims, marks present, and round-trips", () => {
    const m = parseFocusManifest({ review: { path_filters: [" src/** ", "!src/generated/**", ""] } });
    expect(m.review.pathFilters).toEqual(["src/**", "!src/generated/**"]);
    expect(m.review.present).toBe(true);
    expect(m.warnings.some((w) => /path_filters\[2\]/.test(w))).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.pathFilters).toEqual(m.review.pathFilters);
  });

  it("ignores invalid path_filters entries and caps the list", () => {
    const bad = parseFocusManifest({ review: { path_filters: "src/**" } });
    expect(bad.review.pathFilters).toEqual([]);
    expect(bad.warnings.some((w) => /path_filters.*must be a list/.test(w))).toBe(true);
    const bareNegation = parseFocusManifest({ review: { path_filters: ["!"] } });
    expect(bareNegation.review.pathFilters).toEqual([]);
    expect(bareNegation.warnings.some((w) => /path_filters\[0\].*after a leading '!'/i.test(w))).toBe(true);
    const many = parseFocusManifest({ review: { path_filters: Array.from({ length: 60 }, (_, i) => `dir${i}/**`) } });
    expect(many.review.pathFilters).toHaveLength(50);
    expect(many.warnings.some((w) => /path_filters.*capped/.test(w))).toBe(true);
  });

  it("drops an over-long path_filters glob (defense-in-depth length cap)", () => {
    const huge = `${"a".repeat(400)}/x.ts`;
    const m = parseFocusManifest({ review: { path_filters: [huge, "src/**"] } });
    expect(m.review.pathFilters).toEqual(["src/**"]);
    expect(m.warnings.some((w) => /path_filters\[0\].*exceeds/.test(w))).toBe(true);
  });

  it("drops non-string path_filters entries with warnings", () => {
    const m = parseFocusManifest({ review: { path_filters: [42, "src/**"] } });
    expect(m.review.pathFilters).toEqual(["src/**"]);
    expect(m.warnings.some((w) => /path_filters\[0\]/.test(w))).toBe(true);
  });

  it("applyReviewPathFilters: include-only restricts; negation subtracts; empty is byte-identical", () => {
    const files = [
      { path: "src/a.ts" },
      { path: "src/generated/x.ts" },
      { path: "docs/readme.md" },
    ];
    expect(applyReviewPathFilters(files, ["src/**"])).toEqual([{ path: "src/a.ts" }, { path: "src/generated/x.ts" }]);
    expect(applyReviewPathFilters(files, ["src/**", "!src/generated/**"])).toEqual([{ path: "src/a.ts" }]);
    expect(applyReviewPathFilters(files, ["!docs/**"])).toEqual([{ path: "src/a.ts" }, { path: "src/generated/x.ts" }]);
    expect(applyReviewPathFilters(files, [])).toBe(files);
  });

  it("filterReviewFilesForAi applies exclude_paths before path_filters", () => {
    const files = [
      { path: "src/a.ts" },
      { path: "src/generated/x.ts" },
      { path: "pnpm-lock.yaml" },
      { path: "docs/readme.md" },
    ];
    expect(filterReviewFilesForAi(files, ["**/*.lock", "pnpm-lock.yaml"], ["src/**", "!src/generated/**"])).toEqual([
      { path: "src/a.ts" },
    ]);
    expect(filterReviewFilesForAi(files, [], [])).toBe(files);
  });
});

describe("overlayReviewConfig / review.shared_config (#2046)", () => {
  it("lets the override win per nullable field while the base fills gaps", () => {
    const base = parseReviewConfigMapping({ tone: "house-tone", profile: "chill" }, []);
    const override = parseReviewConfigMapping({ profile: "assertive" }, []);
    const merged = overlayReviewConfig(base, override);
    expect(merged.tone).toBe("house-tone");
    expect(merged.profile).toBe("assertive");
    expect(merged.present).toBe(true);
  });

  it("replaces array fields wholesale from the override when non-empty", () => {
    const base = parseReviewConfigMapping({ path_filters: ["shared/**"], exclude_paths: ["vendor/**"] }, []);
    const override = parseReviewConfigMapping({ path_filters: ["src/**"] }, []);
    const merged = overlayReviewConfig(base, override);
    expect(merged.pathFilters).toEqual(["src/**"]);
    expect(merged.excludePaths).toEqual(["vendor/**"]);
  });

  it("merges nested auto_review and partial field maps key-by-key", () => {
    const base = parseReviewConfigMapping({ auto_review: { skip_drafts: true, ignore_authors: ["bot"] }, fields: { relatedWork: false } }, []);
    const override = parseReviewConfigMapping({ auto_review: { ignore_authors: ["dependabot"] }, fields: { openPrQueue: true } }, []);
    const merged = overlayReviewConfig(base, override);
    expect(merged.autoReview.skipDrafts).toBe(true);
    expect(merged.autoReview.ignoreAuthors).toEqual(["dependabot"]);
    expect(merged.fields).toEqual({ relatedWork: false, openPrQueue: true });
  });

  it("preserves sharedConfigSource from the override when set", () => {
    const base = parseReviewConfigMapping({ tone: "house" }, []);
    const override = { ...parseReviewConfigMapping({ profile: "assertive" }, []), sharedConfigSource: "_shared/.gittensory.yml" };
    expect(overlayReviewConfig(base, override).sharedConfigSource).toBe("_shared/.gittensory.yml");
  });

  it("is byte-identical to the override when the base is empty", () => {
    const base = parseReviewConfigMapping(undefined, []);
    const override = parseReviewConfigMapping({ tone: "repo-only" }, []);
    expect(overlayReviewConfig(base, override)).toEqual(override);
  });
});

describe("review.auto_review (#1954 / #2038–#2041)", () => {
  it("parses auto_review knobs, marks present, and round-trips", () => {
    const m = parseFocusManifest({
      review: {
        auto_review: {
          skip_drafts: true,
          ignore_authors: [" *[bot] ", "dependabot[bot]"],
          ignore_title_keywords: [" WIP ", "draft"],
          skip_labels: [" do-not-review ", "WIP"],
          base_branches: ["main", "release/**"],
        },
      },
    });
    expect(m.review.autoReview).toEqual({
      skipDrafts: true,
      ignoreAuthors: ["*[bot]", "dependabot[bot]"],
      ignoreTitleKeywords: ["WIP", "draft"],
      skipLabels: ["do-not-review", "wip"],
      skipDocsOnly: null,
      maxAddedLines: 0,
      maxFiles: 0,
      baseBranches: ["main", "release/**"],
      autoPauseAfterReviewedCommits: null,
    });
    expect(m.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.autoReview).toEqual(m.review.autoReview);
  });

  it("ignores invalid auto_review entries with warnings", () => {
    const bad = parseFocusManifest({ review: { auto_review: "nope" } });
    expect(bad.review.autoReview).toEqual({ ...EMPTY_AUTO_REVIEW_CONFIG });
    expect(bad.warnings.some((w) => /auto_review.*must be a mapping/.test(w))).toBe(true);
    const skipDraftsBad = parseFocusManifest({ review: { auto_review: { skip_drafts: "yes" } } });
    expect(skipDraftsBad.review.autoReview.skipDrafts).toBeNull();
    expect(skipDraftsBad.warnings.some((w) => /skip_drafts.*boolean/.test(w))).toBe(true);
    const keywordsBad = parseFocusManifest({ review: { auto_review: { ignore_title_keywords: ["", 42, "WIP"] } } });
    expect(keywordsBad.review.autoReview.ignoreTitleKeywords).toEqual(["WIP"]);
    expect(keywordsBad.warnings.some((w) => /ignore_title_keywords\[0\]/.test(w))).toBe(true);
    expect(keywordsBad.warnings.some((w) => /ignore_title_keywords\[1\]/.test(w))).toBe(true);
    const many = parseFocusManifest({
      review: { auto_review: { ignore_authors: Array.from({ length: 60 }, (_, i) => `bot${i}`) } },
    });
    expect(many.review.autoReview.ignoreAuthors).toHaveLength(50);
    expect(many.warnings.some((w) => /ignore_authors.*capped/.test(w))).toBe(true);
  });

  it("resolveAutoReviewConfig: null manifest yields empty defaults", () => {
    expect(resolveAutoReviewConfig(null)).toEqual({ ...EMPTY_AUTO_REVIEW_CONFIG });
  });

  it("evaluateAutoReviewSkipReason: byte-identical when unset; skips with deterministic reasons when configured", () => {
    const empty = { ...EMPTY_AUTO_REVIEW_CONFIG };
    const input = { isDraft: true, author: "dependabot[bot]", title: "WIP: bump deps", labels: [] as string[], changedPaths: [] as string[], addedLineCount: 0, changedFileCount: 0, baseRef: "develop", reviewedCommitCount: 0 };
    expect(evaluateAutoReviewSkipReason(empty, input)).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDrafts: true }, { ...input, isDraft: true })).toBe("review skipped (draft)");
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDrafts: true }, { ...input, isDraft: false })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, ignoreAuthors: ["*[bot]"] }, input)).toBe("review skipped (ignored author)");
    expect(evaluateAutoReviewSkipReason({ ...empty, ignoreAuthors: ["*[bot]"] }, { ...input, author: "Dependabot[bot]" })).toBe(
      "review skipped (ignored author)",
    );
    expect(evaluateAutoReviewSkipReason({ ...empty, ignoreAuthors: ["human"] }, input)).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, ignoreTitleKeywords: ["wip"] }, { ...input, title: "Fix WIP regression" })).toBe("review skipped (WIP title)");
    expect(evaluateAutoReviewSkipReason({ ...empty, ignoreTitleKeywords: ["wip"] }, { ...input, title: "Fix regression" })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipLabels: ["do-not-review"] }, { ...input, labels: ["Do-Not-Review"] })).toBe("review skipped (label)");
    expect(evaluateAutoReviewSkipReason({ ...empty, skipLabels: ["wip", "hold"] }, { ...input, labels: ["hold"] })).toBe("review skipped (label)");
    expect(evaluateAutoReviewSkipReason({ ...empty, skipLabels: ["wip"] }, { ...input, labels: ["feature"] })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipLabels: ["wip"] }, { ...input, labels: [] })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipLabels: [] }, { ...input, labels: ["feature"] })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDocsOnly: true }, { ...input, changedPaths: ["README.md", "docs/guide.md"] })).toBe("review skipped (docs only)");
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDocsOnly: true }, { ...input, changedPaths: ["README.md", "src/a.ts"] })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDocsOnly: true }, { ...input, changedPaths: [] })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDocsOnly: false }, { ...input, changedPaths: ["README.md"] })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, maxAddedLines: 10 }, { ...input, addedLineCount: 11 })).toBe("review skipped (too large)");
    expect(evaluateAutoReviewSkipReason({ ...empty, maxAddedLines: 10 }, { ...input, addedLineCount: 10 })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, maxAddedLines: 0 }, { ...input, addedLineCount: 999 })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, maxFiles: 3 }, { ...input, changedFileCount: 4 })).toBe("review skipped (too large)");
    expect(evaluateAutoReviewSkipReason({ ...empty, maxFiles: 3 }, { ...input, changedFileCount: 3 })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, maxFiles: 0 }, { ...input, changedFileCount: 99 })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, baseBranches: ["main"] }, { ...input, baseRef: "develop" })).toBe(
      "review skipped (base branch out of scope)",
    );
    expect(evaluateAutoReviewSkipReason({ ...empty, baseBranches: ["main", "release/**"] }, { ...input, baseRef: "release/1.2" })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, baseBranches: ["main"] }, { ...input, baseRef: null })).toBe(
      "review skipped (base branch out of scope)",
    );
    expect(evaluateAutoReviewSkipReason({ ...empty, skipDrafts: false }, { ...input, isDraft: true })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, ignoreAuthors: ["*[bot]"] }, { ...input, author: null })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, autoPauseAfterReviewedCommits: 2 }, { ...input, reviewedCommitCount: 1 })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, autoPauseAfterReviewedCommits: 2 }, { ...input, reviewedCommitCount: 2 })).toBe(
      "review paused (commit threshold)",
    );
    expect(evaluateAutoReviewSkipReason({ ...empty, autoPauseAfterReviewedCommits: 0 }, { ...input, reviewedCommitCount: 99 })).toBeNull();
    expect(evaluateAutoReviewSkipReason({ ...empty, autoPauseAfterReviewedCommits: null }, { ...input, reviewedCommitCount: 99 })).toBeNull();
  });

  it("resolveAutoReviewSkipSummary maps every known skip reason to a public-safe sentence (#2067)", () => {
    for (const [reason, summary] of Object.entries(AUTO_REVIEW_SKIP_SUMMARY)) {
      expect(resolveAutoReviewSkipSummary(reason)).toBe(summary);
      expect(summary.length).toBeGreaterThan(0);
    }
    expect(resolveAutoReviewSkipSummary("review skipped (unknown)")).toBe("review skipped (unknown)");
  });

  it("marks only contributor-controlled auto_review skip reasons as requiring a hold", () => {
    expect(isContributorControlledAutoReviewSkipReason("review skipped (WIP title)")).toBe(true);
    expect(isContributorControlledAutoReviewSkipReason("review skipped (base branch out of scope)")).toBe(true);
    expect(isContributorControlledAutoReviewSkipReason("review skipped (draft)")).toBe(false);
    expect(isContributorControlledAutoReviewSkipReason("review skipped (ignored author)")).toBe(false);
    expect(isContributorControlledAutoReviewSkipReason("review skipped (label)")).toBe(false);
    expect(isContributorControlledAutoReviewSkipReason("review skipped (unknown)")).toBe(false);
  });

  it("parses auto_pause_after_reviewed_commits with bounds validation (#2042)", () => {
    const ok = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: 3 } } });
    expect(ok.review.autoReview.autoPauseAfterReviewedCommits).toBe(3);
    expect(ok.review.present).toBe(true);
    const zero = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: 0 } } });
    expect(zero.review.autoReview.autoPauseAfterReviewedCommits).toBe(0);
    const bad = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: -1 } } });
    expect(bad.review.autoReview.autoPauseAfterReviewedCommits).toBeNull();
    expect(bad.warnings.some((w) => /auto_pause_after_reviewed_commits.*non-negative integer/.test(w))).toBe(true);
    const floatBad = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: 1.5 } } });
    expect(floatBad.review.autoReview.autoPauseAfterReviewedCommits).toBeNull();
    const stringBad = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: "3" } } });
    expect(stringBad.review.autoReview.autoPauseAfterReviewedCommits).toBeNull();
    expect(stringBad.warnings.some((w) => /auto_pause_after_reviewed_commits.*non-negative integer/.test(w))).toBe(true);
    expect(reviewConfigToJson(ok.review)).toEqual({ auto_review: { auto_pause_after_reviewed_commits: 3 } });
    expect(reviewConfigToJson(zero.review)).toEqual({ auto_review: { auto_pause_after_reviewed_commits: 0 } });
  });

  it("serializes explicit skip_drafts: false and drops unsafe title keywords", () => {
    const m = parseFocusManifest({ review: { auto_review: { skip_drafts: false, ignore_title_keywords: ["WIP", "reward payout"] } } });
    expect(m.review.autoReview.skipDrafts).toBe(false);
    expect(m.review.autoReview.ignoreTitleKeywords).toEqual(["WIP"]);
    expect(m.warnings.some((w) => /ignore_title_keywords\[1\]/.test(w))).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.autoReview.skipDrafts).toBe(false);
  });

  it("round-trips individual auto_review fields through reviewConfigToJson", () => {
    const authorsOnly = parseFocusManifest({ review: { auto_review: { ignore_authors: ["*[bot]"] } } });
    expect(reviewConfigToJson(authorsOnly.review)).toEqual({ auto_review: { ignore_authors: ["*[bot]"] } });
    const keywordsOnly = parseFocusManifest({ review: { auto_review: { ignore_title_keywords: ["DRAFT"] } } });
    expect(reviewConfigToJson(keywordsOnly.review)).toEqual({ auto_review: { ignore_title_keywords: ["DRAFT"] } });
    const labelsOnly = parseFocusManifest({ review: { auto_review: { skip_labels: ["do-not-review"] } } });
    expect(reviewConfigToJson(labelsOnly.review)).toEqual({ auto_review: { skip_labels: ["do-not-review"] } });
    const docsOnly = parseFocusManifest({ review: { auto_review: { skip_docs_only: true } } });
    expect(reviewConfigToJson(docsOnly.review)).toEqual({ auto_review: { skip_docs_only: true } });
    const linesCap = parseFocusManifest({ review: { auto_review: { max_added_lines: 500 } } });
    expect(reviewConfigToJson(linesCap.review)).toEqual({ auto_review: { max_added_lines: 500 } });
    const filesCap = parseFocusManifest({ review: { auto_review: { max_files: 25 } } });
    expect(reviewConfigToJson(filesCap.review)).toEqual({ auto_review: { max_files: 25 } });
    const basesOnly = parseFocusManifest({ review: { auto_review: { base_branches: ["main"] } } });
    expect(reviewConfigToJson(basesOnly.review)).toEqual({ auto_review: { base_branches: ["main"] } });
  });

  it("warns on invalid max_added_lines and max_files values", () => {
    const badLines = parseFocusManifest({ review: { auto_review: { max_added_lines: -1 } } });
    expect(badLines.review.autoReview.maxAddedLines).toBe(0);
    expect(badLines.warnings.some((w) => /max_added_lines.*non-negative integer/.test(w))).toBe(true);
    const badFiles = parseFocusManifest({ review: { auto_review: { max_files: "many" } } });
    expect(badFiles.review.autoReview.maxFiles).toBe(0);
    expect(badFiles.warnings.some((w) => /max_files.*non-negative integer/.test(w))).toBe(true);
    const explicitZero = parseFocusManifest({ review: { auto_review: { max_added_lines: 0, max_files: 0 } } });
    expect(explicitZero.review.autoReview.maxAddedLines).toBe(0);
    expect(explicitZero.review.autoReview.maxFiles).toBe(0);
    expect(reviewConfigToJson(explicitZero.review)).toBeNull();
  });

  it("warns on invalid skip_docs_only values and round-trips explicit false", () => {
    const bad = parseFocusManifest({ review: { auto_review: { skip_docs_only: "yes" } } });
    expect(bad.review.autoReview.skipDocsOnly).toBeNull();
    expect(bad.warnings.some((w) => /skip_docs_only.*boolean/.test(w))).toBe(true);
    const explicitOff = parseFocusManifest({ review: { auto_review: { skip_docs_only: false } } });
    expect(explicitOff.review.autoReview.skipDocsOnly).toBe(false);
    expect(parseFocusManifest({ review: reviewConfigToJson(explicitOff.review) }).review.autoReview.skipDocsOnly).toBe(false);
  });

  it("warns on invalid skip_labels list shapes, dedupes case-insensitively, and caps entries", () => {
    const bad = parseFocusManifest({ review: { auto_review: { skip_labels: "wip" } } });
    expect(bad.review.autoReview.skipLabels).toEqual([]);
    expect(bad.warnings.some((w) => /skip_labels.*must be a list/.test(w))).toBe(true);
    const deduped = parseFocusManifest({ review: { auto_review: { skip_labels: ["WIP", "wip", ""] } } });
    expect(deduped.review.autoReview.skipLabels).toEqual(["wip"]);
    expect(deduped.warnings.some((w) => /skip_labels\[2\]/.test(w))).toBe(true);
    const nonString = parseFocusManifest({ review: { auto_review: { skip_labels: ["wip", 42] } } });
    expect(nonString.review.autoReview.skipLabels).toEqual(["wip"]);
    expect(nonString.warnings.some((w) => /skip_labels\[1\]/.test(w))).toBe(true);
    const unsafe = parseFocusManifest({ review: { auto_review: { skip_labels: ["wip", "reward payout"] } } });
    expect(unsafe.review.autoReview.skipLabels).toEqual(["wip"]);
    expect(unsafe.warnings.some((w) => /skip_labels\[1\]/.test(w))).toBe(true);
    const many = parseFocusManifest({
      review: { auto_review: { skip_labels: Array.from({ length: 60 }, (_, i) => `label${i}`) } },
    });
    expect(many.review.autoReview.skipLabels).toHaveLength(50);
    expect(many.warnings.some((w) => /skip_labels.*capped/.test(w))).toBe(true);
  });

  it("warns on invalid ignore_title_keywords list shapes and caps entries", () => {
    const bad = parseFocusManifest({ review: { auto_review: { ignore_title_keywords: "WIP" } } });
    expect(bad.review.autoReview.ignoreTitleKeywords).toEqual([]);
    expect(bad.warnings.some((w) => /ignore_title_keywords.*must be a list/.test(w))).toBe(true);
    const many = parseFocusManifest({
      review: { auto_review: { ignore_title_keywords: Array.from({ length: 60 }, (_, i) => `kw${i}`) } },
    });
    expect(many.review.autoReview.ignoreTitleKeywords).toHaveLength(50);
    expect(many.warnings.some((w) => /ignore_title_keywords.*capped/.test(w))).toBe(true);
  });
});

describe("review.ai_model (#selfhost-ai-model-override)", () => {
  it("parses all eight knobs, marks present, and round-trips", () => {
    const m = parseFocusManifest({
      review: {
        ai_model: {
          claude_model: "claude-opus-4-8",
          claude_effort: "high",
          codex_model: "gpt-5.5-pro",
          codex_effort: "xhigh",
          ollama_model: "llama3.3",
          openai_model: "gpt-5.5",
          openai_compatible_model: "qwen2.5-coder",
          anthropic_model: "claude-opus-4-8",
        },
      },
    });
    expect(m.review.aiModel).toEqual({
      claudeModel: "claude-opus-4-8",
      claudeEffort: "high",
      codexModel: "gpt-5.5-pro",
      codexEffort: "xhigh",
      ollamaModel: "llama3.3",
      openaiModel: "gpt-5.5",
      openaiCompatibleModel: "qwen2.5-coder",
      anthropicModel: "claude-opus-4-8",
    });
    expect(m.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.aiModel).toEqual(m.review.aiModel);
  });

  it("parses each of the four HTTP-API provider knobs independently (#3902)", () => {
    for (const [key, camelKey] of [
      ["ollama_model", "ollamaModel"],
      ["openai_model", "openaiModel"],
      ["openai_compatible_model", "openaiCompatibleModel"],
      ["anthropic_model", "anthropicModel"],
    ] as const) {
      const m = parseFocusManifest({ review: { ai_model: { [key]: "some-model" } } });
      expect(m.review.aiModel).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG, [camelKey]: "some-model" });
      expect(m.review.present).toBe(true);
      expect(reviewConfigToJson(m.review)).toEqual({ ai_model: { [key]: "some-model" } });
    }
  });

  it("absent/null ai_model yields the empty defaults and does not mark review present on its own", () => {
    expect(parseFocusManifest({}).review.aiModel).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG });
    expect(parseFocusManifest({ review: { ai_model: null } }).review.aiModel).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG });
    expect(parseFocusManifest({}).review.present).toBe(false);
  });

  it("ignores a non-mapping ai_model with a warning", () => {
    const bad = parseFocusManifest({ review: { ai_model: "claude-sonnet-5" } });
    expect(bad.review.aiModel).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG });
    expect(bad.warnings.some((w) => /review\.ai_model.*must be a mapping/.test(w))).toBe(true);
  });

  it("drops an unsafe value with a warning but keeps the other three fields (each is independently optional)", () => {
    const m = parseFocusManifest({ review: { ai_model: { claude_model: "claude-sonnet-5", claude_effort: "reward payout" } } });
    expect(m.review.aiModel.claudeModel).toBe("claude-sonnet-5");
    expect(m.review.aiModel.claudeEffort).toBeNull();
    expect(m.review.aiModel.codexModel).toBeNull();
    expect(m.review.aiModel.codexEffort).toBeNull();
    expect(m.warnings.some((w) => /review\.ai_model\.claude_effort.*not public-safe/.test(w))).toBe(true);
  });

  it("round-trips individual ai_model fields through reviewConfigToJson", () => {
    const claudeOnly = parseFocusManifest({ review: { ai_model: { claude_model: "claude-sonnet-5" } } });
    expect(reviewConfigToJson(claudeOnly.review)).toEqual({ ai_model: { claude_model: "claude-sonnet-5" } });
    const codexOnly = parseFocusManifest({ review: { ai_model: { codex_effort: "low" } } });
    expect(reviewConfigToJson(codexOnly.review)).toEqual({ ai_model: { codex_effort: "low" } });
  });

  it("resolveReviewSelfHostAiModel: null manifest yields empty defaults; a set manifest passes through", () => {
    expect(resolveReviewSelfHostAiModel(null)).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG });
    const manifest = parseFocusManifest({ review: { ai_model: { codex_model: "gpt-5.5" } } });
    expect(resolveReviewSelfHostAiModel(manifest)).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG, codexModel: "gpt-5.5" });
  });

  it("resolveReviewPromptOverrides folds in selfHostAiModel alongside the other AI-reviewer overrides", () => {
    const manifest = parseFocusManifest({ review: { ai_model: { claude_effort: "xhigh" } } });
    const overrides: SelfHostAiModelConfig = resolveReviewPromptOverrides(manifest).selfHostAiModel;
    expect(overrides).toEqual({ ...EMPTY_SELF_HOST_AI_MODEL_CONFIG, claudeEffort: "xhigh" });
  });
});

describe("review.visual (#3609 preview.url_template / #3610 routes)", () => {
  it("parses preview.url_template + routes, marks present, and round-trips", () => {
    const m = parseFocusManifest({
      review: {
        visual: {
          preview: { url_template: "https://pr-{number}.preview.example.com" },
          routes: { paths: ["/pricing", "/docs"], max_routes: 3 },
        },
      },
    });
    expect(m.review.visual).toEqual({
      preview: { urlTemplate: "https://pr-{number}.preview.example.com" },
      routes: { paths: ["/pricing", "/docs"], maxRoutes: 3 },
      themes: [],
      gif: false,
    });
    expect(m.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.visual).toEqual(m.review.visual);
  });

  it("absent/null visual yields the empty defaults and does not mark review present on its own", () => {
    expect(parseFocusManifest({}).review.visual).toEqual({ ...EMPTY_VISUAL_CONFIG });
    expect(parseFocusManifest({ review: { visual: null } }).review.visual).toEqual({ ...EMPTY_VISUAL_CONFIG });
    expect(parseFocusManifest({}).review.present).toBe(false);
  });

  it("ignores a non-mapping review.visual with a warning", () => {
    const bad = parseFocusManifest({ review: { visual: "on" } });
    expect(bad.review.visual).toEqual({ ...EMPTY_VISUAL_CONFIG });
    expect(bad.warnings.some((w) => /review\.visual.*must be a mapping/.test(w))).toBe(true);
  });

  it("ignores a non-mapping review.visual array with a warning", () => {
    const bad = parseFocusManifest({ review: { visual: ["preview"] } });
    expect(bad.review.visual).toEqual({ ...EMPTY_VISUAL_CONFIG });
    expect(bad.warnings.some((w) => /review\.visual.*must be a mapping/.test(w))).toBe(true);
  });

  it("ignores a non-mapping review.visual.preview with a warning but keeps routes", () => {
    const bad = parseFocusManifest({ review: { visual: { preview: "https://pr.example.com", routes: { paths: ["/app"] } } } });
    expect(bad.review.visual.preview).toEqual({ urlTemplate: null });
    expect(bad.review.visual.routes.paths).toEqual(["/app"]);
    expect(bad.warnings.some((w) => /review\.visual\.preview.*must be a mapping/.test(w))).toBe(true);
  });

  it("ignores a non-mapping review.visual.routes with a warning but keeps preview", () => {
    const bad = parseFocusManifest({ review: { visual: { preview: { url_template: "https://pr.example.com" }, routes: "everything" } } });
    expect(bad.review.visual.routes).toEqual({ paths: [], maxRoutes: null });
    expect(bad.review.visual.preview.urlTemplate).toBe("https://pr.example.com");
    expect(bad.warnings.some((w) => /review\.visual\.routes.*must be a mapping/.test(w))).toBe(true);
  });

  it("rejects a non-HTTPS url_template with a warning", () => {
    const bad = parseFocusManifest({ review: { visual: { preview: { url_template: "http://pr-{number}.example.com" } } } });
    expect(bad.review.visual.preview.urlTemplate).toBeNull();
    expect(bad.warnings.some((w) => /review\.visual\.preview\.url_template.*valid HTTPS URL/.test(w))).toBe(true);
  });

  it("rejects a url_template resolving to a private/internal host with a warning", () => {
    const bad = parseFocusManifest({ review: { visual: { preview: { url_template: "https://pr-{number}.internal" } } } });
    expect(bad.review.visual.preview.urlTemplate).toBeNull();
    expect(bad.warnings.some((w) => /review\.visual\.preview\.url_template.*valid HTTPS URL/.test(w))).toBe(true);
  });

  it("rejects a malformed url_template (unparseable even with placeholders substituted) with a warning", () => {
    const bad = parseFocusManifest({ review: { visual: { preview: { url_template: "not-a-url-at-all" } } } });
    expect(bad.review.visual.preview.urlTemplate).toBeNull();
    expect(bad.warnings.some((w) => /review\.visual\.preview\.url_template.*valid HTTPS URL/.test(w))).toBe(true);
  });

  it("accepts a url_template with no placeholders at all (a fixed preview host)", () => {
    const m = parseFocusManifest({ review: { visual: { preview: { url_template: "https://staging.example.com" } } } });
    expect(m.review.visual.preview.urlTemplate).toBe("https://staging.example.com");
  });

  it("rejects max_routes of zero or a negative number with a warning", () => {
    const zero = parseFocusManifest({ review: { visual: { routes: { max_routes: 0 } } } });
    expect(zero.review.visual.routes.maxRoutes).toBeNull();
    expect(zero.warnings.some((w) => /review\.visual\.routes\.max_routes.*positive whole number/.test(w))).toBe(true);
    const negative = parseFocusManifest({ review: { visual: { routes: { max_routes: -1 } } } });
    expect(negative.review.visual.routes.maxRoutes).toBeNull();
  });

  it("clamps max_routes above the safe visual route limit with a warning", () => {
    const m = parseFocusManifest({ review: { visual: { routes: { max_routes: 1000 } } } });
    expect(m.review.visual.routes.maxRoutes).toBe(5);
    expect(m.warnings.some((w) => /review\.visual\.routes\.max_routes.*at most 5/.test(w))).toBe(true);
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { routes: { max_routes: 5 } } });
  });

  it("marks present via routes.paths alone (preview + max_routes both empty)", () => {
    const m = parseFocusManifest({ review: { visual: { routes: { paths: ["/app"] } } } });
    expect(m.review.present).toBe(true);
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { routes: { paths: ["/app"] } } });
  });

  it("marks present via routes.max_routes alone (preview + paths both empty)", () => {
    const m = parseFocusManifest({ review: { visual: { routes: { max_routes: 5 } } } });
    expect(m.review.present).toBe(true);
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { routes: { max_routes: 5 } } });
  });

  it("round-trips a preview-only config through reviewConfigToJson without an empty routes block", () => {
    const m = parseFocusManifest({ review: { visual: { preview: { url_template: "https://pr-{number}.example.com" } } } });
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { preview: { url_template: "https://pr-{number}.example.com" } } });
  });

  it("resolveReviewVisualConfig: null manifest yields empty defaults; a set manifest passes through", () => {
    expect(resolveReviewVisualConfig(null)).toEqual({ ...EMPTY_VISUAL_CONFIG });
    const manifest = parseFocusManifest({ review: { visual: { routes: { paths: ["/app"] } } } });
    expect(resolveReviewVisualConfig(manifest)).toEqual({ preview: { urlTemplate: null }, routes: { paths: ["/app"], maxRoutes: null }, themes: [], gif: false });
  });
});

describe("review.visual.themes (#3678 dark-mode capture)", () => {
  it("parses a light+dark list, marks present, and round-trips", () => {
    const m = parseFocusManifest({ review: { visual: { themes: ["light", "dark"] } } });
    expect(m.review.visual.themes).toEqual(["light", "dark"]);
    expect(m.review.present).toBe(true);
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { themes: ["light", "dark"] } });
  });

  it("absent/empty themes yields [] and does not mark review present on its own", () => {
    expect(parseFocusManifest({}).review.visual.themes).toEqual([]);
    expect(parseFocusManifest({ review: { visual: { themes: [] } } }).review.visual.themes).toEqual([]);
    expect(parseFocusManifest({ review: { visual: {} } }).review.present).toBe(false);
  });

  it("lowercases + dedupes entries, preserving first-seen order", () => {
    const m = parseFocusManifest({ review: { visual: { themes: ["DARK", "light", "dark", "Light"] } } });
    expect(m.review.visual.themes).toEqual(["dark", "light"]);
  });

  it("drops an unrecognized theme value with a warning but keeps the valid ones", () => {
    const bad = parseFocusManifest({ review: { visual: { themes: ["light", "sepia", "dark"] } } });
    expect(bad.review.visual.themes).toEqual(["light", "dark"]);
    expect(bad.warnings.some((w) => /review\.visual\.themes\[1\].*"light" or "dark"/.test(w))).toBe(true);
  });

  it("warns and drops the whole list when it's not an array", () => {
    const bad = parseFocusManifest({ review: { visual: { themes: "dark" } } });
    expect(bad.review.visual.themes).toEqual([]);
    expect(bad.warnings.some((w) => /review\.visual\.themes.*must be a list/.test(w))).toBe(true);
  });

  it("drops a non-string entry with a warning naming its index", () => {
    const bad = parseFocusManifest({ review: { visual: { themes: ["light", 42, "dark"] } } });
    expect(bad.review.visual.themes).toEqual(["light", "dark"]);
    expect(bad.warnings.some((w) => /review\.visual\.themes\[1\]/.test(w))).toBe(true);
  });

  it("marks present via themes alone (preview + routes both empty)", () => {
    const m = parseFocusManifest({ review: { visual: { themes: ["dark"] } } });
    expect(m.review.present).toBe(true);
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { themes: ["dark"] } });
  });

  it("resolveReviewVisualConfig passes a configured theme list through", () => {
    const manifest = parseFocusManifest({ review: { visual: { themes: ["dark"] } } });
    expect(resolveReviewVisualConfig(manifest).themes).toEqual(["dark"]);
  });
});

describe("review.visual.gif (#3612 scroll-through GIF capture)", () => {
  it("parses gif: true, marks present, and round-trips", () => {
    const m = parseFocusManifest({ review: { visual: { gif: true } } });
    expect(m.review.visual.gif).toBe(true);
    expect(m.review.present).toBe(true);
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { gif: true } });
  });

  it("absent gif defaults to false and does not mark review present on its own", () => {
    expect(parseFocusManifest({}).review.visual.gif).toBe(false);
    expect(parseFocusManifest({ review: { visual: {} } }).review.present).toBe(false);
  });

  it("gif: false does not mark review present, so the whole review block round-trips to null", () => {
    const m = parseFocusManifest({ review: { visual: { gif: false } } });
    expect(m.review.visual.gif).toBe(false);
    expect(reviewConfigToJson(m.review)).toBeNull();
  });

  it("warns and defaults to false when gif is not a boolean", () => {
    const bad = parseFocusManifest({ review: { visual: { gif: "yes" } } });
    expect(bad.review.visual.gif).toBe(false);
    expect(bad.warnings.some((w) => /review\.visual\.gif.*must be a boolean/.test(w))).toBe(true);
  });

  it("marks present via gif alone (preview + routes + themes all empty)", () => {
    const m = parseFocusManifest({ review: { visual: { gif: true } } });
    expect(m.review.present).toBe(true);
  });

  it("composes with themes — both configured independently and both round-trip", () => {
    const m = parseFocusManifest({ review: { visual: { gif: true, themes: ["dark"] } } });
    expect(m.review.visual).toEqual({ preview: { urlTemplate: null }, routes: { paths: [], maxRoutes: null }, themes: ["dark"], gif: true });
    expect(reviewConfigToJson(m.review)).toEqual({ visual: { themes: ["dark"], gif: true } });
  });

  it("resolveReviewVisualConfig passes a configured gif: true through", () => {
    const manifest = parseFocusManifest({ review: { visual: { gif: true } } });
    expect(resolveReviewVisualConfig(manifest).gif).toBe(true);
  });
});

describe("review.pre_merge_checks (#review-pre-merge-checks)", () => {
  it("parses checks (name + assertions + when_paths + enforce), marks present, and round-trips", () => {
    const m = parseFocusManifest({
      review: {
        pre_merge_checks: [
          { name: "Migration note", when_paths: ["migrations/**"], description_contains: "migration", enforce: true },
          { name: "Conventional title", title_contains: "(" },
          { name: "Breaking label", require_label: "breaking-change" },
        ],
      },
    });
    expect(m.review.preMergeChecks).toEqual([
      { name: "Migration note", whenPaths: ["migrations/**"], titleContains: null, descriptionContains: "migration", requireLabel: null, enforce: true },
      { name: "Conventional title", whenPaths: [], titleContains: "(", descriptionContains: null, requireLabel: null, enforce: false },
      { name: "Breaking label", whenPaths: [], titleContains: null, descriptionContains: null, requireLabel: "breaking-change", enforce: false },
    ]);
    expect(m.review.present).toBe(true);
    expect(parseFocusManifest({ review: reviewConfigToJson(m.review) }).review.preMergeChecks).toEqual(m.review.preMergeChecks);
  });

  it("drops invalid entries with warnings: non-mapping, missing name, no assertion", () => {
    const m = parseFocusManifest({
      review: {
        pre_merge_checks: [
          "nope", // non-mapping
          { title_contains: "x" }, // missing name
          { name: "empty check" }, // no assertion
          { name: 42, require_label: "x" }, // non-string (not public-safe) name → dropped at the name parse
          { name: "ok", require_label: "ship" },
        ],
      },
    });
    expect(m.review.preMergeChecks).toEqual([{ name: "ok", whenPaths: [], titleContains: null, descriptionContains: null, requireLabel: "ship", enforce: false }]);
    expect(m.warnings.some((w) => /pre_merge_checks\[0\]/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /pre_merge_checks\[1\]\.name/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /pre_merge_checks\[2\].*at least one/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /pre_merge_checks\[3\]\.name/.test(w))).toBe(true);
  });

  it("ignores a non-array and caps the list; when_paths warnings name the right field", () => {
    const bad = parseFocusManifest({ review: { pre_merge_checks: { name: "x" } } });
    expect(bad.review.preMergeChecks).toEqual([]);
    expect(bad.warnings.some((w) => /pre_merge_checks.*must be a list/.test(w))).toBe(true);
    const many = parseFocusManifest({ review: { pre_merge_checks: Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, require_label: "l" })) } });
    expect(many.review.preMergeChecks).toHaveLength(50);
    expect(many.warnings.some((w) => /pre_merge_checks.*capped/.test(w))).toBe(true);
    const badWhen = parseFocusManifest({ review: { pre_merge_checks: [{ name: "c", require_label: "l", when_paths: "src/**" }] } });
    expect(badWhen.warnings.some((w) => /pre_merge_checks\[0\]\.when_paths.*must be a list/.test(w))).toBe(true);
  });

  it("resolveReviewPreMergeChecks: non-null manifest passes checks through; null manifest → []", () => {
    const manifest = parseFocusManifest({ review: { pre_merge_checks: [{ name: "c", require_label: "l" }] } });
    expect(resolveReviewPreMergeChecks(manifest)).toEqual(manifest.review.preMergeChecks);
    expect(resolveReviewPreMergeChecks(null)).toEqual([]);
  });
});

describe("composeRepoReviewContext (#review-skills)", () => {
  it("returns '' for null/empty/whitespace-only context", () => {
    expect(composeRepoReviewContext(null, ["a.ts"])).toBe("");
    expect(composeRepoReviewContext({ guide: null, skills: [] }, ["a.ts"])).toBe("");
    expect(composeRepoReviewContext({ guide: "   ", skills: [] }, ["a.ts"])).toBe("");
  });

  it("includes the guide + always/blank-when/glob-matched skills, excluding non-matching ones", () => {
    const ctx = {
      guide: "Review THIS repo carefully.",
      skills: [
        { name: "voice", when: "always", body: "Be decisive." },
        { name: "blank", when: "", body: "Blank-when is always-on." },
        { name: "sql", when: "**/*.sql", body: "Check the index usage." },
        { name: "schema", when: "{**/db/schema.ts,**/*.sql}", body: "Migration parity." },
        { name: "ui", when: "app/**", body: "Should not appear." },
      ],
    };
    const out = composeRepoReviewContext(ctx, ["migrations/0079_x.sql"]);
    expect(out).toContain("Review THIS repo carefully.");
    expect(out).toContain("## skill: voice");
    expect(out).toContain("## skill: blank");
    expect(out).toContain("## skill: sql"); // **/*.sql matched the .sql file
    expect(out).toContain("## skill: schema"); // brace-list matched the .sql file
    expect(out).not.toContain("## skill: ui"); // app/** did not match
    expect(out).not.toContain("Should not appear.");
  });

  it("drops empty-body and non-matching skills (⇒ '' when nothing applies)", () => {
    const out = composeRepoReviewContext(
      { guide: null, skills: [{ name: "empty", when: "always", body: "   " }, { name: "x", when: "src/**", body: "nope" }] },
      ["README.md"],
    );
    expect(out).toBe("");
  });

  it("bounds the injected context to the cost cap", () => {
    const out = composeRepoReviewContext({ guide: "x".repeat(20_000), skills: [] }, []);
    expect(out.length).toBeLessThanOrEqual(16_000);
  });
});

describe("gate.size manual-review hold config (#gate-size)", () => {
  it("parses gate.size.mode, warns on a non-mapping size, and round-trips via gateConfigToJson", () => {
    const m = parseFocusManifest({ gate: { size: { mode: "advisory" } } });
    expect(m.gate.sizeMode).toBe("advisory");
    expect(m.gate.present).toBe(true);
    const bad = parseFocusManifest({ gate: { size: "nope" } });
    expect(bad.gate.sizeMode).toBeNull();
    expect(bad.warnings.some((w) => w.includes("gate.size"))).toBe(true);
    const round = parseFocusManifest({ gate: gateConfigToJson(m.gate) });
    expect(round.gate.sizeMode).toBe("advisory");
  });
});

describe("gate.lockfileIntegrity lockfile-tamper-risk gate config (#2563)", () => {
  it("parses gate.lockfileIntegrity, sets present, round-trips via gateConfigToJson, and resolves into effective settings", () => {
    const m = parseFocusManifest({ gate: { lockfileIntegrity: "block" } });
    expect(m.gate.lockfileIntegrityMode).toBe("block");
    expect(m.gate.present).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ lockfileIntegrity: "block" });
    const round = parseFocusManifest({ gate: gateConfigToJson(m.gate) });
    expect(round.gate.lockfileIntegrityMode).toBe("block");
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.lockfileIntegrityGateMode).toBe("block");
  });

  it("defaults to unset/null when omitted — byte-identical to today (off)", () => {
    const m = parseFocusManifest({});
    expect(m.gate.lockfileIntegrityMode).toBeNull();
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.lockfileIntegrityGateMode).toBeUndefined();
  });

  it("warns and drops an invalid mode value rather than silently coercing it", () => {
    const m = parseFocusManifest({ gate: { lockfileIntegrity: "sometimes" as never } });
    expect(m.gate.lockfileIntegrityMode).toBeNull();
    expect(m.warnings.some((w) => /gate\.lockfileIntegrity/i.test(w))).toBe(true);
  });
});

describe("gate.dryRun dry-run disposition config (#gate-dryrun)", () => {
  it("parses gate.dryRun, sets present, and round-trips via gateConfigToJson", () => {
    const m = parseFocusManifest({ gate: { dryRun: true } });
    expect(m.gate.dryRun).toBe(true);
    expect(m.gate.present).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ dryRun: true });
  });
});

describe("gate.premergeContentRecheck live migration-collision recheck config (#2550)", () => {
  it("parses gate.premergeContentRecheck, sets present, round-trips, and resolves into effective settings", () => {
    const m = parseFocusManifest({ gate: { premergeContentRecheck: true } });
    expect(m.gate.premergeContentRecheck).toBe(true);
    expect(m.gate.present).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ premergeContentRecheck: true });
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.premergeContentRecheck).toBe(true);
  });

  it("defaults to unset/undefined when omitted — byte-identical to today", () => {
    const m = parseFocusManifest({});
    expect(m.gate.premergeContentRecheck).toBeNull();
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.premergeContentRecheck).toBeUndefined();
  });

  it("warns and drops an invalid (non-boolean) value rather than silently coercing it", () => {
    const m = parseFocusManifest({ gate: { premergeContentRecheck: "yes" as never } });
    expect(m.gate.premergeContentRecheck).toBeNull();
    expect(m.warnings.some((w) => /gate\.premergeContentRecheck/i.test(w))).toBe(true);
  });
});

describe("gate.requireFreshRebaseWindow force-rebase-before-merge config (#2552)", () => {
  it("parses gate.requireFreshRebaseWindow, sets present, round-trips, and resolves into effective settings", () => {
    const m = parseFocusManifest({ gate: { requireFreshRebaseWindow: 10 } });
    expect(m.gate.requireFreshRebaseWindowMinutes).toBe(10);
    expect(m.gate.present).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ requireFreshRebaseWindow: 10 });
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.requireFreshRebaseWindowMinutes).toBe(10);
  });

  it("defaults to unset/undefined when omitted — byte-identical to today", () => {
    const m = parseFocusManifest({});
    expect(m.gate.requireFreshRebaseWindowMinutes).toBeNull();
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.requireFreshRebaseWindowMinutes).toBeUndefined();
  });

  it("warns and drops a fractional/non-positive value rather than silently coercing it", () => {
    const fractional = parseFocusManifest({ gate: { requireFreshRebaseWindow: 2.5 } });
    expect(fractional.gate.requireFreshRebaseWindowMinutes).toBeNull();
    expect(fractional.warnings.some((w) => /gate\.requireFreshRebaseWindow/i.test(w))).toBe(true);

    const nonPositive = parseFocusManifest({ gate: { requireFreshRebaseWindow: 0 } });
    expect(nonPositive.gate.requireFreshRebaseWindowMinutes).toBeNull();
    expect(nonPositive.warnings.some((w) => /gate\.requireFreshRebaseWindow/i.test(w))).toBe(true);
  });

  it("lets the DB value pass through when the manifest doesn't override it", () => {
    const db = { requireFreshRebaseWindowMinutes: 15 } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest(null));
    expect(eff.requireFreshRebaseWindowMinutes).toBe(15);
  });
});

describe("gate.claMode / gate.cla CLA / license-compatibility gate config (#2564)", () => {
  it("parses gate.claMode, sets present, round-trips, and resolves into effective settings", () => {
    const m = parseFocusManifest({ gate: { claMode: "block" } });
    expect(m.gate.claMode).toBe("block");
    expect(m.gate.present).toBe(true);
    expect(gateConfigToJson(m.gate)).toMatchObject({ claMode: "block" });
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.claGateMode).toBe("block");
  });

  it("defaults to unset/undefined when omitted — byte-identical to today (off by default)", () => {
    const m = parseFocusManifest({});
    expect(m.gate.claMode).toBeNull();
    expect(m.gate.claConsentPhrase).toBeNull();
    expect(m.gate.claCheckRunName).toBeNull();
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, m);
    expect(eff.claGateMode).toBeUndefined();
    expect(eff.claConsentPhrase).toBeUndefined();
    expect(eff.claCheckRunName).toBeUndefined();
  });

  it("warns and drops an invalid claMode value rather than silently coercing it", () => {
    const m = parseFocusManifest({ gate: { claMode: "sometimes" as never } });
    expect(m.gate.claMode).toBeNull();
    expect(m.warnings.some((w) => /gate\.claMode/i.test(w))).toBe(true);
  });

  it("parses the gate.cla block (consentPhrase + checkRunName), round-trips it, and warns on a non-mapping", () => {
    const m = parseFocusManifest({ gate: { claMode: "block", cla: { consentPhrase: "I have read and agree to the CLA", checkRunName: "CLA Assistant Lite", checkRunAppSlug: "cla-assistant" } } });
    expect(m.gate.claConsentPhrase).toBe("I have read and agree to the CLA");
    expect(m.gate.claCheckRunName).toBe("CLA Assistant Lite");
    expect(m.gate.claCheckRunAppSlug).toBe("cla-assistant");
    expect(gateConfigToJson(m.gate)).toMatchObject({ cla: { consentPhrase: "I have read and agree to the CLA", checkRunName: "CLA Assistant Lite", checkRunAppSlug: "cla-assistant" } });

    const bad = parseFocusManifest({ gate: { cla: "block" as never } });
    expect(bad.gate.claConsentPhrase).toBeNull();
    expect(bad.gate.claCheckRunName).toBeNull();
    expect(bad.warnings.some((w) => /gate\.cla/.test(w))).toBe(true);
  });

  it("drops a consentPhrase/checkRunName that is not public-safe, with a warning (mirrors pre_merge_checks.titleContains)", () => {
    const m = parseFocusManifest({ gate: { cla: { consentPhrase: "please share your wallet hotkey to agree", checkRunName: "leak reward payout check" } } });
    expect(m.gate.claConsentPhrase).toBeNull();
    expect(m.gate.claCheckRunName).toBeNull();
    expect(m.warnings.some((w) => /gate\.cla\.consentPhrase/i.test(w))).toBe(true);
    expect(m.warnings.some((w) => /gate\.cla\.checkRunName/i.test(w))).toBe(true);
  });

  it("round-trips a full gate.claMode + gate.cla config through gateConfigToJson + parse (the cache path)", () => {
    const original = parseFocusManifest({ gate: { claMode: "advisory", cla: { consentPhrase: "agree to the CLA" } } });
    const reparsed = parseFocusManifest({ gate: gateConfigToJson(original.gate) });
    expect(reparsed.gate).toEqual(original.gate);
  });

  it("lets the DB value pass through when the manifest doesn't override it", () => {
    const db = { claGateMode: "advisory", claConsentPhrase: "agree to the CLA" } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest(null));
    expect(eff.claGateMode).toBe("advisory");
    expect(eff.claConsentPhrase).toBe("agree to the CLA");
  });
});

describe("gate.expectedCiContexts (#selfhost-ci-verification)", () => {
  it("parses a clean list, sets present, and preserves order", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["build", "test"] } });
    expect(m.gate.expectedCiContexts).toEqual(["build", "test"]);
    expect(m.gate.present).toBe(true);
  });

  it("trims whitespace from each entry", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["  build  ", "test"] } });
    expect(m.gate.expectedCiContexts).toEqual(["build", "test"]);
  });

  it("drops a non-string entry, keeps the valid ones, and warns naming the field", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["build", 42, "test"] as never } });
    expect(m.gate.expectedCiContexts).toEqual(["build", "test"]);
    expect(m.warnings.some((w) => w.includes("gate.expectedCiContexts") && /non-string entry/i.test(w))).toBe(true);
  });

  it("silently drops blank/whitespace-only entries with no warning (matches normalizeStringList's blank-skip branch)", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["build", "", "   "] } });
    expect(m.gate.expectedCiContexts).toEqual(["build"]);
    expect(m.warnings).toEqual([]);
  });

  it("is null when gate.expectedCiContexts is absent, and gate.present is not forced true by an otherwise-empty gate block", () => {
    const withEmptyGate = parseFocusManifest({ gate: {} });
    expect(withEmptyGate.gate.expectedCiContexts).toBeNull();
    expect(withEmptyGate.gate.present).toBe(false);

    const withNoGateKey = parseFocusManifest({});
    expect(withNoGateKey.gate.expectedCiContexts).toBeNull();
    expect(withNoGateKey.gate.present).toBe(false);
  });

  it("is null when gate.expectedCiContexts is explicitly null", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: null } });
    expect(m.gate.expectedCiContexts).toBeNull();
    expect(m.gate.present).toBe(false);
  });

  it("normalizes an entirely blank/invalid list back to null, not an empty array (normalizeOptionalStringList's empty-after-normalization branch)", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["", "   ", 123] as never } });
    expect(m.gate.expectedCiContexts).toBeNull();
    // Distinct from the "absent" case: this run DID produce warnings (the non-string 123 entry) even
    // though the final normalized value collapses to null just like the absent case does.
    expect(m.warnings.some((w) => w.includes("gate.expectedCiContexts"))).toBe(true);
  });

  it("warns and drops a non-array value (mirrors normalizeStringList's own non-array warning branch)", () => {
    const nonArrayString = parseFocusManifest({ gate: { expectedCiContexts: "build" as never } });
    expect(nonArrayString.gate.expectedCiContexts).toBeNull();
    expect(nonArrayString.warnings.some((w) => w.includes("gate.expectedCiContexts") && /must be a list/i.test(w))).toBe(true);

    const nonArrayObject = parseFocusManifest({ gate: { expectedCiContexts: { build: true } as never } });
    expect(nonArrayObject.gate.expectedCiContexts).toBeNull();
    expect(nonArrayObject.warnings.some((w) => w.includes("gate.expectedCiContexts") && /must be a list/i.test(w))).toBe(true);
  });

  it("round-trips a set expectedCiContexts through gateConfigToJson and back through parseFocusManifest", () => {
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["build", "lint"] } });
    const json = gateConfigToJson(m.gate);
    expect(json).toMatchObject({ expectedCiContexts: ["build", "lint"] });
    const round = parseFocusManifest({ gate: json });
    expect(round.gate.expectedCiContexts).toEqual(["build", "lint"]);
  });

  it("omits the expectedCiContexts key from gateConfigToJson output when unset", () => {
    const m = parseFocusManifest({ gate: { claMode: "block" } });
    expect(m.gate.expectedCiContexts).toBeNull();
    const json = gateConfigToJson(m.gate);
    expect(json).not.toBeNull();
    expect("expectedCiContexts" in (json as Record<string, unknown>)).toBe(false);
  });

  it("overlay wins over the DB value when the manifest sets expectedCiContexts", () => {
    const db = { expectedCiContexts: ["old"] } as unknown as RepositorySettings;
    const m = parseFocusManifest({ gate: { expectedCiContexts: ["new"] } });
    const eff = resolveEffectiveSettings(db, m);
    expect(eff.expectedCiContexts).toEqual(["new"]);
  });

  it("lets the DB value pass through when the manifest doesn't configure expectedCiContexts", () => {
    const db = { expectedCiContexts: ["from-db"] } as unknown as RepositorySettings;
    const eff = resolveEffectiveSettings(db, parseFocusManifest(null));
    expect(eff.expectedCiContexts).toEqual(["from-db"]);
  });

  it("is undefined when neither the DB nor the manifest sets expectedCiContexts (no DB column for this field)", () => {
    const eff = resolveEffectiveSettings({} as unknown as RepositorySettings, parseFocusManifest(null));
    expect(eff.expectedCiContexts).toBeUndefined();
  });
});

describe("formatManifestValidationNotice (#2056)", () => {
  it("returns null for an empty warnings array", () => {
    expect(formatManifestValidationNotice([])).toBeNull();
  });

  it("returns null when every warning is blank/whitespace-only", () => {
    expect(formatManifestValidationNotice(["", "   ", "\n"])).toBeNull();
  });

  it("formats a single warning as a bullet line", () => {
    expect(formatManifestValidationNotice(["Manifest field \"review.tone\" must be a string; ignoring it."])).toBe(
      "- Manifest field \"review.tone\" must be a string; ignoring it.",
    );
  });

  it("groups multiple distinct warnings, preserving order", () => {
    const result = formatManifestValidationNotice(["first warning", "second warning", "third warning"]);
    expect(result).toBe("- first warning\n- second warning\n- third warning");
  });

  it("dedupes identical warnings (case-sensitive, exact-match), keeping the first occurrence's position", () => {
    const result = formatManifestValidationNotice(["dup warning", "unique warning", "dup warning"]);
    expect(result).toBe("- dup warning\n- unique warning");
  });

  it("trims surrounding whitespace from each warning before formatting/deduping", () => {
    const result = formatManifestValidationNotice(["  padded warning  ", "padded warning"]);
    expect(result).toBe("- padded warning");
  });

  it("round-trips through a real malformed manifest's warnings", () => {
    const malformed = parseFocusManifest({ review: { tone: 42, profile: "loud" } });
    expect(malformed.warnings.length).toBeGreaterThan(0);
    const notice = formatManifestValidationNotice(malformed.warnings);
    expect(notice).not.toBeNull();
    expect(notice).toContain("- ");
  });

  it("returns null for a fully-valid manifest with zero warnings (byte-identical, no notice)", () => {
    const valid = parseFocusManifest({ review: { profile: "chill" } });
    expect(valid.warnings).toEqual([]);
    expect(formatManifestValidationNotice(valid.warnings)).toBeNull();
  });
});
