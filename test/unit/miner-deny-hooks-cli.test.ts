import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDenyHooksArgs, runDenyHooks } from "../../packages/loopover-miner/lib/deny-hooks-cli";
import { initDenyHookSynthesisStore } from "../../packages/loopover-miner/lib/deny-hook-synthesis";
import { resolveAttemptHouseRulesConfig } from "../../packages/loopover-miner/lib/attempt-cli";

// #8806: the operate half of the deny-hook loop — refresh (explicit --history file) → approve → the
// attempt-side resolver picks the approved rule up. The end-to-end test below is the loop the audit found
// severed: pre-#8806 nothing invoked refreshProposals and nothing read resolveEffectiveRules.
describe("loopover-miner deny-hooks (#8806)", () => {
  let configDir: string;
  const savedEnv = { configDir: process.env.LOOPOVER_MINER_CONFIG_DIR, dbOverride: process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "miner-deny-hooks-cli-"));
    process.env.LOOPOVER_MINER_CONFIG_DIR = configDir;
    delete process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB;
  });
  afterEach(() => {
    if (savedEnv.configDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
    else process.env.LOOPOVER_MINER_CONFIG_DIR = savedEnv.configDir;
    if (savedEnv.dbOverride === undefined) delete process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB;
    else process.env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB = savedEnv.dbOverride;
    vi.restoreAllMocks();
  });

  function writeHistory(): string {
    const path = join(configDir, "history.json");
    writeFileSync(
      path,
      JSON.stringify([
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
        { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      ]),
    );
    return path;
  }

  it("END-TO-END: refresh --history → approve → the attempt-side resolver enforces the approved rule", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runDenyHooks(["refresh", "acme/widgets", "--history", writeHistory(), "--json"])).toBe(0);
    const { proposals } = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { proposals: Array<{ id: string }> };
    expect(proposals.length).toBeGreaterThan(0);

    expect(runDenyHooks(["approve", "acme/widgets", proposals[0]!.id])).toBe(0);

    // The enforce half: buildAttemptDeps' resolver (same default store path) now includes the approved rule.
    const baseline = resolveAttemptHouseRulesConfig("other/repo");
    const withApproved = resolveAttemptHouseRulesConfig("acme/widgets");
    expect(withApproved?.rules.length).toBe((baseline?.rules.length ?? 0) + 1);
  });

  it("list renders proposals with status and the effective-rule count", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runDenyHooks(["refresh", "acme/widgets", "--history", writeHistory()]);
    expect(runDenyHooks(["list", "acme/widgets", "--json"])).toBe(0);
    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { proposals: unknown[]; effectiveRuleCount: number };
    expect(payload.proposals.length).toBeGreaterThan(0);
    expect(payload.effectiveRuleCount).toBeGreaterThan(0);
    // Human output too (both list arms + the empty-repo arm).
    expect(runDenyHooks(["list", "acme/widgets"])).toBe(0);
    expect(runDenyHooks(["list", "empty/repo"])).toBe(0);
  });

  it("reject marks a proposal rejected — it never reaches the effective rules", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runDenyHooks(["refresh", "acme/widgets", "--history", writeHistory(), "--json"]);
    const { proposals } = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { proposals: Array<{ id: string }> };
    expect(runDenyHooks(["reject", "acme/widgets", proposals[0]!.id])).toBe(0);
    const store = initDenyHookSynthesisStore();
    try {
      const baselineCount = store.resolveEffectiveRules("other/repo").length;
      expect(store.resolveEffectiveRules("acme/widgets").length).toBe(baselineCount); // defaults only
    } finally {
      store.close();
    }
  });

  it("every failure path exits 2 (the shared default), including a bad history file", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runDenyHooks([])).toBe(2); // no subcommand
    expect(runDenyHooks(["list"])).toBe(2); // no repo
    expect(runDenyHooks(["refresh", "acme/widgets"])).toBe(2); // no --history
    expect(runDenyHooks(["approve", "acme/widgets"])).toBe(2); // no proposal id
    expect(runDenyHooks(["bogus", "acme/widgets"])).toBe(2); // unknown subcommand
    const badPath = join(configDir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ not: "an array" }));
    // The catch-all now returns the shared default (2), not the old bespoke 1.
    expect(runDenyHooks(["refresh", "acme/widgets", "--history", badPath])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("JSON array"));
  });

  // #9687: the parser hand-rolled `args.filter((a) => !a.startsWith("--"))`, so `--history`'s value (a path,
  // which does not start with "--") leaked into the positional list. Placed before the repo, it stole the
  // `repoFullName` slot and the command operated on a nonsense repo. These pin the index-based parse.
  describe("parseDenyHooksArgs (#9687)", () => {
    it("REGRESSION: --history before the repo resolves the repo correctly, not to the history path", () => {
      // Against the old `args.filter` code this yielded repoFullName === "h.json".
      const parsed = parseDenyHooksArgs(["refresh", "--history", "h.json", "acme/widgets"]);
      expect(parsed).toEqual({ subcommand: "refresh", repoFullName: "acme/widgets", proposalId: undefined, historyPath: "h.json", json: false });
    });

    it("consumes --history after the repo too, and threads --json", () => {
      expect(parseDenyHooksArgs(["refresh", "acme/widgets", "--history", "h.json", "--json"])).toEqual({
        subcommand: "refresh",
        repoFullName: "acme/widgets",
        proposalId: undefined,
        historyPath: "h.json",
        json: true,
      });
    });

    it("keeps the third positional as the proposal id (approve/reject)", () => {
      expect(parseDenyHooksArgs(["approve", "acme/widgets", "prop-1"])).toEqual({
        subcommand: "approve",
        repoFullName: "acme/widgets",
        proposalId: "prop-1",
        historyPath: undefined,
        json: false,
      });
    });

    it("rejects a missing --history value with the usage error", () => {
      const parsed = parseDenyHooksArgs(["refresh", "acme/widgets", "--history"]);
      expect(parsed).toEqual({ error: expect.stringContaining("--history <file.json>") });
    });

    it("rejects a flag-like --history value with the usage error", () => {
      const parsed = parseDenyHooksArgs(["refresh", "acme/widgets", "--history", "--json"]);
      expect(parsed).toEqual({ error: expect.stringContaining("--history <file.json>") });
    });

    it("rejects an unknown -x option with 'Unknown option: -x'", () => {
      expect(parseDenyHooksArgs(["list", "acme/widgets", "-x"])).toEqual({ error: "Unknown option: -x" });
    });
  });

  it("routes parse errors through reportCliFailure — --json emits { ok: false, error } on stdout, exit 2", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Unknown option under --json: machine-readable on stdout, nothing on stderr, exit 2.
    expect(runDenyHooks(["list", "acme/widgets", "-x", "--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ ok: false, error: "Unknown option: -x" });
    expect(error).not.toHaveBeenCalled();
    // Same option without --json: plain text on stderr instead, still exit 2.
    log.mockClear();
    expect(runDenyHooks(["list", "acme/widgets", "-x"])).toBe(2);
    expect(error).toHaveBeenCalledWith("Unknown option: -x");
    expect(log).not.toHaveBeenCalled();
  });

  it("a failing store call under --json prints { ok: false, error } on stdout with exit 2", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const badPath = join(configDir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ not: "an array" }));
    // The catch-all: parseHistoryFile throws inside the store try-block; --json routes it to stdout, exit 2.
    expect(runDenyHooks(["refresh", "acme/widgets", "--history", badPath, "--json"])).toBe(2);
    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("JSON array");
    expect(error).not.toHaveBeenCalled();
  });
});
