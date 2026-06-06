import { describe, expect, it } from "vitest";
import {
  buildFocusManifestGuidance,
  compileFocusManifestPolicy,
  deriveContributionLanes,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  parseFocusManifest,
  parseFocusManifestContent,
  type FocusManifest,
} from "../../src/signals/focus-manifest";

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
      blockedPaths: ["migrations/", "infra/secrets.tf"],
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
    expect(manifest.blockedPaths).toEqual(["ok"]);
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
    expect(manifest.blockedPaths).toContain("migrations/");
  });

  it("warns instead of throwing on malformed JSON", () => {
    const manifest = parseFocusManifestContent("{ not: valid json");
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/not valid JSON/i);
  });

  it("warns when JSON content is not a mapping", () => {
    for (const content of ['["a","b"]', '"string"']) {
      const manifest = parseFocusManifestContent(content);
      expect(manifest.present).toBe(false);
      expect(manifest.warnings.join(" ")).toMatch(/must be a mapping/i);
    }
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

  it("flags a critical blocked-path finding and public next step", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["migrations/0099_x.sql"] });
    const blocked = guidance.findings.find((finding) => finding.code === "manifest_blocked_path");
    expect(blocked?.severity).toBe("critical");
    expect(guidance.matchedBlockedPaths).toEqual(["migrations/"]);
    expect(guidance.publicNextSteps.join(" ")).toMatch(/maintainer-blocked/i);
    expect(guidance.summary).toMatch(/blocked area/i);
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

  it("prefers a linked issue under the preferred policy", () => {
    const manifest = parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" });
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["src/x.ts"], linkedIssueCount: 0, testFileCount: 1 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_linked_issue_preferred")).toBe(true);
  });

  it("surfaces missing preferred labels and test expectations", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["src/x.ts"], labels: [], linkedIssueCount: 1, testFileCount: 0, passedValidationCount: 0 });
    expect(guidance.findings.some((finding) => finding.code === "manifest_missing_preferred_label")).toBe(true);
    expect(guidance.findings.some((finding) => finding.code === "manifest_missing_tests")).toBe(true);
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
  // ── Minimal: absent manifest ───────────────────────────────────────────
  it("returns unconstrained policy with neutral lanes for an absent manifest", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifest(null));
    expect(policy.present).toBe(false);
    expect(policy.source).toBe("none");
    expect(policy.publicSafe.contributionLanes).toEqual({ directPrLane: "neutral", issueDiscoveryLane: "neutral", preferredEntryPaths: [] });
    expect(policy.publicSafe.discouragedWork).toEqual({ blockedEntryPaths: [], issueDiscoveryDiscouraged: false });
    expect(policy.publicSafe.labelExpectations).toEqual({ preferredLabels: [], linkedIssuePolicy: "optional" });
    expect(policy.publicSafe.validationExpectations).toEqual({ testExpectations: [], linkedIssueRequired: false, linkedIssuePreferred: false });
    expect(policy.publicSafe.entryGuidance).toEqual([]);
    expect(policy.publicSafe.summary).toMatch(/unconstrained/i);
    expect(policy.authenticated.readinessWarnings.length).toBeGreaterThan(0);
  });

  it("forwards parse warnings into authenticated.readinessWarnings for a malformed manifest", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifestContent("{ broken json"));
    expect(policy.present).toBe(false);
    expect(policy.authenticated.parseWarnings.join(" ")).toMatch(/not valid JSON/i);
    expect(policy.authenticated.readinessWarnings.length).toBeGreaterThan(0);
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
    const policy = compileFocusManifestPolicy(manifest);

    expect(policy.present).toBe(true);
    expect(policy.source).toBe("repo_file");

    // contribution lanes
    expect(policy.publicSafe.contributionLanes.directPrLane).toBe("preferred");
    expect(policy.publicSafe.contributionLanes.issueDiscoveryLane).toBe("discouraged");
    expect(policy.publicSafe.contributionLanes.preferredEntryPaths).toContain("src/");

    // discouraged work
    expect(policy.publicSafe.discouragedWork.blockedEntryPaths).toContain("migrations/");
    expect(policy.publicSafe.discouragedWork.issueDiscoveryDiscouraged).toBe(true);

    // label expectations
    expect(policy.publicSafe.labelExpectations.preferredLabels).toContain("bug");
    expect(policy.publicSafe.labelExpectations.linkedIssuePolicy).toBe("required");

    // validation expectations
    expect(policy.publicSafe.validationExpectations.testExpectations).toContain("unit tests for new branches");
    expect(policy.publicSafe.validationExpectations.linkedIssueRequired).toBe(true);
    expect(policy.publicSafe.validationExpectations.linkedIssuePreferred).toBe(false);

    // entry guidance
    expect(policy.publicSafe.entryGuidance.join(" ")).toMatch(/src\/|bug|linked issue/i);
    expect(policy.publicSafe.entryGuidance).toContain("Prefer small, focused PRs.");

    // summary
    expect(policy.publicSafe.summary).toMatch(/wanted areas|preferred/i);

    // authenticated: maintainerNotes present and not in publicSafe
    expect(policy.authenticated.maintainerContext).toContain("Internal: ping @owner before the queue processor.");
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(/ping @owner/);
  });

  // ── Missing-field: partial manifest ───────────────────────────────────
  it("handles a partial manifest with only linkedIssuePolicy set", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" }));
    expect(policy.present).toBe(true);
    expect(policy.publicSafe.contributionLanes.directPrLane).toBe("preferred");
    expect(policy.publicSafe.labelExpectations.linkedIssuePolicy).toBe("preferred");
    expect(policy.publicSafe.validationExpectations.linkedIssueRequired).toBe(false);
    expect(policy.publicSafe.validationExpectations.linkedIssuePreferred).toBe(true);
    expect(policy.publicSafe.discouragedWork.blockedEntryPaths).toEqual([]);
    expect(policy.publicSafe.discouragedWork.issueDiscoveryDiscouraged).toBe(false);
    expect(policy.authenticated.maintainerContext).toEqual([]);
  });

  it("handles a manifest with only issueDiscoveryPolicy:encouraged", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifest({ issueDiscoveryPolicy: "encouraged" }));
    expect(policy.present).toBe(true);
    expect(policy.publicSafe.contributionLanes.directPrLane).toBe("discouraged");
    expect(policy.publicSafe.contributionLanes.issueDiscoveryLane).toBe("preferred");
    expect(policy.publicSafe.discouragedWork.issueDiscoveryDiscouraged).toBe(false);
    expect(policy.publicSafe.summary).toMatch(/issue.discovery is the preferred/i);
    expect(policy.publicSafe.entryGuidance.join(" ")).toMatch(/welcomed|search for gaps/i);
  });

  it("handles a manifest with only blockedPaths set", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifest({ blockedPaths: ["infra/"] }));
    expect(policy.present).toBe(true);
    expect(policy.publicSafe.discouragedWork.blockedEntryPaths).toContain("infra/");
    expect(policy.publicSafe.contributionLanes.directPrLane).toBe("neutral");
    expect(policy.authenticated.readinessWarnings.join(" ")).toMatch(/blocked area/i);
  });

  it("emits a readiness warning when issue discovery is discouraged but no wanted paths are declared", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifest({ issueDiscoveryPolicy: "discouraged" }));
    expect(policy.authenticated.readinessWarnings.join(" ")).toMatch(/limited guidance/i);
  });

  it("emits a readiness warning when linked issues are required but no labels or wanted paths guide contributors", () => {
    const policy = compileFocusManifestPolicy(parseFocusManifest({ linkedIssuePolicy: "required" }));
    expect(policy.authenticated.readinessWarnings.join(" ")).toMatch(/linked issues are required/i);
  });

  // ── Public/private separation ──────────────────────────────────────────
  it("keeps maintainerContext out of publicSafe entirely", () => {
    const policy = compileFocusManifestPolicy(
      parseFocusManifest({ wantedPaths: ["src/"], maintainerNotes: ["Private queue note.", "Ping @owner privately."] }),
    );
    expect(policy.authenticated.maintainerContext).toEqual(["Private queue note.", "Ping @owner privately."]);
    expect(JSON.stringify(policy.publicSafe)).not.toMatch(/Private queue note|Ping @owner/);
  });

  it("excludes forbidden language from all publicSafe fields even when injected via publicNotes or testExpectations", () => {
    const policy = compileFocusManifestPolicy(
      parseFocusManifest({
        wantedPaths: ["src/"],
        publicNotes: ["Maximize your reward payout", "Keep PRs focused."],
        testExpectations: ["Submit wallet seed phrase proof", "npm run test:ci"],
      }),
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
      blockedPaths: [],
      preferredLabels: [],
      linkedIssuePolicy: "optional",
      testExpectations: [],
      issueDiscoveryPolicy: "neutral",
      maintainerNotes: [],
      publicNotes: ["Keep PRs focused.", "Maximize your reward payout"],
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
    expect(compileFocusManifestPolicy(parseFocusManifest({ wantedPaths: ["src/"] }, "repo_file")).source).toBe("repo_file");
    expect(compileFocusManifestPolicy(parseFocusManifest({ wantedPaths: ["src/"] }, "api_record")).source).toBe("api_record");
    expect(compileFocusManifestPolicy(parseFocusManifest(null)).source).toBe("none");
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
      const policy = compileFocusManifestPolicy(manifest);
      const allPublicText = [
        ...policy.publicSafe.contributionLanes.preferredEntryPaths,
        ...policy.publicSafe.discouragedWork.blockedEntryPaths,
        ...policy.publicSafe.labelExpectations.preferredLabels,
        ...policy.publicSafe.validationExpectations.testExpectations,
        ...policy.publicSafe.entryGuidance,
        policy.publicSafe.summary,
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

  it("includes blocked paths in discouragedEntryPaths and PR entry guidance", () => {
    const lanes = deriveContributionLanes(parseFocusManifest({ wantedPaths: ["src/"], blockedPaths: ["migrations/", "infra/secrets.tf"] }));
    expect(lanes.discouragedEntryPaths).toEqual(["migrations/", "infra/secrets.tf"]);
    expect(lanes.prEntryGuidance.join(" ")).toMatch(/migrations\/.*infra\/secrets\.tf|infra\/secrets\.tf.*migrations\//);
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
    expect(lanes.discouragedEntryPaths).toContain("migrations/");
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
