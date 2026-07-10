import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_RULES,
  evaluateDenyHooks,
} from "../../packages/gittensory-miner/lib/deny-hooks.js";
import {
  aggregateBlockerHistory,
  changedPathToDenyGlob,
  initDenyHookSynthesisStore,
  normalizeBlockerHistory,
  resolveEffectiveDenyRules,
  setProposalStatuses,
  synthesizeDenyRuleProposals,
} from "../../packages/gittensory-miner/lib/deny-hook-synthesis.js";

const tempDirs: string[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "miner-deny-hook-synthesis-"));
  tempDirs.push(dir);
  const store = initDenyHookSynthesisStore(join(dir, "deny-hook-synthesis.sqlite3"));
  stores.push(store);
  return store;
}

describe("synthesizeDenyRuleProposals() (#4522)", () => {
  it("returns no proposals and empty history aggregates cleanly", () => {
    expect(synthesizeDenyRuleProposals([])).toEqual([]);
    expect(aggregateBlockerHistory([]).recordCount).toBe(0);
    expect(normalizeBlockerHistory([null, {}, { blockerCodes: [] }])).toEqual([]);
  });

  it("derives a path-shaped deny rule from repeated blocker history", () => {
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["./CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], guardrailMatches: ["CHANGELOG.md"] },
    ];
    const proposals = synthesizeDenyRuleProposals(history, { minPathOccurrences: 2 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.rule).toMatchObject({
      matcher: "*",
      pathPattern: "**/changelog.md",
    });
    expect(proposals[0]?.status).toBe("proposed");
    expect(proposals[0]?.audit.blockerCodes).toEqual(["guardrail_hold"]);
    expect(proposals[0]?.audit.occurrenceCount).toBe(3);
    expect(changedPathToDenyGlob("src/Foo.ts")).toBe("**/src/foo.ts");
  });

  it("skips paths already covered by DEFAULT_DENY_RULES", () => {
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: [".github/workflows/ci.yml"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: [".github/workflows/ci.yml"] },
    ];
    expect(synthesizeDenyRuleProposals(history)).toEqual([]);
  });

  it("does not emit proposals below the occurrence threshold", () => {
    const history = [{ blockerCodes: ["guardrail_hold"], changedPaths: ["docs/ONLY.md"] }];
    expect(synthesizeDenyRuleProposals(history, { minPathOccurrences: 2 })).toEqual([]);
  });
});

describe("resolveEffectiveDenyRules() (#4522)", () => {
  it("falls back to static defaults when history is empty or nothing is approved", () => {
    expect(resolveEffectiveDenyRules()).toEqual(DEFAULT_DENY_RULES);
    const proposals = synthesizeDenyRuleProposals([
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md", "CHANGELOG.md"] },
    ]);
    expect(resolveEffectiveDenyRules({ approvedProposals: proposals })).toEqual(DEFAULT_DENY_RULES);
  });

  it("merges approved synthesized rules after defaults and blocks matching tool calls", () => {
    const proposals = synthesizeDenyRuleProposals([
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ]);
    const approved = setProposalStatuses(proposals, { [proposals[0]!.id]: "approved" });
    const effective = resolveEffectiveDenyRules({ approvedProposals: approved });
    expect(effective.length).toBe(DEFAULT_DENY_RULES.length + 1);
    const verdict = evaluateDenyHooks({ name: "Write", input: { file_path: "CHANGELOG.md" } }, effective);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy?.pathPattern).toBe("**/changelog.md");
  });
});

describe("initDenyHookSynthesisStore() (#4522)", () => {
  it("refreshes proposals, preserves approval, and resolves effective rules from the store", () => {
    const store = tempStore();
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ];
    const refreshed = store.refreshProposals("acme/widgets", history);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.status).toBe("proposed");

    store.setProposalStatus("acme/widgets", refreshed[0]!.id, "approved");
    const again = store.refreshProposals("acme/widgets", history);
    expect(again.find((entry) => entry.id === refreshed[0]!.id)?.status).toBe("approved");

    const effective = store.resolveEffectiveRules("acme/widgets");
    expect(effective.length).toBe(DEFAULT_DENY_RULES.length + 1);
  });
});
