import { describe, expect, it } from "vitest";
import { buildPublicPrBodyDraft, EXCLUDED_PRIVATE_PR_BODY_FIELDS, type PrBodyDraftSource } from "../../src/services/pr-body-draft";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /\b(wallet|hotkey|coldkey|mnemonic|raw trust score|raw[-_\s]?trust|trust score|payout|reward estimate|reward|farming|private reviewability|reviewability|public score estimate|scoreability|ranking)\b|\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\Users\\/i;

function source(overrides: Partial<PrBodyDraftSource> = {}): PrBodyDraftSource {
  return {
    repoFullName: "octo/demo",
    prPacket: {
      titleSuggestion: "Fix cache refresh race",
      markdown: "# Fix cache refresh race\n",
      bodySections: [
        { heading: "Changed Paths", lines: ["- src/cache.ts (modified, +12/-3)", "- src/cache.test.ts (added, +20/-0)"] },
      ],
      reviewerNotes: [],
      validationSummary: {
        passed: 1,
        failed: 0,
        notRun: 0,
        commands: [{ command: "npm run test:ci", status: "passed", summary: "all green" }],
      },
      publicSafeWarnings: [],
      ...overrides.prPacket,
    },
    baseFreshness: {
      status: "fresh",
      changedFileCount: 2,
      testFileCount: 1,
      passedValidationCount: 1,
      warnings: [],
      recommendation: undefined,
      ...overrides.baseFreshness,
    },
    manifestGuidance: {
      present: false,
      source: "none",
      linkedIssuePolicy: "optional",
      issueDiscoveryPolicy: "neutral",
      matchedWantedPaths: [],
      matchedBlockedPaths: [],
      preferredLabelHits: [],
      findings: [],
      publicNextSteps: [],
      warnings: [],
      summary: "",
      ...overrides.manifestGuidance,
    },
    preflight: {
      linkedIssues: [42],
      collisions: [],
      reviewBurden: "low",
      ...overrides.preflight,
    },
    ...overrides,
  };
}

function headings(draft: ReturnType<typeof buildPublicPrBodyDraft>): string[] {
  return draft.sections.map((section) => section.heading);
}

function section(draft: ReturnType<typeof buildPublicPrBodyDraft>, heading: string): string[] {
  return draft.sections.find((s) => s.heading === heading)?.lines ?? [];
}

// ── Clean branch ────────────────────────────────────────────────────────────

describe("buildPublicPrBodyDraft — clean branch", () => {
  it("produces a concise, useful draft with all expected sections and a metadata-only guard", () => {
    const draft = buildPublicPrBodyDraft(source());
    expect(draft.title).toBe("Fix cache refresh race");
    expect(headings(draft)).toEqual(["Summary", "Changed files", "Tests run", "Linked issue", "Duplicate / WIP check", "Branch freshness", "Next steps"]);
    expect(section(draft, "Changed files").join(" ")).toMatch(/2 file\(s\) changed, including 1 test file\(s\)/);
    expect(section(draft, "Tests run").join(" ")).toMatch(/1 passed/);
    expect(section(draft, "Linked issue")).toContain("Closes #42");
    expect(draft.caveats).toEqual([]);
    expect(draft.sourceUploadDisabled).toBe(true);
    expect(section(draft, "Next steps").join(" ")).toMatch(/source upload disabled/i);
    expect(draft.markdown).toContain("# Fix cache refresh race");
    expect(draft.markdown).toContain("## Changed files");
  });

  it("falls back to a default title when none is suggested", () => {
    const draft = buildPublicPrBodyDraft(source({ prPacket: { ...source().prPacket, titleSuggestion: "" } }));
    expect(draft.title).toBe("Describe this change");
  });
});

// ── Missing tests ───────────────────────────────────────────────────────────

describe("buildPublicPrBodyDraft — missing tests", () => {
  it("emits a public-safe caveat when no tests were recorded", () => {
    const draft = buildPublicPrBodyDraft(
      source({ prPacket: { ...source().prPacket, validationSummary: { passed: 0, failed: 0, notRun: 0, commands: [] } } }),
    );
    expect(section(draft, "Tests run").join(" ")).toMatch(/No automated tests were recorded/i);
    expect(draft.caveats.join(" ")).toMatch(/No test evidence was supplied/i);
  });

  it("treats only not_run/skipped commands as missing tests", () => {
    const draft = buildPublicPrBodyDraft(
      source({ prPacket: { ...source().prPacket, validationSummary: { passed: 0, failed: 0, notRun: 1, commands: [{ command: "npm test", status: "not_run" }] } } }),
    );
    expect(section(draft, "Tests run").join(" ")).toMatch(/No automated tests were recorded/i);
  });
});

// ── Duplicate / WIP risk ────────────────────────────────────────────────────

