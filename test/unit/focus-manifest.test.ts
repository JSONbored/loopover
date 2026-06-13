import { describe, expect, it } from "vitest";
import {
  buildFocusManifestGuidance,
  compileFocusManifestPolicy,
  deriveContributionLanes,
  gateConfigToJson,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  parseFocusManifest,
  parseFocusManifestContent,
  resolveEffectiveSettings,
  reviewConfigToJson,
  settingsOverrideToJson,
  type FocusManifest,
} from "../../src/signals/focus-manifest";
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
    expect(manifest.blockedPaths).toContain("migrations/");
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
    expect(manifest.blockedPaths).toEqual(["dist/"]);
  });

  it("warns instead of throwing on malformed YAML", () => {
    const manifest = parseFocusManifestContent("wantedPaths: [unterminated", "repo_file");
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/not valid YAML/i);
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

  it("handles a manifest with only blockedPaths set", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ blockedPaths: ["infra/"] }), opts);
    expect(policy.present).toBe(true);
    expect(policy.publicSafe.readinessWarnings.join(" ")).toMatch(/blocked area|pair blocked/i);
  });

  it("emits a readiness warning when no wanted paths or preferred labels are declared", () => {
    const policy = compileFocusManifestPolicy(REPO, parseFocusManifest({ issueDiscoveryPolicy: "discouraged" }), opts);
    expect(policy.publicSafe.readinessWarnings.join(" ")).toMatch(/does not define wanted paths|contribution scope may be unclear/i);
  });

  it("emits a readiness warning when blocked paths exist but no wanted paths are declared", () => {
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
      blockedPaths: [],
      preferredLabels: [],
      linkedIssuePolicy: "optional",
      testExpectations: [],
      issueDiscoveryPolicy: "neutral",
      maintainerNotes: [],
      publicNotes: ["Keep PRs focused.", "Maximize your reward payout"],
      gate: { present: false, enabled: null, linkedIssue: null, duplicates: null, readinessMode: null, readinessMinScore: null },
      settings: {},
      review: { present: false, footerText: null, note: null, fields: {} },
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

describe("parseFocusManifest gate config", () => {
  it("parses a full gate section including the readiness block", () => {
    const m = parseFocusManifest({ gate: { linkedIssue: "block", duplicates: "advisory", readiness: { mode: "block", minScore: 70 } } });
    expect(m.present).toBe(true);
    expect(m.gate).toEqual({ present: true, enabled: null, linkedIssue: "block", duplicates: "advisory", readinessMode: "block", readinessMinScore: 70 });
  });

  it("parses gate.enabled (on/off) and ignores non-boolean values with a warning", () => {
    expect(parseFocusManifest({ gate: { enabled: true } }).gate.enabled).toBe(true);
    expect(parseFocusManifest({ gate: { enabled: false } }).gate.enabled).toBe(false);
    expect(parseFocusManifest({ gate: { enabled: true } }).gate.present).toBe(true);
    const bad = parseFocusManifest({ gate: { enabled: "yes" } });
    expect(bad.gate.enabled).toBeNull();
    expect(bad.warnings.some((w) => /gate\.enabled/.test(w))).toBe(true);
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

  it("clamps and rounds the readiness minScore to 0-100", () => {
    expect(parseFocusManifest({ gate: { readiness: { minScore: 250 } } }).gate.readinessMinScore).toBe(100);
    expect(parseFocusManifest({ gate: { readiness: { minScore: -10 } } }).gate.readinessMinScore).toBe(0);
    expect(parseFocusManifest({ gate: { readiness: { minScore: 59.6 } } }).gate.readinessMinScore).toBe(60);
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
    const m = parseFocusManifestContent("gate:\n  duplicates: block\n  readiness:\n    mode: block\n    minScore: 80\n", "repo_file");
    expect(m.gate.duplicates).toBe("block");
    expect(m.gate.readinessMode).toBe("block");
    expect(m.gate.readinessMinScore).toBe(80);
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
        privateTrustEnabled: true,
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
      privateTrustEnabled: true,
    });
  });

  it("drops invalid settings values with warnings and keeps the valid ones", () => {
    const m = parseFocusManifest({
      settings: { commentMode: "loud", qualityGateMinScore: "high", autoLabelEnabled: "yes", gittensorLabel: "   ", publicSurface: "comment_only" },
    });
    expect(m.settings).toEqual({ publicSurface: "comment_only" });
    expect(m.warnings.some((w) => /settings\.commentMode/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.qualityGateMinScore/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.autoLabelEnabled/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /settings\.gittensorLabel/.test(w))).toBe(true);
  });

  it("ignores a non-mapping settings block and treats a settings-only manifest as present", () => {
    expect(parseFocusManifest({ settings: ["nope"] }).warnings.some((w) => /"settings" must be a mapping/.test(w))).toBe(true);
    expect(parseFocusManifest({ settings: { commentMode: "off" } }).present).toBe(true);
  });

  it("round-trips settings through settingsOverrideToJson and serializes empty as null", () => {
    const original = parseFocusManifest({ settings: { commentMode: "all_prs", qualityGateMinScore: 40 } });
    const reparsed = parseFocusManifest({ settings: settingsOverrideToJson(original.settings) });
    expect(reparsed.settings).toEqual(original.settings);
    expect(settingsOverrideToJson(parseFocusManifest({}).settings)).toBeNull();
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
});
