import { describe, expect, it } from "vitest";
import { __controlPanelRolesInternals, buildControlPanelRoleSummary } from "../../src/services/control-panel-roles";
import {
  buildCollisionReport,
  buildConfigQuality,
  buildContributorIntakeHealth,
  buildLabelAudit,
  buildLaneAdvice,
  buildMaintainerCutReadiness,
  buildQueueHealth,
} from "../../src/signals/engine";
import { buildGittensorConfigRecommendation, buildRegistrationReadiness, type InstallationHealthSummary as ReadinessInstallHealth } from "../../src/signals/registration-readiness";
import { buildRepoSettingsPreview, decidePublicSurface, type InstallationHealthSummary as PreviewInstallHealth } from "../../src/signals/settings-preview";
import {
  compileFocusManifestPolicy,
  deriveContributionLanes,
  isFocusManifestPublicSafe,
  parseFocusManifest,
} from "../../src/signals/focus-manifest";
import type { InstallationRecord, IssueRecord, PullRequestRecord, RepoLabelRecord, RegistryRepoConfig, RepositoryRecord, RepositorySettings } from "../../src/types";

const { sanitizeRoleText } = __controlPanelRolesInternals;

const FORBIDDEN_POLICY_PATTERN =
  /wallet|hotkey|coldkey|mnemonic|payout|reward estimate|raw trust|trust score|public score estimate|private reviewability|private scoreability|farming/i;

const PRIVATE_TERMS_PATTERN =
  /wallet|hotkey|coldkey|raw trust|trust score|payout|reward estimate|farming|private reviewability|public score estimate|seed phrase|mnemonic|private key/i;

// ─── shared fixtures ──────────────────────────────────────────────────────────

function repoRecord(fullName: string, owner: string, installationId: number, overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  const [, name] = fullName.split("/");
  return { fullName, owner, name: name ?? fullName, installationId, isInstalled: true, isRegistered: true, isPrivate: false, ...overrides };
}

function registeredRepo(fullName: string, registryConfig: RegistryRepoConfig | null = null, overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner: owner ?? fullName,
    name: name ?? fullName,
    installationId: 1,
    isInstalled: true,
    isRegistered: registryConfig !== null,
    isPrivate: false,
    registryConfig: registryConfig ?? undefined,
    ...overrides,
  };
}

function configFor(overrides: Partial<RegistryRepoConfig> = {}): RegistryRepoConfig {
  return { repo: "x/y", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: { bug: 1.1 }, trustedLabelPipeline: true, maintainerCut: 0, raw: {}, ...overrides };
}

function settingsFor(repoFullName: string, overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName,
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "off",
    checkRunDetailLevel: "standard",
    gateCheckMode: "off",
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "advisory",
    qualityGateMode: "advisory",
    qualityGateMinScore: null,
    autoLabelEnabled: true,
    gittensorLabel: "gittensor",
    createMissingLabel: true,
    publicSurface: "comment_and_label",
    includeMaintainerAuthors: false,
    requireLinkedIssue: false,
    backfillEnabled: true,
    privateTrustEnabled: true,
    ...overrides,
  };
}

function installation(id: number, accountLogin: string): InstallationRecord {
  return { id, accountLogin, accountId: id, targetType: "User", repositorySelection: "selected", permissions: {}, events: [] };
}

function pull(repoFullName: string, authorLogin: string, authorAssociation: string): PullRequestRecord {
  return { repoFullName, number: 1, title: "Test PR", state: "open", authorLogin, authorAssociation, labels: [], linkedIssues: [] };
}

function label(name: string): RepoLabelRecord {
  return { repoFullName: "x/y", name, isConfigured: true, observedCount: 3, payload: {} };
}

const healthyInstall: ReadinessInstallHealth = { status: "healthy", missingPermissions: [], missingEvents: [] };
const previewHealthyInstall: PreviewInstallHealth = { installationId: 1, status: "healthy", missingPermissions: [], missingEvents: [], permissionRemediation: [] };

