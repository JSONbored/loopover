import { describe, expect, it } from "vitest";
import {
  buildFocusManifestGuidance,
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

  it("never leaks maintainer-private notes into public next steps", () => {
    const guidance = buildFocusManifestGuidance({ manifest: wanted, changedPaths: ["migrations/x.sql"] });
    expect(guidance.maintainerNotes.join(" ")).toMatch(/ping @owner/);
    expect(guidance.publicNextSteps.join(" ")).not.toMatch(/ping @owner/);
    expect(guidance.publicNextSteps.every(isFocusManifestPublicSafe)).toBe(true);
  });

  it("produces a neutral summary when no wanted paths are configured", () => {
    const manifest = parseFocusManifest({ preferredLabels: ["bug"] });
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["src/x.ts"], labels: ["bug"] });
    expect(guidance.summary).toMatch(/no path-specific verdict/i);
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
