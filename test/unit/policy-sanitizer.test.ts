import { describe, expect, it } from "vitest";
import { __controlPanelRolesInternals } from "../../src/services/control-panel-roles";
import {
  compileFocusManifestPolicy,
  deriveContributionLanes,
  isFocusManifestPublicSafe,
  parseFocusManifest,
} from "../../src/signals/focus-manifest";

const { sanitizeRoleText } = __controlPanelRolesInternals;

const FORBIDDEN_POLICY_PATTERN =
  /wallet|hotkey|coldkey|mnemonic|payout|reward estimate|raw trust|trust score|public score estimate|private reviewability|private scoreability|farming/i;

// ---------------------------------------------------------------------------
// sanitizeRoleText — path redaction
// ---------------------------------------------------------------------------

describe("sanitizeRoleText — path redaction", () => {
  it("redacts Unix user paths", () => {
    expect(sanitizeRoleText("/Users/alice/repo")).toBe("<redacted-path>");
    expect(sanitizeRoleText("/home/bob/.ssh/key")).toBe("<redacted-path>");
    expect(sanitizeRoleText("/tmp/workdir/secret")).toBe("<redacted-path>");
  });

  it("redacts Windows user paths", () => {
    expect(sanitizeRoleText("C:\\Users\\Alice\\Desktop\\file.txt")).toBe("<redacted-path>");
  });

  it("replaces embedded paths inline, not the whole string", () => {
    const result = sanitizeRoleText("see /home/alice/notes for context");
    expect(result).toContain("<redacted-path>");
    expect(result).not.toContain("/home/alice");
  });

  it("leaves safe paths unchanged", () => {
    expect(sanitizeRoleText("src/signals/focus-manifest.ts")).toBe("src/signals/focus-manifest.ts");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRoleText — token redaction
// ---------------------------------------------------------------------------

describe("sanitizeRoleText — token redaction", () => {
  it("redacts GitHub personal access tokens", () => {
    expect(sanitizeRoleText("token: ghp_abcdefghijklmno")).toContain("<redacted-token>");
    expect(sanitizeRoleText("token: github_pat_abcdefghij1234567890")).toContain("<redacted-token>");
  });

  it("redacts gts_ and glpat- tokens", () => {
    expect(sanitizeRoleText("gts_abcdefghijklmno")).toContain("<redacted-token>");
    expect(sanitizeRoleText("glpat-abcdefghijklmno")).toContain("<redacted-token>");
  });

  it("redacts Bearer authorization headers", () => {
    const result = sanitizeRoleText("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("<redacted-token>");
    expect(result).not.toMatch(/eyJhbGci/);
  });

  it("leaves short token-like strings that are too short to redact", () => {
    expect(sanitizeRoleText("ghp_short")).toBe("ghp_short");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRoleText — private term redaction
// ---------------------------------------------------------------------------

describe("sanitizeRoleText — private term redaction", () => {
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
});