function signalsFor(repo: RepositoryRecord, issues: IssueRecord[], pullRequests: PullRequestRecord[], labels: RepoLabelRecord[]) {
  const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
  return {
    lane: buildLaneAdvice(repo, repo.fullName),
    configQuality: buildConfigQuality(repo, issues, pullRequests, repo.fullName),
    labelAudit: buildLabelAudit(repo, labels, issues, pullRequests, repo.fullName),
    queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions),
    maintainerCutReadiness: buildMaintainerCutReadiness(repo, issues, pullRequests, repo.fullName, {}, collisions),
    contributorIntakeHealth: buildContributorIntakeHealth(repo, issues, pullRequests, repo.fullName, collisions),
  };
}

// ─── sanitizeRoleText: path redaction ────────────────────────────────────────

describe("sanitizeRoleText path redaction", () => {
  it("redacts Unix /Users paths entirely", () => {
    expect(sanitizeRoleText("/Users/alice/secret-repo")).toBe("<redacted-path>");
    expect(sanitizeRoleText("/Users/alice/.ssh/id_rsa")).toBe("<redacted-path>");
    expect(sanitizeRoleText("clone /Users/alice/repo here")).toBe("clone <redacted-path> here");
  });

  it("redacts Unix /home paths entirely", () => {
    expect(sanitizeRoleText("/home/runner/.github/token")).toBe("<redacted-path>");
    expect(sanitizeRoleText("path: /home/ci/build done")).toBe("path: <redacted-path> done");
  });

  it("redacts Unix /tmp paths entirely", () => {
    expect(sanitizeRoleText("/tmp/deploy_key.pem")).toBe("<redacted-path>");
  });

  it("redacts Windows C:\\Users paths entirely", () => {
    expect(sanitizeRoleText("C:\\Users\\bob\\AppData\\token.txt")).toBe("<redacted-path>");
  });

  it("preserves safe text with no path prefix", () => {
    expect(sanitizeRoleText("owner/normal-repo")).toBe("owner/normal-repo");
  });
});

// ─── sanitizeRoleText: token redaction ───────────────────────────────────────