describe("buildPublicPrBodyDraft — duplicate risk", () => {
  it("phrases overlap as hygiene, never as an accusation", () => {
    const draft = buildPublicPrBodyDraft(
      source({
        preflight: {
          linkedIssues: [],
          reviewBurden: "medium",
          collisions: [{ id: "c1", risk: "medium", reason: "shared files", items: [{ type: "pull_request", number: 12, title: "Other work" }] }],
        },
      }),
    );
    const text = section(draft, "Duplicate / WIP check").join(" ");
    expect(text).toMatch(/possible overlap with existing work/i);
    expect(text).toMatch(/double-check PR #12 before review to avoid duplicate effort/i);
    expect(text).not.toMatch(/\b(stole|stolen|copied|plagiar|you (?:copied|took))\b/i);
    expect(draft.caveats.join(" ")).toMatch(/confirm this is not a duplicate/i);
  });

  it("reports no overlap when there are no collisions", () => {
    const draft = buildPublicPrBodyDraft(source());
    expect(section(draft, "Duplicate / WIP check").join(" ")).toMatch(/No overlapping open work was detected/i);
  });
});

// ── Stale base ──────────────────────────────────────────────────────────────

describe("buildPublicPrBodyDraft — stale base", () => {
  it("flags a stale base branch as a public-safe caveat", () => {
    const draft = buildPublicPrBodyDraft(
      source({ baseFreshness: { ...source().baseFreshness, status: "stale", warnings: ["Base branch advanced since this branch was cut."], recommendation: "Rebase onto the latest base." } }),
    );
    expect(section(draft, "Branch freshness").join(" ")).toMatch(/base freshness: stale/i);
    expect(draft.caveats.join(" ")).toMatch(/Base branch may be stale/i);
  });
});

// ── Source-upload guard ─────────────────────────────────────────────────────

describe("buildPublicPrBodyDraft — source-upload guard", () => {
  it("always marks source upload disabled and never leaks local paths", () => {
    const draft = buildPublicPrBodyDraft(
      source({
        prPacket: {
          ...source().prPacket,
          bodySections: [{ heading: "Changed Paths", lines: ["- /Users/dev/secret/file.ts (modified, +1/-0)", "- src/ok.ts (modified, +1/-0)"] }],
          publicSafeWarnings: ["Reviewed at /home/dev/workspace before posting."],
        },
      }),
    );
    expect(draft.sourceUploadDisabled).toBe(true);
    const blob = JSON.stringify(draft);
    expect(blob).not.toMatch(/\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\Users\\/);
  });

  it("lists the private analysis fields it deliberately excludes", () => {
    const draft = buildPublicPrBodyDraft(source());
    expect(draft.excludedPrivateFields).toEqual([...EXCLUDED_PRIVATE_PR_BODY_FIELDS]);
    // The exclusion list itself stays public-safe (no private/financial terms).
    expect(JSON.stringify(draft.excludedPrivateFields)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(draft.excludedPrivateFields.join(" ")).toMatch(/score|risk|eligibility/i);
  });
});

// ── Forbidden-language invariant ────────────────────────────────────────────

describe("buildPublicPrBodyDraft — public-output safety", () => {
  it("strips forbidden private/financial language injected through any source field", () => {
    const draft = buildPublicPrBodyDraft(
      source({
        prPacket: {
          ...source().prPacket,
          titleSuggestion: "Boost reward payout and raw trust score",
          publicSafeWarnings: ["Maximize your scoreability and reward estimate", "Mention wallet hotkey farming"],
          bodySections: [{ heading: "Changed Paths", lines: ["- src/ok.ts (modified, +1/-0)"] }],
        },
        baseFreshness: { ...source().baseFreshness, warnings: ["public score estimate looks high"] },
        manifestGuidance: { ...source().manifestGuidance, present: true, publicNextSteps: ["Improve your private reviewability ranking"] },
      }),
    );
    const blob = JSON.stringify(draft);
    expect(blob).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(draft.markdown).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("keeps the rendered markdown free of forbidden language across clean and risky fixtures", () => {
    const drafts = [
      buildPublicPrBodyDraft(source()),
      buildPublicPrBodyDraft(source({ prPacket: { ...source().prPacket, validationSummary: { passed: 0, failed: 1, notRun: 0, commands: [{ command: "npm test", status: "failed" }] } } })),
      buildPublicPrBodyDraft(source({ preflight: { linkedIssues: [], reviewBurden: "high", collisions: [{ id: "c", risk: "high", reason: "overlap", items: [{ type: "issue", number: 9, title: "x" }] }] } })),
    ];
    for (const draft of drafts) {
      expect(draft.markdown).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    }
  });
});

// ── Edge cases / fallback branches ──────────────────────────────────────────

describe("buildPublicPrBodyDraft — fallback branches", () => {
  it("omits the test-file note when no test files changed", () => {
    const draft = buildPublicPrBodyDraft(source({ baseFreshness: { ...source().baseFreshness, changedFileCount: 1, testFileCount: 0 } }));
    expect(section(draft, "Changed files")[0]).toBe("1 file(s) changed.");
  });

  it("handles empty linked-issue and collision metadata", () => {
    const draft = buildPublicPrBodyDraft(source({ preflight: { linkedIssues: [], collisions: [], reviewBurden: "low" } }));
    expect(section(draft, "Linked issue").join(" ")).toMatch(/No linked issue detected/i);
    expect(section(draft, "Duplicate / WIP check").join(" ")).toMatch(/No overlapping open work/i);
  });

  it("labels recent-merge overlap items distinctly", () => {
    const draft = buildPublicPrBodyDraft(
      source({ preflight: { linkedIssues: [], reviewBurden: "low", collisions: [{ id: "c", risk: "low", reason: "overlap", items: [{ type: "recent_merged_pull_request", number: 7, title: "x" }] }] } }),
    );
    expect(section(draft, "Duplicate / WIP check").join(" ")).toMatch(/recent merge #7/);
  });

  it("omits the changed-files paths when no Changed Paths section is present", () => {
    const draft = buildPublicPrBodyDraft(source({ prPacket: { ...source().prPacket, bodySections: [] } }));
    expect(section(draft, "Changed files")).toEqual(["2 file(s) changed, including 1 test file(s)."]);
  });

  it("drops whitespace-only source lines", () => {
    const draft = buildPublicPrBodyDraft(source({ prPacket: { ...source().prPacket, publicSafeWarnings: ["   ", "Keep PRs focused."] } }));
    const steps = section(draft, "Next steps");
    expect(steps).toContain("Keep PRs focused.");
    expect(steps.every((line) => line.trim().length > 0)).toBe(true);
  });
});
