import { describe, expect, it } from "vitest";
// #5667: the deny-hook pure logic now lives in gittensory-engine. This suite drives it through the ENGINE's
// public barrel ALONE (no @loopover/miner, no SQLite in the import graph), proving portability, and exercises
// every branch of the extracted evaluator + synthesizer so the moved code carries its own coverage.
import {
  DEFAULT_DENY_RULES,
  DEFAULT_SYNTHESIS_CONFIG,
  PROPOSAL_STATUSES,
  aggregateBlockerHistory,
  canonicalizeChangedPath,
  changedPathToDenyGlob,
  evaluateDenyHooks,
  isCoveredByDefaultDenyRules,
  normalizeBlockerHistory,
  normalizeBlockerHistoryRecord,
  normalizeRepoFullName,
  proposalStatusSet,
  resolveEffectiveDenyRules,
  setProposalStatuses,
  synthesizeDenyRuleProposals,
  type DenyRuleProposal,
} from "../../packages/gittensory-engine/src/index";
import { denyHookFixtures } from "../fixtures/deny-hooks/cases.js";

// A fixed injected clock so the synthesizer is deterministic given its inputs (the #5667 requirement).
const NOW = 1_700_000_000_000;

describe("deny-hook engine extraction — evaluator, via @loopover/engine alone (#5667)", () => {
  it.each(denyHookFixtures)("fixture: $name", (fixture) => {
    const verdict = fixture.rules ? evaluateDenyHooks(fixture.toolCall, fixture.rules) : evaluateDenyHooks(fixture.toolCall);
    expect(verdict.allowed).toBe(fixture.expected.allowed);
    if (fixture.expected.allowed) {
      expect(verdict.blockedBy).toBeUndefined();
    } else if (fixture.expected.blockedByIncludes !== undefined) {
      expect(verdict.blockedBy?.reason).toContain(fixture.expected.blockedByIncludes);
    }
  });

  it("allows a call with no matching rule, an empty rule set, a non-array rule set, and a non-object tool call", () => {
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "src/ok.ts" } }, []).allowed).toBe(true);
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "src/ok.ts" } }, null as never).allowed).toBe(true);
    expect(evaluateDenyHooks(null as never).allowed).toBe(true);
    expect(evaluateDenyHooks({ name: "Write", input: {} as never }).allowed).toBe(true);
  });

  it("ignores a malformed rule and a non-string matcher, and force-push token/substring rules fire", () => {
    // A non-object rule + a rule whose matcher is not a string are both skipped without throwing.
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "ls" } }, [null as never, { matcher: 42 as never, reason: "x" }]).allowed).toBe(true);
    // inputIncludesAll (push + --force) and inputTokenPattern (-f bundled) both block.
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push --force origin main" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push -uf origin main" } }).allowed).toBe(false);
    // A "push" without any force flag is allowed (inputTokenPattern must not match --follow-tags).
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push --follow-tags origin main" } }).allowed).toBe(true);
  });

  it("collects strings from nested/array inputs, skips falsy values, and tolerates a cyclic input object", () => {
    const cyclic: Record<string, unknown> = { nested: { file_path: "config/secrets/x.json" } };
    cyclic.self = cyclic; // exercises the WeakSet cycle guard in collectInputStrings
    expect(evaluateDenyHooks({ name: "Write", input: cyclic }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Edit", input: { edits: ["src/a.ts", ".env.production"] } }).allowed).toBe(false);
    // Falsy, non-string nested values (0/null/false) are skipped without recursing — the `value && ...` guard.
    expect(evaluateDenyHooks({ name: "Write", input: { count: 0, flag: null, ok: false, file_path: ".env" } }).allowed).toBe(false);
  });
});