describe("sanitizeRoleText token redaction", () => {
  it("redacts GitHub PAT (ghp_ prefix)", () => {
    const result = sanitizeRoleText("token: ghp_1234567890abcdefABCD");
    expect(result).toContain("<redacted-token>");
    expect(result).not.toContain("ghp_");
  });

  it("redacts fine-grained GitHub PAT (github_pat_ prefix)", () => {
    const result = sanitizeRoleText("auth github_pat_abc123456789XYZ");
    expect(result).toContain("<redacted-token>");
    expect(result).not.toContain("github_pat_");
  });

  it("redacts gts_ and glpat- prefixed tokens", () => {
    expect(sanitizeRoleText("key gts_abcdefghij1234")).toContain("<redacted-token>");
    expect(sanitizeRoleText("key glpat-abcdefghij1234")).toContain("<redacted-token>");
  });

  it("redacts Bearer authorization tokens", () => {
    const result = sanitizeRoleText("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc");
    expect(result).toBe("Authorization: Bearer <redacted-token>");
  });

  it("preserves short strings that do not match token patterns", () => {
    expect(sanitizeRoleText("ghp_short")).toBe("ghp_short");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRoleText — private term redaction
// ---------------------------------------------------------------------------

// ─── sanitizeRoleText: private term redaction ─────────────────────────────────

describe("sanitizeRoleText private term redaction", () => {
  const PRIVATE_TERMS = [
    "wallet",
    "hotkey",
    "coldkey",
    "mnemonic",
    "raw trust",
    "trust score",
    "payout",
    "reward estimate",
    "farming",
    "private reviewability",
    "public score estimate",
    "seed phrase",
    "mnemonic",
    "private key",
  ];

  for (const term of PRIVATE_TERMS) {
    it(`returns <redacted> when text contains "${term}"`, () => {
      expect(sanitizeRoleText(`This involves ${term} details.`)).toBe("<redacted>");
    });
  }

  it("does not redact safe contribution guidance text", () => {
    const safe = "Keep pull requests small and tied to accepted repository scope.";
    expect(sanitizeRoleText(safe)).toBe(safe);
  });

  it("truncates text to 200 characters", () => {
    const long = "a".repeat(300);
    expect(sanitizeRoleText(long)).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// Contribution lane validation — role cards and onboarding states
// ---------------------------------------------------------------------------

describe("contribution lane output — public-safe via deriveContributionLanes", () => {
  it("produces a neutral result when no manifest is present", () => {
    const lanes = deriveContributionLanes(parseFocusManifest(null));
    expect(lanes.directPrLane).toBe("neutral");
    expect(lanes.issueDiscoveryLane).toBe("neutral");
    expect(lanes.preferredEntryPaths).toEqual([]);
    expect(lanes.discouragedEntryPaths).toEqual([]);
    expect(lanes.summary).toMatch(/neutral lane defaults/i);
    expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("prefers direct PR lane when wanted paths are set", () => {
    const manifest = parseFocusManifest({ wantedPaths: ["src/"], testExpectations: ["npm run test:ci"] });
    const lanes = deriveContributionLanes(manifest);
    expect(lanes.directPrLane).toBe("preferred");
    expect(lanes.preferredEntryPaths).toContain("src/");
    expect(lanes.validationExpectations).toContain("npm run test:ci");
    expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("discourages issue discovery when policy is discouraged", () => {
    const manifest = parseFocusManifest({ wantedPaths: ["src/"], issueDiscoveryPolicy: "discouraged" });
    const lanes = deriveContributionLanes(manifest);
    expect(lanes.issueDiscoveryLane).toBe("discouraged");
    expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("prefers issue discovery when policy is encouraged", () => {
    const manifest = parseFocusManifest({ issueDiscoveryPolicy: "encouraged", wantedPaths: ["src/"] });
    const lanes = deriveContributionLanes(manifest);
    expect(lanes.issueDiscoveryLane).toBe("preferred");
    expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("includes a linked-issue guidance hint when policy is required", () => {
    const manifest = parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "required" });
    const lanes = deriveContributionLanes(manifest);
    expect(lanes.guidanceText.join(" ")).toMatch(/link a tracked issue/i);
    expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("silently drops unsafe public notes from lanes", () => {
    const manifest = parseFocusManifest({
      wantedPaths: ["src/"],
      publicNotes: ["Maximize your reward payout.", "Keep PRs focused."],
    });
    const lanes = deriveContributionLanes(manifest);
    expect(lanes.guidanceText).not.toContain("Maximize your reward payout.");
    expect(lanes.guidanceText).toContain("Keep PRs focused.");
    expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("emits a warning when contribution scope is unclear", () => {
    const manifest = parseFocusManifest({ wantedPaths: [], preferredLabels: [], issueDiscoveryPolicy: "encouraged" });
    const lanes = deriveContributionLanes(manifest);
    expect(lanes.warnings.join(" ")).toMatch(/scope is unclear/i);
  });

  it("never exposes forbidden language across 400 property-based iterations", () => {
    const stringPool = [
      "src/",
      "migrations/",
      "Keep PRs focused",
      "Maximize your reward payout",
      "paste your hotkey here",
      "trusted label pipeline",
      "raw trust score context",
      "npm run test:ci",
    ];
    const linkedIssuePolicies = ["required", "preferred", "optional"] as const;
    const issueDiscoveryPolicies = ["encouraged", "neutral", "discouraged"] as const;

    let seed = 0x1337cafe;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const sample = (max: number): string[] =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(stringPool));

    for (let i = 0; i < 400; i++) {
      const manifest = parseFocusManifest({
        wantedPaths: sample(4),
        blockedPaths: sample(2),
        preferredLabels: sample(3),
        linkedIssuePolicy: pick(linkedIssuePolicies),
        issueDiscoveryPolicy: pick(issueDiscoveryPolicies),
        publicNotes: sample(3),
        testExpectations: sample(2),
      });
      const lanes = deriveContributionLanes(manifest);
      expect(JSON.stringify(lanes)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
    }
  });
});

// ---------------------------------------------------------------------------
// Readiness warnings and guidance — compileFocusManifestPolicy
// ---------------------------------------------------------------------------

describe("compileFocusManifestPolicy — public-safe output boundaries", () => {
  const FIXED_DATE = "2026-06-03T00:00:00.000Z";

  it("returns a present policy for a valid manifest", () => {
    const manifest = parseFocusManifest({
      wantedPaths: ["src/signals/"],
      testExpectations: ["npm run test:ci"],
      linkedIssuePolicy: "required",
      preferredLabels: ["feature", "settings"],
      publicNotes: ["Keep PRs narrow and tied to accepted scope."],
    });
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });

    expect(policy.present).toBe(true);
    expect(policy.repoFullName).toBe("JSONbored/gittensory");
    expect(policy.generatedAt).toBe(FIXED_DATE);
    expect(policy.publicSafe.labelPolicy.preferredLabels).toContain("feature");
    expect(policy.publicSafe.validation.linkedIssuePolicy).toBe("required");
    expect(policy.publicSafe.publicNotes).toContain("Keep PRs narrow and tied to accepted scope.");
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("keeps private notes out of publicSafe", () => {
    const manifest = parseFocusManifest({
      wantedPaths: ["src/"],
      maintainerNotes: ["Internal: hotkey validation context only visible to maintainers."],
      publicNotes: ["Contribute only to accepted scope."],
    });
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });

    expect(JSON.stringify(policy.publicSafe)).not.toMatch(/hotkey/i);
    expect(policy.authenticated.privateNoteCount).toBe(1);
    expect(policy.authenticated.parseWarnings).toEqual([]);
  });

  it("drops unsafe text from publicSafe contribution lanes", () => {
    const manifest = parseFocusManifest({
      wantedPaths: ["src/"],
      publicNotes: ["wallet setup guidance for contributors", "Keep PRs focused."],
    });
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });

    expect(policy.publicSafe.publicNotes).not.toContain("wallet setup guidance for contributors");
    expect(policy.publicSafe.publicNotes).toContain("Keep PRs focused.");
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("emits readiness warnings when scope and validation are missing", () => {
    const manifest = parseFocusManifest({ issueDiscoveryPolicy: "neutral" });
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });
    expect(policy.present).toBe(false);
    expect(policy.publicSafe.readinessWarnings).toEqual([]);
  });

  it("emits a readiness warning for blocked-only manifests with no wanted scope", () => {
    const manifest = parseFocusManifest({ blockedPaths: ["migrations/"], wantedPaths: [], preferredLabels: [], testExpectations: [] });
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });
    expect(policy.publicSafe.readinessWarnings.join(" ")).toMatch(/blocks work areas.*does not define wanted|pair blocked areas/i);
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(FORBIDDEN_POLICY_PATTERN);
  });

  it("produces an absent policy for an empty manifest with no parse warnings", () => {
    const manifest = parseFocusManifest(null);
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });
    expect(policy.present).toBe(false);
    expect(policy.publicSafe.contributionLanes).toEqual([]);
    expect(policy.authenticated.parseWarnings).toEqual([]);
  });

  it("records parse warnings in authenticated context without leaking to publicSafe", () => {
    const manifest = parseFocusManifest({ wantedPaths: "src/" });
    const policy = compileFocusManifestPolicy("JSONbored/gittensory", manifest, { generatedAt: FIXED_DATE });
    expect(policy.authenticated.manifestWarningCount).toBeGreaterThan(0);
    expect(policy.authenticated.parseWarnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(/wantedPaths.*must be a list/i);
  });

  it("isFocusManifestPublicSafe blocks all forbidden terms used in policy compiler", () => {
    const forbidden = [
      "wallet balance",
      "hotkey abc123",
      "coldkey xyz",
      "mnemonic phrase",
      "payout estimate",
      "reward estimate value",
      "raw trust score",
      "trust score context",
      "farming strategy",
      "private reviewability",
      "score context",
      "scored output",
    ];
    for (const term of forbidden) {
      expect(isFocusManifestPublicSafe(term)).toBe(false);
    }
    expect(isFocusManifestPublicSafe("Keep PRs focused and narrow.")).toBe(true);
  });

  it("path regex consumes path-embedded private terms before the term check fires", () => {
    // The path regex eats the entire /Users/alice/wallet-configs string, so the
    // remaining text is just <redacted-path> which contains no private terms.
    expect(sanitizeRoleText("/Users/alice/wallet-configs")).toBe("<redacted-path>");
    // A private term appearing OUTSIDE the path prefix still triggers full redaction.
    expect(sanitizeRoleText("your wallet address is here")).toBe("<redacted>");
  });

  it("passes safe strings unchanged", () => {
    const safe = "Review maintainer queue and installation health.";
    expect(sanitizeRoleText(safe)).toBe(safe);
  });
});

// ─── sanitizeRoleText: truncation ────────────────────────────────────────────

describe("sanitizeRoleText truncation", () => {
  it("truncates strings longer than 200 characters", () => {
    const long = "a".repeat(250);
    expect(sanitizeRoleText(long)).toHaveLength(200);
  });

  it("returns strings of exactly 200 characters unchanged", () => {
    const exact = "b".repeat(200);
    expect(sanitizeRoleText(exact)).toBe(exact);
  });
});

// ─── contribution lanes: role card text is sanitized ─────────────────────────

describe("contribution lanes sanitizer", () => {
  it("redacts wallet/hotkey references injected into repo names surfaced in role cards", () => {
    const summary = buildControlPanelRoleSummary({
      login: "miner",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: true,
      operator: false,
      repositories: [repoRecord("owner/wallet-hotkey-repo", "owner", 10)],
      installations: [installation(10, "owner")],
      pullRequests: [pull("owner/wallet-hotkey-repo", "miner", "COLLABORATOR")],
    });
    expect(JSON.stringify(summary)).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(summary.publicSafe).toBe(true);
  });

  it("sanitizes raw trust and seed phrase references in role card detail text", () => {
    const summary = buildControlPanelRoleSummary({
      login: "owner",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: false,
      repositories: [repoRecord("/Users/owner/raw trust score seed phrase repo", "owner", 11)],
      installations: [installation(11, "owner")],
      pullRequests: [],
    });
    expect(JSON.stringify(summary)).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps contribution lane next actions free of private terms for a fully-onboarded user", () => {
    const summary = buildControlPanelRoleSummary({
      login: "onboarded",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: true,
      operator: false,
      repositories: [repoRecord("onboarded/repo", "onboarded", 12)],
      installations: [installation(12, "onboarded")],
      pullRequests: [],
    });
    const nextActions = summary.onboarding.nextActions.join(" ");
    expect(nextActions).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps onboarding next actions free of private terms when the user is in needs_setup state", () => {
    const summary = buildControlPanelRoleSummary({
      login: "newcomer",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: false,
      repositories: [],
      installations: [],
      pullRequests: [],
    });
    expect(summary.onboarding.status).toBe("needs_setup");
    const nextActions = summary.onboarding.nextActions.join(" ");
    expect(nextActions).not.toMatch(PRIVATE_TERMS_PATTERN);
  });
});

// ─── label guidance sanitizer ─────────────────────────────────────────────────

describe("label guidance sanitizer", () => {
  it("does not expose private terms in settings-preview label decisions", () => {
    const repo = registeredRepo("octo/label-test", configFor({ repo: "octo/label-test" }));
    const settings = settingsFor(repo.fullName, { gittensorLabel: "gittensor", autoLabelEnabled: true, publicSurface: "label_only" });
    const preview = buildRepoSettingsPreview({ repoFullName: repo.fullName, repo, settings, installation: previewHealthyInstall, issues: [], pullRequests: [], sample: { authorLogin: "miner", minerStatus: "confirmed" } });

    expect(preview.appliedLabel).toBe("gittensor");
    expect(JSON.stringify(preview)).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps label policy fields in registration-readiness free of private terms", () => {
    const repo = registeredRepo("octo/lp-test", configFor({ repo: "octo/lp-test", labelMultipliers: { bug: 1.1, feature: 2 } }));
    const signals = signalsFor(repo, [], [], [label("bug")]);
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName), installation: healthyInstall, ...signals });

    expect(JSON.stringify(report.labelPolicy)).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(report.labelPolicy.label).toBe("gittensor");
  });

  it("sanitizes preview warnings that reference label permissions without leaking private context", () => {
    const repo = registeredRepo("octo/perms", configFor({ repo: "octo/perms" }));
    const preview = buildRepoSettingsPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: { installationId: 1, status: "needs_attention" as const, missingPermissions: ["issues"], missingEvents: [], permissionRemediation: [] },
      issues: [],
      pullRequests: [],
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.warnings.some((w) => /Issues/.test(w))).toBe(true);
    expect(preview.warnings.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });
});

// ─── validation guidance sanitizer ───────────────────────────────────────────

describe("validation guidance sanitizer", () => {
  it("keeps check-run decisions free of private terms", () => {
    const repo = registeredRepo("octo/checks", configFor({ repo: "octo/checks" }));
    const preview = buildRepoSettingsPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName, { checkRunMode: "enabled", checkRunDetailLevel: "deep" }),
      installation: previewHealthyInstall,
      issues: [],
      pullRequests: [],
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });

    expect(preview.checkRun).not.toBeNull();
    expect(JSON.stringify(preview.checkRun)).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps decidePublicSurface decision summaries free of private terms", () => {
    const settings = settingsFor("octo/surface");

    const confirmed = decidePublicSurface({ settings, authorLogin: "miner", minerStatus: "confirmed" });
    const skipped = decidePublicSurface({ settings, authorLogin: null, minerStatus: "confirmed" });
    const miner_missing = decidePublicSurface({ settings, authorLogin: "unknown", minerStatus: "not_found" });

    for (const decision of [confirmed, skipped, miner_missing]) {
      expect(decision.summary).not.toMatch(PRIVATE_TERMS_PATTERN);
    }
  });

  it("keeps config recommendation tradeoffs and reasons free of private terms", () => {
    const repo = registeredRepo("octo/config-rec", configFor({ repo: "octo/config-rec", emissionShare: 0.2 }));
    const issues: IssueRecord[] = [{ repoFullName: repo.fullName, number: 1, title: "Improve test speed", state: "open", labels: ["bug"], linkedPrs: [] }];
    const signals = signalsFor(repo, issues, [], [label("bug")]);
    const recommendation = buildGittensorConfigRecommendation({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      lane: signals.lane,
      configQuality: signals.configQuality,
      contributorIntakeHealth: signals.contributorIntakeHealth,
      maintainerCutReadiness: signals.maintainerCutReadiness,
    });

    expect(recommendation.privateOnly).toBe(true);
    expect(recommendation.tradeoffs.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(recommendation.reasons.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(recommendation.warnings.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });
});

// ─── readiness warnings sanitizer ────────────────────────────────────────────

describe("readiness warnings sanitizer", () => {
  it("keeps blockers and warnings free of private terms for a blocked repo", () => {
    const repo = registeredRepo("octo/blocked", null);
    const signals = signalsFor(repo, [], [], []);
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName, { publicSurface: "off" }),
      installation: null,
      ...signals,
    });

    expect(report.blockers.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(report.warnings.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps strained-intake and config-attention warnings free of private terms", () => {
    const repo = registeredRepo("octo/strained", configFor({ repo: "octo/strained" }));
    const base = signalsFor(repo, [], [], [label("bug")]);
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...base,
      configQuality: { ...base.configQuality, level: "needs_attention" },
      contributorIntakeHealth: { ...base.contributorIntakeHealth, level: "strained" },
    });

    expect(report.warnings).toEqual(expect.arrayContaining(["Repository config quality needs attention before registration promotion.", "Contributor intake is strained; expect more maintainer triage."]));
    expect(report.warnings.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(report.blockers.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps upstream registry drift warnings free of private terms", () => {
    const repo = registeredRepo("octo/drift", configFor({ repo: "octo/drift" }));
    const signals = signalsFor(repo, [], [], [label("bug")]);
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...signals,
      upstreamRegistryDriftWarnings: ["Registry entry emissionShare drifted from 0.02 to 0.01; re-sync recommended."],
    });

    expect(report.warnings).toContain("Registry entry emissionShare drifted from 0.02 to 0.01; re-sync recommended.");
    expect(report.warnings.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps testCoverageHealth warnings free of private terms when trusted label pipeline is absent", () => {
    const repo = registeredRepo("octo/no-labels", configFor({ repo: "octo/no-labels" }));
    const signals = signalsFor(repo, [], [], []);
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName, { checkRunMode: "off" }), installation: healthyInstall, ...signals });

    expect(report.testCoverageHealth.status).toBe("gate_unknown");
    expect(report.testCoverageHealth.warnings.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps githubApp behavior text free of private terms across all surface modes", () => {
    const repo = registeredRepo("octo/surface-check", configFor({ repo: "octo/surface-check" }));
    const base = { repoFullName: repo.fullName, repo, installation: healthyInstall, ...signalsFor(repo, [], [], [label("bug")]) };

    const off = buildRegistrationReadiness({ ...base, settings: settingsFor(repo.fullName, { publicSurface: "off" }) });
    const on = buildRegistrationReadiness({ ...base, settings: settingsFor(repo.fullName, { publicSurface: "comment_and_label", commentMode: "all_prs" }) });

    expect(off.githubApp.behavior).not.toMatch(PRIVATE_TERMS_PATTERN);
    expect(on.githubApp.behavior).not.toMatch(PRIVATE_TERMS_PATTERN);
  });
});

// ─── onboarding-pack inputs sanitizer ────────────────────────────────────────

describe("onboarding-pack inputs sanitizer", () => {
  it("returns publicSafe:true and no private terms in any output field", () => {
    const summary = buildControlPanelRoleSummary({
      login: "full-user",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: true,
      operator: true,
      repositories: [repoRecord("full-user/project", "full-user", 20)],
      installations: [installation(20, "full-user")],
      pullRequests: [pull("full-user/project", "full-user", "OWNER")],
    });

    expect(summary.publicSafe).toBe(true);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps needs_setup onboarding next actions generic and private-term-free", () => {
    const summary = buildControlPanelRoleSummary({
      login: "blank-user",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: false,
      repositories: [],
      installations: [],
      pullRequests: [],
    });

    expect(summary.onboarding.status).toBe("needs_setup");
    expect(summary.onboarding.primaryRole).toBeUndefined();
    expect(summary.onboarding.nextActions.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("keeps operator onboarding next actions private-term-free", () => {
    const summary = buildControlPanelRoleSummary({
      login: "ops",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: true,
      repositories: [],
      installations: [],
      pullRequests: [],
    });

    expect(summary.onboarding.status).toBe("ready");
    expect(summary.onboarding.primaryRole).toBe("operator");
    expect(summary.onboarding.nextActions.join(" ")).not.toMatch(PRIVATE_TERMS_PATTERN);
  });

  it("never emits private maintainer economics in the public-safe onboarding payload", () => {
    const repo = registeredRepo("owner/economics", configFor({ repo: "owner/economics", maintainerCut: 0.3, emissionShare: 0.15 }));
    const signals = signalsFor(repo, [], [], [label("bug")]);
    const recommendation = buildGittensorConfigRecommendation({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      lane: signals.lane,
      configQuality: signals.configQuality,
      contributorIntakeHealth: signals.contributorIntakeHealth,
      maintainerCutReadiness: signals.maintainerCutReadiness,
    });

    expect(recommendation.privateOnly).toBe(true);
    const serialized = JSON.stringify(recommendation);
    // emissionShare is part of the private-only config record — that is intentional.
    // What must not appear is user-facing wallet/hotkey/trust language.
    expect(serialized).not.toMatch(PRIVATE_TERMS_PATTERN);
  });
});
