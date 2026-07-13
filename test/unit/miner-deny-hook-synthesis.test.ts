import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  describe("forge-scoping (#5563)", () => {
    it("two forge hosts can each hold their own proposals for the same owner/repo without colliding", () => {
      const store = tempStore();
      const history = [
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      ];
      const ghRefreshed = store.refreshProposals("acme/widgets", history, {}, "https://api.github.com");
      const gheRefreshed = store.refreshProposals("acme/widgets", history, {}, "https://ghe.example.com/api/v3");
      expect(ghRefreshed).toHaveLength(1);
      expect(gheRefreshed).toHaveLength(1);
      // Same synthesized proposal id (derived from the path, not the host) on both hosts, but the rows are
      // independent -- approving one host's proposal must not affect the other's.
      expect(ghRefreshed[0]!.id).toBe(gheRefreshed[0]!.id);
      store.setProposalStatus("acme/widgets", ghRefreshed[0]!.id, "approved", "https://api.github.com");
      expect(store.listProposals("acme/widgets", "https://api.github.com")[0]?.status).toBe("approved");
      expect(store.listProposals("acme/widgets", "https://ghe.example.com/api/v3")[0]?.status).toBe("proposed");
    });

    it("defaults apiBaseUrl to the github.com default when omitted", () => {
      const store = tempStore();
      const history = [
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      ];
      store.refreshProposals("acme/widgets", history);
      expect(store.listProposals("acme/widgets", "https://api.github.com")).toHaveLength(1);
    });

    it("resolveEffectiveRules threads options.apiBaseUrl through to listProposals", () => {
      const store = tempStore();
      const history = [
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      ];
      const refreshed = store.refreshProposals("acme/widgets", history, {}, "https://ghe.example.com/api/v3");
      store.setProposalStatus("acme/widgets", refreshed[0]!.id, "approved", "https://ghe.example.com/api/v3");

      // The github.com host has no approved proposal -- effective rules stay at the static defaults.
      expect(store.resolveEffectiveRules("acme/widgets").length).toBe(DEFAULT_DENY_RULES.length);
      // The GHE host's approval is picked up when its apiBaseUrl is threaded through.
      expect(
        store.resolveEffectiveRules("acme/widgets", { apiBaseUrl: "https://ghe.example.com/api/v3" }).length,
      ).toBe(DEFAULT_DENY_RULES.length + 1);
    });

    it("rejects a non-string or blank apiBaseUrl", () => {
      const store = tempStore();
      expect(() => store.listProposals("acme/widgets", "  ")).toThrow("invalid_api_base_url");
      expect(() => store.refreshProposals("acme/widgets", [], {}, 42 as never)).toThrow("invalid_api_base_url");
      expect(() => store.setProposalStatus("acme/widgets", "x", "approved", "  ")).toThrow("invalid_api_base_url");
    });

    it("migrates an existing pre-#5563 file, backfilling api_base_url and preserving every row", () => {
      const dir = mkdtempSync(join(tmpdir(), "miner-deny-hook-synthesis-legacy-"));
      tempDirs.push(dir);
      const dbPath = join(dir, "legacy.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE deny_rule_proposals (
          repo_full_name TEXT NOT NULL,
          id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
          rule_json TEXT NOT NULL,
          audit_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, id)
        )
      `);
      legacy
        .prepare(
          "INSERT INTO deny_rule_proposals (repo_full_name, id, status, rule_json, audit_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "acme/widgets",
          "path:abc123",
          "approved",
          JSON.stringify({ matcher: "*", pathPattern: "**/changelog.md", reason: "legacy" }),
          JSON.stringify({ kind: "path_history", synthesizedAt: "2026-01-01T00:00:00.000Z" }),
          "2026-01-01T00:00:00.000Z",
        );
      legacy.close();

      const store = initDenyHookSynthesisStore(dbPath);
      stores.push(store);
      expect(store.listProposals("acme/widgets", "https://api.github.com")).toEqual([
        {
          id: "path:abc123",
          status: "approved",
          rule: { matcher: "*", pathPattern: "**/changelog.md", reason: "legacy" },
          audit: { kind: "path_history", synthesizedAt: "2026-01-01T00:00:00.000Z" },
        },
      ]);
      // The old bare (repo_full_name, id) collision is gone: a second host can now hold its own proposal state.
      store.setProposalStatus("acme/widgets", "path:abc123", "rejected", "https://ghe.example.com/api/v3");
      expect(store.listProposals("acme/widgets", "https://api.github.com")[0]?.status).toBe("approved");
    });

    it("REGRESSION: a legacy row violating the rebuilt table's status CHECK constraint is dropped, not a migration-aborting crash", () => {
      const dir = mkdtempSync(join(tmpdir(), "miner-deny-hook-synthesis-legacy-corrupt-"));
      tempDirs.push(dir);
      const dbPath = join(dir, "legacy-corrupt.sqlite3");
      const legacy = new DatabaseSync(dbPath);
      // No CHECK on status here, simulating a hand-edited or otherwise corrupted legacy file -- the real
      // baseline schema always enforces the CHECK, so this can only arise from external tampering.
      legacy.exec(`
        CREATE TABLE deny_rule_proposals (
          repo_full_name TEXT NOT NULL,
          id TEXT NOT NULL,
          status TEXT NOT NULL,
          rule_json TEXT NOT NULL,
          audit_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, id)
        )
      `);
      legacy
        .prepare(
          "INSERT INTO deny_rule_proposals (repo_full_name, id, status, rule_json, audit_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("acme/corrupt", "path:bad", "bogus", "{}", "{}", "2026-01-01T00:00:00.000Z");
      legacy
        .prepare(
          "INSERT INTO deny_rule_proposals (repo_full_name, id, status, rule_json, audit_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("acme/widgets", "path:ok", "proposed", "{}", "{}", "2026-01-01T00:00:00.000Z");
      legacy.close();

      let opened: ReturnType<typeof initDenyHookSynthesisStore> | undefined;
      expect(() => {
        opened = initDenyHookSynthesisStore(dbPath);
      }).not.toThrow();
      const store = opened!;
      stores.push(store);
      // The corrupt row was dropped, not migrated -- only the valid row survived the rebuild.
      expect(store.listProposals("acme/corrupt", "https://api.github.com")).toEqual([]);
      expect(store.listProposals("acme/widgets", "https://api.github.com")).toHaveLength(1);
    });
  });
});
