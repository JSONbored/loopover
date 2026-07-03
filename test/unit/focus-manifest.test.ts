import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
  resolveEffectiveSettings,
  excludeReviewPaths,
  resolveReviewPathInstructions,
  resolveReviewPreMergeChecks,
  composeRepoReviewContext,
  resolveReviewPromptOverrides,
  reviewConfigToJson,
  settingsOverrideToJson,
  type FocusManifest,
} from "../../src/signals/focus-manifest";
import { DEFAULT_COMMAND_AUTHORIZATION_POLICY } from "../../src/settings/command-authorization";
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
      gate: { present: false, enabled: null, pack: null, linkedIssue: null, duplicates: null, readinessMode: null, readinessMinScore: null, slopMode: null, slopMinScore: null, slopAiAdvisory: null, sizeMode: null, lockfileIntegrityMode: null, aiReviewMode: null, aiReviewByok: null, aiReviewProvider: null, aiReviewModel: null, aiReviewAllAuthors: null, aiReviewCloseConfidence: null, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, mergeReadiness: null, selfAuthoredLinkedIssue: null, manifestPolicy: null, dryRun: null, firstTimeContributorGrace: null, premergeContentRecheck: null, requireFreshRebaseWindowMinutes: null },
      settings: {},
      review: { present: false, footerText: null, note: null, fields: {}, profile: null, securityFocus: null, inlineComments: null, pathInstructions: [], instructions: null, excludePaths: [], preMergeChecks: [] },
      features: { present: false, rag: null, reputation: null, unifiedComment: null, safety: null },
      contentLane: { present: false, entryFileGlob: null, providerFileGlob: null, artifactGlob: null, collectionField: null, maxAppendedEntries: null, duplicateKeyFields: [], validatorId: null },
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
    expect(m.gate).toEqual({ present: true, enabled: null, pack: null, linkedIssue: "block", duplicates: "advisory", readinessMode: "advisory", readinessMinScore: 70, slopMode: null, slopMinScore: null, slopAiAdvisory: null, sizeMode: null, lockfileIntegrityMode: null, aiReviewMode: null, aiReviewByok: null, aiReviewProvider: null, aiReviewModel: null, aiReviewAllAuthors: null, aiReviewCloseConfidence: null, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, mergeReadiness: null, selfAuthoredLinkedIssue: null, manifestPolicy: null, dryRun: null, firstTimeContributorGrace: null, premergeContentRecheck: null, requireFreshRebaseWindowMinutes: null });
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
    const original = parseFocusManifest({ settings: { commentMode: "all_prs", qualityGateMinScore: 40 } });
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
    // A cap is a discrete count, not a 0-100 score: fractional, non-positive, and non-numeric values are all
    // dropped with a warning rather than silently coerced or clamped into range.
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

  it("parses + resolves autoCloseExemptLogins from the settings: block, overlaying the DB (#2463)", () => {
    const manifest = parseFocusManifest({ settings: { autoCloseExemptLogins: ["Trusted-Regular", "another-one", "-bad", 42 as never] } });
    expect(manifest.settings.autoCloseExemptLogins).toEqual(["Trusted-Regular", "another-one"]); // invalid entries dropped
    const eff = resolveEffectiveSettings({ autoCloseExemptLogins: ["db-only"] } as unknown as RepositorySettings, manifest);
    expect(eff.autoCloseExemptLogins).toEqual(["Trusted-Regular", "another-one"]); // yml overlays (replaces) DB
    // An empty/all-invalid block never blanks the DB-configured list (only set when a valid entry survives).
    const noOverride = resolveEffectiveSettings({ autoCloseExemptLogins: ["keep-me"] } as unknown as RepositorySettings, parseFocusManifest({ settings: { autoCloseExemptLogins: ["-bad"] } }));
    expect(noOverride.autoCloseExemptLogins).toEqual(["keep-me"]);
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
    const manifest = parseFocusManifest({ review: { profile: "chill", security_focus: true, inline_comments: true, path_instructions: [{ path: "src/**", instructions: "be strict" }], instructions: "Follow our async-error conventions.", exclude_paths: ["**/*.lock"] } });
    expect(resolveReviewPromptOverrides(manifest)).toEqual({ profile: "chill", securityFocus: true, inlineComments: true, pathInstructions: [{ path: "src/**", instructions: "be strict" }], instructions: "Follow our async-error conventions.", excludePaths: ["**/*.lock"] });
    // A null manifest (load failure) yields the byte-identical defaults; inline comments + security focus default OFF.
    expect(resolveReviewPromptOverrides(null)).toEqual({ profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], instructions: null, excludePaths: [] });
    // An explicit false / absent toggle both resolve to the strict-boolean false.
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { inline_comments: false } })).inlineComments).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { profile: "chill" } })).inlineComments).toBe(false);
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