describe("deny-hook engine extraction — synthesizer, via @loopover/engine alone (#5667)", () => {
  it("normalizes blocker history, dropping malformed rows and shaping valid ones", () => {
    expect(normalizeBlockerHistory("not-an-array" as never)).toEqual([]);
    expect(normalizeBlockerHistory([null, 42, [], { blockerCodes: [] }])).toEqual([]);
    const [record] = normalizeBlockerHistory([
      {
        repoFullName: "acme/widgets",
        blockerCodes: ["guardrail_hold", " ", 7 as never],
        changedPaths: ["src/a.ts"],
        guardrailMatches: ["src/b.ts"],
        pullNumber: 12,
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(record).toMatchObject({ repoFullName: "acme/widgets", blockerCodes: ["guardrail_hold"], pullNumber: 12 });
    // repoFullName absent, pullNumber invalid, recordedAt absent → all null/[]; a blockerCodes-only row still normalizes.
    expect(normalizeBlockerHistoryRecord({ blockerCodes: ["x"], pullNumber: 0 })).toMatchObject({
      repoFullName: null,
      pullNumber: null,
      recordedAt: null,
      changedPaths: [],
      guardrailMatches: [],
    });
    expect(normalizeBlockerHistoryRecord(null)).toBeNull();
    expect(normalizeBlockerHistoryRecord([] as never)).toBeNull();
    expect(normalizeBlockerHistoryRecord({ blockerCodes: [] })).toBeNull();
    expect(normalizeBlockerHistoryRecord({ blockerCodes: "nope" as never })).toBeNull();
  });

  it("normalizeRepoFullName validates owner/repo and rejects malformed values", () => {
    expect(normalizeRepoFullName("  acme/widgets  ")).toBe("acme/widgets");
    expect(() => normalizeRepoFullName(42 as never)).toThrow("invalid_repo_full_name");
    expect(() => normalizeRepoFullName("no-slash")).toThrow("invalid_repo_full_name");
    expect(() => normalizeRepoFullName("a/b/c")).toThrow("invalid_repo_full_name");
  });

  it("canonicalizes and globs changed paths, rejecting traversal and non-strings", () => {
    expect(canonicalizeChangedPath("./Src/Foo.ts")).toBe("src/foo.ts");
    expect(canonicalizeChangedPath("a\\b\\C.TS")).toBe("a/b/c.ts");
    expect(canonicalizeChangedPath(42 as never)).toBeNull();
    expect(canonicalizeChangedPath("../escape")).toBeNull();
    expect(canonicalizeChangedPath("   ")).toBeNull();
    expect(changedPathToDenyGlob("src/Foo.ts")).toBe("**/src/foo.ts");
    expect(changedPathToDenyGlob("../nope")).toBeNull();
  });

  it("isCoveredByDefaultDenyRules recognizes built-in coverage and handles blank input", () => {
    expect(isCoveredByDefaultDenyRules("**/.github/workflows/deploy.yml")).toBe(true);
    expect(isCoveredByDefaultDenyRules("**/docs/CHANGELOG.md")).toBe(false);
    expect(isCoveredByDefaultDenyRules("   ")).toBe(false);
    expect(isCoveredByDefaultDenyRules(42 as never)).toBe(false);
    expect(isCoveredByDefaultDenyRules("**/")).toBe(false); // samplePath collapses to empty
  });

  it("aggregates blocker/path frequencies", () => {
    expect(aggregateBlockerHistory([]).recordCount).toBe(0);
    const agg = aggregateBlockerHistory([
      // "../escape.md" canonicalizes to null (traversal) and is skipped — the `if (canonical)` false branch.
      { blockerCodes: ["a"], changedPaths: ["CHANGELOG.md", "../escape.md"] },
      { blockerCodes: ["a", "b"], changedPaths: ["./CHANGELOG.md"], guardrailMatches: ["CHANGELOG.md"] },
    ]);
    expect(agg.pathCounts.has("../escape.md")).toBe(false);
    expect(agg.recordCount).toBe(2);
    expect(agg.pathCounts.get("changelog.md")).toBe(2);
    expect(agg.blockerCounts.get("a")).toBe(2);
    expect([...(agg.pathBlockers.get("changelog.md") ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("synthesizes deterministic, clock-stamped proposals and honors config + thresholds + caps", () => {
    expect(synthesizeDenyRuleProposals([], {}, NOW)).toEqual([]);
    expect(DEFAULT_SYNTHESIS_CONFIG).toMatchObject({ minPathOccurrences: 2, maxProposals: 20 });
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["./CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], guardrailMatches: ["CHANGELOG.md"] },
    ];
    const proposals = synthesizeDenyRuleProposals(history, { minPathOccurrences: 2, maxProposals: 5 }, NOW);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.rule).toMatchObject({ matcher: "*", pathPattern: "**/changelog.md" });
    expect(proposals[0]?.status).toBe("proposed");
    expect(proposals[0]?.audit.occurrenceCount).toBe(3);
    // The injected clock makes synthesizedAt deterministic — the whole point of #5667's nowMs injection.
    expect(proposals[0]?.audit.synthesizedAt).toBe(new Date(NOW).toISOString());

    // Non-integer config falls back to defaults; below-threshold + default-covered paths yield nothing.
    expect(synthesizeDenyRuleProposals(history, { minPathOccurrences: 1.5 as never }, NOW)).toHaveLength(1);
    expect(synthesizeDenyRuleProposals([{ blockerCodes: ["x"], changedPaths: ["docs/ONE.md"] }], { minPathOccurrences: 2 }, NOW)).toEqual([]);
    expect(
      synthesizeDenyRuleProposals(
        [
          { blockerCodes: ["x"], changedPaths: [".github/workflows/ci.yml"] },
          { blockerCodes: ["x"], changedPaths: [".github/workflows/ci.yml"] },
        ],
        {},
        NOW,
      ),
    ).toEqual([]);
    // maxProposals cap: two distinct repeated paths, cap of 1 → only one proposal.
    const capped = synthesizeDenyRuleProposals(
      [
        { blockerCodes: ["x"], changedPaths: ["docs/AAA.md"] },
        { blockerCodes: ["x"], changedPaths: ["docs/AAA.md"] },
        { blockerCodes: ["x"], changedPaths: ["docs/BBB.md"] },
        { blockerCodes: ["x"], changedPaths: ["docs/BBB.md"] },
      ],
      { minPathOccurrences: 2, maxProposals: 1 },
      NOW,
    );
    expect(capped).toHaveLength(1);
  });

  it("resolves effective rules from defaults + approved proposals, and setProposalStatuses applies decisions", () => {
    expect(resolveEffectiveDenyRules()).toEqual(DEFAULT_DENY_RULES);
    expect(resolveEffectiveDenyRules({ includeDefaults: false })).toEqual([]);
    const proposals = synthesizeDenyRuleProposals(
      [
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      ],
      {},
      NOW,
    );
    // Not yet approved → still just the defaults.
    expect(resolveEffectiveDenyRules({ approvedProposals: proposals })).toEqual(DEFAULT_DENY_RULES);
    // setProposalStatuses: object form, a Map form, an unknown id (no-op), an invalid status (no-op), undefined updates.
    const approved = setProposalStatuses(proposals, { [proposals[0]!.id]: "approved" });
    expect(approved[0]?.status).toBe("approved");
    expect(setProposalStatuses(proposals, new Map([[proposals[0]!.id, "rejected" as const]]))[0]?.status).toBe("rejected");
    expect(setProposalStatuses(proposals, { unknown: "approved" })[0]?.status).toBe("proposed");
    expect(setProposalStatuses(proposals, { [proposals[0]!.id]: "bogus" as never })[0]?.status).toBe("proposed");
    expect(setProposalStatuses(proposals, undefined as never)[0]?.status).toBe("proposed");
    expect(() => setProposalStatuses("nope" as never, {})).toThrow("invalid_proposals");

    const effective = resolveEffectiveDenyRules({ approvedProposals: approved });
    expect(effective.length).toBe(DEFAULT_DENY_RULES.length + 1);
    // A non-approved / malformed / duplicate proposal in the approved list is skipped (status + rule-shape + dedupe guards).
    const noisy: DenyRuleProposal[] = [
      ...approved,
      { id: "x", status: "proposed", rule: approved[0]!.rule, audit: approved[0]!.audit },
      { id: "y", status: "approved", rule: null as never, audit: approved[0]!.audit },
      { id: "z", status: "approved", rule: approved[0]!.rule, audit: approved[0]!.audit }, // duplicate signature
    ];
    expect(resolveEffectiveDenyRules({ approvedProposals: noisy }).length).toBe(DEFAULT_DENY_RULES.length + 1);
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "CHANGELOG.md" } }, effective).allowed).toBe(false);
  });

  it("exposes the frozen proposal-status vocabulary", () => {
    expect(PROPOSAL_STATUSES).toEqual(["proposed", "approved", "rejected"]);
    expect(proposalStatusSet.has("approved")).toBe(true);
    expect(proposalStatusSet.has("nope")).toBe(false);
  });
});
