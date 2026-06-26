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
  excludeReviewPaths,
  resolveReviewPathInstructions,
  resolveReviewPreMergeChecks,
  resolveReviewPromptOverrides,
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

  it("**/ matches at the repo ROOT too (zero-depth), not only nested files (#review-audit)", () => {
    expect(matchesManifestPath("app.test.ts", "**/*.test.ts")).toBe(true); // root-level (was a bug: required a slash)
    expect(matchesManifestPath("dir/app.test.ts", "**/*.test.ts")).toBe(true); // nested still matches
    expect(matchesManifestPath("foo", "**/foo")).toBe(true);
    expect(matchesManifestPath("a/b/foo", "**/foo")).toBe(true);
    expect(matchesManifestPath("a/b/c.ts", "**/*.ts")).toBe(true);
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
      gate: { present: false, enabled: null, pack: null, linkedIssue: null, duplicates: null, readinessMode: null, readinessMinScore: null, slopMode: null, slopMinScore: null, slopAiAdvisory: null, aiReviewMode: null, aiReviewByok: null, aiReviewProvider: null, aiReviewModel: null, mergeReadiness: null, selfAuthoredLinkedIssue: null, manifestPolicy: null, firstTimeContributorGrace: null },
      settings: {},
      review: { present: false, footerText: null, note: null, fields: {}, profile: null, pathInstructions: [], excludePaths: [], preMergeChecks: [] },
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
    expect(m.gate).toEqual({ present: true, enabled: null, pack: null, linkedIssue: "block", duplicates: "advisory", readinessMode: "block", readinessMinScore: 70, slopMode: null, slopMinScore: null, slopAiAdvisory: null, aiReviewMode: null, aiReviewByok: null, aiReviewProvider: null, aiReviewModel: null, mergeReadiness: null, selfAuthoredLinkedIssue: null, manifestPolicy: null, firstTimeContributorGrace: null });
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
    const manifest = parseFocusManifest({ review: { profile: "chill", path_instructions: [{ path: "src/**", instructions: "be strict" }], exclude_paths: ["**/*.lock"] } });
    expect(resolveReviewPromptOverrides(manifest)).toEqual({ profile: "chill", pathInstructions: [{ path: "src/**", instructions: "be strict" }], excludePaths: ["**/*.lock"] });
    // A null manifest (load failure) yields the byte-identical defaults.
    expect(resolveReviewPromptOverrides(null)).toEqual({ profile: null, pathInstructions: [], excludePaths: [] });
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
    // `*` collapses to `.*` (crosses slashes), so `*.yaml` matches a top-level lockfile; `dist/**` matches under dist/.
    expect(excludeReviewPaths(files, ["*.yaml", "dist/**"])).toEqual([{ path: "src/a.ts" }]);
    expect(excludeReviewPaths(files, ["docs/**"])).toEqual(files); // no match → unchanged
    expect(excludeReviewPaths(files, [])).toBe(files); // empty → same reference (no-op)
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
